export interface FolderLocator {
  accountId: string;
  mailbox: string;
}

export interface MessageLocator extends FolderLocator {
  uidValidity: string;
  uid: number;
}

export interface MailSearchFilters {
  query?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  body?: string;
  subject?: string;
  text?: string;
  unread?: boolean;
  flagged?: boolean;
  answered?: boolean;
  draft?: boolean;
  deleted?: boolean;
  after?: string;
  before?: string;
  hasAttachments?: boolean;
  minSize?: number;
  maxSize?: number;
}

export interface MailSummary {
  id: string;
  accountId: string;
  accountName: string;
  mailboxName: string;
  uid: number;
  subject: string;
  from: Array<{ name?: string; address: string }>;
  to: Array<{ name?: string; address: string }>;
  cc: Array<{ name?: string; address: string }>;
  date?: string;
  flags: string[];
  unread: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  size?: number;
  url: string;
}

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  size: number;
  contentDisposition?: string;
  checksum?: string;
  cid?: string;
  content?: Buffer;
}

export interface ParsedMessage {
  subject: string;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  date?: string;
  from: Array<{ name?: string; address: string }>;
  sender: Array<{ name?: string; address: string }>;
  replyTo: Array<{ name?: string; address: string }>;
  to: Array<{ name?: string; address: string }>;
  cc: Array<{ name?: string; address: string }>;
  bcc: Array<{ name?: string; address: string }>;
  text: string;
  truncated: boolean;
  attachments: ParsedAttachment[];
  headers: {
    autoSubmitted?: string;
    precedence?: string;
    listId?: string;
  };
}

export interface ContactRecord {
  email: string;
  name?: string;
  accounts: string[];
  messageCount: number;
  lastSeen?: string;
}
