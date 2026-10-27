import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpenbotRoutes,
  DELIVER_PATH,
  MEMBERSHIP_PATH,
  type OpenbotRoutesOptions,
} from "./openbot-routes.js";

const AUTH = "Bearer 0123456789abcdef0123456789abcdef";

type SlackCall = { method: string; body: Record<string, unknown> };

function fakeSlack(answers: Array<Record<string, unknown> | number>) {
  const calls: SlackCall[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: String(url).replace("https://slack.com/api/", ""),
      body: JSON.parse(String(init?.body)),
    });
    const answer = answers.shift() ?? { ok: true };
    if (typeof answer === "number") return new Response("", { status: answer });
    return Response.json(answer);
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

let server: Server | undefined;

async function serve(options: OpenbotRoutesOptions) {
  const handle = createOpenbotRoutes(options);
  server = createServer((request, response) => {
    void handle(request, response).then((handled) => {
      if (!handled) {
        response.statusCode = 404;
        response.end("next");
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return (path: string, body: unknown, auth: string | null = AUTH, method = "POST") =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: auth } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    });
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const delivery = {
  id: "opentag-reply:1",
  platform: "slack",
  address: "U012ABCDEF",
  text: "**Done.** The report is ready.",
};

describe("OpenBot routes", () => {
  it("leaves other paths to the next listener", async () => {
    const slack = fakeSlack([]);
    const call = await serve({ authHeader: AUTH, slackBotToken: "xoxb-1", fetchImpl: slack.fetchImpl });
    expect((await call("/api/copilotkit/info", {}, null, "GET")).status).toBe(404);
  });

  it("refuses a request without OpenBot's secret", async () => {
    const slack = fakeSlack([]);
    const call = await serve({ authHeader: AUTH, slackBotToken: "xoxb-1", fetchImpl: slack.fetchImpl });
    expect((await call(DELIVER_PATH, delivery, "Bearer wrong")).status).toBe(401);
    expect((await call(DELIVER_PATH, delivery, null)).status).toBe(401);
    expect(slack.calls).toHaveLength(0);
  });

  it("stays shut when no secret is configured", async () => {
    const slack = fakeSlack([]);
    const call = await serve({ slackBotToken: "xoxb-1", fetchImpl: slack.fetchImpl });
    expect((await call(DELIVER_PATH, delivery, "")).status).toBe(401);
  });

  it("says so when no bot token is configured", async () => {
    const call = await serve({ authHeader: AUTH });
    const response = await call(DELIVER_PATH, delivery);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "slack_token_not_configured" });
  });

  it("posts a delivery as the Bot and answers with where it landed", async () => {
    const slack = fakeSlack([{ ok: true, ts: "1730000000.000100", channel: "D0ABCDEFGH" }]);
    const call = await serve({ authHeader: AUTH, slackBotToken: "xoxb-1", fetchImpl: slack.fetchImpl });
    const response = await call(DELIVER_PATH, {
      ...delivery,
      sender: { name: "Analytics", iconUrl: "https://example.com/a.png" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, id: "1730000000.000100", channel: "D0ABCDEFGH" });
    expect(slack.calls).toEqual([
      {
        method: "chat.postMessage",
        body: {
          channel: "U012ABCDEF",
          markdown_text: delivery.text,
          unfurl_links: false,
          username: "Analytics",
          icon_url: "https://example.com/a.png",
        },
      },
    ]);
  });

  it("answers a retried delivery without posting it twice", async () => {
    const slack = fakeSlack([{ ok: true, ts: "1.2", channel: "D0ABCDEFGH" }]);
    const call = await serve({ authHeader: AUTH, slackBotToken: "xoxb-1", fetchImpl: slack.fetchImpl });
    await call(DELIVER_PATH, delivery);
    const again = await call(DELIVER_PATH, delivery);
    expect(await again.json()).toEqual({ ok: true, id: "1.2", channel: "D0ABCDEFGH" });
    expect(slack.calls).toHaveLength(1);
  });

  it("posts under the app's name when the Bot's name needs a missing scope", async () => {
    const slack = fakeSlack([{ ok: false, error: "missing_scope" }, { ok: true, ts: "1.3" }]);
    const call = await serve({ authHeader: AUTH, slackBotToken: "xoxb-1", fetchImpl: slack.fetchImpl });
    const response = await call(DELIVER_PATH, { ...delivery, sender: { name: "Analytics" } });
    expect(response.status).toBe(200);
    expect(slack.calls[1]?.body).not.toHaveProperty("username");
  });

  it("passes Slack's refusal on, retryable only when Slack is at fault", async () => {
    const slack = fakeSlack([{ ok: false, error: "channel_not_found" }, 429]);
    const call = await serve({ authHeader: AUTH, slackBotToken: "xoxb-1", fetchImpl: slack.fetchImpl });
    const refused = await call(DELIVER_PATH, delivery);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: "channel_not_found" });
    const limited = await call(DELIVER_PATH, { ...delivery, id: "other" });
    expect(limited.status).toBe(503);
    expect(await limited.json()).toEqual({ error: "ratelimited" });
  });

  it("refuses Teams and malformed deliveries", async () => {
    const slack = fakeSlack([]);
    const call = await serve({ authHeader: AUTH, slackBotToken: "xoxb-1", fetchImpl: slack.fetchImpl });
    expect((await call(DELIVER_PATH, { ...delivery, platform: "teams" })).status).toBe(422);
    expect((await call(DELIVER_PATH, { ...delivery, address: "#general" })).status).toBe(422);
    expect((await call(DELIVER_PATH, { id: "x" })).status).toBe(400);
    expect(slack.calls).toHaveLength(0);
  });

  it("finds a member across pages", async () => {
    const slack = fakeSlack([
      { ok: true, members: ["U1"], response_metadata: { next_cursor: "c2" } },
      { ok: true, members: ["U012ABCDEF"], response_metadata: { next_cursor: "" } },
    ]);
    const call = await serve({ authHeader: AUTH, slackBotToken: "xoxb-1", fetchImpl: slack.fetchImpl });
    const response = await call(MEMBERSHIP_PATH, {
      teamId: "T1",
      slackUserId: "U012ABCDEF",
      channelId: "C0ABCDEFGH",
    });
    expect(await response.json()).toEqual({ member: true });
    expect(slack.calls[1]?.body).toEqual({ channel: "C0ABCDEFGH", limit: 1000, cursor: "c2" });
  });

  it("answers not a member when the last page has no match", async () => {
    const slack = fakeSlack([{ ok: true, members: ["U1"] }]);
    const call = await serve({ authHeader: AUTH, slackBotToken: "xoxb-1", fetchImpl: slack.fetchImpl });
    const response = await call(MEMBERSHIP_PATH, {
      teamId: "T1",
      slackUserId: "U012ABCDEF",
      channelId: "C0ABCDEFGH",
    });
    expect(await response.json()).toEqual({ member: false });
  });
});
