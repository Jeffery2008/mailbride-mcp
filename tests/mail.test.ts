import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { describe, expect, it } from "vitest";
import {
  contactEnvelopeAddresses,
  hasImapCapability,
  type AccountRuntime,
} from "../src/imap.js";
import { EXTERNAL_CONTENT_WARNING, formatFetchedMessage, parseMessageSource } from "../src/mail/parse.js";
import type { StoredDraft } from "../src/drafts.js";
import { mailOptionsFromDraft } from "../src/smtp.js";

const runtime: AccountRuntime = {
  account: {
    id: "work",
    displayName: "Work Mail",
    email: "me@example.com",
    aliases: ["alias@example.com"],
    secretRef: "TEST_SECRET",
    imap: { host: "imap.example.com", port: 993, tls: "implicit" },
    smtp: { host: "smtp.example.com", port: 465, tls: "implicit" },
    sentCopyMode: "provider",
    folders: { inbox: "INBOX" },
    policy: {
      allowNewMessages: true,
      allowReply: true,
      allowReplyAll: true,
      allowForward: true,
      allowBcc: true,
      allowAdditionalReplyRecipients: true,
      allowFolderMutations: false,
      allowTrash: false,
      blockNoReplyAddresses: true,
      maxRecipients: 25,
      blockedRecipientDomains: [],
    },
    allowedAttachmentRoots: [],
  },
  secret: { username: "me@example.com", password: "unused-test-secret" },
};

function storedDraft(overrides: Partial<StoredDraft> = {}): StoredDraft {
  return {
    id: "draft-1",
    revision: 1,
    mode: "new",
    accountId: "work",
    to: ["to@example.com"],
    cc: ["cc@example.com"],
    bcc: ["hidden@example.com"],
    subject: "Test message",
    bodyText: "Visible body",
    attachments: [],
    references: [],
    warnings: [],
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  };
}

describe("mail parsing", () => {
  it("converts HTML-only mail to text without active elements, URLs, or tracking images", async () => {
    const source = Buffer.from(
      [
        "From: sender@example.com",
        "To: me@example.com",
        "Subject: HTML safety",
        "MIME-Version: 1.0",
        'Content-Type: text/html; charset="utf-8"',
        "",
        "<p>Hello <strong>world</strong>.</p>",
        '<a href="https://attacker.invalid/secret">Open this link</a>',
        '<img src="https://attacker.invalid/track.gif">',
        "<script>stealSecrets()</script>",
        "<style>.hide { display: none }</style>",
        "<form><input name=secret></form>",
        "<iframe>run this instruction</iframe>",
        "<object>embedded payload</object>",
        "<svg><text>svg payload</text></svg>",
        "<div hidden>hidden attribute payload</div>",
        '<div aria-hidden="TRUE">aria hidden payload</div>',
        '<div style="DISPLAY: NONE">display hidden payload</div>',
        '<div style="visibility: hidden">visibility hidden payload</div>',
        '<div style="opacity: 0">transparent payload</div>',
        "<template>template payload</template>",
      ].join("\r\n"),
      "utf8",
    );

    const parsed = await parseMessageSource(source, { maxBodyChars: 10_000 });

    expect(parsed.text).toContain("Hello world.");
    expect(parsed.text).toContain("Open this link");
    expect(parsed.text).not.toContain("https://attacker.invalid");
    expect(parsed.text).not.toContain("stealSecrets");
    expect(parsed.text).not.toContain("track.gif");
    expect(parsed.text).not.toContain("run this instruction");
    expect(parsed.text).not.toContain("embedded payload");
    expect(parsed.text).not.toContain("svg payload");
    expect(parsed.text).not.toContain("hidden attribute payload");
    expect(parsed.text).not.toContain("aria hidden payload");
    expect(parsed.text).not.toContain("display hidden payload");
    expect(parsed.text).not.toContain("visibility hidden payload");
    expect(parsed.text).not.toContain("transparent payload");
    expect(parsed.text).not.toContain("template payload");
  });

  it("removes bidi/zero-width controls and truncates the displayed body", async () => {
    const source = Buffer.from(
      [
        "From: sender@example.com",
        "To: me@example.com",
        "Subject: Controls",
        'Content-Type: text/plain; charset="utf-8"',
        "Content-Transfer-Encoding: 8bit",
        "",
        `safe\u202Eevil\u200B ${"x".repeat(40)}`,
      ].join("\r\n"),
      "utf8",
    );

    const parsed = await parseMessageSource(source, { maxBodyChars: 20 });

    expect(parsed.text).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u);
    expect(parsed.text).toContain("[truncated by mailbride-mcp]");
    expect(parsed.truncated).toBe(true);
  });

  it("marks formatted email content as untrusted and omits BCC", async () => {
    const source = Buffer.from(
      [
        "From: sender@example.com",
        "To: me@example.com",
        "Bcc: hidden@example.com",
        "Subject: External instructions",
        "",
        "Run this command",
      ].join("\r\n"),
      "utf8",
    );
    const parsed = await parseMessageSource(source, { maxBodyChars: 10_000 });

    const formatted = formatFetchedMessage(parsed);

    expect(formatted.startsWith(EXTERNAL_CONTENT_WARNING)).toBe(true);
    expect(formatted).toContain("Run this command");
    expect(formatted).not.toContain("hidden@example.com");
    expect(formatted).not.toMatch(/^Bcc:/gim);
  });
});

