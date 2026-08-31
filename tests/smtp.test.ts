import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { StoredDraft } from "../src/drafts.js";
import type { AccountRuntime } from "../src/imap.js";

const mocks = vi.hoisted(() => ({
  appendSentCopy: vi.fn(),
  close: vi.fn(),
  sendMail: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({
      close: mocks.close,
      sendMail: mocks.sendMail,
    })),
  },
}));

vi.mock("../src/imap.js", () => ({
  appendSentCopy: mocks.appendSentCopy,
}));

import { sendDraft } from "../src/smtp.js";

const runtime: AccountRuntime = {
  account: {
    id: "work",
    displayName: "Work Mail",
    email: "me@example.com",
    aliases: [],
    secretRef: "TEST_SECRET",
    imap: { host: "imap.example.com", port: 993, tls: "implicit" },
    smtp: { host: "smtp.example.com", port: 465, tls: "implicit" },
    sentCopyMode: "imap_append",
    folders: { inbox: "INBOX", sent: "Sent" },
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

const draft: StoredDraft = {
  id: "draft-1",
  revision: 1,
  mode: "new",
  accountId: "work",
  to: ["to@example.com"],
  cc: ["cc@example.com"],
  bcc: ["hidden@example.com"],
  subject: "One serialized message",
  bodyText: "Visible body",
  attachments: [],
  references: [],
  warnings: [],
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
};

const config = {
  limits: { maxMessageBytes: 15 * 1024 * 1024 },
} as AppConfig;

describe("SMTP and IMAP Sent-copy MIME reuse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendMail.mockImplementation(async (options: unknown) => ({
      accepted: ["to@example.com", "cc@example.com", "hidden@example.com"],
      rejected: [],
      response: "250 queued",
      messageId: (options as { messageId: string }).messageId,
    }));
  });

  it("sends and appends the same raw MIME while keeping BCC envelope-only", async () => {
    const result = await sendDraft(runtime, draft, config);

    expect(result.status).toBe("accepted");
    expect(result.sentCopy).toBe("saved");
    expect(mocks.sendMail).toHaveBeenCalledOnce();
    expect(mocks.appendSentCopy).toHaveBeenCalledOnce();

    const sendOptions = mocks.sendMail.mock.calls[0]![0] as {
      raw: Buffer;
      envelope: { from: string | false; to: string[] };
      messageId: string;
    };
    const appendedRaw = mocks.appendSentCopy.mock.calls[0]![3] as Buffer;
    const rawText = sendOptions.raw.toString("utf8");

    expect(appendedRaw).toBe(sendOptions.raw);
    expect(sendOptions.envelope).toEqual({
      from: "me@example.com",
      to: ["to@example.com", "cc@example.com", "hidden@example.com"],
    });
    expect(rawText).toContain(`Message-ID: ${sendOptions.messageId}`);
    expect(result.messageId).toBe(sendOptions.messageId);
    expect(rawText).not.toMatch(/^Bcc:/gim);
    expect(rawText).not.toContain("hidden@example.com");
  });

  it("classifies authentication failure as a definite rejection so the draft can be edited", async () => {
    mocks.sendMail.mockRejectedValueOnce(
      Object.assign(new Error("authentication failed"), {
        code: "EAUTH",
        command: "AUTH",
        response: "535 authentication failed",
        responseCode: 535,
      }),
    );

    const result = await sendDraft(runtime, draft, config);

    expect(result.status).toBe("rejected");
    expect(result.detail).toMatch(/definitely not accepted or submitted/i);
    expect(mocks.appendSentCopy).not.toHaveBeenCalled();
  });

  it("keeps Nodemailer's generic CONN close ambiguous to prevent automatic duplicates", async () => {
    mocks.sendMail.mockRejectedValueOnce(
      Object.assign(new Error("socket closed"), {
        code: "ECONNECTION",
        command: "CONN",
      }),
    );

    const result = await sendDraft(runtime, draft, config);

    expect(result.status).toBe("unknown");
    expect(result.detail).toMatch(/do not retry automatically/i);
    expect(mocks.appendSentCopy).not.toHaveBeenCalled();
  });
});
