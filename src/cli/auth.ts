/**
 * `adispatch auth hash-password` (WI-26): reads a password and prints its
 * scrypt hash for `auth.users[].password_hash_env`.
 *
 * - Terminal: asks twice without echo (raw mode), Ctrl-C aborts (exit 130).
 * - Pipe/file: reads the first line of stdin (`printf '%s' "$PW" | adispatch auth hash-password`).
 *
 * The password is never printed or logged; only the hash goes to stdout.
 * Exit codes: 0 = hash printed, 1 = input mismatch/empty/too short, 130 = aborted.
 */
import { hashPassword } from '../api/index.js';
import type { CliIo } from './program.js';

/** Minimum password length accepted by `hash-password`. */
export const MIN_PASSWORD_LENGTH = 8;

/** stdin as seen by the command (injectable for tests). */
export interface PasswordInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  removeAllListeners(event?: string): unknown;
  resume?(): unknown;
  pause?(): unknown;
  setEncoding?(enc: BufferEncoding): unknown;
}

export interface HashPasswordDeps {
  stdin?: PasswordInput;
  hash?: (password: string) => Promise<string>;
}

const ABORTED = Symbol('aborted');

/** Read one line from a terminal without echo. */
function readHidden(input: PasswordInput, io: Pick<CliIo, 'stderr'>, prompt: string): Promise<string | typeof ABORTED> {
  return new Promise((resolve) => {
    io.stderr(prompt);
    input.setRawMode?.(true);
    input.resume?.();
    let value = '';
    const done = (result: string | typeof ABORTED): void => {
      input.setRawMode?.(false);
      input.pause?.();
      input.removeAllListeners('data');
      io.stderr('\n');
      resolve(result);
    };
    input.on('data', (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\u0003' || ch === '\u0004') return done(ABORTED); // Ctrl-C / Ctrl-D
        if (ch === '\r' || ch === '\n') return done(value);
        if (ch === '\u007f' || ch === '\b') value = [...value].slice(0, -1).join('');
        else if (ch >= ' ') value += ch;
      }
    });
  });
}

/** Read stdin completely (pipe) and return its first line. */
function readFirstLine(input: PasswordInput): Promise<{ line: string; more: boolean }> {
  return new Promise((resolve) => {
    let data = '';
    input.setEncoding?.('utf8');
    input.on('data', (chunk) => {
      data += String(chunk);
    });
    input.on('end', () => {
      const lines = data.replace(/\r?\n$/, '').split(/\r?\n/);
      resolve({ line: lines[0] ?? '', more: lines.length > 1 });
    });
    input.resume?.();
  });
}

/** Create the `auth hash-password` handler. */
export function createHashPasswordHandler(io: Pick<CliIo, 'stdout' | 'stderr'>, deps: HashPasswordDeps = {}) {
  return async (): Promise<number> => {
    const input = deps.stdin ?? (process.stdin as unknown as PasswordInput);
    const hash = deps.hash ?? ((pw: string) => hashPassword(pw));
    let password: string;
    if (input.isTTY) {
      const first = await readHidden(input, io, 'Password: ');
      if (first === ABORTED) return 130;
      const second = await readHidden(input, io, 'Repeat password: ');
      if (second === ABORTED) return 130;
      if (first !== second) {
        io.stderr('auth hash-password: the passwords do not match\n');
        return 1;
      }
      password = first;
    } else {
      const { line, more } = await readFirstLine(input);
      if (more) {
        io.stderr('auth hash-password: expected exactly one line on stdin\n');
        return 1;
      }
      password = line;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      io.stderr(`auth hash-password: the password must have at least ${MIN_PASSWORD_LENGTH} characters\n`);
      return 1;
    }
    io.stdout(`${await hash(password)}\n`);
    io.stderr('Store it in the service environment (e.g. ADISPATCH_PW_ALICE=<hash> in /etc/default/adispatchd) and reference it as password_hash_env.\n');
    return 0;
  };
}
