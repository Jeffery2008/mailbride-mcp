import { ImapFlow, type FetchMessageObject, type MessageAddressObject, type MessageStructureObject, type SearchObject } from "imapflow";
import type { AccountConfig, AppConfig, MailSecret } from "./config.js";
import type { ContactRecord, MailSearchFilters, ParsedMessage } from "./mail/types.js";
import { parseMessageSource } from "./mail/parse.js";

export interface AccountRuntime {
  account: AccountConfig;
  secret: MailSecret;
}

export interface MailboxSession {
  client: ImapFlow;
  uidValidity: bigint;
  exists: number;
}

export interface RawSearchResult {
  message: FetchMessageObject;
  mailbox: string;
  uidValidity: bigint;
}

export interface FolderInfo {
  path: string;
  name: string;
  delimiter: string;
  specialUse?: string;
  selectable: boolean;
  subscribed: boolean;
  messages?: number;
  unseen?: number;
}

export interface ContactScanResult {
  contacts: ContactRecord[];
  errors: Array<{ mailbox: string; error: string }>;
}

type CapabilityView = Pick<ImapFlow, "capabilities" | "enabled">;

/** Match ImapFlow's RFC 9051 folding for the destructive capabilities we use. */
export function hasImapCapability(client: CapabilityView, capability: "MOVE" | "UIDPLUS"): boolean {
  if (client.capabilities.has(capability)) return true;
  const rev2Active =
    client.enabled.has("IMAP4REV2") ||
    (client.capabilities.has("IMAP4rev2") && !client.capabilities.has("IMAP4rev1"));
  return rev2Active;
}

function authOptions(secret: MailSecret): { user: string; pass?: string; accessToken?: string } {
  if ("password" in secret && typeof secret.password === "string") {
    return { user: secret.username, pass: secret.password };
  }
  return { user: secret.username, accessToken: secret.accessToken };
}

export function createImapClient(runtime: AccountRuntime, maxMessageBytes: number): ImapFlow {
  const { account, secret } = runtime;
  const implicitTls = account.imap.tls === "implicit";
  return new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: implicitTls,
    doSTARTTLS: !implicitTls,
    servername: account.imap.host,
    auth: authOptions(secret),
    tls: {
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      servername: account.imap.host,
    },
    disableAutoIdle: true,
    disableCompression: true,
    logger: false,
    emitLogs: false,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
    maxLiteralSize: maxMessageBytes + 1024 * 1024,
    maxResponseSize: maxMessageBytes + 2 * 1024 * 1024,
    maxLineLength: 1024 * 1024,
  });
}

export async function withImapClient<T>(
  runtime: AccountRuntime,
  maxMessageBytes: number,
  callback: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = createImapClient(runtime, maxMessageBytes);
  client.on("error", () => {
    // Errors are surfaced by the awaited operation. Never log protocol data or credentials here.
  });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

export async function withMailbox<T>(
  runtime: AccountRuntime,
  config: AppConfig,
  mailbox: string,
  readOnly: boolean,
  callback: (session: MailboxSession) => Promise<T>,
): Promise<T> {
  return withImapClient(runtime, config.limits.maxMessageBytes, async (client) => {
    const lock = await client.getMailboxLock(mailbox, {
      readOnly,
      acquireTimeout: 15_000,
      maxLockHoldTime: 60_000,
    });
    try {
      if (!client.mailbox) throw new Error("mailbox did not open");
      return await callback({
        client,
        uidValidity: client.mailbox.uidValidity,
        exists: client.mailbox.exists,
      });
    } finally {
      lock.release();
    }
  });
}

export async function listFolders(runtime: AccountRuntime, config: AppConfig): Promise<FolderInfo[]> {
  return withImapClient(runtime, config.limits.maxMessageBytes, async (client) => {
    const accountFolders = runtime.account.folders;
    const folders = await client.list({
      statusQuery: { messages: true, unseen: true },
      specialUseHints: {
        ...(accountFolders.sent ? { sent: accountFolders.sent } : {}),
        ...(accountFolders.trash ? { trash: accountFolders.trash } : {}),
        ...(accountFolders.drafts ? { drafts: accountFolders.drafts } : {}),
        ...(accountFolders.archive ? { archive: accountFolders.archive } : {}),
      },
    });
    return folders.map((folder) => {
      const result: FolderInfo = {
        path: folder.path,
        name: folder.name,
        delimiter: folder.delimiter,
        selectable: !folder.flags.has("\\Noselect"),
        subscribed: folder.subscribed,
      };
      if (folder.specialUse) result.specialUse = folder.specialUse;
      if (folder.status?.messages !== undefined) result.messages = folder.status.messages;
      if (folder.status?.unseen !== undefined) result.unseen = folder.status.unseen;
      return result;
    });
  });
}

function dateFromFilter(value: string | undefined, label: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf())) throw new Error(`${label} must use YYYY-MM-DD`);
  return date;
}

