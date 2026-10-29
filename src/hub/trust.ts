/**
 * Trust channel between a hub and the instances it starts (WI-36).
 *
 * The hub authenticates the browser users, then forwards their identity to the
 * workspace instance (`X-Adispatch-Hub-*` headers, see `api/auth.ts`). So that
 * nobody else can claim an identity on the instance's loopback port, the hub
 * hands every child process a fresh random secret **on its standard input**
 * (one line). It is never put into the environment, the arguments or a file:
 * all of these can be read by other processes of the same user (workers).
 */
import { randomBytes } from 'node:crypto';
import { HUB_TOKEN_PATTERN } from '../api/index.js';

/** A new secret for one child process. */
export function newHubToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Standard input (any readable stream). */
export type TokenInput = NodeJS.ReadableStream;

/**
 * Read the hub's secret: the first line of `input`. Rejects after `timeoutMs`,
 * if the input ends without a valid line, or if the line is not a token.
 */
export function readHubToken(input: TokenInput, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let done = false;
    const finish = (err: Error | null, token?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('close', onEnd);
      input.removeListener('error', onError);
      input.pause();
      if (err) reject(err);
      else resolve(token as string);
    };
    const check = (line: string): void => {
      const token = line.trim();
      if (HUB_TOKEN_PATTERN.test(token)) finish(null, token);
      else finish(new Error('the hub sent an invalid secret on standard input'));
    };
    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl >= 0) check(buffer.slice(0, nl));
      else if (buffer.length > 256) finish(new Error('the hub sent an invalid secret on standard input'));
    };
    const onEnd = (): void => (buffer.trim() !== '' ? check(buffer) : finish(new Error('standard input ended before the hub sent its secret')));
    const onError = (err: Error): void => finish(err);
    const timer = setTimeout(() => finish(new Error(`no secret from the hub on standard input within ${timeoutMs} ms`)), timeoutMs);
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('close', onEnd);
    input.on('error', onError);
    input.resume();
  });
}
