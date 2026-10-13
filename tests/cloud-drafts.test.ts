import { beforeEach, describe, expect, it, vi } from "vitest";
import { simpleParser } from "mailparser";
import type { StoredDraft } from "../src/drafts.js";

const remote = vi.hoisted(() => ({
  messages: new Map<number, { raw: Buffer; messageId: string; flags: Set<string> }>(),
  nextUid: 100,
  uidValidity: 7n,
  uidPlus: true,
  omitAppendUid: false,
  appendError: undefined as Error | undefined,
  saveBeforeError: false,
  deleteError: undefined as Error | undefined,
  beforeAppend: undefined as (() => Promise<void>) | undefined,
  append: vi.fn(),
  delete: vi.fn(),
  sendMail: vi.fn(),
  connections: vi.fn(),
}));

vi.mock("imapflow", () => ({
  ImapFlow: class FakeImapFlow {
    capabilities = new Map(remote.uidPlus ? [["UIDPLUS", true]] : []);
    enabled = new Set<string>();
    mailbox = { uidValidity: remote.uidValidity, exists: remote.messages.size };
    on() { return this; }
    async connect() { remote.connections(); }
    async logout() {}
    close() {}
    async getMailboxLock() { return { release() {} }; }
    async append(mailbox: string, raw: Buffer, flags: string[]) {
      remote.append(mailbox, Buffer.from(raw), flags);
      if (remote.beforeAppend) await remote.beforeAppend();
      if (remote.appendError && !remote.saveBeforeError) throw remote.appendError;
      const uid = remote.nextUid++;
      const messageId = raw.toString("utf8").match(/^Message-ID:\s*(.+)\r?$/im)![1]!.trim();
      remote.messages.set(uid, { raw: Buffer.from(raw), messageId, flags: new Set(flags) });
      this.mailbox.exists = remote.messages.size;
      if (remote.appendError) throw remote.appendError;
      return remote.omitAppendUid ? { destination: mailbox } : { destination: mailbox, uid, uidValidity: this.mailbox.uidValidity };
    }
    async fetchOne(uid: string, query: { source?: boolean }) {
      const message = remote.messages.get(Number(uid));
      if (!message) return false;
      return {
        uid: Number(uid),
        size: message.raw.length,
        flags: new Set(message.flags),
        envelope: { messageId: message.messageId },
        ...(query.source ? { source: Buffer.from(message.raw) } : {}),
      };
    }
    async search(query: { header?: Record<string, string> }) {
      return Array.from(remote.messages.entries())
        .filter(([, message]) => message.messageId === query.header?.["Message-ID"])
        .map(([uid]) => uid);
    }
    async messageDelete(uids: number[], options: unknown) {
      remote.delete(uids, options);
      if (remote.deleteError) throw remote.deleteError;
      for (const uid of uids) remote.messages.delete(uid);
      return true;
    }
  },
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: remote.sendMail, close() {} }) },
}));

import { AccountConfigSchema, AppConfigSchema, type LoadedConfig } from "../src/config.js";
import { syncCloudDraft } from "../src/cloud-drafts.js";
import { MailService } from "../src/service.js";

function loadedConfig(mode: "none" | "imap" = "imap"): LoadedConfig {
  return {
    config: AppConfigSchema.parse({
      version: 1,
      accounts: [{
        id: "test", displayName: "Test Mail", email: "me@example.test", secretRef: "TEST_SECRET",
        imap: { host: "imap.example.test", port: 993, tls: "implicit" },
        smtp: { host: "smtp.example.test", port: 465, tls: "implicit" },
        draftSyncMode: mode, folders: { drafts: "Drafts" },
        policy: { allowNewMessages: true, allowReply: true, allowBcc: true },
      }],
    }),
    credentials: new Map([["TEST_SECRET", { username: "me@example.test", password: "unused-test-secret" }]]),
    paths: { config: "accounts.json", credentials: "credentials.json" },
  };
}

const createRequest = {
  accountId: "test", mode: "new" as const, to: ["to@example.test"],
  cc: ["cc@example.test"], bcc: ["hidden@example.test"], subject: "Cloud draft test", bodyText: "Original body",
};