function buildSearchQuery(filters: MailSearchFilters): SearchObject {
  const query: SearchObject = {};
  const effectiveText = filters.text || filters.query;
  if (filters.from) query.from = filters.from;
  if (filters.to) query.to = filters.to;
  if (filters.body) query.body = filters.body;
  if (filters.subject) query.subject = filters.subject;
  // Some providers (notably QQ's IMAP service) treat TEXT as an unrestricted
  // match and similarly ignore CC/BCC search keys. Keep the server-side query
  // to fields that are portable there; CC/BCC are verified against the fetched
  // envelope below. The OR preserves the useful common TEXT semantics without
  // handing provider false positives to the caller.
  if (effectiveText) {
    query.or = [
      { subject: effectiveText },
      { body: effectiveText },
      { from: effectiveText },
      { to: effectiveText },
    ];
  }
  if (filters.unread !== undefined) query.seen = !filters.unread;
  if (filters.flagged !== undefined) query.flagged = filters.flagged;
  if (filters.answered !== undefined) query.answered = filters.answered;
  if (filters.draft !== undefined) query.draft = filters.draft;
  if (filters.deleted !== undefined) query.deleted = filters.deleted;
  if (filters.minSize !== undefined) query.larger = Math.max(0, filters.minSize - 1);
  if (filters.maxSize !== undefined) query.smaller = filters.maxSize + 1;
  const after = dateFromFilter(filters.after, "after");
  const before = dateFromFilter(filters.before, "before");
  if (after) query.since = after;
  if (before) query.before = before;
  if (Object.keys(query).length === 0) query.all = true;
  return query;
}

function envelopeFieldMatches(
  values: MessageAddressObject[] | undefined,
  needle: string,
): boolean {
  const normalizedNeedle = needle.trim().toLowerCase();
  if (!normalizedNeedle) return true;
  return (values || []).some((entry) => {
    const address = entry.address?.toLowerCase() || "";
    const name = entry.name?.toLowerCase() || "";
    return address.includes(normalizedNeedle) || name.includes(normalizedNeedle);
  });
}

function matchesEnvelopeFilters(message: FetchMessageObject, filters: MailSearchFilters): boolean {
  const envelope = message.envelope;
  if (filters.cc && !envelopeFieldMatches(envelope?.cc, filters.cc)) return false;
  if (filters.bcc && !envelopeFieldMatches(envelope?.bcc, filters.bcc)) return false;
  return true;
}

export async function searchThreadMailbox(
  runtime: AccountRuntime,
  config: AppConfig,
  mailbox: string,
  messageIds: string[],
  limit: number,
): Promise<{
  items: RawSearchResult[];
  hasMore: boolean;
  scanIncomplete: boolean;
  candidateLimitReached: boolean;
}> {
  if (messageIds.length === 0) {
    return { items: [], hasMore: false, scanIncomplete: false, candidateLimitReached: false };
  }
  return withMailbox(runtime, config, mailbox, true, async ({ client, uidValidity, exists }) => {
    const clauses: SearchObject[] = [];
    for (const messageId of messageIds.slice(-50)) {
      clauses.push(
        { header: { "Message-ID": messageId } },
        { header: { "In-Reply-To": messageId } },
        { header: { References: messageId } },
      );
    }
    const query: SearchObject = clauses.length === 1 ? clauses[0]! : { or: clauses };
    const collected = await collectSearchUids(
      client,
      query,
      exists,
      // Keep one look-ahead match so a terminal sequence window containing
      // more than `limit` related messages still reports hasMore correctly.
      Math.max(1, limit) + 1,
      Math.max(1, config.limits.maxSearchCandidatesPerFolder),
    );
    const uids = collected.uids.slice(0, limit);
    if (uids.length === 0) {
      return {
        items: [],
        hasMore: !collected.reachedEnd,
        scanIncomplete: !collected.reachedEnd,
        candidateLimitReached: collected.candidateLimitReached,
      };
    }

    const output: RawSearchResult[] = [];
    for await (const message of client.fetch(
      uids,
      { uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true },
      { uid: true },
    )) {
      output.push({ message, mailbox, uidValidity });
    }
    return {
      items: output,
      // A thread search is intentionally bounded. If the scan did not reach
      // sequence 1, older related messages may still exist even when this
      // mailbox returned fewer rows than the requested limit.
      hasMore: collected.uids.length > limit || !collected.reachedEnd,
      scanIncomplete: !collected.reachedEnd,
      candidateLimitReached: collected.candidateLimitReached,
    };
  });
}

