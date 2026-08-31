import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listFolders: vi.fn(),
  searchMailbox: vi.fn(),
  searchThreadMailbox: vi.fn(),
  fetchParsedMessage: vi.fn(),
  scanContacts: vi.fn(),
  updateFlags: vi.fn(),
  moveMessage: vi.fn(),
  copyMessage: vi.fn(),
  permanentlyDeleteMessage: vi.fn(),
  manageFolder: vi.fn(),
  fetchAttachmentSource: vi.fn(),
  appendSentCopy: vi.fn(),
}));

vi.mock("../src/imap.js", () => ({
  ...mocks,
  structureHasAttachments: (node: unknown) =>
    Boolean((node as { attached?: boolean } | undefined)?.attached),
}));

import { AppConfigSchema, type LoadedConfig } from "../src/config.js";
import { MailService } from "../src/service.js";

function loadedConfig(): LoadedConfig {
  const config = AppConfigSchema.parse({
    version: 1,
    accounts: [
      {
        id: "test",
        displayName: "Test Mail",
        email: "me@example.test",
        secretRef: "TEST_MAIL_SECRET",
        imap: { host: "imap.example.test", port: 993, tls: "implicit" },
        smtp: { host: "smtp.example.test", port: 465, tls: "implicit" },
      },
    ],
    limits: {},
  });
  return {
    config,
    credentials: new Map([
      ["TEST_MAIL_SECRET", { username: "me@example.test", password: "test-secret" }],
    ]),
    paths: { config: "accounts.json", credentials: "credentials.json" },
  };
}

function rawMessage(
  uid: number,
  subject: string,
  messageId: string,
  date: string,
  mailbox = "INBOX",
) {
  return {
    mailbox,
    uidValidity: 7n,
    message: {
      uid,
      envelope: {
        subject,
        messageId,
        date: new Date(date),
        from: [{ address: "sender@example.test" }],
        to: [{ address: "me@example.test" }],
        cc: [],
      },
      flags: new Set<string>(),
      internalDate: new Date(date),
      size: 123,
      bodyStructure: { type: "text" },
    },
  };
}

function parsedSource(messageId?: string) {
  return {
    parsed: {
      subject: "Source",
      ...(messageId ? { messageId } : {}),
      references: [],
      from: [{ address: "sender@example.test" }],
      sender: [],
      replyTo: [],
      to: [{ address: "me@example.test" }],
      cc: [],
      bcc: [],
      text: "source body",
      truncated: false,
      attachments: [],
      headers: {},
      date: "2026-01-02T00:00:00.000Z",
    },
    flags: [],
    size: 123,
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.listFolders.mockResolvedValue([
    {
      path: "INBOX",
      name: "INBOX",
      delimiter: "/",
      selectable: true,
      subscribed: true,
    },
  ]);
  mocks.scanContacts.mockResolvedValue({ contacts: [], errors: [] });
});

async function sourceId(service: MailService, source = rawMessage(
  42,
  "Source",
  "<source@example.test>",
  "2026-01-02T00:00:00.000Z",
)) {
  mocks.searchMailbox.mockResolvedValue({
    items: [source],
    hasMore: false,
    candidateLimitReached: false,
  });
  const found = await service.search({ accountId: "test", query: "Source", limit: 10 });
  return found.results[0]!.id;
}

describe("MailService bounded pagination", () => {
  it("keeps a safe cursor while known bounded results remain", async () => {
    const service = new MailService(loadedConfig());
    mocks.listFolders.mockResolvedValue([
      { path: "INBOX", name: "INBOX", delimiter: "/", selectable: true, subscribed: true },
    ]);
    mocks.searchMailbox.mockResolvedValue({
      items: [
        rawMessage(2, "newer", "<newer@example.test>", "2026-01-02T00:00:00.000Z"),
        rawMessage(1, "older", "<older@example.test>", "2026-01-01T00:00:00.000Z"),
      ],
      hasMore: true,
      candidateLimitReached: true,
    });

    const first = await service.search({
      accountId: "test",
      folderScope: "all",
      query: "bounded",
      limit: 1,
    });
    expect(first.results.map((item) => item.subject)).toEqual(["newer"]);
    expect(first.partial).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await service.search({
      accountId: "test",
      folderScope: "all",
      query: "bounded",
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.results.map((item) => item.subject)).toEqual(["older"]);
    expect(second.nextCursor).toBeUndefined();
    expect(second.hasMore).toBe(true);
  });

  it("lets an unbounded source advance even when another source hit its ceiling", async () => {
    const service = new MailService(loadedConfig());
    mocks.listFolders.mockResolvedValue([
      { path: "INBOX", name: "INBOX", delimiter: "/", selectable: true, subscribed: true },
      { path: "Archive", name: "Archive", delimiter: "/", selectable: true, subscribed: true },
    ]);
    mocks.searchMailbox.mockImplementation(
      async (_runtime, _config, mailbox: string, _filters, requestedLimit: number) => {
        if (mailbox === "INBOX") {
          return { items: [], hasMore: true, candidateLimitReached: true };
        }
        const items = [
          rawMessage(3, "archive-newer", "<a3@example.test>", "2026-01-03T00:00:00.000Z", "Archive"),
          rawMessage(2, "archive-older", "<a2@example.test>", "2026-01-02T00:00:00.000Z", "Archive"),
        ];
        return {
          items: items.slice(0, Math.max(1, requestedLimit - 1)),
          hasMore: requestedLimit <= 2,
          candidateLimitReached: false,
        };
      },
    );

    const first = await service.search({
      accountId: "test",
      folderScope: "all",
      query: "archive",
      limit: 1,
    });
    expect(first.results[0]!.subject).toBe("archive-newer");
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await service.search({
      accountId: "test",
      folderScope: "all",
      query: "archive",
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.results[0]!.subject).toBe("archive-older");
  });
});

describe("MailService thread view", () => {
  it("always keeps the selected source and reports global truncation", async () => {
    const service = new MailService(loadedConfig());
    const id = await sourceId(service);
    mocks.fetchParsedMessage.mockResolvedValue(parsedSource("<source@example.test>"));
    mocks.searchThreadMailbox.mockResolvedValue({
      items: [
        rawMessage(41, "Earlier", "<earlier@example.test>", "2026-01-01T00:00:00.000Z"),
      ],
      hasMore: false,
      candidateLimitReached: false,
    });

    const thread = await service.getThread(id, 1);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]!.id).toBe(id);
    expect(thread.messages[0]).not.toHaveProperty("text");
    expect(thread.hasMore).toBe(true);
    expect(thread.partial).toBe(true);
  });

  it("uses the same summary shape when threading headers are unavailable", async () => {
    const service = new MailService(loadedConfig());
    const id = await sourceId(service);
    mocks.fetchParsedMessage.mockResolvedValue(parsedSource());

    const thread = await service.getThread(id, 10);
    expect(thread.threading).toBe("unavailable_without_message_id");
    expect(thread.messages[0]!.id).toBe(id);
    expect(thread.messages[0]).toMatchObject({ subject: "Source", uid: 42 });
    expect(thread.messages[0]).not.toHaveProperty("text");
    expect(thread.hasMore).toBe(false);
    expect(thread.partial).toBe(false);
  });
});
