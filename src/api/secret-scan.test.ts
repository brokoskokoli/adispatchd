import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as server from './secret-scan.js';
import * as ui from '../ui/shared/secret-scan.js';

const SAMPLES = [
  `ghp_${'a'.repeat(36)} and gho_${'B'.repeat(36)}`,
  `github_pat_${'x1'.repeat(20)}`,
  `key: sk-ant-api03-${'Z'.repeat(40)}`,
  'AKIAIOSFODNN7EXAMPLE',
  'xoxb-1234567890-abcdef',
  '-----BEGIN RSA PRIVATE KEY-----\nMIIE (truncated, no END line)',
  '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
  'nothing secret here: ghp_short, AKIA123, sk-ant-x',
];

describe('secret scan (comments, WI-27)', () => {
  it('server and UI use the same code', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const body = (file: string) => readFileSync(file, 'utf8').replace(/^\/\*\*[\s\S]*?\*\/\n/, '');
    expect(body(path.join(here, 'secret-scan.ts'))).toBe(body(path.join(here, '../ui/shared/secret-scan.ts')));
    for (const s of SAMPLES) expect(server.scanSecrets(s)).toEqual(ui.scanSecrets(s));
  });

  it('finds kinds and counts, never values', () => {
    expect(server.scanSecrets(SAMPLES[0]!)).toEqual([{ kind: 'GitHub token', count: 2 }]);
    expect(server.scanSecrets(SAMPLES[1]!)).toEqual([{ kind: 'GitHub token', count: 1 }]);
    expect(server.scanSecrets(SAMPLES[2]!)).toEqual([{ kind: 'Anthropic API key', count: 1 }]);
    expect(server.scanSecrets(SAMPLES[3]!)).toEqual([{ kind: 'AWS access key ID', count: 1 }]);
    expect(server.scanSecrets(SAMPLES[5]!)).toEqual([{ kind: 'private key', count: 1 }]);
    expect(server.scanSecrets(SAMPLES[7]!)).toEqual([]);
    expect(server.describeFindings(server.scanSecrets(SAMPLES.join('\n')))).toBe(
      'private key ×2, GitHub token ×3, Anthropic API key ×1, AWS access key ID ×1, Slack token ×1',
    );
    expect(server.maskSecrets(SAMPLES[0]!)).toBe('[REDACTED] and [REDACTED]');
  });
});
