import { createHash } from "node:crypto";
import type { ImapFlow } from "imapflow";
import type { AppConfig } from "./config.js";
import type { CloudDraftReference, CloudDraftState, PendingCloudDraft, StoredDraft } from "./drafts.js";
import { hasImapCapability, withMailbox, type AccountRuntime } from "./imap.js";
import { composeCloudDraftSource } from "./smtp.js";

class CloudDraftError extends Error {
  constructor(message: string, readonly status: "not_saved" | "unknown" | "conflict" = "conflict") {
    super(message);
  }
}

function failure(state: CloudDraftState, error: unknown, phase: string): void {
  // Never return executedCommand, protocol literals, raw responses, or credentials.
  const status = (error as { responseStatus?: string } | null)?.responseStatus;
  const code = (error as { code?: string } | null)?.code;
  state.status = error instanceof CloudDraftError
    ? error.status
    : state.pending?.attempted ? "unknown" : state.previous ? "partial" : "not_saved";
  state.detail = error instanceof CloudDraftError
    ? error.message
    : `Cloud draft ${phase} failed${status === "NO" || status === "BAD" ? ` (IMAP ${status})` : /^[A-Z0-9_]{1,40}$/.test(code || "") ? ` (${code})` : ""}. Local draft state was preserved.`;
}

async function readReference(
  client: ImapFlow,
  config: AppConfig,
  mailbox: string,
  uid: number,
  messageId: string,
  revision: number,
  allowDeleted = false,
): Promise<CloudDraftReference | undefined> {
  const metadata = await client.fetchOne(String(uid), { uid: true, size: true, flags: true, envelope: true }, { uid: true });
  if (!metadata) return undefined;
  if (metadata.uid !== uid || metadata.envelope?.messageId !== messageId || !metadata.flags?.has("\\Draft")) {
    throw new CloudDraftError("Cloud draft identity or Draft flag changed; inspect it in your mail client before continuing.");
  }
  if (metadata.flags.has("\\Deleted") && !allowDeleted) {
    throw new CloudDraftError("Cloud draft is flagged for deletion in another client; it was not recreated.");
  }
  if ((metadata.size || 0) > config.limits.maxMessageBytes) {
    throw new CloudDraftError("Cloud draft exceeds the configured read limit; it was left untouched.");
  }
  const fetched = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
  if (!fetched || fetched.uid !== uid || !fetched.source || !client.mailbox) {
    throw new CloudDraftError("Cloud draft source could not be verified; it was left untouched.", "unknown");
  }
  try {
    if (fetched.source.length > config.limits.maxMessageBytes) {
      throw new CloudDraftError("Cloud draft exceeds the configured read limit; it was left untouched.");
    }
    return {
      mailbox,
      uidValidity: client.mailbox.uidValidity.toString(),
      uid,
      messageId,
      revision,
      sha256: createHash("sha256").update(fetched.source).digest("hex"),
    };
  } finally {
    fetched.source.fill(0);
  }
}

async function verifyReference(
  client: ImapFlow,
  config: AppConfig,
  reference: CloudDraftReference,
  allowMissing = false,
): Promise<boolean> {
  if (!client.mailbox || client.mailbox.uidValidity.toString() !== reference.uidValidity) {
    throw new CloudDraftError("Drafts UIDVALIDITY changed; old cloud references cannot be safely reused.");
  }
  const fresh = await readReference(client, config, reference.mailbox, reference.uid, reference.messageId, reference.revision, allowMissing);
  if (!fresh) {
    if (allowMissing) return false;
    throw new CloudDraftError("Cloud draft was moved, deleted, or sent in another client; it was not recreated.");
  }
  if (fresh.sha256 !== reference.sha256) {
    throw new CloudDraftError("Cloud draft was edited in another client; it was left untouched. Review the cloud copy before creating a new draft.");
  }
  return true;
}

async function deleteReference(client: ImapFlow, config: AppConfig, reference: CloudDraftReference): Promise<void> {
  if (!(await verifyReference(client, config, reference, true))) return;
  if (!hasImapCapability(client, "UIDPLUS")) {
    throw new CloudDraftError("Safe cloud draft cleanup requires UIDPLUS; refusing a mailbox-wide EXPUNGE.", "not_saved");
  }
  if (!(await client.messageDelete([reference.uid], { uid: true }))) {
    throw new CloudDraftError("The server did not confirm cloud draft cleanup; retry cleanup using the same draftId.", "unknown");
  }
}

async function findPending(
  client: ImapFlow,
  config: AppConfig,
  state: CloudDraftState,
  pending: PendingCloudDraft,
): Promise<CloudDraftReference> {
  if (!client.mailbox) throw new CloudDraftError("Drafts did not open.", "unknown");
  const validity = client.mailbox.uidValidity.toString();
  if (pending.uidValidity && validity !== pending.uidValidity) {
    throw new CloudDraftError("Drafts UIDVALIDITY changed after APPEND; verify the cloud copy manually.");
  }
  if (pending.uid) {
    const found = await readReference(client, config, state.mailbox, pending.uid, pending.messageId, pending.revision);
    if (found) return found;
  }

  // Some servers omit APPENDUID. Only inspect a bounded recent window and
  // verify exact Message-ID matches because provider SEARCH can be imprecise.
  const exists = client.mailbox.exists;
  const window = Math.min(config.limits.maxSearchCandidatesPerFolder, 1000);
  const uids = exists > 0
    ? await client.search({ seq: `${Math.max(1, exists - window + 1)}:${exists}`, header: { "Message-ID": pending.messageId } }, { uid: true })
    : [];
  if (!uids || uids.length > window) {
    throw new CloudDraftError("Cloud APPEND could not be reconciled within the safe search window; do not create another copy.", "unknown");
  }
  const matches: number[] = [];
  for (const uid of uids) {
    const metadata = await client.fetchOne(String(uid), { uid: true, envelope: true }, { uid: true });
    if (metadata && metadata.envelope?.messageId === pending.messageId) matches.push(uid);
    if (matches.length > 1) {
      throw new CloudDraftError("Multiple matching cloud copies exist; inspect Drafts before retrying.");
    }
  }
  if (matches.length === 1) {
    const found = await readReference(client, config, state.mailbox, matches[0]!, pending.messageId, pending.revision);
    if (found) return found;
  }
  throw new CloudDraftError("APPEND may have succeeded but its cloud copy is not yet verifiable; inspect Drafts before retrying. No second APPEND was issued.", "unknown");
}