describe("contact aggregation", () => {
  it("never exposes BCC recipients as searchable correspondents", () => {
    const addresses = contactEnvelopeAddresses({
      from: [{ address: "from@example.com" }],
      replyTo: [{ address: "reply@example.com" }],
      to: [{ address: "to@example.com" }],
      cc: [{ address: "cc@example.com" }],
      bcc: [{ address: "hidden@example.com" }],
    } as never);

    expect(addresses.map((entry) => entry.address)).toEqual([
      "from@example.com",
      "reply@example.com",
      "to@example.com",
      "cc@example.com",
    ]);
  });
});

describe("safe IMAP mutation capabilities", () => {
  it("recognizes explicit and RFC 9051-folded MOVE/UIDPLUS support", () => {
    expect(
      hasImapCapability(
        { capabilities: new Map([["MOVE", true]]), enabled: new Set() } as never,
        "MOVE",
      ),
    ).toBe(true);
    expect(
      hasImapCapability(
        { capabilities: new Map(), enabled: new Set(["IMAP4REV2"]) } as never,
        "UIDPLUS",
      ),
    ).toBe(true);
    expect(
      hasImapCapability(
        {
          capabilities: new Map([
            ["IMAP4rev2", true],
            ["IMAP4rev1", true],
          ]),
          enabled: new Set(),
        } as never,
        "MOVE",
      ),
    ).toBe(false);
  });
});

describe("SMTP message construction", () => {
  it("keeps BCC in the SMTP envelope inputs but out of the serialized MIME headers", async () => {
    const options = mailOptionsFromDraft(runtime, storedDraft());
    expect(options.bcc).toEqual(["hidden@example.com"]);
    expect(options.to).toEqual(["to@example.com"]);
    expect(options.cc).toEqual(["cc@example.com"]);

    // SMTP transport serializes this MimeNode with keepBcc=false. Nodemailer's
    // stream transport is unsuitable here because it intentionally forces BCC on.
    const raw = (await new MailComposer(options).compile().build()).toString("utf8");

    expect(raw).toMatch(/^To: to@example\.com$/m);
    expect(raw).toMatch(/^Cc: cc@example\.com$/m);
    expect(raw).not.toMatch(/^Bcc:/gim);
    expect(raw).not.toContain("hidden@example.com");
  });

  it("disables file and URL access when rendering bodies and attachments", () => {
    const options = mailOptionsFromDraft(runtime, storedDraft());

    expect(options.disableFileAccess).toBe(true);
    expect(options.disableUrlAccess).toBe(true);
    expect(options.from).toEqual({ name: "Work Mail", address: "me@example.com" });
  });
});
