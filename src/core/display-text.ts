/**
 * Safe single-line display text from script output (WI-24): stderr lines of
 * conditions, values and errors of dashboard info tiles.
 *
 * Order matters: control sequences are removed first (so a secret split by an
 * escape sequence is still found), then the text is redacted, and only then
 * shortened (a secret cut at the limit would no longer match the redactor).
 */

/** ANSI escape sequences: CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ESC \`), other two-byte escapes. */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]?/g;
/** C0 controls (incl. tab, CR, LF), DEL and C1 controls. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
/** Bidi formatting / direction marks (Trojan-source style reordering). */
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Remove ANSI escapes, control and bidi characters; tabs/newlines become spaces; trimmed. */
export function sanitizeDisplayText(text: string): string {
  return text.replace(ANSI, '').replace(/[\t\r\n]/g, ' ').replace(CONTROLS, '').replace(BIDI, '').trim();
}

/** Shorten to `max` characters (last one `…`). */
export function shortenText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** Sanitize, redact, then shorten (see module docs). */
export function displayText(text: string, max: number, redact: (s: string) => string = (s) => s): string {
  return shortenText(redact(sanitizeDisplayText(text)), max);
}
