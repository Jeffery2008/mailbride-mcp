import { describe, expect, it, vi } from "vitest";
import type { FetchMessageObject } from "imapflow";

/**
 * searchMailbox is deliberately tested against a tiny ImapFlow double.  The
 * real client is a protocol transport; the important contract here is the
 * sequence windows and the bounded fetches issued through that transport.
 */
const mocks = vi.hoisted(() => ({
  exists: 0,
  search: vi.fn(),
  fetch: vi.fn(),
  clients: [] as Array<{
    mailbox?: { uidValidity: bigint; exists: number };
  }>,
}));

vi.mock("imapflow", () => ({
  ImapFlow: class FakeImapFlow {
    capabilities = new Map<string, true>();
    enabled = new Set<string>();
    mailbox = { uidValidity: 7n, exists: mocks.exists };

    constructor() {
      mocks.clients.push(this);
    }

    on() {
      return this;
    }

    async connect() {}

    async logout() {}

    close() {}

    async getMailboxLock() {
      return { release() {} };
    }

    search(...args: unknown[]) {
      return mocks.search(...args);
    }

    fetch(...args: unknown[]) {
      return mocks.fetch(...args);
    }
  },
}));

import { searchMailbox, searchThreadMailbox, type AccountRuntime } from "../src/imap.js";
import type { AppConfig } from "../src/config.js";

const runtime = {
  account: {
    id: "test",
    imap: { host: "imap.example.test", port: 993, tls: "implicit" },
  },
  secret: { username: "test@example.test", password: "test-secret" },
} as AccountRuntime;

const config = (maxSearchCandidatesPerFolder = 5_000) =>
  ({
    limits: {
      maxMessageBytes: 1_000_000,
      maxSearchCandidatesPerFolder,
    },
  }) as AppConfig;

function parseRange(value: unknown): [number, number] {
  const range = (value as { seq?: unknown }).seq;
  expect(typeof range).toBe("string");
  const match = String(range).match(/^(\d+):(\d+)$/u);
  if (!match) throw new Error(`unexpected sequence range: ${String(range)}`);
  return [Number(match[1]), Number(match[2])];
}

function message(uid: number, attached = false): FetchMessageObject {
  return {
    seq: uid,
    uid,
    envelope: {
      subject: `message-${uid}`,
      from: [{ address: `sender-${uid}@example.test` }],
      to: [{ address: "test@example.test" }],
      cc: [],
      bcc: [],
    },
    flags: new Set<string>(),
    internalDate: new Date(uid * 1_000).toISOString(),
    size: 100,
    bodyStructure: attached
      ? { type: "application/octet-stream", disposition: "attachment" }
      : { type: "text" },
  };
}

function addressedMessage(
  uid: number,
  fields: { cc?: string[]; bcc?: string[] } = {},
) {
  const value = message(uid);
  if (fields.cc) value.envelope!.cc = fields.cc.map((address) => ({ address }));
  if (fields.bcc) value.envelope!.bcc = fields.bcc.map((address) => ({ address }));
  return value;
}

function setSearchScenario(
  searchForRange: (low: number, high: number) => number[] | false,
  fetchForUids: (uids: number[]) => Array<ReturnType<typeof message>>,
) {
  mocks.search.mockImplementation(async (query: unknown) => {
    const [low, high] = parseRange(query);
    return searchForRange(low, high);
  });
  mocks.fetch.mockImplementation((uids: unknown) => {
    const values = Array.isArray(uids) ? uids.map(Number) : [];
    const rows = fetchForUids(values);
    return (async function* () {
      for (const row of rows) yield row;
    })();
  });
}

function resetMocks(exists: number) {
  mocks.exists = exists;
  mocks.search.mockReset();
  mocks.fetch.mockReset();
  mocks.clients.length = 0;
}

