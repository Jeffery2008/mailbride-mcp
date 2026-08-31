import { describe, expect, it } from "vitest";
import {
  assertEmailAddress,
  normalizeAddress,
  uniqueAddresses,
} from "../src/security/addresses.js";
import { OpaqueTokenCodec } from "../src/security/tokens.js";

describe("OpaqueTokenCodec", () => {
  const secret = Buffer.alloc(32, 0x42);

  it("round-trips an issued value", () => {
    const codec = new OpaqueTokenCodec(secret);
    const value = { accountId: "work", mailbox: "INBOX", uidValidity: "19", uid: 7 };

    const token = codec.issue("message", value);

    expect(codec.read("message", token)).toEqual(value);
    expect(token).not.toContain("INBOX");
  });

  it("rejects a payload modified without recomputing its MAC", () => {
    const codec = new OpaqueTokenCodec(secret);
    const token = codec.issue("message", { accountId: "work", uid: 7 });
    const [body, signature] = token.split(".") as [string, string];
    const envelope = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      kind: string;
      value: { accountId: string; uid: number };
    };
    envelope.value.uid = 8;
    const tamperedBody = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");

    expect(() => codec.read("message", `${tamperedBody}.${signature}`)).toThrow(
      "invalid or expired opaque reference",
    );
  });

  it("rejects a modified signature and a token issued by another codec", () => {
    const codec = new OpaqueTokenCodec(secret);
    const token = codec.issue("folder", { accountId: "work", mailbox: "INBOX" });
    const [body, signature] = token.split(".") as [string, string];
    const tamperedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;

    expect(() => codec.read("folder", `${body}.${tamperedSignature}`)).toThrow(
      "invalid or expired opaque reference",
    );
    expect(() => new OpaqueTokenCodec(Buffer.alloc(32, 0x24)).read("folder", token)).toThrow(
      "invalid or expired opaque reference",
    );
  });

  it("keeps message, folder, and cursor token domains separate", () => {
    const codec = new OpaqueTokenCodec(secret);
    const token = codec.issue("folder", { accountId: "work", mailbox: "INBOX" });

    expect(() => codec.read("message", token)).toThrow("reference is not a message reference");
    expect(() => codec.read("cursor", token)).toThrow("reference is not a cursor reference");
  });

  it("rejects malformed token framing", () => {
    const codec = new OpaqueTokenCodec(secret);

    expect(() => codec.read("message", "not-a-token")).toThrow("invalid opaque reference");
    expect(() => codec.read("message", "one.two.three")).toThrow("invalid opaque reference");
  });
});

describe("email address validation", () => {
  it("rejects CRLF and header-style recipient injection", () => {
    const malicious = [
      "victim@example.com\r\nBcc: attacker@example.com",
      "victim@example.com\nCc: attacker@example.com",
      "victim@example.com, attacker@example.com",
      '"Victim" <victim@example.com>',
    ];

    for (const address of malicious) {
      expect(() => assertEmailAddress(address)).toThrow("invalid email address");
    }
  });

  it("deduplicates case-insensitively while preserving the first spelling", () => {
    expect(
      uniqueAddresses([
        " Alice@Example.com ",
        "alice@example.com",
        "BOB@example.com",
        "bob@EXAMPLE.com",
      ]),
    ).toEqual(["Alice@Example.com", "BOB@example.com"]);
  });

  it("excludes self aliases and prior recipient buckets case-insensitively", () => {
    expect(
      uniqueAddresses(
        ["self@example.com", "alias@example.com", "friend@example.com", "FRIEND@example.com"],
        ["SELF@example.com", "Alias@Example.com"],
      ),
    ).toEqual(["friend@example.com"]);
  });

  it("normalizes surrounding whitespace and case only", () => {
    expect(normalizeAddress("  User+Tag@Example.COM ")).toBe("user+tag@example.com");
  });
});