export function structureHasAttachments(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  if (node.disposition?.toLowerCase() === "attachment") return true;
  if (node.dispositionParameters?.filename || node.parameters?.name) return true;
  return node.childNodes?.some(structureHasAttachments) === true;
}

const SEARCH_SEQUENCE_CHUNK = 500;

interface SearchWindowState {
  /** UIDs collected in newest-to-oldest order. */
  uids: number[];
  reachedEnd: boolean;
  candidateLimitReached: boolean;
}

/**
 * Search bounded sequence windows instead of asking the server for the whole
 * mailbox result set.  A broad SEARCH can otherwise materialize millions of
 * UIDs in ImapFlow before the caller's page limit is applied.
 */
async function collectSearchUids(
  client: ImapFlow,
  baseQuery: SearchObject,
  exists: number,
  wanted: number,
  sequenceBudget: number,
  stopWhenWanted = true,
): Promise<SearchWindowState> {
  const uids: number[] = [];
  const seen = new Set<number>();
  const safeExists = Number.isSafeInteger(exists) && exists > 0 ? Math.min(exists, 0xffffffff) : 0;
  const safeWanted = Number.isSafeInteger(wanted) && wanted > 0 ? wanted : 1;
  const safeBudget = Number.isSafeInteger(sequenceBudget) && sequenceBudget > 0 ? sequenceBudget : 1;
  let high = safeExists;
  let scannedSequences = 0;
  let reachedEnd = high === 0;

  while (
    high > 0 &&
    scannedSequences < safeBudget &&
    (!stopWhenWanted || uids.length < safeWanted)
  ) {
    const width = Math.min(SEARCH_SEQUENCE_CHUNK, high, safeBudget - scannedSequences);
    const low = high - width + 1;
    const query = { ...baseQuery, seq: `${low}:${high}` } satisfies SearchObject;
    const found = await client.search(query, { uid: true });
    // ImapFlow returns an empty array for a successful no-match SEARCH. A
    // false result means the command was not executed or failed; do not turn a
    // protocol error into a misleading empty mailbox result.
    if (found === false) throw new Error("mail server search failed for the selected mailbox");
    for (const uid of [...found].sort((a, b) => b - a)) {
      if (!Number.isSafeInteger(uid) || uid < 1) continue;
      if (seen.has(uid)) continue;
      seen.add(uid);
      uids.push(uid);
      if (stopWhenWanted && uids.length >= safeWanted) break;
    }
    scannedSequences += width;
    high = low - 1;
    reachedEnd = high <= 0;
  }

  return {
    uids,
    reachedEnd,
    candidateLimitReached:
      !reachedEnd &&
      scannedSequences >= safeBudget &&
      (!stopWhenWanted || uids.length < safeWanted),
  };
}

