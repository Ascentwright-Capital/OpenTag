import type { ProviderActor } from "@copilotkit/channels";

/** No account is trusted to speak through an app: the default. */
export const NO_TRUSTED_APP_SENDERS: ReadonlySet<string> = new Set();

/**
 * Slack user ids: `U…` for an ordinary workspace member, `W…` for an
 * Enterprise Grid one. A bot user is also a `U…` id, which is why an id alone is
 * never enough here: see {@link speaksForAPerson}.
 */
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;

/**
 * Whether a message speaks for a person, so the bot should answer it and may
 * name its sender.
 *
 * `ProviderActor.kind` is the provider's own untrusted word for what sent a
 * message, so it works as a filter and never as a grant. `human` always
 * speaks for a person. `bot` never does, so the bot can't answer its own posts
 * or another bot's and loop. `system` and `unknown` never do either: one is the
 * platform talking about the channel, and the other is a message nobody could
 * attribute.
 *
 * `app` is a person's own account posting through an app they authorised. A
 * Claude session posting as the shared company account is one example: Slack
 * shows "Sent using …" and the provider reports `app`. Such a message speaks
 * for that account only when the operator has named the account in
 * `OPENTAG_TRUSTED_APP_SENDERS`. Two conditions must both hold, the kind and
 * the id, so a bot user with a listed id still stays out.
 */
export function speaksForAPerson(
  actor: Pick<ProviderActor, "id" | "kind"> | undefined,
  trustedAppSenders: ReadonlySet<string> = NO_TRUSTED_APP_SENDERS,
): boolean {
  if (actor?.kind === "human") return true;
  return (
    actor?.kind === "app" &&
    typeof actor.id === "string" &&
    trustedAppSenders.has(actor.id)
  );
}

/**
 * `OPENTAG_TRUSTED_APP_SENDERS`: a comma-separated list of Slack user ids.
 *
 * Unset or blank trusts nobody. Anything that is not a Slack user id is
 * rejected at boot. A typo here should stop the service, not quietly leave the
 * account it was meant to name unable to reach the bot.
 */
export function parseTrustedAppSenders(
  raw: string | undefined,
  name = "OPENTAG_TRUSTED_APP_SENDERS",
): ReadonlySet<string> {
  const ids = (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  for (const id of ids) {
    if (!SLACK_USER_ID.test(id)) {
      throw new Error(
        `Invalid ${name}: "${id}" is not a Slack user id (U… or W…).`,
      );
    }
  }
  return ids.length > 0 ? new Set(ids) : NO_TRUSTED_APP_SENDERS;
}