async function reconcilePending(client: ImapFlow, config: AppConfig, state: CloudDraftState): Promise<void> {
  if (!state.pending?.attempted) return;
  const found = await findPending(client, config, state, state.pending);
  if (state.current && state.current.uid !== found.uid) state.previous = state.current;
  state.current = found;
  delete state.pending;
}

async function cleanupPrevious(client: ImapFlow, config: AppConfig, state: CloudDraftState): Promise<void> {
  if (!state.previous) return;
  await deleteReference(client, config, state.previous);
  delete state.previous;
}

export async function syncCloudDraft(runtime: AccountRuntime, config: AppConfig, draft: StoredDraft): Promise<void> {
  if (runtime.account.draftSyncMode !== "imap") return;
  const mailbox = runtime.account.folders.drafts!;
  const state = draft.cloudDraft ||= { status: "not_saved", mailbox };
  let phase = "connection or folder selection";
  try {
    await withMailbox(runtime, config, mailbox, false, async ({ client }) => {
      phase = "reconciliation";
      await reconcilePending(client, config, state);
      phase = "old revision cleanup";
      await cleanupPrevious(client, config, state);
      phase = "verification";
      if (state.current) {
        await verifyReference(client, config, state.current);
        if (state.current.revision === draft.revision) {
          state.status = "saved";
          delete state.detail;
          return;
        }
        if (!hasImapCapability(client, "UIDPLUS")) {
          throw new CloudDraftError("Cloud draft replacement requires UIDPLUS; the existing cloud copy was left untouched.", "not_saved");
        }
      }

      const pending: PendingCloudDraft = {
        messageId: `<mailbride.${draft.id}.${draft.revision}@${runtime.account.email.split("@").at(-1)}>`,
        revision: draft.revision,
        attempted: false,
        uidValidity: client.mailbox ? client.mailbox.uidValidity.toString() : "",
      };
      phase = "MIME composition";
      let raw: Buffer;
      try {
        raw = await composeCloudDraftSource(runtime, draft, pending.messageId, config.limits.maxMessageBytes);
      } catch {
        throw new CloudDraftError("Cloud draft MIME could not be built within maxMessageBytes; the local draft was preserved.", "not_saved");
      }
      state.pending = pending;
      phase = "APPEND";
      try {
        pending.attempted = true;
        const appended = await client.append(mailbox, raw, ["\\Draft", "\\Seen"]);
        if (!appended) {
          delete state.pending;
          throw new CloudDraftError("The server did not accept the cloud draft APPEND.", "not_saved");
        }
        if (appended.uid) pending.uid = appended.uid;
        pending.uidValidity = appended.uidValidity?.toString() || (client.mailbox ? client.mailbox.uidValidity.toString() : "");
      } catch (error) {
        const imapError = error as { responseStatus?: string; serverResponseCode?: string };
        if (imapError.responseStatus === "NO" || imapError.responseStatus === "BAD" || imapError.serverResponseCode === "APPENDLIMIT") {
          delete state.pending;
        }
        throw error;
      } finally {
        raw.fill(0);
      }
      phase = "APPEND verification";
      await reconcilePending(client, config, state);
      phase = "old revision cleanup";
      await cleanupPrevious(client, config, state);
      state.status = "saved";
      delete state.detail;
    });
  } catch (error) {
    failure(state, error, phase);
    if (state.current?.revision === draft.revision && state.previous && state.status !== "conflict") state.status = "partial";
  }
}

/** Validate a saved cloud copy before sending the explicitly approved local preview. */
export async function verifyCloudDraft(runtime: AccountRuntime, config: AppConfig, draft: StoredDraft): Promise<void> {
  const state = draft.cloudDraft;
  if (!state || (!state.current && !state.pending)) return;
  try {
    await withMailbox(runtime, config, state.mailbox, true, async ({ client }) => {
      await reconcilePending(client, config, state);
      if (state.current) await verifyReference(client, config, state.current);
    });
  } catch (error) {
    failure(state, error, "pre-send verification");
    throw new Error(state.detail);
  }
}

/** Removes only verified copies belonging to this local draft, never other Drafts messages. */
export async function removeCloudDraft(runtime: AccountRuntime, config: AppConfig, draft: StoredDraft): Promise<boolean> {
  const state = draft.cloudDraft;
  if (!state) return true;
  if (!state.current && !state.previous && !state.pending?.attempted) {
    delete state.pending;
    delete state.detail;
    state.status = "removed";
    return true;
  }
  try {
    await withMailbox(runtime, config, state.mailbox, false, async ({ client }) => {
      await reconcilePending(client, config, state);
      await cleanupPrevious(client, config, state);
      if (state.current) {
        await deleteReference(client, config, state.current);
        delete state.current;
      }
      delete state.pending;
      delete state.detail;
      state.status = "removed";
    });
    return true;
  } catch (error) {
    failure(state, error, "cleanup");
    return false;
  }
}
