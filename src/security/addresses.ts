import type { AddressObject } from "mailparser";

const SIMPLE_EMAIL = /^[^\s<>@,;:\\"\r\n]+@[^\s<>@,;:\\"\r\n]+$/u;
const NO_REPLY = /^(?:do[-_.]?not[-_.]?reply|no[-_.]?reply|noreply|mailer[-_.]?daemon)@/i;

export interface MailAddress {
  name?: string;
  address: string;
}

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function assertEmailAddress(address: string): string {
  const trimmed = address.trim();
  if (!SIMPLE_EMAIL.test(trimmed)) {
    throw new Error(`invalid email address: ${JSON.stringify(address)}`);
  }
  return trimmed;
}

export function isNoReplyAddress(address: string): boolean {
  return NO_REPLY.test(normalizeAddress(address));
}

export function addressDomain(address: string): string {
  return normalizeAddress(address).split("@").at(-1) || "";
}

export function flattenAddressObject(value: AddressObject | AddressObject[] | undefined): MailAddress[] {
  const values = value ? (Array.isArray(value) ? value : [value]) : [];
  const flattened: MailAddress[] = [];
  for (const group of values) {
    for (const entry of group.value || []) {
      if (!entry.address) continue;
      const item: MailAddress = { address: entry.address };
      if (entry.name) item.name = entry.name;
      flattened.push(item);
    }
  }
  return flattened;
}

export function uniqueAddresses(addresses: Iterable<string>, excluded: Iterable<string> = []): string[] {
  const excludedSet = new Set(Array.from(excluded, normalizeAddress));
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of addresses) {
    const valid = assertEmailAddress(raw);
    const normalized = normalizeAddress(valid);
    if (excludedSet.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(valid);
  }
  return output;
}

export function maskEmail(address: string): string {
  const [local = "", domain = ""] = address.split("@");
  const maskedLocal = local.length <= 2 ? `${local.slice(0, 1)}*` : `${local.slice(0, 2)}***`;
  return `${maskedLocal}@${domain}`;
}
