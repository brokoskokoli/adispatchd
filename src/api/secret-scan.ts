/**
 * Best-effort detection of secrets in texts a user is about to send as a
 * GitHub comment (WI-27). Kept identical to src/ui/shared/secret-scan.ts (the
 * server cannot import UI modules; src/api/secret-scan.test.ts compares both).
 * Findings name only the kind and count, never the value.
 */

/** One kind of secret found in a text. */
export interface SecretFinding {
  kind: string;
  count: number;
}

/** Recognised token formats (global regexes). */
export const SECRET_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  // The BEGIN line alone suffices (a truncated key is still a leak).
  { kind: 'private key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  { kind: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { kind: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: 'AWS access key ID', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
];

/** Kinds and counts of recognised secrets in `text` (empty = none found). */
export function scanSecrets(text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const { kind, pattern } of SECRET_PATTERNS) {
    const count = text.match(new RegExp(pattern.source, pattern.flags))?.length ?? 0;
    if (count > 0) out.push({ kind, count });
  }
  return out;
}

/** Replace every recognised secret by `[REDACTED]`. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const { pattern } of SECRET_PATTERNS) out = out.replace(new RegExp(pattern.source, pattern.flags), '[REDACTED]');
  return out;
}

/** `GitHub token ×2, private key ×1`. */
export function describeFindings(findings: readonly SecretFinding[]): string {
  return findings.map((f) => `${f.kind} ×${f.count}`).join(', ');
}
