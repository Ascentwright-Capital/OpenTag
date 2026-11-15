// Contract test for the OpenBot pairing: this repository's code against OpenBot's own code.
//
// The other pairing tests check each side against a hand-written copy of what the other side
// sends. This one imports OpenBot's delivery module from a checkout, so it fails when the two
// repositories stop agreeing. Run it before you move OpenBot to a new version:
//
//   OPENBOT_DIR=/path/to/openbot pnpm exec vitest run app/openbot-contract.test.ts
//
// The OpenBot checkout needs its dependencies installed (`bun install`). Without OPENBOT_DIR
// the suite is skipped, so `pnpm test` and CI do not need an OpenBot checkout.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseInterrupt } from "./interrupt.js";
import { createOpenbotRoutes } from "./openbot-routes.js";
import { OPENBOT_SENDER_CONTEXT, openbotSenderContext } from "./openbot-sender.js";

const OPENBOT_DIR = process.env.OPENBOT_DIR;
const SECRET = "contract-secret-0000000000000000";
const PERSON = "slack:T0TEAM00001:U0PERSON001";

type SlackCall = { method: string; body: Record<string, unknown> };

describe.skipIf(!OPENBOT_DIR)("OpenBot pairing contract", () => {
  // OpenBot's server/src/delivery/opentag.ts. It is outside this project, so it has no types here.
  let bot: any;
  let server: Server;
  let base = "";
  const slackCalls: SlackCall[] = [];
  const posts = () => slackCalls.filter((call) => call.method === "chat.postMessage");

  beforeAll(async () => {
    bot = await import(`${OPENBOT_DIR}/server/src/delivery/opentag.ts`);

    const fakeSlack = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      slackCalls.push({ method, body });
      if (method === "conversations.open") {
        return Response.json({ ok: true, channel: { id: "D0AAAAAAAA1" } });
      }
      if (method === "chat.postMessage") {
        return Response.json({ ok: true, ts: "1731600000.000100", channel: body.channel });
      }
      if (method === "conversations.members") {
        return Response.json({ ok: true, members: ["U0MEMBER001"] });
      }
      return Response.json({ ok: false, error: "unknown_method" });
    }) as typeof fetch;

    const handle = createOpenbotRoutes({
      authHeader: `Bearer ${SECRET}`,
      slackBotToken: "xoxb-contract-test",
      fetchImpl: fakeSlack,
    });
    server = createServer(async (request, response) => {
      if (!(await handle(request, response))) {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const run = (context: unknown[], extra: Record<string, unknown> = {}) =>
    bot.parseOpenTagRunInput({
      threadId: "thread-1",
      runId: "run-1",
      messages: [{ id: "m1", role: "user", content: "<@U0APPBOT001> hello" }],
      context,
      ...extra,
    });

  const transport = (secret = SECRET) => bot.createOpenTagTransport({ secret, url: base });

  describe("OpenTag to OpenBot: the sender entry on a turn", () => {
    it("uses the context name OpenBot reads", () => {
      expect(OPENBOT_SENDER_CONTEXT).toBe(bot.OPENTAG_SENDER_CONTEXT);
    });

    it("is read as private for a direct message", () => {
      const context = openbotSenderContext(
        {
          user: { id: PERSON, name: "Ken" },
          eventId: "Ev0001",
          operation: { mentioned: false },
        },
        { id: "D0AAAAAAAA1", kind: "direct_message" },
      );
      const sender = bot.senderFromContext(run(context));
      expect(sender).not.toBeNull();
      expect(sender.transport).toBe("slack");
      expect(sender.private).toBe(true);
      expect(sender.mentioned).toBe(false);
      expect(sender.event).toBe("Ev0001");
      expect(sender.conversationId).toBe("D0AAAAAAAA1");
    });

    it("is read as shared and mentioned for a thread mention", () => {
      const context = openbotSenderContext(
        {
          user: { id: PERSON, name: "Ken" },
          eventId: "Ev0002",
          operation: { mentioned: true },
        },
        { id: "C0CHANNEL01", kind: "thread" },
      );
      const sender = bot.senderFromContext(run(context));
      expect(sender.private).toBe(false);
      expect(sender.mentioned).toBe(true);
      expect(sender.conversationId).toBe("C0CHANNEL01");
    });

    it("is absent when no person is named, and OpenBot then finds no sender", () => {
      const context = openbotSenderContext({ user: null, eventId: "Ev0003" }, undefined);
      expect(context).toEqual([]);
      expect(bot.senderFromContext(run(context))).toBeNull();
    });
  });

  describe("OpenBot to OpenTag: proactive sends and membership", () => {
    it("accepts OpenBot's send to a person and posts it to Slack", async () => {
      const result = await transport().send({
        id: "delivery-1",
        address: "U0PERSON001",
        text: "Your approval is waiting.",
        transport: "slack",
        sender: { name: "Factory Master", agentId: "orchestrator", avatarSeed: "orchestrator" },
      });
      expect(result.status).toBe("sent");
      expect(result.id).toBe("D0AAAAAAAA1/1731600000.000100");
      const post = posts()[0];
      expect(post?.body.channel).toBe("D0AAAAAAAA1");
      expect(post?.body.markdown_text).toBe("Your approval is waiting.");
      expect(post?.body.username).toBe("Factory Master");
    });

    it("answers a repeated delivery ID without a second post", async () => {
      const before = posts().length;
      const again = await transport().send({
        id: "delivery-1",
        address: "U0PERSON001",
        text: "Your approval is waiting.",
      });
      expect(again.id).toBe("D0AAAAAAAA1/1731600000.000100");
      expect(posts().length).toBe(before);
    });

    it("accepts OpenBot's send to a channel address", async () => {
      const result = await transport().send({
        id: "delivery-2",
        address: "C0CHANNEL01",
        text: "Done.",
      });
      expect(result.id).toBe("C0CHANNEL01/1731600000.000100");
    });

    it("answers OpenBot's membership check with a boolean", async () => {
      const ask = (slackUserId: string) =>
        transport().isMember({ teamId: "T0TEAM00001", slackUserId, channelId: "C0CHANNEL01" });
      expect(await ask("U0MEMBER001")).toBe(true);
      expect(await ask("U0STRANGER1")).toBe(false);
    });

    it("refuses a wrong shared secret in both directions", async () => {
      const wrong = transport("another-secret-000000000000000000");
      await expect(
        wrong.send({ id: "delivery-3", address: "C0CHANNEL01", text: "x" }),
      ).rejects.toThrow();
      expect(transport().authenticates(`Bearer ${SECRET}`)).toBe(true);
      expect(transport().authenticates("Bearer nope")).toBe(false);
    });
  });

  describe("approval card round trip", () => {
    it("draws OpenBot's interrupt as a card and answers with a resume OpenBot accepts", () => {
      const approvalId = "0f8fad5b-d9cb-469f-a165-70867728950e";
      const interrupt = bot.confirmWriteInterrupt({
        approvalId,
        action: "Digital Factory wants to create an issue in Linear",
        approver: PERSON,
        effect: "write",
        fields: bot.approvalFields({ title: "Fix the thing", team: "AP" }),
        allowAlways: false,
      });
      const parsed = parseInterrupt(interrupt);
      expect(parsed.kind).toBe("confirm_write");
      if (parsed.kind !== "confirm_write") return;
      const interruptId = parsed.interruptId;
      expect(interruptId).toBe(bot.interruptIdForApproval(approvalId));
      if (!interruptId) return;
      expect(parsed.args.effect).toBe("write");
      expect(parsed.args.approver).toBe(PERSON);
      expect(parsed.args.fields?.length).toBeGreaterThan(0);

      // The answer the card sends on Approve (components/confirm-write.tsx): `{ confirmed, by }`.
      const resumed = bot.resumeFromInput(
        run([], {
          forwardedProps: {
            command: { resume: { [interruptId]: { confirmed: true, by: PERSON } } },
          },
        }),
      );
      expect(resumed.invalid).toBe(false);
      expect(resumed.approvalId).toBe(approvalId);
      expect(resumed.confirmed).toBe(true);
      expect(resumed.by).toBe(PERSON);
    });
  });
});
