import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftStore, type StoredDraft } from "../src/drafts.js";
import type { SendResult } from "../src/smtp.js";

type DraftInput = Omit<
  StoredDraft,
  "id" | "revision" | "createdAt" | "updatedAt" | "preview"
>;

const acceptedResult: SendResult = {
  status: "accepted",
  accepted: ["friend@example.com"],
  rejected: [],
  detail: "accepted by test SMTP server",
};

const rejectedResult: SendResult = {
  status: "rejected",
  accepted: [],
  rejected: ["friend@example.com"],
  detail: "rejected by test SMTP server",
};

function draftInput(overrides: Partial<DraftInput> = {}): DraftInput {
  return {
    mode: "new",
    accountId: "work",
    to: ["friend@example.com"],
    cc: [],
    bcc: [],
    subject: "Status",
    bodyText: "Hello",
    attachments: [],
    references: [],
    warnings: [],
    ...overrides,
  };
}

describe("DraftStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses optimistic revisions and invalidates an old preview after update", () => {
    const store = new DraftStore(10, 60);
    const draft = store.create(draftInput());
    const preview = store.preview(draft.id, 1);

    const updated = store.update(draft.id, 1, (current) => {
      current.bodyText = "Changed after preview";
    });

    expect(updated.revision).toBe(2);
    expect(updated.preview).toBeUndefined();
    expect(() => store.update(draft.id, 1, () => undefined)).toThrow("draft revision conflict");
    expect(() =>
      store.authorizeSend(draft.id, 2, preview.confirmationToken, "send-1"),
    ).toThrow("confirmation token is invalid");
  });

  it("expires preview confirmation tokens", () => {
    const store = new DraftStore(10, 60);
    const draft = store.create(draftInput());
    const preview = store.preview(draft.id, draft.revision);

    vi.advanceTimersByTime(60_001);

    expect(() =>
      store.authorizeSend(draft.id, draft.revision, preview.confirmationToken, "send-1"),
    ).toThrow("confirmation token expired");
  });

  it("expires unsent drafts after the configured audit window", () => {
    const store = new DraftStore(10, 60);
    const draft = store.create(draftInput());

    vi.advanceTimersByTime(4 * 60_000 + 1);

    expect(() => store.get(draft.id)).toThrow("draft was not found or expired");
  });

  it("consumes a confirmation token and returns the recorded result on idempotent replay", () => {
    const store = new DraftStore(10, 60);
    const draft = store.create(draftInput());
    const preview = store.preview(draft.id, draft.revision);
    const authorized = store.authorizeSend(
      draft.id,
      draft.revision,
      preview.confirmationToken,
      "stable-key",
    );

    expect(authorized.prior).toBeUndefined();
    expect(() =>
      store.authorizeSend(draft.id, draft.revision, preview.confirmationToken, "second-key"),
    ).toThrow("confirmation token is invalid");

    store.recordSend("stable-key", authorized.draft, authorized.digest, acceptedResult);
    const replay = store.authorizeSend(draft.id, draft.revision, "not-needed", "stable-key");

    expect(replay.prior).toEqual(acceptedResult);
  });

  it("does not allow an idempotency key to identify a different draft", () => {
    const store = new DraftStore(10, 60);
    const first = store.create(draftInput());
    const firstPreview = store.preview(first.id, first.revision);
    const firstAuthorization = store.authorizeSend(
      first.id,
      first.revision,
      firstPreview.confirmationToken,
      "shared-key",
    );
    store.recordSend("shared-key", first, firstAuthorization.digest, acceptedResult);

    const second = store.create(draftInput({ subject: "Different" }));
    const secondPreview = store.preview(second.id, second.revision);

    expect(() =>
      store.authorizeSend(
        second.id,
        second.revision,
        secondPreview.confirmationToken,
        "shared-key",
      ),
    ).toThrow("idempotency key was already used for a different message");
  });

  it("records a definite rejection idempotently while keeping the draft editable", () => {
    const store = new DraftStore(10, 60);
    const draft = store.create(draftInput());
    const preview = store.preview(draft.id, draft.revision);
    const authorized = store.authorizeSend(
      draft.id,
      draft.revision,
      preview.confirmationToken,
      "rejected-key",
    );
    store.recordAttempt("rejected-key", authorized.draft, authorized.digest, rejectedResult);

    const replay = store.authorizeSend(draft.id, draft.revision, "consumed", "rejected-key");
    expect(replay.prior).toEqual(rejectedResult);
    expect(store.get(draft.id).bodyText).toBe("Hello");

    const updated = store.update(draft.id, draft.revision, (candidate) => {
      candidate.to = ["other@example.com"];
    });
    expect(updated.revision).toBe(2);
    expect(() =>
      store.authorizeSend(draft.id, updated.revision, "unused", "rejected-key"),
    ).toThrow("idempotency key was already used for a different message");
  });

  it("binds the preview digest to attachment bytes, not only attachment metadata", () => {
    const store = new DraftStore(10, 60);
    const draft = store.create(
      draftInput({
        attachments: [
          {
            filename: "report.txt",
            contentType: "text/plain",
            content: Buffer.from("approved"),
          },
        ],
      }),
    );
    const preview = store.preview(draft.id, draft.revision);

    // Same length and metadata, different bytes: authorization must still fail.
    draft.attachments[0]!.content = Buffer.from("tampered");

    expect(() =>
      store.authorizeSend(draft.id, draft.revision, preview.confirmationToken, "send-attachment"),
    ).toThrow("draft changed after preview");
  });

  it("zeroes superseded attachment buffers after a successful update", () => {
    const store = new DraftStore(10, 60);
    const oldContent = Buffer.from("sensitive-old-attachment");
    const draft = store.create(
      draftInput({
        attachments: [{ filename: "old.txt", content: oldContent }],
      }),
    );

    const updated = store.update(draft.id, draft.revision, (candidate) => {
      candidate.attachments = [
        { filename: "new.txt", content: Buffer.from("replacement") },
      ];
    });

    expect(oldContent.every((byte) => byte === 0)).toBe(true);
    expect(updated.attachments[0]!.content.toString("utf8")).toBe("replacement");
  });
});
