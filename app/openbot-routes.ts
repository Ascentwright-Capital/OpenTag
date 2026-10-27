/**
 * The two routes OpenBot calls on OpenTag when they are paired (`OPENBOT_PAIRING`).
 *
 * A managed Channel can only post inside a live delivery, fenced to that turn's
 * recipient, so a message OpenBot sends on its own (a reply after an approval, a
 * Bot's question, a routine result) has no turn to ride on. These routes post it
 * with the workspace's own bot token instead (`SLACK_BOT_TOKEN`), and answer
 * OpenBot's channel-membership checks with the same token.
 *
 * The contract is OpenBot's `createOpenTagTransport`
 * (`server/src/delivery/opentag.ts`):
 *
 * - `POST /openbot/deliver` `{ id, platform, address, text, sender? }` answers
 *   `{ ok: true, id: <ts>, channel }`. A failure answers `{ error: <code> }`;
 *   OpenBot retries a 5xx and records anything else as failed.
 * - `POST /openbot/membership` `{ teamId, slackUserId, channelId }` answers
 *   `{ member: boolean }`. OpenBot fails closed on anything else.
 *
 * Both require `Authorization` to equal `AGENT_AUTH_HEADER`, which is the same
 * `Bearer <secret>` OpenBot already checks on every turn. Without a secret the
 * routes stay shut: anybody who can reach this port could otherwise post as the
 * app.
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const DELIVER_PATH = "/openbot/deliver";
export const MEMBERSHIP_PATH = "/openbot/membership";

const MAX_BODY_BYTES = 256 * 1024;
const SLACK_TIMEOUT_MS = 15_000;
/** Slack's `markdown_text` limit; longer text goes out as plain `text`. */
const MARKDOWN_TEXT_LIMIT = 12_000;
/** OpenBot retries a delivery under the same id; the answer is kept this long. */
const SENT_TTL_MS = 24 * 60 * 60 * 1000;
const SENT_LIMIT = 5_000;

export interface OpenbotRoutesOptions {
  /** The `Authorization` value OpenBot presents: `AGENT_AUTH_HEADER`. */
  authHeader?: string;
  /** The Slack app's bot token (`xoxb-…`). */
  slackBotToken?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

type SlackAnswer = { ok?: boolean; error?: string; [key: string]: unknown };

class SlackCallError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

function sameSecret(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  // Equal-length buffers, so neither content nor length leaks through an early exit.
  const padded = Buffer.alloc(a.length);
  b.copy(padded);
  return timingSafeEqual(a, padded) && a.length === b.length;
}

/** An error code OpenBot will record as given: lowercase, digits, underscores. */
function errorCode(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value)
    ? value
    : fallback;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new SyntaxError("body_too_large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** Slack conversation and user ids: `C…`, `G…`, `D…`, `U…`, `W…`. */
function isSlackId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9]{2,64}$/.test(value);
}