export async function searchMailbox(
  runtime: AccountRuntime,
  config: AppConfig,
  mailbox: string,
  filters: MailSearchFilters,
  limit: number,
  offset: number,
): Promise<{ items: RawSearchResult[]; hasMore: boolean; candidateLimitReached: boolean }> {
  return withMailbox(runtime, config, mailbox, true, async ({ client, uidValidity, exists }) => {
    const envelopeFilterRequired = Boolean(filters.cc || filters.bcc);
    const requestedMatches = Math.max(0, offset) + Math.max(0, limit) + 1;
    // Keep the per-folder sequence budget hard even for deep cursors. A large
    // maxSearchOffset must not turn into an unbounded scan; callers receive a
    // partial response once the safe candidate window is exhausted.
    const sequenceBudget = Math.max(1, config.limits.maxSearchCandidatesPerFolder);
    const wantedMatches =
      filters.hasAttachments === undefined ? requestedMatches : sequenceBudget + 1;
    const collected = await collectSearchUids(
      client,
      buildSearchQuery(filters),
      exists,
      wantedMatches,
      sequenceBudget,
      filters.hasAttachments === undefined && !envelopeFilterRequired,
    );
    if (filters.hasAttachments === undefined) {
      // When the provider ignores CC/BCC SEARCH keys, the server-side result
      // is deliberately broad. Scan the bounded candidate window and verify
      // those address fields against the returned envelope before paging.
      const selected = envelopeFilterRequired
        ? collected.uids
        : collected.uids.slice(offset, offset + limit + 1);
      if (selected.length === 0) {
        return {
          items: [],
          hasMore: !collected.reachedEnd,
          candidateLimitReached: collected.candidateLimitReached,
        };
      }
      const fetched: RawSearchResult[] = [];
      for (let start = 0; start < selected.length; start += 200) {
        const batch = selected.slice(start, start + 200);
        for await (const message of client.fetch(
          batch,
          { uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true },
          { uid: true },
        )) {
          if (envelopeFilterRequired && !matchesEnvelopeFilters(message, filters)) continue;
          fetched.push({ message, mailbox, uidValidity });
        }
      }
      fetched.sort((a, b) => b.message.uid - a.message.uid);
      return {
        items: fetched.slice(envelopeFilterRequired ? offset : 0, (envelopeFilterRequired ? offset : 0) + limit),
        hasMore:
          (envelopeFilterRequired ? fetched.length > offset + limit : fetched.length > limit) ||
          !collected.reachedEnd,
        candidateLimitReached: collected.candidateLimitReached,
      };
    }

    // IMAP has no portable attachment predicate, so inspect BODYSTRUCTURE in
    // bounded chunks until this page is filled. If the configured ceiling is
    // reached first, surface a partial result instead of a false "no matches".
    const matching: RawSearchResult[] = [];
    const candidateUids = collected.uids.slice(0, sequenceBudget);
    for (let start = 0; start < candidateUids.length && matching.length < offset + limit + 1; start += 200) {
      const selected = candidateUids.slice(start, Math.min(start + 200, candidateUids.length));
      if (selected.length === 0) break;
      for await (const message of client.fetch(
        selected,
        { uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true },
        { uid: true },
      )) {
        if (envelopeFilterRequired && !matchesEnvelopeFilters(message, filters)) continue;
        if (structureHasAttachments(message.bodyStructure) === filters.hasAttachments) {
          matching.push({ message, mailbox, uidValidity });
        }
      }
    }
    matching.sort((a, b) => b.message.uid - a.message.uid);
    return {
      items: matching.slice(offset, offset + limit),
      hasMore: matching.length > offset + limit || !collected.reachedEnd,
      candidateLimitReached: collected.candidateLimitReached,
    };
  });
}

export async function fetchParsedMessage(
  runtime: AccountRuntime,
  config: AppConfig,
  mailbox: string,
  expectedUidValidity: string,
  uid: number,
  includeAttachmentContent = false,
): Promise<{ parsed: ParsedMessage; flags: string[]; size: number }> {
  return withMailbox(runtime, config, mailbox, true, async ({ client, uidValidity }) => {
    if (uidValidity.toString() !== expectedUidValidity) {
      throw new Error("message reference expired because the mailbox UIDVALIDITY changed; search again");
    }
    const metadata = await client.fetchOne(
      String(uid),
      { uid: true, size: true, flags: true },
      { uid: true },
    );
    if (!metadata) throw new Error("message was not found; it may have moved or been deleted");
    const size = metadata.size || 0;
    if (size > config.limits.maxMessageBytes) {
      throw new Error(
        `message is ${size} bytes, above the configured ${config.limits.maxMessageBytes}-byte read limit`,
      );
    }
    const fetched = await client.fetchOne(
      String(uid),
      { uid: true, source: true },
      { uid: true },
    );
    if (!fetched || !fetched.source) throw new Error("message source was unavailable");
    return {
      parsed: await parseMessageSource(fetched.source, {
        maxBodyChars: config.limits.maxBodyChars,
        includeAttachmentContent,
      }),
      flags: Array.from(metadata.flags || []),
      size,
    };
  });
}

