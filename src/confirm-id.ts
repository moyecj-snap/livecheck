import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 48-bit timestamp → 10 Crockford chars (ULID time component). */
export function encodeUlidTime(ms: number): string {
  let remaining = Math.max(0, Math.floor(ms));
  let out = "";
  for (let i = 0; i < 10; i += 1) {
    out = CROCKFORD[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

/** 80-bit randomness → 16 Crockford chars (ULID random component). */
export function encodeUlidRandom(bytes = randomBytes(10)): string {
  if (bytes.length < 10) throw new Error("ULID random requires 10 bytes");
  let buffer = 0n;
  for (let i = 0; i < 10; i += 1) {
    buffer = (buffer << 8n) | BigInt(bytes[i]);
  }
  let out = "";
  for (let i = 15; i >= 0; i -= 1) {
    const idx = Number((buffer >> BigInt(i * 5)) & 31n);
    out += CROCKFORD[idx];
  }
  return out;
}

export function ulid(now = Date.now()): string {
  return encodeUlidTime(now) + encodeUlidRandom();
}

/** Stable Confirm id: `cfm_` + Crockford ULID. */
export function newConfirmId(now = Date.now()): string {
  return `cfm_${ulid(now)}`;
}

export function isConfirmId(value: string): boolean {
  return /^cfm_[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

/** Sentinel check id: `chk_` + Crockford ULID. Same receipt store as Confirm. */
export function newCheckId(now = Date.now()): string {
  return `chk_${ulid(now)}`;
}

export function isCheckId(value: string): boolean {
  return /^chk_[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

export function isReceiptId(value: string): boolean {
  return isConfirmId(value) || isCheckId(value);
}
