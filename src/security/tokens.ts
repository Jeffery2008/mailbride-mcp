import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

type TokenKind = "folder" | "message" | "cursor";

interface TokenEnvelope<T> {
  kind: TokenKind;
  value: T;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

export class OpaqueTokenCodec {
  readonly #secret: Buffer;

  constructor(secret = randomBytes(32)) {
    this.#secret = secret;
  }

  issue<T>(kind: TokenKind, value: T): string {
    const body = encode({ kind, value } satisfies TokenEnvelope<T>);
    const signature = createHmac("sha256", this.#secret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  read<T>(kind: TokenKind, token: string): T {
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra) throw new Error("invalid opaque reference");
    const expected = createHmac("sha256", this.#secret).update(body).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, "base64url");
    } catch {
      throw new Error("invalid opaque reference");
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("invalid or expired opaque reference");
    }
    let envelope: TokenEnvelope<T>;
    try {
      envelope = decode<TokenEnvelope<T>>(body);
    } catch {
      throw new Error("invalid opaque reference");
    }
    if (envelope.kind !== kind) throw new Error(`reference is not a ${kind} reference`);
    return envelope.value;
  }
}
