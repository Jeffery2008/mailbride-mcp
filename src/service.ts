import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { AccountConfig, LoadedConfig } from "./config.js";
import { DraftStore, type DraftAttachment, type DraftMode, type StoredDraft } from "./drafts.js";
import {
  copyMessage as copyMessageImap,
  fetchAttachmentSource,
  fetchParsedMessage,
  listFolders,
  manageFolder as manageFolderImap,
  moveMessage as moveMessageImap,
  permanentlyDeleteMessage,
  scanContacts,
  searchMailbox,
  searchThreadMailbox,
  structureHasAttachments,
  updateFlags,
  type AccountRuntime,
  type FolderInfo,
  type RawSearchResult,
} from "./imap.js";
import { EXTERNAL_CONTENT_WARNING, formatFetchedMessage, messageDigest } from "./mail/parse.js";
import type {
  ContactRecord,
  FolderLocator,
  MailSearchFilters,
  MailSummary,
  MessageLocator,
  ParsedMessage,
} from "./mail/types.js";
import {
  addressDomain,
  assertEmailAddress,
  isNoReplyAddress,
  maskEmail,
  normalizeAddress,
  uniqueAddresses,
} from "./security/addresses.js";
import { OpaqueTokenCodec } from "./security/tokens.js";
import { sendDraft, type SendResult } from "./smtp.js";

export interface SearchRequest extends MailSearchFilters {
  accountId?: string;
  mailboxId?: string;
  folderScope?: "inbox" | "all";
  includeTrash?: boolean;
  includeJunk?: boolean;
  limit?: number;
  cursor?: string;
}

export interface ContactSearchRequest {
  query: string;
  accountId?: string;
  limit?: number;
}

export interface LocalAttachmentInput {
  path: string;
  filename?: string;
  contentType?: string;
}

export interface CreateDraftRequest {
  accountId: string;
  mode: DraftMode;
  sourceMessageId?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  bodyText: string;
  bodyHtml?: string;
  quoteOriginal?: boolean;
  includeOriginalAttachments?: boolean;
  attachments?: LocalAttachmentInput[];
}

export interface UpdateDraftRequest {
  draftId: string;
  revision: number;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  bodyText?: string;
  bodyHtml?: string | null;
  attachments?: LocalAttachmentInput[];
}

interface CachedContacts {
  expiresAt: number;
  values: ContactRecord[];
  errors: Array<{ mailbox: string; error: string }>;
}

interface SearchCursor {
  fingerprint: string;
  offset: number;
}

interface SearchMailboxBatch {
  items: MailSummary[];
  hasMore: boolean;
  canAdvance: boolean;
  candidateLimitReached: boolean;
  errors: Array<{ accountId: string; mailbox?: string; error: string }>;
}

interface ThreadMailboxBatch {
  items: RawSearchResult[];
  hasMore: boolean;
  errors: Array<{ mailbox: string; error: string }>;
}

/**
 * Run independent mailbox work with a bounded number of live IMAP clients.
 * Results retain input order so error/result ordering is deterministic even
 * though the underlying network operations complete at different times.
 */
async function mapConcurrentOrdered<T, R>(
  values: readonly T[],
  requestedConcurrency: number | undefined,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];
  const normalized = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.floor(requestedConcurrency as number))
    : 4;
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(normalized, values.length) }, () => worker()),
  );
  return results;
}

function asMessageAddress(values: Array<{ name?: string; address?: string }> | undefined) {
  return (values || []).flatMap((entry) => {
    if (!entry.address) return [];
    const result: { name?: string; address: string } = { address: entry.address };
    if (entry.name) result.name = entry.name;
    return [result];
  });
}

function addPrefix(subject: string, prefix: "Re" | "Fwd"): string {
  const trimmed = subject.trim() || "(no subject)";
  const pattern = prefix === "Re" ? /^\s*re\s*:/i : /^\s*(?:fwd?|转发)\s*:/i;
  return pattern.test(trimmed) ? trimmed : `${prefix}: ${trimmed}`;
}

function quoteText(value: string): string {
  return value
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function attachmentSummary(attachment: DraftAttachment) {
  const result: { filename: string; contentType?: string; size: number } = {
    filename: attachment.filename,
    size: attachment.content.length,
  };
  if (attachment.contentType) result.contentType = attachment.contentType;
  return result;
}

function isPathInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Read at most maxBytes + 1 bytes so a file that grows after stat() cannot
 * cause an unbounded attachment allocation. */
async function readFileBounded(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  const chunks: Buffer[] = [];
  let total = 0;
  let result: Buffer | undefined;
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("attachment is no longer a regular file");
    while (total <= maxBytes) {
      const remaining = maxBytes + 1 - total;
      const chunk = Buffer.alloc(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > maxBytes) break;
    }
    result = Buffer.concat(chunks, total);
    for (const chunk of chunks) chunk.fill(0);
    return result;
  } finally {
    if (!result) {
      for (const chunk of chunks) chunk.fill(0);
    }
    try {
      await handle.close();
    } catch {
      // Preserve the original read/open error, if any.
    }
  }
}

function isTrashFolder(account: AccountConfig, folder: FolderInfo): boolean {
  return (
    folder.specialUse?.toLowerCase() === "\\trash" ||
    (account.folders.trash !== undefined && folder.path === account.folders.trash)
  );
}

function isJunkFolder(folder: FolderInfo): boolean {
  const specialUse = folder.specialUse?.toLowerCase();
  return specialUse === "\\junk" || specialUse === "\\spam";
}

function sameMailboxPath(left: string, right: string): boolean {
  if (left.toUpperCase() === "INBOX" && right.toUpperCase() === "INBOX") return true;
  return left === right;
}

type RecipientPolicyDraft = Pick<
  StoredDraft,
  "to" | "cc" | "bcc" | "mode" | "replyRecipientAllowlist"
>;

/**
 * Enforce account send policy against the current draft contents. This must be
 * called at every mutation and send boundary, not only when a reply is first
 * created, because an agent may edit recipients after creation.
 */
