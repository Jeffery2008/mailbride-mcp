import { describe, expect, it } from "vitest";
import type { AccountConfig } from "../src/config.js";
import { DraftStore, type StoredDraft } from "../src/drafts.js";
import { validateRecipientPolicy } from "../src/service.js";

function account(overrides: Partial<AccountConfig["policy"]> = {}): AccountConfig {
  return {
    id: "restricted",
    displayName: "Restricted Mail",
    email: "me@example.com",
    aliases: [],
    secretRef: "TEST_SECRET",
    imap: { host: "imap.example.com", port: 993, tls: "implicit" },
    smtp: { host: "smtp.example.com", port: 465, tls: "implicit" },
    sentCopyMode: "provider",
    folders: { inbox: "INBOX" },
    policy: {
      allowNewMessages: false,
      allowReply: true,
      allowReplyAll: true,
      allowForward: false,
      allowBcc: true,
      allowAdditionalReplyRecipients: false,
      allowFolderMutations: false,
      allowTrash: false,
      blockNoReplyAddresses: true,
      maxRecipients: 25,
      blockedRecipientDomains: [],
      ...overrides,
    },
    allowedAttachmentRoots: [],
  };
}

function replyDraft(overrides: Partial<StoredDraft> = {}): StoredDraft {
  return {
    id: "draft-1",
    revision: 1,
    mode: "reply",
    accountId: "restricted",
    to: ["sender@example.com"],
    cc: [],
    bcc: [],
    subject: "Re: source",
    bodyText: "Reply",
    attachments: [],
    references: [],
    replyRecipientAllowlist: ["sender@example.com"],
    warnings: [],
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  };
}

describe("reply recipient policy", () => {
  it("accepts only recipients derived from the source message when additions are disabled", () => {
    expect(() => validateRecipientPolicy(account(), replyDraft())).not.toThrow();
    expect(() =>
      validateRecipientPolicy(account(), replyDraft({ cc: ["attacker@example.net"] })),
    ).toThrow(/additional reply recipients are disabled/i);
    expect(() =>
      validateRecipientPolicy(account(), replyDraft({ bcc: ["hidden-attacker@example.net"] })),
    ).toThrow(/additional reply recipients are disabled/i);
  });

  it("fails closed if a restricted reply lacks its source-derived boundary", () => {
    const missingBoundary = replyDraft();
    delete missingBoundary.replyRecipientAllowlist;
    expect(() => validateRecipientPolicy(account(), missingBoundary)).toThrow(/policy metadata is missing/i);
  });

  it("allows explicit additions only when the account opts in", () => {
    expect(() =>
      validateRecipientPolicy(
        account({ allowAdditionalReplyRecipients: true }),
        replyDraft({ cc: ["colleague@example.net"] }),
      ),
    ).not.toThrow();
  });

  it("preserves the internal boundary across draft updates without exposing it in previews", () => {
    const store = new DraftStore(5, 300);
    const input = replyDraft();
    const created = store.create({
      mode: input.mode,
      accountId: input.accountId,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      bodyText: input.bodyText,
      attachments: input.attachments,
      references: input.references,
      ...(input.replyRecipientAllowlist
        ? { replyRecipientAllowlist: input.replyRecipientAllowlist }
        : {}),
      warnings: input.warnings,
    });
    const updated = store.update(created.id, created.revision, (candidate) => {
      candidate.subject = "Re: edited";
    });

    expect(updated.replyRecipientAllowlist).toEqual(["sender@example.com"]);
    expect(store.snapshot(updated)).not.toHaveProperty("replyRecipientAllowlist");
  });
});