beforeEach(() => {
  vi.clearAllMocks();
  remote.messages.clear();
  remote.nextUid = 100;
  remote.uidValidity = 7n;
  remote.uidPlus = true;
  remote.omitAppendUid = false;
  remote.appendError = undefined;
  remote.deleteError = undefined;
  remote.beforeAppend = undefined;
  remote.saveBeforeError = false;
  remote.sendMail.mockResolvedValue({ accepted: ["to@example.test"], rejected: [], response: "250 queued", messageId: "<sent@example.test>" });
});

describe("cloud draft lifecycle", () => {
  it("creates a readable cloud Drafts copy, replaces revisions, and discards only its own UID", async () => {
    const service = new MailService(loadedConfig());
    const created = await service.createDraft(createRequest);
    expect(created.cloudDraft.status).toBe("saved");
    expect(created.cloudDraft.revision).toBe(1);
    expect(created.cloudDraft.messageId).toBeTypeOf("string");
    expect(remote.append.mock.calls[0]![2]).toEqual(["\\Draft", "\\Seen"]);
    const parsed = await simpleParser(remote.messages.get(100)!.raw);
    expect(parsed.text?.trim()).toBe("Original body");
    expect(parsed.bcc).toMatchObject({ value: [{ address: "hidden@example.test" }] });

    const preview = await service.previewDraft(created.draftId, 1);
    const updated = await service.updateDraft({ draftId: created.draftId, revision: 1, bodyText: "Edited body" });
    expect(updated.revision).toBe(2);
    expect(updated.cloudDraft.status).toBe("saved");
    expect(updated.cloudDraft.messageId).not.toBe(created.cloudDraft.messageId);
    expect(remote.messages.size).toBe(1);
    expect(remote.delete).toHaveBeenCalledWith([100], { uid: true });
    await expect(service.sendDraft(created.draftId, 2, preview.confirmationToken, "stale-preview", true)).rejects.toThrow(/confirmation token/i);
    const discarded = await service.discardDraft(created.draftId);
    expect(discarded).toMatchObject({ discarded: true, cloudDraft: { status: "removed" } });
    expect(remote.messages.size).toBe(0);
    expect(remote.sendMail).not.toHaveBeenCalled();
  });

  it("leaves synchronization off for existing configs and requires a configured Drafts folder when enabled", async () => {
    const service = new MailService(loadedConfig("none"));
    expect((await service.createDraft(createRequest)).cloudDraft.status).toBe("disabled");
    expect(remote.connections).not.toHaveBeenCalled();
    const account = loadedConfig().config.accounts[0]!;
    expect(AccountConfigSchema.parse({ ...account, draftSyncMode: undefined }).draftSyncMode).toBe("none");
    expect(() => AccountConfigSchema.parse({ ...account, folders: { inbox: "INBOX" } })).toThrow(/required for IMAP draft sync/i);
  });

  it("preserves a local draft after explicit APPEND rejection and retries the same draftId", async () => {
    remote.appendError = Object.assign(new Error("do not expose protocol or passwords"), { responseStatus: "NO" });
    const service = new MailService(loadedConfig());
    const created = await service.createDraft(createRequest);
    expect(created.cloudDraft.status).toBe("not_saved");
    expect(created.cloudDraft.detail).toContain("IMAP NO");
    expect(created.cloudDraft.detail).not.toContain("passwords");
    expect((await service.previewDraft(created.draftId, 1)).snapshot.bodyText).toBe("Original body");
    remote.appendError = undefined;
    const saved = await service.syncDraft(created.draftId, 1);
    expect(saved.cloudDraft.status).toBe("saved");
    expect(saved.revision).toBe(1);
    expect(remote.messages.size).toBe(1);
  });

  it("reconciles a timed-out APPEND that succeeded without creating another copy", async () => {
    remote.appendError = Object.assign(new Error("socket closed"), { code: "ECONNECTION" });
    remote.saveBeforeError = true;
    const service = new MailService(loadedConfig());
    const created = await service.createDraft(createRequest);
    expect(created.cloudDraft.status).toBe("unknown");
    expect(remote.messages.size).toBe(1);
    remote.appendError = undefined;
    const reconciled = await service.syncDraft(created.draftId, 1);
    expect(reconciled.cloudDraft.status).toBe("saved");
    expect(remote.append).toHaveBeenCalledOnce();
    expect(remote.messages.size).toBe(1);
  });

  it("does not retry an ambiguous APPEND when no matching cloud copy can be found", async () => {
    remote.appendError = Object.assign(new Error("socket closed"), { code: "ECONNECTION" });
    const service = new MailService(loadedConfig());
    const created = await service.createDraft(createRequest);
    remote.appendError = undefined;
    expect((await service.syncDraft(created.draftId, 1)).cloudDraft.status).toBe("unknown");
    expect(remote.append).toHaveBeenCalledOnce();
    expect(await service.discardDraft(created.draftId)).toMatchObject({ discarded: false });
    expect((await service.previewDraft(created.draftId, 1)).snapshot.bodyText).toBe("Original body");
  });

  it("does not adopt an ambiguous APPEND after Drafts UIDVALIDITY changes", async () => {
    remote.appendError = Object.assign(new Error("socket closed"), { code: "ECONNECTION" });
    remote.saveBeforeError = true;
    const service = new MailService(loadedConfig());
    const created = await service.createDraft(createRequest);
    remote.appendError = undefined;
    remote.uidValidity = 8n;
    expect((await service.syncDraft(created.draftId, 1)).cloudDraft.status).toBe("conflict");
    expect(remote.append).toHaveBeenCalledOnce();
    expect(remote.delete).not.toHaveBeenCalled();
  });

  it("can discard a definitely unsaved local draft without another IMAP connection", async () => {
    remote.appendError = Object.assign(new Error("rejected"), { responseStatus: "NO" });
    const service = new MailService(loadedConfig());
    const created = await service.createDraft(createRequest);
    expect(created.cloudDraft.status).toBe("not_saved");
    expect((await service.discardDraft(created.draftId)).discarded).toBe(true);
    expect(remote.connections).toHaveBeenCalledOnce();
    expect(remote.delete).not.toHaveBeenCalled();
  });

  it("uses exact Message-ID lookup when the provider omits APPENDUID", async () => {
    remote.omitAppendUid = true;
    const created = await new MailService(loadedConfig()).createDraft(createRequest);
    expect(created.cloudDraft.status).toBe("saved");
    expect(created.cloudDraft.messageId).toBeTypeOf("string");
  });

  it("refuses replacement and cleanup without UIDPLUS instead of expunging unrelated messages", async () => {
    remote.uidPlus = false;
    const service = new MailService(loadedConfig());
    const created = await service.createDraft(createRequest);
    const updated = await service.updateDraft({ draftId: created.draftId, revision: 1, bodyText: "Changed" });
    expect(updated.cloudDraft.status).toBe("not_saved");
    expect(updated.cloudDraft.detail).toMatch(/UIDPLUS/);
    expect(remote.append).toHaveBeenCalledOnce();
    expect((await service.discardDraft(created.draftId)).discarded).toBe(false);
    expect(remote.delete).not.toHaveBeenCalled();
  });

  it("preserves externally edited cloud drafts and blocks overwrite, discard, and local send", async () => {
    const service = new MailService(loadedConfig());
    const created = await service.createDraft(createRequest);
    remote.messages.get(100)!.raw = Buffer.concat([remote.messages.get(100)!.raw, Buffer.from("User edit")]);
    const updated = await service.updateDraft({ draftId: created.draftId, revision: 1, bodyText: "Agent edit" });
    expect(updated.cloudDraft.status).toBe("conflict");
    expect(remote.append).toHaveBeenCalledOnce();
    expect((await service.discardDraft(created.draftId)).discarded).toBe(false);
    const preview = await service.previewDraft(created.draftId, 2);
    await expect(service.sendDraft(created.draftId, 2, preview.confirmationToken, "conflict-send", true)).rejects.toThrow(/edited in another client/i);
    expect(remote.delete).not.toHaveBeenCalled();
    expect(remote.sendMail).not.toHaveBeenCalled();
  });

  it("rejects stale UIDVALIDITY without modifying the rebuilt folder", async () => {
    const service = new MailService(loadedConfig());
    const created = await service.createDraft(createRequest);
    remote.uidValidity = 8n;
    const updated = await service.updateDraft({ draftId: created.draftId, revision: 1, bodyText: "Changed" });
    expect(updated.cloudDraft.status).toBe("conflict");
    expect(remote.append).toHaveBeenCalledOnce();
    expect(remote.delete).not.toHaveBeenCalled();
  });

  it("keeps both references after partial cleanup and retries cleanup without appending a third version", async () => {
    const service = new MailService(loadedConfig());
    const created = await service.createDraft(createRequest);
    remote.deleteError = Object.assign(new Error("cleanup failed"), { responseStatus: "NO" });
    const updated = await service.updateDraft({ draftId: created.draftId, revision: 1, bodyText: "Changed" });
    expect(updated.cloudDraft).toMatchObject({ status: "partial", revision: 2, cleanupPending: true });
    expect(remote.messages.size).toBe(2);
    remote.deleteError = undefined;
    const synced = await service.syncDraft(created.draftId, 2);
    expect(synced.cloudDraft).toMatchObject({ status: "saved", cleanupPending: false });
    expect(remote.messages.size).toBe(1);
    expect(remote.append).toHaveBeenCalledTimes(2);
  });

  it("serializes concurrent updates and waits for synchronization before previewing", async () => {
    const service = new MailService(loadedConfig());
    const created = await service.createDraft(createRequest);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    remote.beforeAppend = () => { entered(); return gate; };
    const first = service.updateDraft({ draftId: created.draftId, revision: 1, bodyText: "First edit" });
    await started;
    const second = service.updateDraft({ draftId: created.draftId, revision: 1, bodyText: "Stale edit" });
    const preview = service.previewDraft(created.draftId, 2);
    release();
    expect((await first).cloudDraft.status).toBe("saved");
    await expect(second).rejects.toThrow(/revision conflict/i);
    expect((await preview).snapshot.bodyText).toBe("First edit");
    expect(remote.messages.size).toBe(1);
    expect(remote.append).toHaveBeenCalledTimes(2);
  });

  it("queues separate MCP draft calls on the same account rather than opening parallel IMAP connections", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    remote.beforeAppend = () => { entered(); return gate; };
    const service = new MailService(loadedConfig());
    const first = service.createDraft(createRequest);
    await started;
    const second = service.createDraft({ ...createRequest, subject: "Second draft" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(remote.connections).toHaveBeenCalledOnce();
    release();
    expect((await first).cloudDraft.status).toBe("saved");
    expect((await second).cloudDraft.status).toBe("saved");
    expect(remote.connections).toHaveBeenCalledTimes(2);
    expect(remote.messages.size).toBe(2);
  });

  it("does not recreate a cloud draft marked for deletion by another client", async () => {
    const service = new MailService(loadedConfig());
    const created = await service.createDraft(createRequest);
    remote.messages.get(100)!.flags.add("\\Deleted");
    const updated = await service.updateDraft({ draftId: created.draftId, revision: 1, bodyText: "Agent edit" });
    expect(updated.cloudDraft.status).toBe("conflict");
    expect(remote.append).toHaveBeenCalledOnce();
    expect((await service.discardDraft(created.draftId)).discarded).toBe(true);
  });

  it("cleans up after accepted SMTP delivery and never leaks BCC into the sent MIME", async () => {
    const service = new MailService(loadedConfig());
    const created = await service.createDraft(createRequest);
    const preview = await service.previewDraft(created.draftId, 1);
    const result = await service.sendDraft(created.draftId, 1, preview.confirmationToken, "accepted-key", true);
    expect(result).toMatchObject({ status: "accepted", cloudDraft: { status: "removed" } });
    expect(remote.messages.size).toBe(0);
    const raw = remote.sendMail.mock.calls[0]![0].raw.toString("utf8");
    expect(raw).not.toMatch(/^Bcc:/im);
    expect(raw).not.toContain("hidden@example.test");
    const replay = await service.sendDraft(created.draftId, 1, preview.confirmationToken, "accepted-key", true);
    expect(replay.status).toBe("accepted");
    expect(remote.sendMail).toHaveBeenCalledOnce();
  });

  it("reports post-send cleanup failure without reversing delivery and allows a cleanup-only retry", async () => {
    const service = new MailService(loadedConfig());
    const created = await service.createDraft(createRequest);
    const preview = await service.previewDraft(created.draftId, 1);
    remote.deleteError = Object.assign(new Error("cleanup failed"), { responseStatus: "NO" });
    const sent = await service.sendDraft(created.draftId, 1, preview.confirmationToken, "cleanup-key", true);
    expect(sent.status).toBe("accepted");
    expect(sent.cloudDraft?.status).toBe("not_saved");
    remote.deleteError = undefined;
    expect((await service.syncDraft(created.draftId, 1)).cloudDraft.status).toBe("removed");
    expect(remote.messages.size).toBe(0);
    expect(remote.sendMail).toHaveBeenCalledOnce();
  });

  it.each(["partial", "unknown"])("retains the cloud copy after %s SMTP delivery", async (status) => {
    if (status === "partial") remote.sendMail.mockResolvedValueOnce({ accepted: ["to@example.test"], rejected: ["cc@example.test"], messageId: "<partial@example.test>" });
    else remote.sendMail.mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "ECONNECTION" }));
    const service = new MailService(loadedConfig());
    const created = await service.createDraft(createRequest);
    const preview = await service.previewDraft(created.draftId, 1);
    const sent = await service.sendDraft(created.draftId, 1, preview.confirmationToken, `outcome-${status}`, true);
    expect(sent).toMatchObject({ status, cloudDraft: { status: "retained" } });
    expect(remote.messages.size).toBe(1);
    expect(remote.delete).not.toHaveBeenCalled();
    await expect(service.syncDraft(created.draftId, 1)).rejects.toThrow(/verify delivery/i);
  });

  it("retains the editable cloud copy after definite SMTP rejection", async () => {
    remote.sendMail.mockRejectedValueOnce(Object.assign(new Error("bad auth"), { code: "EAUTH" }));
    const service = new MailService(loadedConfig());
    const created = await service.createDraft(createRequest);
    const preview = await service.previewDraft(created.draftId, 1);
    expect((await service.sendDraft(created.draftId, 1, preview.confirmationToken, "rejection-key", true)).status).toBe("rejected");
    expect(remote.messages.size).toBe(1);
    expect((await service.updateDraft({ draftId: created.draftId, revision: 1, bodyText: "Retry later" })).cloudDraft.status).toBe("saved");
  });

  it("preserves HTML, attachments, BCC, and threading in a private cloud MIME copy", async () => {
    const loaded = loadedConfig();
    const draft: StoredDraft = {
      id: "44444444-4444-4444-8444-444444444444", revision: 1, mode: "reply", accountId: "test",
      to: ["to@example.test"], cc: ["cc@example.test"], bcc: ["hidden@example.test"],
      subject: "Re: Source", bodyText: "Reply", bodyHtml: "<p>Reply</p>",
      attachments: [{ filename: "notes.txt", contentType: "text/plain", content: Buffer.from("Attachment content") }],
      inReplyTo: "<source@example.test>", references: ["<source@example.test>"], warnings: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await syncCloudDraft({ account: loaded.config.accounts[0]!, secret: loaded.credentials.get("TEST_SECRET")! }, loaded.config, draft);
    expect(draft.cloudDraft?.status).toBe("saved");
    const parsed = await simpleParser(remote.messages.get(100)!.raw);
    expect(parsed.html).toBe("<p>Reply</p>");
    expect(parsed.inReplyTo).toBe("<source@example.test>");
    expect(parsed.references).toContain("<source@example.test>");
    expect(parsed.attachments[0]!.content.toString()).toBe("Attachment content");
    expect(parsed.bcc).toMatchObject({ value: [{ address: "hidden@example.test" }] });
    expect(draft.attachments[0]!.content.toString()).toBe("Attachment content");
  });

  it("bounds composed MIME before APPEND without raising memory limits", async () => {
    const loaded = loadedConfig();
    loaded.config.limits.maxMessageBytes = 1024;
    const service = new MailService(loaded);
    const created = await service.createDraft({ ...createRequest, bodyText: "x".repeat(2048) });
    expect(created.cloudDraft.status).toBe("not_saved");
    expect(created.cloudDraft.detail).toContain("maxMessageBytes");
    expect(remote.append).not.toHaveBeenCalled();
    expect((await service.previewDraft(created.draftId, 1)).snapshot.bodyText).toHaveLength(2048);
  });
});