export function validateRecipientPolicy(account: AccountConfig, draft: RecipientPolicyDraft): void {
  if (draft.mode === "new" && !account.policy.allowNewMessages) throw new Error("new messages are disabled for this account");
  if (draft.mode === "reply" && !account.policy.allowReply) throw new Error("reply is disabled for this account");
  if (draft.mode === "reply_all" && !account.policy.allowReplyAll) throw new Error("reply all is disabled for this account");
  if (draft.mode === "forward" && !account.policy.allowForward) throw new Error("forward is disabled for this account");
  if (draft.bcc.length && !account.policy.allowBcc) throw new Error("BCC is disabled for this account");
  const recipients = uniqueAddresses([...draft.to, ...draft.cc, ...draft.bcc]);
  if (recipients.length === 0) throw new Error("at least one To, CC, or BCC recipient is required");
  if (recipients.length > account.policy.maxRecipients) {
    throw new Error(`recipient count ${recipients.length} exceeds the account limit ${account.policy.maxRecipients}`);
  }
  if (
    (draft.mode === "reply" || draft.mode === "reply_all") &&
    !account.policy.allowAdditionalReplyRecipients
  ) {
    if (!draft.replyRecipientAllowlist) {
      throw new Error("reply recipient policy metadata is missing; discard and recreate this draft");
    }
    const allowed = new Set(draft.replyRecipientAllowlist.map(normalizeAddress));
    const additions = recipients.filter((recipient) => !allowed.has(normalizeAddress(recipient)));
    if (additions.length) {
      throw new Error(
        "additional reply recipients are disabled for this account; discard the added recipients or use a new message",
      );
    }
  }
  const allowed = account.policy.allowedRecipientDomains?.map((value) => value.toLowerCase());
  const blocked = new Set(account.policy.blockedRecipientDomains.map((value) => value.toLowerCase()));
  for (const recipient of recipients) {
    const domain = addressDomain(recipient);
    if (blocked.has(domain)) throw new Error(`recipient domain is blocked by account policy: ${domain}`);
    if (allowed?.length && !allowed.includes(domain)) {
      throw new Error(`recipient domain is not in the account allowlist: ${domain}`);
    }
    if (account.policy.blockNoReplyAddresses && isNoReplyAddress(recipient)) {
      throw new Error(`recipient is a no-reply address blocked by account policy: ${recipient}`);
    }
  }
}

export class MailService {
  readonly #config: LoadedConfig;
  readonly #accounts = new Map<string, AccountRuntime>();
  readonly #tokens = new OpaqueTokenCodec();
  readonly #drafts: DraftStore;
  readonly #contactCache = new Map<string, CachedContacts>();