describe("bounded IMAP mailbox search", () => {
  it("compiles free-text search into portable fields instead of TEXT", async () => {
    resetMocks(10);
    let observedQuery: Record<string, unknown> | undefined;
    mocks.search.mockImplementation(async (query: unknown) => {
      observedQuery = query as Record<string, unknown>;
      const [low, high] = parseRange(query);
      return low === 1 && high === 10 ? [10] : [];
    });
    mocks.fetch.mockImplementation((uids: unknown) => {
      const rows = (Array.isArray(uids) ? uids : []).map((uid) => message(Number(uid)));
      return (async function* () {
        for (const row of rows) yield row;
      })();
    });

    const result = await searchMailbox(runtime, config(), "INBOX", { query: "needle" }, 1, 0);

    expect(result.items.map((item) => item.message.uid)).toEqual([10]);
    expect(observedQuery).not.toHaveProperty("text");
    expect(observedQuery?.or).toEqual([
      { subject: "needle" },
      { body: "needle" },
      { from: "needle" },
      { to: "needle" },
    ]);
  });

  it("verifies CC and BCC against fetched envelopes when providers ignore those keys", async () => {
    resetMocks(5);
    const queries: Array<Record<string, unknown>> = [];
    mocks.search.mockImplementation(async (query: unknown) => {
      queries.push(query as Record<string, unknown>);
      const [low, high] = parseRange(query);
      return low === 1 && high === 5 ? [5, 4, 3, 2, 1] : [];
    });
    mocks.fetch.mockImplementation((uids: unknown) => {
      const rows = (Array.isArray(uids) ? uids : []).map((uid) => {
        const value = Number(uid);
        if (value === 4) return addressedMessage(value, { cc: ["target@example.test"] });
        if (value === 2) return addressedMessage(value, { bcc: ["target@example.test"] });
        return addressedMessage(value);
      });
      return (async function* () {
        for (const row of rows) yield row;
      })();
    });

    const ccResult = await searchMailbox(runtime, config(), "INBOX", { cc: "target" }, 1, 0);
    const bccResult = await searchMailbox(runtime, config(), "INBOX", { bcc: "target" }, 1, 0);

    expect(ccResult.items.map((item) => item.message.uid)).toEqual([4]);
    expect(ccResult.hasMore).toBe(false);
    expect(bccResult.items.map((item) => item.message.uid)).toEqual([2]);
    expect(bccResult.hasMore).toBe(false);
    expect(queries.every((query) => !Object.prototype.hasOwnProperty.call(query, "cc"))).toBe(true);
    expect(queries.every((query) => !Object.prototype.hasOwnProperty.call(query, "bcc"))).toBe(true);
  });

  it("walks newest-to-oldest sequence windows without gaps or overlap", async () => {
    resetMocks(1_001);
    const ranges: Array<[number, number]> = [];
    setSearchScenario((low, high) => {
      ranges.push([low, high]);
      return [];
    }, (uids) => uids.map((uid) => message(uid)));

    const result = await searchMailbox(runtime, config(), "INBOX", { query: "needle" }, 1, 0);

    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.candidateLimitReached).toBe(false);
    expect(ranges).toEqual([
      [502, 1_001],
      [2, 501],
      [1, 1],
    ]);
    expect(
      ranges.flatMap(([low, high]) =>
        Array.from({ length: high - low + 1 }, (_, i) => high - i),
      ),
    ).toEqual(Array.from({ length: 1_001 }, (_, i) => 1_001 - i));
  });

  it("stops after the requested page plus look-ahead and fetches only those UIDs", async () => {
    resetMocks(1_200);
    const searched: Array<[number, number]> = [];
    let fetched: number[] = [];
    setSearchScenario((low, high) => {
      searched.push([low, high]);
      // Nothing matches in the newest window; four old messages do.
      if (low === 201 && high === 700) return [700, 600, 500, 400];
      return [];
    }, (uids) => {
      fetched = uids;
      return uids.map((uid) => message(uid));
    });

    const result = await searchMailbox(runtime, config(), "INBOX", { subject: "needle" }, 3, 0);

    expect(searched).toEqual([
      [701, 1_200],
      [201, 700],
    ]);
    expect(fetched).toEqual([700, 600, 500, 400]);
    expect(result.items.map((item) => item.message.uid)).toEqual([700, 600, 500]);
    expect(result.hasMore).toBe(true);
    expect(result.candidateLimitReached).toBe(false);
  });

  it("reports a bounded partial result when the sequence budget is exhausted", async () => {
    resetMocks(1_000);
    const ranges: Array<[number, number]> = [];
    setSearchScenario((low, high) => {
      ranges.push([low, high]);
      return [];
    }, (uids) => uids.map((uid) => message(uid)));

    const result = await searchMailbox(runtime, config(600), "INBOX", { query: "rare" }, 20, 0);

    expect(ranges).toEqual([
      [501, 1_000],
      [401, 500],
    ]);
    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(true);
    expect(result.candidateLimitReached).toBe(true);
  });

  it("does not expand the hard sequence budget for a deep requested page", async () => {
    resetMocks(2_000);
    const ranges: Array<[number, number]> = [];
    setSearchScenario((low, high) => {
      ranges.push([low, high]);
      return Array.from({ length: high - low + 1 }, (_, index) => high - index);
    }, (uids) => uids.map((uid) => message(uid)));

    const result = await searchMailbox(runtime, config(600), "INBOX", {}, 700, 0);

    expect(ranges).toEqual([
      [1_501, 2_000],
      [1_401, 1_500],
    ]);
    expect(result.items).toHaveLength(600);
    expect(result.hasMore).toBe(true);
    expect(result.candidateLimitReached).toBe(true);
  });

  it("surfaces a false SEARCH result as a mailbox failure", async () => {
    resetMocks(10);
    setSearchScenario(() => false, (uids) => uids.map((uid) => message(uid)));

    await expect(
      searchMailbox(runtime, config(), "INBOX", { query: "anything" }, 10, 0),
    ).rejects.toThrow(/search failed/i);
  });

  it("reports when a bounded thread search cannot reach the oldest sequence", async () => {
    resetMocks(1_000);
    setSearchScenario(() => [], (uids) => uids.map((uid) => message(uid)));

    const result = await searchThreadMailbox(
      runtime,
      config(600),
      "INBOX",
      ["<thread@example.test>"],
      10,
    );

    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(true);
    expect(result.scanIncomplete).toBe(true);
    expect(result.candidateLimitReached).toBe(true);
  });

  it("reports thread look-ahead matches found in the terminal sequence window", async () => {
    resetMocks(10);
    let fetched: number[] = [];
    setSearchScenario(
      () => [10, 9, 8, 7],
      (uids) => {
        fetched = uids;
        return uids.map((uid) => message(uid));
      },
    );

    const result = await searchThreadMailbox(
      runtime,
      config(),
      "INBOX",
      ["<thread@example.test>"],
      2,
    );

    expect(fetched).toEqual([10, 9]);
    expect(result.items.map((item) => item.message.uid)).toEqual([10, 9]);
    expect(result.hasMore).toBe(true);
    expect(result.scanIncomplete).toBe(false);
    expect(result.candidateLimitReached).toBe(false);
  });

  it("continues past non-attachment candidates until an attachment page is filled", async () => {
    resetMocks(1_000);
    const fetchedBatches: number[][] = [];
    setSearchScenario(
      (low, high) => {
        // The first window contains all candidates for this test.  Only the
        // third and fourth newest messages have attachments.
        if (low === 501 && high === 1_000) return [1_000, 999, 998, 997];
        return [];
      },
      (uids) => {
        fetchedBatches.push(uids);
        return uids.map((uid) => message(uid, uid === 998 || uid === 997));
      },
    );

    const result = await searchMailbox(
      runtime,
      config(),
      "INBOX",
      { hasAttachments: true },
      2,
      0,
    );

    expect(fetchedBatches.flat()).toEqual([1_000, 999, 998, 997]);
    expect(result.items.map((item) => item.message.uid)).toEqual([998, 997]);
    expect(result.hasMore).toBe(false);
    expect(result.candidateLimitReached).toBe(false);
  });

  it("does not issue SEARCH for an empty mailbox", async () => {
    resetMocks(0);
    setSearchScenario(() => {
      throw new Error("search must not run for an empty mailbox");
    }, (uids) => uids.map((uid) => message(uid)));

    const result = await searchMailbox(runtime, config(), "INBOX", { query: "anything" }, 10, 0);

    expect(result).toEqual({ items: [], hasMore: false, candidateLimitReached: false });
    expect(mocks.search).not.toHaveBeenCalled();
  });
});
