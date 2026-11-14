/**
 * Text handling for Slack (WI-39).
 *
 * Outgoing: messages are plain text in Slack's `mrkdwn`; `&`, `<` and `>` are
 * escaped so untrusted values (item titles, worker messages) cannot create
 * mentions such as `<!channel>` or hidden links. Head messages of threads
 * and the texts of orchestrator events are built here.
 *
 * Incoming: the text of a reply is untrusted (Spec §20.5). It is converted to
 * plain text (`<@U…>` → `@U…`, `<url|text>` → `text (url)`, entities
 * decoded), stripped of control characters, shortened to
 * {@link MAX_REPLY_TEXT_BYTES} and HTML comment openers are neutralized like
 * in `source.comment`.
 */
import { neutralizeHtmlComments } from '../lifecycle/index.js';

/** Max. size of `{reply.text}` in UTF-8 bytes. */
export const MAX_REPLY_TEXT_BYTES = 8 * 1024;

/** Marker appended to a shortened reply. */
export const TRUNCATION_MARKER = ' […]';

/** Escape `&`, `<`, `>` for Slack `mrkdwn` (no mentions, no links from untrusted text). */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Item shown in the head message of a thread. */
export interface ThreadHeadInput {
  itemKey: string;
  itemUrl: string | null;
  itemTitle: string | null;
  workflowId: string;
  workflowName: string | null;
  /** Replies are possible in this channel (Socket Mode configured). */
  replies: boolean;
}

/**
 * Head message of a thread (one per (workflow, item)): the item title as a
 * link, the item key and the workflow; a hint that replies go to the
 * workflow when replies are possible. No Block Kit.
 */
export function threadHeadText(input: ThreadHeadInput): string {
  const label = escapeSlack(input.itemTitle?.trim() || input.itemKey);
  const url = input.itemUrl && /^https?:\/\/[^\s<>|]+$/.test(input.itemUrl) ? input.itemUrl : null;
  const title = url ? `*<${url}|${label.replace(/\|/g, '¦')}>*` : `*${label}*`;
  const workflow = escapeSlack(input.workflowName && input.workflowName !== input.workflowId ? `${input.workflowName} (${input.workflowId})` : input.workflowId);
  const lines = [`:speech_balloon: ${title}`, `${escapeSlack(input.itemKey)} · workflow ${workflow}`];
  if (input.replies) lines.push('_Reply in this thread to answer the workflow._');
  return lines.join('\n');
}

/** Text of a message posted into a thread or the channel (escaped). */
export function messageText(text: string): string {
  return escapeSlack(text);
}

/**
 * Convert Slack `mrkdwn` of a received message to plain text, shorten it to
 * {@link MAX_REPLY_TEXT_BYTES} (UTF-8) and neutralize `<!--`.
 */
export function replyPlainText(mrkdwn: string): { text: string; truncated: boolean } {
  let text = mrkdwn.replace(/<([^<>]*)>/g, (_match, inner: string) => convertSpecial(inner));
  text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  // Control characters except tab and line breaks.
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n');
  text = neutralizeHtmlComments(text);
  const limited = limitUtf8(text, MAX_REPLY_TEXT_BYTES - Buffer.byteLength(TRUNCATION_MARKER));
  return limited.truncated ? { text: `${limited.text}${TRUNCATION_MARKER}`, truncated: true } : { text, truncated: false };
}

/** `<…>` sequences of Slack mrkdwn → plain text. */
function convertSpecial(inner: string): string {
  const bar = inner.indexOf('|');
  const target = bar >= 0 ? inner.slice(0, bar) : inner;
  const label = bar >= 0 ? inner.slice(bar + 1) : '';
  if (target.startsWith('@')) return label ? `@${label.replace(/^@/, '')}` : target;
  if (target.startsWith('#')) return label ? `#${label.replace(/^#/, '')}` : target;
  if (target.startsWith('!')) {
    const special = target.slice(1);
    if (label) return label;
    if (special === 'here' || special === 'channel' || special === 'everyone') return `@${special}`;
    return special.startsWith('subteam^') ? `@${special.slice('subteam^'.length)}` : `@${special}`;
  }
  const url = target.replace(/^mailto:/, '');
  if (!label || label === target || label === url) return url;
  return `${label} (${url})`;
}

/** Cut `text` to at most `maxBytes` UTF-8 bytes without splitting a character. */
function limitUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  let bytes = 0;
  let out = '';
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += ch;
  }
  return { text: out, truncated: true };
}