export function createOpenbotRoutes(options: OpenbotRoutesOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sent = new Map<string, { at: number; body: unknown }>();

  async function slack(
    method: string,
    body: Record<string, unknown>,
  ): Promise<SlackAnswer> {
    let response: Response;
    try {
      response = await fetchImpl(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.slackBotToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
      });
    } catch {
      throw new SlackCallError("network_error", true);
    }
    if (response.status === 429)
      throw new SlackCallError("ratelimited", true);
    if (!response.ok)
      throw new SlackCallError(`slack_http_${response.status}`, response.status >= 500);
    let answer: SlackAnswer;
    try {
      answer = (await response.json()) as SlackAnswer;
    } catch {
      throw new SlackCallError("slack_invalid_response", true);
    }
    if (answer.ok !== true) {
      const code = errorCode(answer.error, "slack_error");
      throw new SlackCallError(
        code,
        code === "ratelimited" || code === "internal_error" || code === "fatal_error",
      );
    }
    return answer;
  }

  function remember(id: string, body: unknown): void {
    const at = now();
    sent.delete(id);
    sent.set(id, { at, body });
    for (const [key, entry] of sent) {
      if (sent.size <= SENT_LIMIT && at - entry.at < SENT_TTL_MS) break;
      sent.delete(key);
    }
  }

  /**
   * Where a message to `address` goes. A user id is opened as the person's
   * direct message with the app (`im:write`): posted to the bare user id,
   * Slack files the message under its own "Slack" notifications conversation,
   * where the person cannot answer. Conversation ids pass through.
   */
  async function conversationFor(address: string): Promise<string> {
    if (!/^[UW]/.test(address)) return address;
    const answer = await slack("conversations.open", { users: address });
    const opened = isRecord(answer.channel) ? answer.channel.id : undefined;
    if (typeof opened !== "string" || !opened)
      throw new SlackCallError("slack_invalid_response", true);
    return opened;
  }

  async function deliver(payload: unknown, response: ServerResponse) {
    if (
      !isRecord(payload) ||
      !boundedString(payload.id, 512) ||
      !boundedString(payload.address, 512) ||
      !boundedString(payload.text, 40_000)
    )
      return send(response, 400, { error: "invalid_request" });
    if (payload.platform !== "slack")
      return send(response, 422, { error: "platform_not_supported" });
    if (!isSlackId(payload.address))
      return send(response, 422, { error: "invalid_address" });

    const earlier = sent.get(payload.id);
    if (earlier && now() - earlier.at < SENT_TTL_MS)
      return send(response, 200, earlier.body);

    const sender = isRecord(payload.sender) ? payload.sender : undefined;
    const name = boundedString(sender?.name, 80) ? sender.name : undefined;
    const iconUrl =
      boundedString(sender?.iconUrl, 2048) && sender.iconUrl.startsWith("https://")
        ? sender.iconUrl
        : undefined;
    let channel: string;
    try {
      channel = await conversationFor(payload.address);
    } catch (error) {
      return failed(error, response);
    }
    const text = payload.text;
    const message: Record<string, unknown> = {
      channel,
      ...(text.length <= MARKDOWN_TEXT_LIMIT
        ? { markdown_text: text }
        : { text }),
      unfurl_links: false,
    };
    const asSender = {
      ...message,
      ...(name ? { username: name } : {}),
      ...(iconUrl ? { icon_url: iconUrl } : {}),
    };

    let answer: SlackAnswer;
    try {
      answer = await slack("chat.postMessage", asSender);
    } catch (error) {
      // Posting under the Bot's own name needs `chat:write.customize`. Without
      // it the message still goes, under the app's name.
      if (
        error instanceof SlackCallError &&
        error.code === "missing_scope" &&
        (name || iconUrl)
      ) {
        try {
          answer = await slack("chat.postMessage", message);
        } catch (retry) {
          return failed(retry, response);
        }
      } else {
        return failed(error, response);
      }
    }
    if (typeof answer.ts !== "string")
      return send(response, 502, { error: "missing_message_id" });
    const body = {
      ok: true,
      id: answer.ts,
      ...(typeof answer.channel === "string" ? { channel: answer.channel } : {}),
    };
    remember(payload.id, body);
    return send(response, 200, body);
  }

  async function membership(payload: unknown, response: ServerResponse) {
    if (
      !isRecord(payload) ||
      !isSlackId(payload.slackUserId) ||
      !isSlackId(payload.channelId)
    )
      return send(response, 400, { error: "invalid_request" });
    let cursor: string | undefined;
    try {
      // Bounded: a channel of 20,000 people is 20 pages.
      for (let page = 0; page < 20; page += 1) {
        const answer = await slack("conversations.members", {
          channel: payload.channelId,
          limit: 1000,
          ...(cursor ? { cursor } : {}),
        });
        const members = Array.isArray(answer.members) ? answer.members : [];
        if (members.includes(payload.slackUserId))
          return send(response, 200, { member: true });
        const next = isRecord(answer.response_metadata)
          ? answer.response_metadata.next_cursor
          : undefined;
        if (typeof next !== "string" || !next) break;
        cursor = next;
      }
    } catch (error) {
      return failed(error, response);
    }
    return send(response, 200, { member: false });
  }

  function failed(error: unknown, response: ServerResponse) {
    if (error instanceof SlackCallError) {
      console.warn(`[opentag] Slack refused an OpenBot request: ${error.code}`);
      return send(response, error.retryable ? 503 : 422, { error: error.code });
    }
    console.error("[opentag] an OpenBot request failed:", error);
    return send(response, 500, { error: "internal_error" });
  }

  /** Handles the two routes; anything else is left for the next listener. */
  return async function handleOpenbotRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== DELIVER_PATH && path !== MEMBERSHIP_PATH) return false;
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      send(response, 405, { error: "method_not_allowed" });
      return true;
    }
    const presented = request.headers.authorization;
    if (
      !options.authHeader ||
      typeof presented !== "string" ||
      !sameSecret(options.authHeader, presented.trim())
    ) {
      send(response, 401, { error: "unauthorized" });
      return true;
    }
    if (!options.slackBotToken) {
      send(response, 503, { error: "slack_token_not_configured" });
      return true;
    }
    let payload: unknown;
    try {
      payload = await readJson(request);
    } catch {
      send(response, 400, { error: "invalid_request" });
      return true;
    }
    if (path === DELIVER_PATH) await deliver(payload, response);
    else await membership(payload, response);
    return true;
  };
}
