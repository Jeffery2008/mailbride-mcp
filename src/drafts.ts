import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SendResult } from "./smtp.js";
import { messageDigest } from "./mail/parse.js";

export type DraftMode = "new" | "reply" | "reply_all" | "forward";

export interface DraftAttachment {
  filename: string;
  contentType?: string;
  content: Buffer;
}

export interface StoredDraft {
  id: string;
  revision: number;
  mode: DraftMode;
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  attachments: DraftAttachment[];
  inReplyTo?: string;
  references: string[];
  sourceMessageId?: string;
  /**
   * The recipients derived from the source message for reply/reply-all.
   * This is internal policy state and is intentionally omitted from previews.
   */
  replyRecipientAllowlist?: string[];
  warnings: string[];
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  sentDigest?: string;
  preview?: {
    token: string;
    digest: string;
    expiresAt: number;
  };
}

export interface DraftSnapshot {
  draftId: string;
  revision: number;
  mode: DraftMode;
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  attachments: Array<{ filename: string; contentType?: string; size: number; sha256: string }>;
  inReplyTo?: string;
  references: string[];
}

interface IdempotencyRecord {
  draftId: string;
  digest: string;
  result: SendResult;
}

export class DraftStore {
  readonly #drafts = new Map<string, StoredDraft>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();

  constructor(
    readonly maxDrafts: number,
    readonly ttlSeconds: number,
  ) {}

