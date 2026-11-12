import { describe, expect, it } from "vitest";
import {
  NO_TRUSTED_APP_SENDERS,
  parseTrustedAppSenders,
  speaksForAPerson,
} from "./trusted-senders.js";

const trusted = new Set(["U0CD7JBKWP2"]);

describe("speaksForAPerson", () => {
  it("always admits a person who typed the message", () => {
    expect(speaksForAPerson({ id: "U1", kind: "human" })).toBe(true);
    expect(speaksForAPerson({ id: "U1", kind: "human" }, trusted)).toBe(true);
  });

  it("admits an app post only from a listed account", () => {
    expect(speaksForAPerson({ id: "U0CD7JBKWP2", kind: "app" }, trusted)).toBe(
      true,
    );
    expect(speaksForAPerson({ id: "U9OTHER", kind: "app" }, trusted)).toBe(
      false,
    );
  });

  it("admits no app post when nobody is listed, which is the default", () => {
    expect(speaksForAPerson({ id: "U0CD7JBKWP2", kind: "app" })).toBe(false);
  });

  // The kind and the id must both match, so listing an id never lets a bot in
  // and the reply loop stays closed.
  it.each(["bot", "system", "unknown"] as const)(
    "never admits %s, even with a listed id",
    (kind) => {
      expect(speaksForAPerson({ id: "U0CD7JBKWP2", kind }, trusted)).toBe(
        false,
      );
    },
  );

  it("refuses a message with no actor", () => {
    expect(speaksForAPerson(undefined, trusted)).toBe(false);
  });
});

describe("parseTrustedAppSenders", () => {
  it("trusts nobody when unset or blank", () => {
    expect(parseTrustedAppSenders(undefined)).toBe(NO_TRUSTED_APP_SENDERS);
    expect(parseTrustedAppSenders("  ")).toBe(NO_TRUSTED_APP_SENDERS);
    expect(parseTrustedAppSenders(" , ")).toBe(NO_TRUSTED_APP_SENDERS);
  });

  it("reads a comma-separated list of Slack user ids", () => {
    expect([...parseTrustedAppSenders(" U0CD7JBKWP2 , W012ABC ")]).toEqual([
      "U0CD7JBKWP2",
      "W012ABC",
    ]);
  });

  it.each(["B0CC7NFVCG3", "u0cd7jbkwp2", "ascentwright", "<@U0CD7JBKWP2>"])(
    "stops at boot on %s, which is not a Slack user id",
    (value) => {
      expect(() => parseTrustedAppSenders(value)).toThrow(
        /OPENTAG_TRUSTED_APP_SENDERS/,
      );
    },
  );
});
