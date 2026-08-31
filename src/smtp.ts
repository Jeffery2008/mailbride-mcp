import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type SMTPConnection from "nodemailer/lib/smtp-connection/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";
import { appendSentCopy } from "./imap.js";
import type { AccountRuntime } from "./imap.js";
import type { AppConfig } from "./config.js";
import type { StoredDraft } from "./drafts.js";
import { sanitizeMessageId } from "./mail/parse.js";

export interface SendResult {
  status: "accepted" | "partial" | "rejected" | "unknown";
  messageId?: string;
  accepted: string[];
  rejected: string[];
  response?: string;
  detail: string;
  sentCopy?: "provider" | "saved" | "not_saved";
}

function smtpAuth(runtime: AccountRuntime): SMTPConnection.AuthenticationType {
  const secret = runtime.secret;
  if ("password" in secret && typeof secret.password === "string") {
    return { type: "login", user: secret.username, pass: secret.password };
  }
  return { type: "OAuth2", user: secret.username, accessToken: secret.accessToken };
}

function asStrings(values: Array<string | Mail.Address> | undefined): string[] {
  return (values || []).map((entry) => (typeof entry === "string" ? entry : entry.address));
}

export function mailOptionsFromDraft(runtime: AccountRuntime, draft: StoredDraft): Mail.Options {
  const options: Mail.Options = {
    from: { name: runtime.account.displayName, address: runtime.account.email },
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    text: draft.bodyText,
    attachments: draft.attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: attachment.content,
    })),
    disableFileAccess: true,
    disableUrlAccess: true,
    xMailer: "mailbride-mcp/0.1.0",
  };
  if (draft.bodyHtml) options.html = draft.bodyHtml;
  if (draft.inReplyTo) {
    const valid = sanitizeMessageId(draft.inReplyTo);
    if (!valid) throw new Error("draft contains an invalid In-Reply-To message id");
    options.inReplyTo = valid;
  }
  if (draft.references.length) {
    const references = draft.references.map(sanitizeMessageId);
    if (references.some((value) => !value)) throw new Error("draft contains an invalid References message id");
    options.references = references as string[];
  }
  return options;
}

export async function composeDraftSource(runtime: AccountRuntime, draft: StoredDraft): Promise<Buffer> {
  return (await composeDraftDelivery(runtime, draft)).raw;
}

async function composeDraftDelivery(runtime: AccountRuntime, draft: StoredDraft) {
  const message = new MailComposer(mailOptionsFromDraft(runtime, draft)).compile();

  // Capture the SMTP envelope before serializing. MimeNode intentionally omits
  // the Bcc header from the serialized message while retaining BCC recipients
  // in this envelope. Generate the Message-ID before build() so the exact same
  // ID is present in both the SMTP payload and an optional IMAP Sent copy.
  const envelope = message.getEnvelope();
  const messageId = message.messageId();
  const raw = await message.build();
  return { envelope, messageId, raw };
}

export async function sendDraft(runtime: AccountRuntime, draft: StoredDraft, config: AppConfig): Promise<SendResult> {
  const implicitTls = runtime.account.smtp.tls === "implicit";
  const transportOptions: SMTPTransport.Options = {
    host: runtime.account.smtp.host,
    port: runtime.account.smtp.port,
    secure: implicitTls,
    requireTLS: !implicitTls,
    opportunisticTLS: false,
    auth: smtpAuth(runtime),
    tls: {
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      servername: runtime.account.smtp.host,
    },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
  const transporter = nodemailer.createTransport(transportOptions);

  try {
    const delivery = await composeDraftDelivery(runtime, draft);
    const info = await transporter.sendMail({
      raw: delivery.raw,
      envelope: delivery.envelope,
      messageId: delivery.messageId,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    const accepted = asStrings(info.accepted);
    const rejected = asStrings(info.rejected);
    const status: SendResult["status"] =
      accepted.length > 0 && rejected.length === 0
        ? "accepted"
        : accepted.length > 0
          ? "partial"
          : "rejected";
    const sendResult: SendResult = {
      status,
      messageId: info.messageId,
      accepted,
      rejected,
      response: info.response,
      detail:
        status === "accepted"
          ? "The SMTP server accepted every recipient. This is not a guarantee of final delivery."
          : status === "partial"
            ? "The SMTP server accepted some recipients and rejected others. Do not automatically resend to accepted recipients."
            : "The SMTP server did not accept any recipient.",
      sentCopy: runtime.account.sentCopyMode === "provider" ? "provider" : "not_saved",
    };
    if (status === "accepted" || status === "partial") {
      if (runtime.account.sentCopyMode === "imap_append") {
        const sentMailbox = runtime.account.folders.sent;
        if (!sentMailbox) {
          sendResult.detail += " Sent copy was not saved because no sent folder is configured.";
          sendResult.sentCopy = "not_saved";
        } else {
          try {
            await appendSentCopy(runtime, config, sentMailbox, delivery.raw);
            sendResult.sentCopy = "saved";
          } catch (error) {
            sendResult.sentCopy = "not_saved";
            const detail = error instanceof Error ? error.message : String(error);
            sendResult.detail += ` Sent copy could not be saved: ${detail.slice(0, 300)}`;
          }
        }
      }
    }
    return sendResult;
  } catch (error) {
    const smtpError = error as Error & {
      code?: string;
      command?: string;
      response?: string;
      responseCode?: number;
    };
    const code = smtpError.code?.toUpperCase();
    // Nodemailer reports unexpected closes and socket timeouts as command=CONN
    // even when they happen after DATA, so neither command nor ECONNECTION is
    // sufficient to prove that a message was not accepted.
    const definitelyRejected =
      code === "EENVELOPE" ||
      code === "EAUTH" ||
      code === "EDNS" ||
      code === "ETLS" ||
      (smtpError.responseCode ?? 0) >= 500;
    return {
      status: definitelyRejected ? "rejected" : "unknown",
      accepted: [],
      rejected: [],
      ...(smtpError.response ? { response: smtpError.response.slice(0, 1000) } : {}),
      detail: definitelyRejected
        ? "The message was definitely not accepted or submitted. Fix the connection, authentication, or envelope, then edit or preview the preserved draft before retrying."
        : "The SMTP outcome is unknown because the connection failed or timed out. Do not retry automatically; verify the Sent folder first to avoid duplicates.",
      sentCopy: "not_saved",
    };
  } finally {
    transporter.close();
  }
}
