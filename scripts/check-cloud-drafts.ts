/**
 * Explicit integration check: --account ID --write-test creates one synthetic
 * self-addressed draft, verifies an edit through IMAP, and discards that draft.
 * This script never calls SMTP send and never reads the credentials file.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AppConfigSchema } from "../src/config.js";
import type { CloudDraftView } from "../src/drafts.js";

async function main(): Promise<void> {
  const accountId = process.argv[process.argv.indexOf("--account") + 1];
  if (!process.argv.includes("--account") || !process.argv.includes("--write-test")) {
    throw new Error("Usage: pnpm check:cloud-drafts --account ID --write-test");
  }
  const base = process.platform === "win32"
    ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "CodexEmailMcp")
    : join(homedir(), ".config", "codex-email-mcp");
  const configPath = process.env.CODEX_EMAIL_CONFIG || join(base, "accounts.json");
  const config = AppConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
  const account = config.accounts.find((value) => value.id === accountId);
  if (!account || account.draftSyncMode !== "imap") throw new Error("The selected account must enable draftSyncMode=imap");
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/server.cjs"), "--stdio"],
    env,
    stderr: "pipe",
  });
  // Server stderr may contain diagnostics, but is not forwarded to avoid exposing
  // data. Consume it so a pipe cannot fill and block the subprocess.
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "mailbride-cloud-draft-check", version: "1.0.0" });
  let draftId: string | undefined;
  let cleanup = false;
  const summary: Record<string, unknown> = { accountId, smtpCalled: false };
  const subject = `[MailBride sync check ${randomUUID()}]`;

  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await client.callTool({ name, arguments: args });
    const blocks = result.content as Array<{ type: string; text?: string }>;
    const text = blocks.filter((value) => value.type === "text").map((value) => value.text || "").join("");
    if (result.isError) throw new Error(`${name} failed`);
    return JSON.parse(text) as T;
  }

  async function verifyMissing(id: string): Promise<void> {
    const result = await client.callTool({ name: "mail_get", arguments: { id } });
    const blocks = result.content as Array<{ type: string; text?: string }>;
    const text = blocks.filter((value) => value.type === "text").map((value) => value.text || "").join("");
    if (!result.isError || !/message was not found/i.test(text)) throw new Error("The test cloud UID was not confirmed removed");
  }

  try {
    await client.connect(transport);
    const accounts = await call<Array<{ id: string; capabilities: { cloudDrafts: boolean } }>>("list_accounts", {});
    if (!accounts.find((value) => value.id === accountId)?.capabilities.cloudDrafts) throw new Error("Running server does not enable cloud drafts for this account");
    const mailboxes = await call<Array<{ id: string; path: string }>>("list_mailboxes", { accountId });
    const draftsFolder = mailboxes.find((value) => value.path === account.folders.drafts);
    if (!draftsFolder) throw new Error("Configured Drafts folder was not found");
    const created = await call<{ draftId: string; revision: number; cloudDraft: CloudDraftView }>("mail_draft_create", {
      accountId, mode: "new", to: [account.email], subject,
      bodyText: "Synthetic MailBride Drafts synchronization check. This message will not be sent.",
    });
    draftId = created.draftId;
    summary.create = created.cloudDraft;
    if (created.cloudDraft.status !== "saved" || !created.cloudDraft.messageId) {
      throw new Error(`Create sync was ${created.cloudDraft.status}`);
    }
    const fetched = await call<{ title: string; text: string; metadata: { flags: string[] } }>("mail_get", { id: created.cloudDraft.messageId });
    if (fetched.title !== subject || !fetched.metadata.flags.includes("\\Draft")) throw new Error("Initial cloud copy did not match the test draft");
    summary.readVerified = true;
    const updated = await call<{ draftId: string; revision: number; cloudDraft: CloudDraftView }>("mail_draft_update", {
      draftId, revision: created.revision, bodyText: "Updated synthetic cloud draft. This message will not be sent.",
    });
    summary.update = updated.cloudDraft;
    if (updated.cloudDraft.status !== "saved" || !updated.cloudDraft.messageId) throw new Error(`Update sync was ${updated.cloudDraft.status}`);
    const reread = await call<{ text: string }>("mail_get", { id: updated.cloudDraft.messageId });
    if (!reread.text.includes("Updated synthetic cloud draft")) throw new Error("Updated content was not found in cloud Drafts");
    await verifyMissing(created.cloudDraft.messageId);
    summary.oldRevisionRemoved = true;
    const discarded = await call<{ discarded: boolean; cloudDraft: CloudDraftView }>("mail_draft_discard", { draftId });
    cleanup = discarded.discarded;
    summary.discard = discarded.cloudDraft;
    if (!cleanup) throw new Error("Synthetic cloud draft cleanup was not confirmed");
    await verifyMissing(updated.cloudDraft.messageId);
    summary.cleanupVerified = true;
  } catch (error) {
    summary.error = error instanceof Error ? error.message : "Cloud check failed";
    process.exitCode = 1;
  } finally {
    if (draftId && !cleanup) {
      try {
        const result = await call<{ discarded: boolean; cloudDraft: CloudDraftView }>("mail_draft_discard", { draftId });
        summary.cleanup = result;
        if (!result.discarded) summary.recoverySubject = subject;
      } catch {
        summary.recoverySubject = subject;
      }
    }
    // Opaque mail references are useful during the check, not in console output.
    for (const field of ["create", "update", "discard"]) {
      const view = summary[field] as CloudDraftView | undefined;
      if (view) delete view.messageId;
    }
    console.log(JSON.stringify(summary));
    await client.close();
  }
}

void main().catch(() => {
  console.error("Cloud draft check could not start; verify configuration and the built MCP server.");
  process.exitCode = 1;
});
