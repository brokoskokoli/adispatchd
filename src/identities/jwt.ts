/**
 * GitHub App JWT (RS256) creation with `node:crypto` (Spec §5.3).
 */
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { SourceError } from '../core/index.js';

/** Seconds subtracted from `iat` to tolerate clock drift (GitHub recommendation). */
export const JWT_IAT_SKEW_SECONDS = 60;

/** JWT lifetime counted from the real "now"; GitHub allows at most 10 minutes. */
export const JWT_LIFETIME_SECONDS = 9 * 60;

/**
 * Normalise a PEM private key from an environment variable: accepts real
 * newlines, literal `\n` escapes (common in `.env` files / systemd units),
 * CRLF and surrounding quotes/whitespace.
 */
export function normalizePrivateKeyPem(raw: string): string {
  let pem = raw.trim();
  if ((pem.startsWith('"') && pem.endsWith('"')) || (pem.startsWith("'") && pem.endsWith("'"))) {
    pem = pem.slice(1, -1).trim();
  }
  return `${pem.replace(/\\r\\n|\\n/g, '\n').replace(/\r\n/g, '\n').trim()}\n`;
}

/**
 * Parse a PEM private key. Throws `SourceError('auth')` with a message that
 * never contains key material.
 */
export function parsePrivateKey(raw: string, label: string): KeyObject {
  try {
    const key = createPrivateKey({ key: normalizePrivateKeyPem(raw), format: 'pem' });
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not an RSA key');
    return key;
  } catch {
    throw new SourceError('auth', `Private key for ${label} is not a valid RSA PEM key`, { retryable: false });
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Create a GitHub App JWT: header `{alg: RS256, typ: JWT}`, payload
 * `{iat: now-60s, exp: now+9min, iss: appId}`.
 */
export function createAppJwt(appId: string | number, privateKey: KeyObject, now: Date): string {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: nowSeconds - JWT_IAT_SKEW_SECONDS,
    exp: nowSeconds + JWT_LIFETIME_SECONDS,
    iss: String(appId),
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${base64url(signature)}`;
}
