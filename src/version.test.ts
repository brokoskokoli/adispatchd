import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from './app.js';

describe('version', () => {
  it('APP_VERSION matches package.json and package-lock.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect(APP_VERSION).toBe(pkg.version);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages['']?.version).toBe(pkg.version);
  });
});