  constructor(config: LoadedConfig) {
    this.#config = config;
    for (const account of config.config.accounts) {
      const secret = config.credentials.get(account.secretRef);
      if (!secret) throw new Error(`missing runtime secret for account ${account.id}`);
      this.#accounts.set(account.id.toLowerCase(), { account, secret });
    }
    this.#drafts = new DraftStore(
      config.config.limits.maxPreparedDrafts,
      config.config.limits.draftTtlSeconds,
    );
  }

  private account(id: string): AccountRuntime {
    const account = this.#accounts.get(id.toLowerCase());
    if (!account) throw new Error(`unknown account id: ${id}`);
    return account;
  }

  private accounts(accountId?: string): AccountRuntime[] {
    return accountId ? [this.account(accountId)] : Array.from(this.#accounts.values());
  }

  private issueMessageId(runtime: AccountRuntime, result: RawSearchResult): string {
    return this.#tokens.issue<MessageLocator>("message", {
      accountId: runtime.account.id,
      mailbox: result.mailbox,
      uidValidity: result.uidValidity.toString(),
      uid: result.message.uid,
    });
  }

  private messageLocator(id: string): { runtime: AccountRuntime; locator: MessageLocator } {
    const locator = this.#tokens.read<MessageLocator>("message", id);
    if (!Number.isInteger(locator.uid) || locator.uid < 1) throw new Error("invalid message reference");
    return { runtime: this.account(locator.accountId), locator };
  }

  private folderLocator(id: string): { runtime: AccountRuntime; locator: FolderLocator } {
    const locator = this.#tokens.read<FolderLocator>("folder", id);
    return { runtime: this.account(locator.accountId), locator };
  }

  listAccounts() {
    return Array.from(this.#accounts.values()).map(({ account }) => ({
      id: account.id,
      displayName: account.displayName,
      address: maskEmail(account.email),
      aliases: account.aliases.map(maskEmail),
      capabilities: {
        search: true,
        contacts: true,
        newMessages: account.policy.allowNewMessages,
        reply: account.policy.allowReply,
        replyAll: account.policy.allowReplyAll,
        forward: account.policy.allowForward,
        bcc: account.policy.allowBcc,
        messageManagement: account.policy.allowFolderMutations,
      },
    }));
  }

  async listMailboxes(accountId: string) {
    const runtime = this.account(accountId);
    const folders = await listFolders(runtime, this.#config.config);
    return folders.map((folder) => ({
      id: this.#tokens.issue<FolderLocator>("folder", {
        accountId: runtime.account.id,
        mailbox: folder.path,
      }),
      name: folder.name,
      path: folder.path,
      specialUse: folder.specialUse,
      selectable: folder.selectable,
      subscribed: folder.subscribed,
      messages: folder.messages,
      unseen: folder.unseen,
    }));
  }

  private async targetMailboxes(runtime: AccountRuntime, request: SearchRequest): Promise<string[]> {
    if (request.mailboxId) {
      const folder = this.folderLocator(request.mailboxId);
      if (folder.runtime.account.id !== runtime.account.id) {
        throw new Error("mailbox reference belongs to a different account");
      }
      const current = (await listFolders(runtime, this.#config.config)).find(
        (candidate) => candidate.path === folder.locator.mailbox,
      );
      if (!current) throw new Error("mailbox reference is stale because the folder no longer exists");
      if (!current.selectable) throw new Error("mailbox is not selectable");
      if (!request.includeTrash && isTrashFolder(runtime.account, current)) {
        throw new Error("Trash is excluded by default; set includeTrash to true to search it explicitly");
      }
      if (!request.includeJunk && isJunkFolder(current)) {
        throw new Error("Junk is excluded by default; set includeJunk to true to search it explicitly");
      }
      return [current.path];
    }
    if (request.folderScope !== "all") return [runtime.account.folders.inbox];
    const folders = await listFolders(runtime, this.#config.config);
    return folders
      .filter((folder) => folder.selectable)
      .filter((folder) => request.includeTrash || !isTrashFolder(runtime.account, folder))
      .filter((folder) => request.includeJunk || !isJunkFolder(folder))
      .map((folder) => folder.path);
  }

  private summary(runtime: AccountRuntime, result: RawSearchResult): MailSummary {
    const envelope = result.message.envelope;
    const id = this.issueMessageId(runtime, result);
    const item: MailSummary = {
      id,
      accountId: runtime.account.id,
      accountName: runtime.account.displayName,
      mailboxName: result.mailbox,
      uid: result.message.uid,
      subject: envelope?.subject || "(no subject)",
      from: asMessageAddress(envelope?.from),
      to: asMessageAddress(envelope?.to),
      cc: asMessageAddress(envelope?.cc),
      flags: Array.from(result.message.flags || []),
      unread: !result.message.flags?.has("\\Seen"),
      flagged: result.message.flags?.has("\\Flagged") === true,
      hasAttachments: structureHasAttachments(result.message.bodyStructure),
      url: `mail://mailbride-mcp/${encodeURIComponent(runtime.account.id)}/${encodeURIComponent(id)}`,
    };
    const date = envelope?.date || result.message.internalDate;
    if (date) item.date = new Date(date).toISOString();
    if (result.message.size !== undefined) item.size = result.message.size;
    return item;
  }

  async search(request: SearchRequest) {
    const limit = Math.min(
      Math.max(request.limit || 20, 1),
      this.#config.config.limits.maxSearchResults,
    );
    const fingerprintInput = { ...request, cursor: undefined, limit: undefined };
    const fingerprint = messageDigest(fingerprintInput);
    let offset = 0;
    if (request.cursor) {
      const cursor = this.#tokens.read<SearchCursor>("cursor", request.cursor);
      if (cursor.fingerprint !== fingerprint) throw new Error("cursor does not match this search");
      offset = cursor.offset;
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > this.#config.config.limits.maxSearchOffset
      ) {
        throw new Error("invalid or out-of-range cursor");
      }
    }

    const filters: MailSearchFilters = {};
    for (const key of [
      "query",
      "from",
      "to",
      "cc",
      "bcc",
      "body",
      "subject",
      "text",
      "unread",
      "flagged",
      "answered",
      "draft",
      "deleted",
      "after",
      "before",
      "hasAttachments",
      "minSize",
      "maxSize",
    ] as const) {
      const value = request[key];
      if (value !== undefined) Object.assign(filters, { [key]: value });
    }

    const errors: Array<{ accountId: string; mailbox?: string; error: string }> = [];
    const batches = await mapConcurrentOrdered(
      this.accounts(request.accountId),
      this.#config.config.limits.maxConcurrentConnections,
      async (runtime): Promise<SearchMailboxBatch> => {
        let mailboxes: string[];
        try {
          mailboxes = await this.targetMailboxes(runtime, request);
        } catch (error) {
          return {
            items: [],
            hasMore: false,
            canAdvance: false,
            candidateLimitReached: false,
            errors: [
              {
                accountId: runtime.account.id,
                error: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
        const output: MailSummary[] = [];
        let hasMore = false;
        let canAdvance = false;
        let candidateLimitReached = false;
        const batchErrors: Array<{ accountId: string; mailbox?: string; error: string }> = [];
        for (const mailbox of mailboxes) {
          try {
            const found = await searchMailbox(
              runtime,
              this.#config.config,
              mailbox,
              filters,
              Math.min(
                offset + limit + 1,
                this.#config.config.limits.maxSearchOffset + 1,
              ),
              0,
            );
            output.push(...found.items.map((item) => this.summary(runtime, item)));
            if (found.candidateLimitReached) {
              candidateLimitReached = true;
              batchErrors.push({
                accountId: runtime.account.id,
                mailbox,
                error:
                  "search reached the per-folder candidate limit; results may be incomplete; narrow the filters or increase maxSearchCandidatesPerFolder",
              });
            }
            if (found.hasMore) {
              hasMore = true;
              if (!found.candidateLimitReached) canAdvance = true;
            }
          } catch (error) {
            batchErrors.push({
              accountId: runtime.account.id,
              mailbox,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return {
          items: output,
          hasMore,
          canAdvance,
          candidateLimitReached,
          errors: batchErrors,
        };
      },
    );

    const all = batches
      .flatMap((batch) => batch.items)
      .sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.uid - a.uid);
    for (const batch of batches) errors.push(...batch.errors);
    const page = all.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const sourceHasMore = batches.some((batch) => batch.hasMore);
    const sourceCanAdvance = batches.some((batch) => batch.canAdvance);
    const hasMore = nextOffset < all.length || sourceHasMore;
    const paginationLimitReached =
      hasMore && nextOffset >= this.#config.config.limits.maxSearchOffset;
    const paginationCannotAdvance =
      hasMore && (page.length === 0 || (nextOffset >= all.length && !sourceCanAdvance));
    if (paginationLimitReached) {
      errors.push({
        accountId: request.accountId || "all",
        error:
          "global pagination depth reached maxSearchOffset; narrow the search filters to continue safely",
      });
    }
    if (paginationCannotAdvance && !paginationLimitReached) {
      errors.push({
        accountId: request.accountId || "all",
        error:
          "search could not advance within the bounded mailbox window; narrow the search filters or increase the search candidate limit",
      });
    }
    return {
      results: page,
      nextCursor:
        hasMore && !paginationLimitReached && !paginationCannotAdvance
          ? this.#tokens.issue<SearchCursor>("cursor", { fingerprint, offset: nextOffset })
          : undefined,
      hasMore,
      partial: errors.length > 0,
      errors,
    };
  }

  async fetch(id: string) {
    const { runtime, locator } = this.messageLocator(id);
    const fetched = await fetchParsedMessage(
      runtime,
      this.#config.config,
      locator.mailbox,
      locator.uidValidity,
      locator.uid,
    );
    return {
      id,
      title: fetched.parsed.subject,
      text: formatFetchedMessage(fetched.parsed),
       url: `mail://mailbride-mcp/${encodeURIComponent(runtime.account.id)}/${encodeURIComponent(id)}`,
      metadata: {
        trust: "untrusted_external_content",
        accountId: runtime.account.id,
        mailbox: locator.mailbox,
        flags: fetched.flags,
        size: fetched.size,
        truncated: fetched.parsed.truncated,
        envelope: {
          from: fetched.parsed.from,
          replyTo: fetched.parsed.replyTo,
          to: fetched.parsed.to,
          cc: fetched.parsed.cc,
          bcc: fetched.parsed.bcc,
          date: fetched.parsed.date,
          messageId: fetched.parsed.messageId,
          inReplyTo: fetched.parsed.inReplyTo,
          references: fetched.parsed.references,
        },
        attachments: fetched.parsed.attachments.map(({ content: _content, ...attachment }) => attachment),
        headers: fetched.parsed.headers,
      },
    };
  }

  async getThread(id: string, limit = 50, includeTrash = false, includeJunk = false) {
    const { runtime, locator } = this.messageLocator(id);
    const source = await fetchParsedMessage(
      runtime,
      this.#config.config,
      locator.mailbox,
      locator.uidValidity,
      locator.uid,
    );
    const sourceSummary: MailSummary = {
      id,
      accountId: runtime.account.id,
      accountName: runtime.account.displayName,
      mailboxName: locator.mailbox,
      uid: locator.uid,
      subject: source.parsed.subject,
      from: source.parsed.from,
      to: source.parsed.to,
      cc: source.parsed.cc,
      ...(source.parsed.date ? { date: source.parsed.date } : {}),
      flags: [...source.flags],
      unread: !source.flags.includes("\\Seen"),
      flagged: source.flags.includes("\\Flagged"),
      hasAttachments: source.parsed.attachments.length > 0,
      size: source.size,
       url: `mail://mailbride-mcp/${encodeURIComponent(runtime.account.id)}/${encodeURIComponent(id)}`,
    };
    const messageIds = Array.from(
      new Set(
        [source.parsed.messageId, source.parsed.inReplyTo, ...source.parsed.references]
          .filter((value): value is string => Boolean(value))
          .map((value) => value.trim()),
      ),
    );
    if (messageIds.length === 0) {
      return {
        messages: [sourceSummary],
        hasMore: false,
        partial: false,
        errors: [],
        threading: "unavailable_without_message_id",
      };
    }

    const folders = await listFolders(runtime, this.#config.config);
    const mailboxes = folders
      .filter((folder) => folder.selectable)
      .filter((folder) => includeTrash || !isTrashFolder(runtime.account, folder))
      .filter((folder) => includeJunk || !isJunkFolder(folder))
      .map((folder) => folder.path);

    const errors: Array<{ mailbox: string; error: string }> = [];
    const batches = await mapConcurrentOrdered(
      mailboxes,
      this.#config.config.limits.maxConcurrentConnections,
      async (mailbox): Promise<ThreadMailboxBatch> => {
        try {
          const found = await searchThreadMailbox(
            runtime,
            this.#config.config,
            mailbox,
            messageIds,
            Math.min(Math.max(limit, 1), 100),
          );
          const batchErrors: Array<{ mailbox: string; error: string }> = [];
          if (found.candidateLimitReached) {
            batchErrors.push({
              mailbox,
              error:
                "thread search reached the per-folder candidate limit; older related messages may be missing",
            });
          } else if (found.scanIncomplete) {
            batchErrors.push({
              mailbox,
              error:
                "thread search stopped before the oldest sequence; older related messages may still exist",
            });
          }
          return { items: found.items, hasMore: found.hasMore, errors: batchErrors };
        } catch (error) {
          return {
            items: [],
            hasMore: false,
            errors: [{ mailbox, error: error instanceof Error ? error.message : String(error) }],
          };
        }
      },
    );
    for (const batch of batches) errors.push(...batch.errors);
    const deduplicated = new Map<string, MailSummary>();
    const sourceKey = source.parsed.messageId?.trim().toLowerCase() || `${locator.mailbox}:${locator.uid}`;
    deduplicated.set(sourceKey, sourceSummary);
    for (const item of batches.flatMap((batch) => batch.items)) {
      const summary = this.summary(runtime, item);
      const key = item.message.envelope?.messageId?.trim().toLowerCase() || `${item.mailbox}:${item.message.uid}`;
      if (key === sourceKey) continue;
      const existing = deduplicated.get(key);
      if (!existing || (!existing.date && summary.date)) deduplicated.set(key, summary);
    }
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    const ordered = Array.from(deduplicated.values()).sort(
      (a, b) => (a.date || "").localeCompare(b.date || "") || a.uid - b.uid,
    );
    let messages = ordered.slice(0, boundedLimit);
    if (!messages.some((message) => message.id === id)) {
      // The caller-selected source anchors this view and must remain visible
      // even when a small global limit truncates the chronological result.
      messages = [...messages.slice(0, Math.max(0, boundedLimit - 1)), sourceSummary].sort(
        (a, b) => (a.date || "").localeCompare(b.date || "") || a.uid - b.uid,
      );
    }
    const resultLimitReached = ordered.length > messages.length;
    const hasMore = batches.some((batch) => batch.hasMore) || resultLimitReached;
    return {
      messages,
      hasMore,
      partial: errors.length > 0 || hasMore,
      errors,
      threading: "message_id_references_in_reply_to",
    };
  }

  private async contactsFor(runtime: AccountRuntime): Promise<CachedContacts> {
    const cached = this.#contactCache.get(runtime.account.id);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const mailboxes = Array.from(
      new Set([
        runtime.account.folders.inbox,
        ...(runtime.account.folders.sent ? [runtime.account.folders.sent] : []),
        ...(runtime.account.folders.contacts || []),
      ]),
    );
    const scanned = await scanContacts(runtime, this.#config.config, mailboxes);
    const cachedResult: CachedContacts = {
      values: scanned.contacts,
      errors: scanned.errors,
      expiresAt: Date.now() + this.#config.config.limits.contactCacheSeconds * 1000,
    };
    this.#contactCache.set(runtime.account.id, cachedResult);
    return cachedResult;
  }

  async searchContacts(request: ContactSearchRequest) {
    const query = request.query.trim().toLowerCase();
    const limit = Math.min(Math.max(request.limit || 20, 1), 100);
    const errors: Array<{ accountId: string; mailbox?: string; error: string }> = [];
    const found = await mapConcurrentOrdered(
      this.accounts(request.accountId),
      this.#config.config.limits.maxConcurrentConnections,
      async (runtime) => {
        try {
          const self = new Set([runtime.account.email, ...runtime.account.aliases].map(normalizeAddress));
          const scanned = await this.contactsFor(runtime);
          errors.push(
            ...scanned.errors.map((error) => ({
              accountId: runtime.account.id,
              mailbox: error.mailbox,
              error: error.error,
            })),
          );
          return scanned.values.filter((contact) => !self.has(contact.email));
        } catch (error) {
          errors.push({
            accountId: runtime.account.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        }
      },
    );
    const merged = new Map<string, ContactRecord>();
    for (const contact of found.flat()) {
      if (query && !contact.email.includes(query) && !contact.name?.toLowerCase().includes(query)) continue;
      const existing = merged.get(contact.email);
      if (!existing) {
        merged.set(contact.email, { ...contact, accounts: [...contact.accounts] });
        continue;
      }
      existing.messageCount += contact.messageCount;
      existing.accounts = Array.from(new Set([...existing.accounts, ...contact.accounts]));
      if ((!existing.name || (contact.name?.length || 0) > existing.name.length) && contact.name) {
        existing.name = contact.name;
      }
      if (contact.lastSeen && (!existing.lastSeen || contact.lastSeen > existing.lastSeen)) {
        existing.lastSeen = contact.lastSeen;
      }
    }
    return {
      contacts: Array.from(merged.values())
        .sort((a, b) => {
          const aStarts = a.email.startsWith(query) || a.name?.toLowerCase().startsWith(query) ? 1 : 0;
          const bStarts = b.email.startsWith(query) || b.name?.toLowerCase().startsWith(query) ? 1 : 0;
          return bStarts - aStarts || b.messageCount - a.messageCount || (b.lastSeen || "").localeCompare(a.lastSeen || "");
        })
        .slice(0, limit),
      partial: errors.length > 0,
      errors,
      source: "correspondents",
    };
  }

  private validateHeader(value: string, label: string, max: number): string {
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`${label} cannot be empty`);
    if (/[\r\n]/.test(trimmed)) throw new Error(`${label} cannot contain CR or LF characters`);
    if (trimmed.length > max) throw new Error(`${label} exceeds ${max} characters`);
    return trimmed;
  }

  private validateRecipients(account: AccountConfig, draft: RecipientPolicyDraft): void {
    validateRecipientPolicy(account, draft);
  }

  private async localAttachments(runtime: AccountRuntime, inputs: LocalAttachmentInput[] = []): Promise<DraftAttachment[]> {
    if (inputs.length > 20) throw new Error("a draft can include at most 20 local attachments");
    const roots = await Promise.all(
      runtime.account.allowedAttachmentRoots.map(async (root) => realpath(resolve(root))),
    );
    if (inputs.length && roots.length === 0) {
      throw new Error("local attachments are disabled until allowedAttachmentRoots is configured for this account");
    }
    const attachments: DraftAttachment[] = [];
    let total = 0;
    try {
      for (const input of inputs) {
        const absolute = resolve(input.path);
        const resolvedPath = await realpath(absolute);
        if (!roots.some((root) => isPathInside(resolvedPath, root))) {
          throw new Error(`attachment path is outside the configured roots: ${input.path}`);
        }
        const details = await stat(resolvedPath);
        if (!details.isFile()) throw new Error(`attachment is not a regular file: ${input.path}`);
        if (details.size > this.#config.config.limits.maxAttachmentBytes) {
          throw new Error(`attachment exceeds the configured byte limit: ${input.path}`);
        }
        const remaining = this.#config.config.limits.maxAttachmentBytes - total;
        if (details.size > remaining) {
          throw new Error("combined attachments exceed the configured byte limit");
        }
        const filename = this.validateHeader(input.filename || basename(resolvedPath), "attachment filename", 500);
        const contentType = input.contentType
          ? this.validateHeader(input.contentType, "attachment content type", 200)
          : undefined;
        const content = await readFileBounded(resolvedPath, remaining);
        if (content.length > remaining) {
          content.fill(0);
          throw new Error("combined attachments exceed the configured byte limit");
        }
        total += content.length;
        const attachment: DraftAttachment = { filename, content };
        if (contentType) attachment.contentType = contentType;
        attachments.push(attachment);
      }
      return attachments;
    } catch (error) {
      for (const attachment of attachments) attachment.content.fill(0);
      throw error;
    }
  }

  private sourceWarnings(message: ParsedMessage): string[] {
    const warnings: string[] = [];
    if (message.replyTo.length && message.from.length) {
      const replyTo = message.replyTo.map((entry) => normalizeAddress(entry.address));
      const from = new Set(message.from.map((entry) => normalizeAddress(entry.address)));
      if (replyTo.some((address) => !from.has(address))) warnings.push("Reply-To differs from From. Review recipients carefully.");
    }
    if (message.headers.autoSubmitted && !/^no$/i.test(message.headers.autoSubmitted)) {
      warnings.push(`Original message is automated (Auto-Submitted: ${message.headers.autoSubmitted}).`);
    }
    if (message.headers.precedence && /^(?:bulk|list|junk)$/i.test(message.headers.precedence)) {
      warnings.push(`Original message is marked as ${message.headers.precedence} mail.`);
    }
    if (message.headers.listId) warnings.push("Original message belongs to a mailing list. Reply-all may reach the list.");
    if (!message.messageId) warnings.push("Original message has no Message-ID, so reply threading headers are limited.");
    return warnings;
  }

  private replyRecipients(runtime: AccountRuntime, message: ParsedMessage, replyAll: boolean) {
    const self = [runtime.account.email, ...runtime.account.aliases];
    const primary = (message.replyTo.length ? message.replyTo : message.from).map((entry) => entry.address);
    const to = uniqueAddresses(
      replyAll ? [...primary, ...message.to.map((entry) => entry.address)] : primary,
      self,
    );
    const cc = replyAll
      ? uniqueAddresses(message.cc.map((entry) => entry.address), [...self, ...to])
      : [];
    return { to, cc };
  }

  private originalAttachments(message: ParsedMessage): DraftAttachment[] {
    let total = 0;
    return message.attachments.map((attachment) => {
      if (!attachment.content) throw new Error(`original attachment content was unavailable: ${attachment.filename}`);
      total += attachment.content.length;
      if (total > this.#config.config.limits.maxAttachmentBytes) {
        throw new Error("original attachments exceed the configured combined byte limit");
      }
      const result: DraftAttachment = {
        filename: attachment.filename,
        content: attachment.content,
      };
      if (attachment.contentType) result.contentType = attachment.contentType;
      return result;
    });
  }

  async createDraft(request: CreateDraftRequest) {
    const runtime = this.account(request.accountId);
    const requestedTo = uniqueAddresses(request.to || []);
    const requestedCc = uniqueAddresses(request.cc || [], requestedTo);
    const requestedBcc = uniqueAddresses(request.bcc || [], [...requestedTo, ...requestedCc]);
    let to = requestedTo;
    let cc = requestedCc;
    let bcc = requestedBcc;
    let subject = request.subject || "";
    let bodyText = request.bodyText.trim();
    let inReplyTo: string | undefined;
    let references: string[] = [];
    let warnings: string[] = [];
    let sourceMessageId: string | undefined;
    let originalAttachments: DraftAttachment[] = [];
    let replyRecipientAllowlist: string[] | undefined;

    if (request.mode !== "new") {
      if (!request.sourceMessageId) throw new Error(`${request.mode} requires sourceMessageId`);
      const source = this.messageLocator(request.sourceMessageId);
      if (source.runtime.account.id !== runtime.account.id) {
        throw new Error("source message belongs to a different account");
      }
      const fetched = await fetchParsedMessage(
        runtime,
        this.#config.config,
        source.locator.mailbox,
        source.locator.uidValidity,
        source.locator.uid,
        request.mode === "forward" && request.includeOriginalAttachments === true,
      );
      const message = fetched.parsed;
      sourceMessageId = request.sourceMessageId;
      warnings = this.sourceWarnings(message);
      if (request.mode === "reply" || request.mode === "reply_all") {
        if (
          !runtime.account.policy.allowAdditionalReplyRecipients &&
          (requestedTo.length > 0 || requestedCc.length > 0 || requestedBcc.length > 0)
        ) {
          throw new Error(
            "additional reply recipients are disabled for this account; leave To, CC, and BCC empty or use a new message",
          );
        }
        const derived = this.replyRecipients(runtime, message, request.mode === "reply_all");
        replyRecipientAllowlist = uniqueAddresses([...derived.to, ...derived.cc]);
        const self = [runtime.account.email, ...runtime.account.aliases];
        to = uniqueAddresses([...derived.to, ...requestedTo], self);
        cc = uniqueAddresses([...derived.cc, ...requestedCc], [...self, ...to]);
        bcc = uniqueAddresses(requestedBcc, [...self, ...to, ...cc]);
        if (requestedTo.length || requestedCc.length || requestedBcc.length) {
          warnings.push("Additional reply recipients were supplied explicitly. Review To, CC, and BCC carefully.");
        }
        subject = request.subject || addPrefix(message.subject, "Re");
        if (message.messageId) {
          inReplyTo = message.messageId;
          references = [...message.references, message.messageId].slice(-50);
        }
        if (request.quoteOriginal !== false) {
          bodyText = `${bodyText}\n\nOn ${message.date || "an earlier date"}, ${message.from.map((entry) => entry.address).join(", ")} wrote:\n${quoteText(message.text)}`.trim();
        }
      } else {
        subject = request.subject || addPrefix(message.subject, "Fwd");
        if (request.quoteOriginal !== false) {
          bodyText = `${bodyText}\n\n---------- Forwarded message ----------\nFrom: ${message.from.map((entry) => entry.address).join(", ")}\nDate: ${message.date || "unknown"}\nSubject: ${message.subject}\nTo: ${message.to.map((entry) => entry.address).join(", ")}\n\n${message.text}`.trim();
        }
        if (request.includeOriginalAttachments) originalAttachments = this.originalAttachments(message);
      }
    }

    subject = this.validateHeader(subject || "(no subject)", "subject", 2000);
    if (!bodyText && !request.bodyHtml) throw new Error("draft body cannot be empty");
    if (bodyText.length > this.#config.config.limits.maxBodyChars) throw new Error("draft text exceeds the configured body limit");
    if ((request.bodyHtml?.length || 0) > this.#config.config.limits.maxBodyChars * 2) {
      throw new Error("draft HTML exceeds the configured body limit");
    }
    let attachments: DraftAttachment[] = [];
    try {
      const local = await this.localAttachments(runtime, request.attachments);
      attachments = [...originalAttachments, ...local];
      if (attachments.length > 20) {
        throw new Error("a draft can include at most 20 attachments including forwarded originals");
      }
      const totalAttachmentBytes = attachments.reduce(
        (total, attachment) => total + attachment.content.length,
        0,
      );
      if (totalAttachmentBytes > this.#config.config.limits.maxAttachmentBytes) {
        throw new Error("combined local and forwarded attachments exceed the configured byte limit");
      }
    } catch (error) {
      for (const attachment of new Set([...originalAttachments, ...attachments])) {
        attachment.content.fill(0);
      }
      throw error;
    }
    const draftInput: Omit<StoredDraft, "id" | "revision" | "createdAt" | "updatedAt" | "preview"> = {
      mode: request.mode,
      accountId: runtime.account.id,
      to,
      cc,
      bcc,
      subject,
      bodyText,
      attachments,
      references,
      warnings,
    };
    if (request.bodyHtml) draftInput.bodyHtml = request.bodyHtml;
    if (inReplyTo) draftInput.inReplyTo = inReplyTo;
    if (sourceMessageId) draftInput.sourceMessageId = sourceMessageId;
    // Preserve the source-derived boundary so later draft updates cannot turn
    // a restricted reply into an arbitrary new outbound message. The value is
    // internal and is never returned in draft previews.
    if (replyRecipientAllowlist) draftInput.replyRecipientAllowlist = replyRecipientAllowlist;
    try {
      this.validateRecipients(runtime.account, draftInput);
      return this.publicDraft(this.#drafts.create(draftInput));
    } catch (error) {
      for (const attachment of attachments) attachment.content.fill(0);
      throw error;
    }
  }

  async updateDraft(request: UpdateDraftRequest) {
    const current = this.#drafts.get(request.draftId);
    const runtime = this.account(current.accountId);
    const attachments = request.attachments
      ? await this.localAttachments(runtime, request.attachments)
      : undefined;
    let transferred = false;
    try {
      const updated = this.#drafts.update(request.draftId, request.revision, (draft) => {
        if (request.to) draft.to = uniqueAddresses(request.to);
        if (request.cc) draft.cc = uniqueAddresses(request.cc, draft.to);
        if (request.bcc) draft.bcc = uniqueAddresses(request.bcc, [...draft.to, ...draft.cc]);
        if (request.subject !== undefined) draft.subject = this.validateHeader(request.subject, "subject", 2000);
        if (request.bodyText !== undefined) draft.bodyText = request.bodyText.trim();
        if (request.bodyHtml === null) delete draft.bodyHtml;
        else if (request.bodyHtml !== undefined) draft.bodyHtml = request.bodyHtml;
        if (attachments) draft.attachments = attachments;
        if (!draft.bodyText && !draft.bodyHtml) throw new Error("draft body cannot be empty");
        if (draft.bodyText.length > this.#config.config.limits.maxBodyChars) throw new Error("draft text exceeds the configured body limit");
        if ((draft.bodyHtml?.length || 0) > this.#config.config.limits.maxBodyChars * 2) {
          throw new Error("draft HTML exceeds the configured body limit");
        }
        this.validateRecipients(runtime.account, draft);
      });
      transferred = attachments !== undefined;
      return this.publicDraft(updated);
    } catch (error) {
      if (!transferred && attachments) {
        for (const attachment of attachments) attachment.content.fill(0);
      }
      throw error;
    }
  }

  previewDraft(draftId: string, revision: number) {
    const draft = this.#drafts.get(draftId);
    const runtime = this.account(draft.accountId);
    this.validateRecipients(runtime.account, draft);
    return {
      ...this.#drafts.preview(draftId, revision),
      from: { name: runtime.account.displayName, address: runtime.account.email },
      warnings: draft.warnings,
      instruction:
        "Show the user the exact From, To, CC, BCC, subject, attachment list, warnings, and digest. Call mail_draft_send only after the user explicitly confirms this exact preview.",
    };
  }

  async sendDraft(
    draftId: string,
    revision: number,
    confirmationToken: string,
    idempotencyKey: string,
    confirmed: true,
  ): Promise<SendResult & { answeredFlagUpdated?: boolean }> {
    if (confirmed !== true) throw new Error("confirmed must be true after the user explicitly approves the preview");
    const authorized = this.#drafts.authorizeSend(
      draftId,
      revision,
      confirmationToken,
      idempotencyKey,
    );
    if (authorized.prior) return authorized.prior;
    const runtime = this.account(authorized.draft.accountId);
    this.validateRecipients(runtime.account, authorized.draft);
    const result = await sendDraft(runtime, authorized.draft, this.#config.config);
    if (result.status === "rejected") {
      // A definite pre-acceptance rejection is safe to edit and retry after a
      // fresh preview. Preserve the draft, while recording this key so an
      // identical replay cannot re-submit behind the user's back.
      this.#drafts.recordAttempt(idempotencyKey, authorized.draft, authorized.digest, result);
    } else {
      // accepted/partial are sent; unknown is also terminal to avoid duplicates
      // after a possible DATA acceptance followed by a timeout.
      this.#drafts.recordSend(idempotencyKey, authorized.draft, authorized.digest, result);
    }

    let answeredFlagUpdated: boolean | undefined;
    if (
      authorized.draft.sourceMessageId &&
      (authorized.draft.mode === "reply" || authorized.draft.mode === "reply_all") &&
      (result.status === "accepted" || result.status === "partial")
    ) {
      try {
        const source = this.messageLocator(authorized.draft.sourceMessageId);
        await updateFlags(
          source.runtime,
          this.#config.config,
          source.locator.mailbox,
          source.locator.uidValidity,
          source.locator.uid,
          ["\\Answered"],
          [],
        );
        answeredFlagUpdated = true;
      } catch {
        answeredFlagUpdated = false;
      }
    }
    return answeredFlagUpdated === undefined ? result : { ...result, answeredFlagUpdated };
  }

  discardDraft(draftId: string) {
    return { discarded: this.#drafts.discard(draftId) };
  }

  private publicDraft(draft: StoredDraft) {
    return {
      draftId: draft.id,
      revision: draft.revision,
      mode: draft.mode,
      accountId: draft.accountId,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      bodyText: draft.bodyText,
      hasHtml: Boolean(draft.bodyHtml),
      attachments: draft.attachments.map(attachmentSummary),
      warnings: draft.warnings,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
    };
  }

  async setMessageFlags(
    messageId: string,
    flags: { read?: boolean; starred?: boolean; answered?: boolean; draft?: boolean },
  ) {
    const { runtime, locator } = this.messageLocator(messageId);
    if (!runtime.account.policy.allowFolderMutations) throw new Error("message updates are disabled for this account");
    const mapping: Array<[keyof typeof flags, string]> = [
      ["read", "\\Seen"],
      ["starred", "\\Flagged"],
      ["answered", "\\Answered"],
      ["draft", "\\Draft"],
    ];
    const add: string[] = [];
    const remove: string[] = [];
    for (const [key, imapFlag] of mapping) {
      if (flags[key] === true) add.push(imapFlag);
      else if (flags[key] === false) remove.push(imapFlag);
    }
    if (!add.length && !remove.length) throw new Error("provide at least one flag change");
    await updateFlags(
      runtime,
      this.#config.config,
      locator.mailbox,
      locator.uidValidity,
      locator.uid,
      add,
      remove,
    );
    return { updated: true, added: add, removed: remove };
  }

  async moveMessage(messageId: string, destinationMailboxId: string) {
    const source = this.messageLocator(messageId);
    const destination = this.folderLocator(destinationMailboxId);
    if (source.runtime.account.id !== destination.runtime.account.id) throw new Error("cross-account moves are not supported");
    if (!source.runtime.account.policy.allowFolderMutations) throw new Error("message moves are disabled for this account");
    const destinationFolder = (await listFolders(source.runtime, this.#config.config)).find(
      (folder) => folder.path === destination.locator.mailbox,
    );
    if (!destinationFolder) throw new Error("destination mailbox no longer exists; list mailboxes again");
    if (!destinationFolder.selectable) throw new Error("destination mailbox is not selectable");
    if (isTrashFolder(source.runtime.account, destinationFolder) && !source.runtime.account.policy.allowTrash) {
      throw new Error("moving a message into Trash requires allowTrash for this account");
    }
    if (source.locator.mailbox === destinationFolder.path) {
      throw new Error("source and destination mailboxes are the same");
    }
    await moveMessageImap(
      source.runtime,
      this.#config.config,
      source.locator.mailbox,
      source.locator.uidValidity,
      source.locator.uid,
      destinationFolder.path,
    );
    return { moved: true, destination: destinationFolder.path };
  }

  async copyMessage(messageId: string, destinationMailboxId: string) {
    const source = this.messageLocator(messageId);
    const destination = this.folderLocator(destinationMailboxId);
    if (source.runtime.account.id !== destination.runtime.account.id) throw new Error("cross-account copies are not supported");
    if (!source.runtime.account.policy.allowFolderMutations) throw new Error("message copies are disabled for this account");
    const destinationFolder = (await listFolders(source.runtime, this.#config.config)).find(
      (folder) => folder.path === destination.locator.mailbox,
    );
    if (!destinationFolder) throw new Error("destination mailbox no longer exists; list mailboxes again");
    if (!destinationFolder.selectable) throw new Error("destination mailbox is not selectable");
    await copyMessageImap(
      source.runtime,
      this.#config.config,
      source.locator.mailbox,
      source.locator.uidValidity,
      source.locator.uid,
      destinationFolder.path,
    );
    return { copied: true, destination: destinationFolder.path };
  }

  async trashMessage(messageId: string) {
    const source = this.messageLocator(messageId);
    if (!source.runtime.account.policy.allowTrash) throw new Error("trash is disabled for this account");
    const trash = source.runtime.account.folders.trash;
    if (!trash) throw new Error("trash folder is not configured for this account");
    const trashFolder = (await listFolders(source.runtime, this.#config.config)).find((folder) =>
      sameMailboxPath(folder.path, trash),
    );
    if (!trashFolder) throw new Error("configured trash folder no longer exists");
    if (!trashFolder.selectable) throw new Error("configured trash folder is not selectable");
    if (sameMailboxPath(source.locator.mailbox, trashFolder.path)) {
      throw new Error("message is already in the configured trash folder");
    }
    await moveMessageImap(
      source.runtime,
      this.#config.config,
      source.locator.mailbox,
      source.locator.uidValidity,
      source.locator.uid,
      trashFolder.path,
    );
    return { trashed: true, destination: trashFolder.path };
  }

  async permanentlyDelete(messageId: string, confirmed: true) {
    if (confirmed !== true) throw new Error("confirmed must be true after explicit user confirmation");
    const source = this.messageLocator(messageId);
    if (!source.runtime.account.policy.allowTrash) throw new Error("deletion is disabled for this account");
    const trash = source.runtime.account.folders.trash;
    if (!trash || !sameMailboxPath(source.locator.mailbox, trash)) {
      throw new Error("permanent deletion is allowed only for messages already in the configured trash folder");
    }
    const trashFolder = (await listFolders(source.runtime, this.#config.config)).find((folder) =>
      sameMailboxPath(folder.path, trash),
    );
    if (!trashFolder || !trashFolder.selectable) {
      throw new Error("configured trash folder is unavailable; list mailboxes and update the account config");
    }
    await permanentlyDeleteMessage(
      source.runtime,
      this.#config.config,
      source.locator.mailbox,
      source.locator.uidValidity,
      source.locator.uid,
    );
    return { permanentlyDeleted: true };
  }

  async manageFolder(
    accountId: string,
    action: "create" | "rename" | "delete" | "subscribe" | "unsubscribe",
    folder: string,
    newFolder: string | undefined,
    confirmed: boolean | undefined,
  ) {
    const runtime = this.account(accountId);
    if (!runtime.account.policy.allowFolderMutations) throw new Error("folder management is disabled for this account");
    if (action === "delete" && confirmed !== true) throw new Error("folder deletion requires explicit confirmation");
    const cleanFolder = this.validateHeader(folder, "folder", 1000);
    const cleanNewFolder = newFolder ? this.validateHeader(newFolder, "new folder", 1000) : undefined;
    return manageFolderImap(runtime, this.#config.config, action, cleanFolder, cleanNewFolder);
  }

  async readAttachment(messageId: string, attachmentIndex: number, maxBytes: number) {
    const source = this.messageLocator(messageId);
    const { attachment } = await fetchAttachmentSource(
      source.runtime,
      this.#config.config,
      source.locator.mailbox,
      source.locator.uidValidity,
      source.locator.uid,
      attachmentIndex,
    );
    if (!attachment.content) throw new Error("attachment content was unavailable");
    const limit = Math.min(maxBytes, this.#config.config.limits.maxAttachmentBytes, 5 * 1024 * 1024);
    if (attachment.content.length > limit) {
      throw new Error(`attachment is ${attachment.content.length} bytes; requested maximum is ${limit}`);
    }
    const textual = /^text\//i.test(attachment.contentType) || /(?:json|xml|javascript|csv)$/i.test(attachment.contentType);
    return {
      trust: "untrusted_external_content",
      warning: EXTERNAL_CONTENT_WARNING,
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.content.length,
      encoding: textual ? "utf8" : "base64",
      content: textual ? attachment.content.toString("utf8") : attachment.content.toString("base64"),
    };
  }
}
