/** Test helpers for authentication (WI-26): fast fake scrypt, users with known passwords. */
import { createHash } from 'node:crypto';
import { hashPassword, type ScryptFn } from '../password.js';
import type { AppEnv } from './helpers.js';

/** Fast deterministic stand-in for scrypt (the real one is covered by auth.test.ts). */
export const fakeScrypt: ScryptFn = async (password, salt, keyLength) =>
  createHash('sha512').update(salt).update(password).digest().subarray(0, keyLength);

/** User → password (alice admin, olga operator, victor viewer). */
export const AUTH_PASSWORDS = { alice: 'alice-password-1', olga: 'olga-password-1', victor: 'victor-password-1' } as const;

const HASHES: Record<string, string> = {
  PW_ALICE: await hashPassword(AUTH_PASSWORDS.alice, fakeScrypt),
  PW_OLGA: await hashPassword(AUTH_PASSWORDS.olga, fakeScrypt),
  PW_VICTOR: await hashPassword(AUTH_PASSWORDS.victor, fakeScrypt),
};

/** `auth:` block for config.yaml (password mode). */
export const PASSWORD_AUTH_CONFIG = [
  'auth:',
  '  mode: password',
  '  session_ttl: 1h',
  '  users:',
  '    - { name: alice, password_hash_env: PW_ALICE, role: admin }',
  '    - { name: olga, password_hash_env: PW_OLGA, role: operator }',
  '    - { name: victor, password_hash_env: PW_VICTOR, role: viewer }',
  '',
].join('\n');

/** App options for fast auth tests (fake scrypt, no failure delay). */
export const FAST_AUTH = { auth: { scrypt: fakeScrypt, sleep: async () => undefined } };

/** Put the password hashes into the app environment (call before the app is created). */
export function authEnvSetup(env: Pick<AppEnv, 'env'>): void {
  Object.assign(env.env, HASHES);
}