export function contactEnvelopeAddresses(envelope: FetchMessageObject["envelope"]): MessageAddressObject[] {
  if (!envelope) return [];
  return [
    ...(envelope.from || []),
    ...(envelope.replyTo || []),
    ...(envelope.to || []),
    ...(envelope.cc || []),
  ];
}

export async function scanContacts(
  runtime: AccountRuntime,
  config: AppConfig,
  mailboxes: string[],
): Promise<ContactScanResult> {
  const contacts = new Map<string, ContactRecord>();
  const errors: Array<{ mailbox: string; error: string }> = [];
  for (const mailbox of mailboxes) {
    try {
      await withMailbox(runtime, config, mailbox, true, async ({ client, exists }) => {
        if (exists <= 0) return;
        const first = Math.max(1, exists - config.limits.contactScanMessagesPerFolder + 1);
        for await (const message of client.fetch(
          `${first}:*`,
          { envelope: true, internalDate: true },
          { uid: false },
        )) {
          const seenInMessage = new Set<string>();
          // Never aggregate BCC into the discoverable correspondent index.
          // Even when a provider exposes it in a Sent envelope, it remains a
          // hidden-recipient field and should not leak through contacts_search.
          for (const address of contactEnvelopeAddresses(message.envelope)) {
            if (!address.address) continue;
            const email = address.address.trim().toLowerCase();
            if (!email || seenInMessage.has(email)) continue;
            seenInMessage.add(email);
            const current = contacts.get(email) || {
              email,
              accounts: [],
              messageCount: 0,
            };
            if (address.name && (!current.name || address.name.length > current.name.length)) {
              current.name = address.name.slice(0, 500);
            }
            if (!current.accounts.includes(runtime.account.id)) current.accounts.push(runtime.account.id);
            current.messageCount += 1;
            const date = message.envelope?.date || message.internalDate;
            if (date) {
              const iso = new Date(date).toISOString();
              if (!current.lastSeen || iso > current.lastSeen) current.lastSeen = iso;
            }
            contacts.set(email, current);
          }
        }
      });
    } catch (error) {
      // Continue scanning the remaining folders, but surface partial results
      // so callers do not mistake an incomplete contact index for success.
      errors.push({
        mailbox,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
    }
  }
  return { contacts: Array.from(contacts.values()), errors };
}

export async function updateFlags(
  runtime: AccountRuntime,
  config: AppConfig,
  mailbox: string,
  expectedUidValidity: string,
  uid: number,
  add: string[],
  remove: string[],
): Promise<void> {
  await withMailbox(runtime, config, mailbox, false, async ({ client, uidValidity }) => {
    if (uidValidity.toString() !== expectedUidValidity) {
      throw new Error("message reference expired because the mailbox UIDVALIDITY changed; search again");
    }
    if (add.length && !(await client.messageFlagsAdd([uid], add, { uid: true, silent: true }))) {
      throw new Error("mail server did not confirm the flag update");
    }
    if (remove.length && !(await client.messageFlagsRemove([uid], remove, { uid: true, silent: true }))) {
      throw new Error("mail server did not confirm the flag update");
    }
  });
}

export async function moveMessage(
  runtime: AccountRuntime,
  config: AppConfig,
  mailbox: string,
  expectedUidValidity: string,
  uid: number,
  destination: string,
): Promise<void> {
  await withMailbox(runtime, config, mailbox, false, async ({ client, uidValidity }) => {
    if (uidValidity.toString() !== expectedUidValidity) {
      throw new Error("message reference expired because the mailbox UIDVALIDITY changed; search again");
    }
    const supportsMove = hasImapCapability(client, "MOVE");
    const supportsUidPlus = hasImapCapability(client, "UIDPLUS");
    if (!supportsMove && !supportsUidPlus) {
      throw new Error(
        "safe single-message move requires the IMAP MOVE or UIDPLUS capability; this server supports neither",
      );
    }
    if (supportsMove) {
      const result = await client.messageMove([uid], destination, { uid: true });
      if (!result) throw new Error("mail server did not confirm the move");
      return;
    }

    // Do not use ImapFlow's built-in MOVE fallback here: it proceeds to delete
    // even when COPY returns false. With UIDPLUS we can safely emulate MOVE and
    // verify the copy before issuing a selective UID EXPUNGE.
    const copied = await client.messageCopy([uid], destination, { uid: true });
    if (!copied) throw new Error("mail server did not confirm the copy; the source message was left untouched");
    const deleted = await client.messageDelete([uid], { uid: true });
    if (!deleted) {
      throw new Error(
        "the message was copied but the source could not be safely removed; verify both folders before retrying",
      );
    }
  });
}

export async function copyMessage(
  runtime: AccountRuntime,
  config: AppConfig,
  mailbox: string,
  expectedUidValidity: string,
  uid: number,
  destination: string,
): Promise<void> {
  await withMailbox(runtime, config, mailbox, false, async ({ client, uidValidity }) => {
    if (uidValidity.toString() !== expectedUidValidity) {
      throw new Error("message reference expired because the mailbox UIDVALIDITY changed; search again");
    }
    const result = await client.messageCopy([uid], destination, { uid: true });
    if (!result) throw new Error("mail server did not confirm the copy");
  });
}

export async function permanentlyDeleteMessage(
  runtime: AccountRuntime,
  config: AppConfig,
  mailbox: string,
  expectedUidValidity: string,
  uid: number,
): Promise<void> {
  await withMailbox(runtime, config, mailbox, false, async ({ client, uidValidity }) => {
    if (uidValidity.toString() !== expectedUidValidity) {
      throw new Error("message reference expired because the mailbox UIDVALIDITY changed; search again");
    }
    if (!hasImapCapability(client, "UIDPLUS")) {
      throw new Error(
        "safe single-message permanent deletion requires the IMAP UIDPLUS capability; refusing a broad EXPUNGE",
      );
    }
    if (!(await client.messageDelete([uid], { uid: true }))) {
      throw new Error("mail server did not confirm permanent deletion");
    }
  });
}

export async function appendSentCopy(
  runtime: AccountRuntime,
  config: AppConfig,
  mailbox: string,
  source: Buffer,
): Promise<void> {
  await withImapClient(runtime, config.limits.maxMessageBytes, async (client) => {
    const result = await client.append(mailbox, source, ["\\Seen"]);
    if (!result) throw new Error("mail server did not confirm saving the Sent copy");
  });
}

export async function manageFolder(
  runtime: AccountRuntime,
  config: AppConfig,
  action: "create" | "rename" | "delete" | "subscribe" | "unsubscribe",
  folder: string,
  newFolder?: string,
): Promise<{ path: string; newPath?: string }> {
  return withImapClient(runtime, config.limits.maxMessageBytes, async (client) => {
    if (action === "create") {
      const result = await client.mailboxCreate(folder);
      return { path: result.path };
    }
    if (action === "rename") {
      if (!newFolder) throw new Error("newFolder is required for rename");
      const result = await client.mailboxRename(folder, newFolder);
      return { path: result.path, newPath: result.newPath };
    }
    if (action === "delete") {
      const result = await client.mailboxDelete(folder);
      return { path: result.path };
    }
    const result =
      action === "subscribe"
        ? await client.mailboxSubscribe(folder)
        : await client.mailboxUnsubscribe(folder);
    if (!result) throw new Error(`mail server did not confirm ${action}`);
    return { path: folder };
  });
}

export async function fetchAttachmentSource(
  runtime: AccountRuntime,
  config: AppConfig,
  mailbox: string,
  expectedUidValidity: string,
  uid: number,
  attachmentIndex: number,
): Promise<{ parsed: ParsedMessage; attachment: NonNullable<ParsedMessage["attachments"]>[number] }> {
  const fetched = await fetchParsedMessage(runtime, config, mailbox, expectedUidValidity, uid, true);
  const attachment = fetched.parsed.attachments[attachmentIndex];
  if (!attachment) throw new Error("attachment index was not found");
  if (!attachment.content) throw new Error("attachment content was unavailable");
  if (attachment.content.length > config.limits.maxAttachmentBytes) {
    throw new Error(
      `attachment is ${attachment.content.length} bytes, above the configured ${config.limits.maxAttachmentBytes}-byte limit`,
    );
  }
  return { parsed: fetched.parsed, attachment };
}