  create(input: Omit<StoredDraft, "id" | "revision" | "createdAt" | "updatedAt" | "preview">): StoredDraft {
    this.cleanup();
    const activeDrafts = Array.from(this.#drafts.values()).filter((draft) => !draft.sentAt).length;
    if (activeDrafts >= this.maxDrafts) {
      throw new Error(`prepared draft limit (${this.maxDrafts}) reached; discard or send an older draft`);
    }
    const now = new Date().toISOString();
    const draft: StoredDraft = {
      ...input,
      id: randomUUID(),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.#drafts.set(draft.id, draft);
    return draft;
  }

  get(id: string): StoredDraft {
    this.cleanup();
    const draft = this.#drafts.get(id);
    if (!draft) throw new Error("draft was not found or expired");
    return draft;
  }

  update(
    id: string,
    expectedRevision: number,
    apply: (draft: StoredDraft) => void,
  ): StoredDraft {
    const draft = this.get(id);
    if (draft.sentAt) throw new Error("sent drafts cannot be changed");
    if (draft.revision !== expectedRevision) {
      throw new Error(`draft revision conflict: expected ${expectedRevision}, current is ${draft.revision}`);
    }
    const candidate: StoredDraft = {
      ...draft,
      to: [...draft.to],
      cc: [...draft.cc],
      bcc: [...draft.bcc],
      attachments: draft.attachments.map((attachment) => ({
        ...attachment,
        content: Buffer.from(attachment.content),
      })),
      references: [...draft.references],
      ...(draft.replyRecipientAllowlist
        ? { replyRecipientAllowlist: [...draft.replyRecipientAllowlist] }
        : {}),
      warnings: [...draft.warnings],
      ...(draft.preview ? { preview: { ...draft.preview } } : {}),
    };
    const copiedAttachments = candidate.attachments;
    try {
      apply(candidate);
    } catch (error) {
      for (const attachment of copiedAttachments) attachment.content.fill(0);
      if (candidate.attachments !== copiedAttachments) {
        for (const attachment of candidate.attachments) attachment.content.fill(0);
      }
      throw error;
    }
    if (candidate.attachments !== copiedAttachments) {
      for (const attachment of copiedAttachments) attachment.content.fill(0);
    }
    candidate.revision += 1;
    candidate.updatedAt = new Date().toISOString();
    delete candidate.preview;
    for (const attachment of draft.attachments) attachment.content.fill(0);
    this.#drafts.set(id, candidate);
    return candidate;
  }

  discard(id: string): boolean {
    const draft = this.#drafts.get(id);
    if (draft?.sentAt) throw new Error("sent drafts cannot be discarded from the audit window");
    if (draft) this.wipeDraftContent(draft);
    return this.#drafts.delete(id);
  }

  snapshot(draft: StoredDraft): DraftSnapshot {
    const snapshot: DraftSnapshot = {
      draftId: draft.id,
      revision: draft.revision,
      mode: draft.mode,
      accountId: draft.accountId,
      to: [...draft.to],
      cc: [...draft.cc],
      bcc: [...draft.bcc],
      subject: draft.subject,
      bodyText: draft.bodyText,
      attachments: draft.attachments.map((attachment) => {
        const result: { filename: string; contentType?: string; size: number; sha256: string } = {
          filename: attachment.filename,
          size: attachment.content.length,
          sha256: createHash("sha256").update(attachment.content).digest("hex"),
        };
        if (attachment.contentType) result.contentType = attachment.contentType;
        return result;
      }),
      references: [...draft.references],
    };
    if (draft.bodyHtml) snapshot.bodyHtml = draft.bodyHtml;
    if (draft.inReplyTo) snapshot.inReplyTo = draft.inReplyTo;
    return snapshot;
  }

  preview(id: string, expectedRevision: number): {
    snapshot: DraftSnapshot;
    digest: string;
    confirmationToken: string;
    expiresAt: string;
  } {
    const draft = this.get(id);
    if (draft.sentAt) throw new Error("draft has already been sent");
    if (draft.revision !== expectedRevision) {
      throw new Error(`draft revision conflict: expected ${expectedRevision}, current is ${draft.revision}`);
    }
    const snapshot = this.snapshot(draft);
    const digest = messageDigest(snapshot);
    const expiresAt = Date.now() + this.ttlSeconds * 1000;
    const token = randomBytes(32).toString("base64url");
    draft.preview = { token, digest, expiresAt };
    return {
      snapshot,
      digest,
      confirmationToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  authorizeSend(
    id: string,
    revision: number,
    confirmationToken: string,
    idempotencyKey: string,
  ): { draft: StoredDraft; digest: string; prior?: SendResult } {
    const draft = this.get(id);
    if (draft.revision !== revision) {
      throw new Error(`draft revision conflict: expected ${revision}, current is ${draft.revision}`);
    }
    const prior = this.#idempotency.get(idempotencyKey);
    if (prior) {
      const currentDigest = draft.sentAt ? draft.sentDigest : messageDigest(this.snapshot(draft));
      if (prior.draftId !== id || prior.digest !== currentDigest) {
        throw new Error("idempotency key was already used for a different message");
      }
      return { draft, digest: prior.digest, prior: prior.result };
    }
    if (draft.sentAt) throw new Error("draft has already been sent");
    const snapshot = this.snapshot(draft);
    const digest = messageDigest(snapshot);
    if (!draft.preview || draft.preview.token !== confirmationToken) {
      throw new Error("confirmation token is invalid; preview the current draft again");
    }
    if (draft.preview.expiresAt < Date.now()) {
      delete draft.preview;
      throw new Error("confirmation token expired; preview the draft again");
    }
    if (draft.preview.digest !== digest) {
      delete draft.preview;
      throw new Error("draft changed after preview; preview it again before sending");
    }
    delete draft.preview;
    return { draft, digest };
  }

  recordSend(idempotencyKey: string, draft: StoredDraft, digest: string, result: SendResult): void {
    this.recordAttempt(idempotencyKey, draft, digest, result);
    draft.sentAt = new Date().toISOString();
    draft.updatedAt = draft.sentAt;
    draft.sentDigest = digest;
    this.wipeDraftContent(draft);
  }

  recordAttempt(idempotencyKey: string, draft: StoredDraft, digest: string, result: SendResult): void {
    this.#idempotency.set(idempotencyKey, { draftId: draft.id, digest, result });
    draft.updatedAt = new Date().toISOString();
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.ttlSeconds * 4 * 1000;
    for (const [id, draft] of this.#drafts) {
      const time = Date.parse(draft.updatedAt);
      if (time < cutoff) {
        this.wipeDraftContent(draft);
        this.#drafts.delete(id);
      }
    }
    if (this.#idempotency.size > 1000) {
      const overflow = this.#idempotency.size - 1000;
      for (const key of Array.from(this.#idempotency.keys()).slice(0, overflow)) {
        this.#idempotency.delete(key);
      }
    }
  }

  private wipeDraftContent(draft: StoredDraft): void {
    for (const attachment of draft.attachments) attachment.content.fill(0);
    draft.attachments = [];
    draft.bodyText = "";
    delete draft.bodyHtml;
    draft.to = [];
    draft.cc = [];
    draft.bcc = [];
    draft.references = [];
    delete draft.replyRecipientAllowlist;
    draft.warnings = [];
  }
}
