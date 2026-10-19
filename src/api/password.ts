/**
 * Password hashes of `auth.mode: password` (WI-26): scrypt from `node:crypto`.
 *
 * Format (no `$`, so it survives shells and environment files unquoted):
 * `scrypt:<N>:<r>:<p>:<salt base64url>:<hash base64url>`. Defaults: N = 2^15,
 * r = 8, p = 1 (≈ 32 MiB, ~50–100 ms per check), 16-byte salt, 32-byte key.
 * Parameters of a stored hash are bounded so a bad hash cannot exhaust
 * memory/CPU. The comparison uses `timingSafeEqual`.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/** Default scrypt parameters for new hashes. */
export const SCRYPT_DEFAULTS = { N: 32768, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;

const MIN_LOG_N = 14;
const MAX_LOG_N = 20;
const MAX_R = 32;
const MAX_P = 16;
/** Upper bound of the scrypt memory (128·N·r) a stored hash may demand: 256 MiB (default parameters: 32 MiB). */
const MAX_MEM = 256 * 1024 * 1024;

/** scrypt as a promise (injectable for tests). */
export type ScryptFn = (password: string, salt: Buffer, keyLength: number, options: ScryptOptions) => Promise<Buffer>;

export const nodeScrypt: ScryptFn = (password, salt, keyLength, options) =>
  new Promise((resolve, reject) => {
    scryptCb(password, salt, keyLength, options, (err, key) => (err ? reject(err) : resolve(key)));
  });

/** Parsed hash. */
export interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

/** Parse a stored hash; `null` if malformed or outside the accepted parameter bounds. */
export function parsePasswordHash(value: string | undefined): ParsedHash | null {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  if (!/^\d+$/.test(n) || !/^\d+$/.test(r) || !/^\d+$/.test(p)) return null;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  const logN = Math.log2(N);
  if (!Number.isInteger(logN) || logN < MIN_LOG_N || logN > MAX_LOG_N) return null;
  if (R < 1 || R > MAX_R || P < 1 || P > MAX_P) return null;
  if (128 * N * R > MAX_MEM) return null;
  if (!B64URL.test(salt) || !B64URL.test(hash)) return null;
  const saltBuf = Buffer.from(salt, 'base64url');
  const hashBuf = Buffer.from(hash, 'base64url');
  if (saltBuf.length < 16 || hashBuf.length < 16 || hashBuf.length > 128) return null;
  return { N, r: R, p: P, salt: saltBuf, hash: hashBuf };
}

function options(h: Pick<ParsedHash, 'N' | 'r' | 'p'>): ScryptOptions {
  return { N: h.N, r: h.r, p: h.p, maxmem: MAX_MEM };
}

/** Create a hash for `password` (CLI `adispatch auth hash-password`). */
export async function hashPassword(password: string, scrypt: ScryptFn = nodeScrypt): Promise<string> {
  const salt = randomBytes(SCRYPT_DEFAULTS.saltLength);
  const { N, r, p, keyLength } = SCRYPT_DEFAULTS;
  const key = await scrypt(password, salt, keyLength, options({ N, r, p }));
  return `scrypt:${N}:${r}:${p}:${salt.toString('base64url')}:${key.toString('base64url')}`;
}

/** A hash that never matches, used for unknown users so they cost the same scrypt run (no user enumeration). */
export function dummyHash(like?: Pick<ParsedHash, 'N' | 'r' | 'p'> | null): ParsedHash {
  const { N, r, p } = like ?? SCRYPT_DEFAULTS;
  return { N, r, p, salt: randomBytes(SCRYPT_DEFAULTS.saltLength), hash: randomBytes(SCRYPT_DEFAULTS.keyLength) };
}

/**
 * Check `password` against `stored` in constant time: always one scrypt run
 * with the stored parameters, then `timingSafeEqual` over equal-length buffers.
 */
export async function verifyPassword(password: string, stored: ParsedHash, scrypt: ScryptFn = nodeScrypt): Promise<boolean> {
  const key = await scrypt(password, stored.salt, stored.hash.length, options(stored));
  return key.length === stored.hash.length && timingSafeEqual(key, stored.hash);
}
