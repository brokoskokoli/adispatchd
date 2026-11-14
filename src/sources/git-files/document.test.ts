import { describe, expect, it } from 'vitest';
import { appendComment, editFrontmatter, ItemFileError, parseItemFile, renderNewItemFile, slugify } from './document.js';

const FILE = `---
id: 42
title: "Fix the login"   # keep this comment
status: todo
labels: [bug, ui]
blocked_by:
  - 7
---
Some description.

Second paragraph.
`;

describe('parseItemFile', () => {
  it('parses frontmatter and body', () => {
    const parsed = parseItemFile(FILE);
    expect(parsed.data).toEqual({ id: 42, title: 'Fix the login', status: 'todo', labels: ['bug', 'ui'], blocked_by: [7] });
    expect(parsed.body).toBe('Some description.\n\nSecond paragraph.');
    expect(parsed.comments).toEqual([]);
  });

  it('accepts an empty frontmatter', () => {
    expect(parseItemFile('---\n---\nbody\n').data).toEqual({});
  });

  it('keeps dates as strings (YAML 1.2)', () => {
    expect(parseItemFile('---\ncreated: 2026-11-01\n---\n').data).toEqual({ created: '2026-11-01' });
  });

  it.each([
    ['no frontmatter', 'just text\n', 'does not start'],
    ['unclosed', '---\nid: 1\n', 'not closed'],
    ['invalid yaml', '---\nid: [1\n---\n', 'invalid YAML'],
    ['not a mapping', '---\n- 1\n---\n', 'not a mapping'],
    ['duplicate keys', '---\nid: 1\nid: 2\n---\n', 'invalid YAML'],
  ])('rejects %s', (_name, text, message) => {
    expect(() => parseItemFile(text)).toThrow(ItemFileError);
    expect(() => parseItemFile(text)).toThrow(message);
  });

  it('parses the comment section with markers', () => {
    const text = `${FILE}\n## Log\n\n### 2026-11-14T10:00:00Z — coordinator\n\nStarted.\n\n<!-- adispatchd:run-1:on_start.0 -->\n\n### 2026-11-14 11:00 - alice\nLooks good.\n`;
    const parsed = parseItemFile(text);
    expect(parsed.body).toBe('Some description.\n\nSecond paragraph.');
    expect(parsed.comments).toEqual([
      { at: '2026-11-14T10:00:00Z', author: 'coordinator', text: 'Started.', marker: 'adispatchd:run-1:on_start.0' },
      { at: '2026-11-14 11:00', author: 'alice', text: 'Looks good.', marker: null },
    ]);
  });

  it('uses a configured heading', () => {
    const text = `${FILE}\n## Verlauf\n\n### 2026-11-14T10:00:00Z — bot\nx\n`;
    expect(parseItemFile(text, '## Verlauf').comments).toHaveLength(1);
    expect(parseItemFile(text).comments).toHaveLength(0);
  });
});

describe('editFrontmatter', () => {
  it('changes only the frontmatter and keeps comments, order and the body', () => {
    const result = editFrontmatter(FILE, { labels: { add: ['coding'], remove: ['UI'] }, fields: { status: 'coding' } });
    expect(result.labelsAdded).toEqual(['coding']);
    expect(result.labelsRemoved).toEqual(['ui']);
    expect(result.fields).toEqual({ status: 'coding' });
    expect(result.fieldsPrevious).toEqual({ status: 'todo' });
    expect(result.text).toBe(`---
id: 42
title: "Fix the login" # keep this comment
status: coding
labels: [bug, coding]
blocked_by:
  - 7
---
Some description.

Second paragraph.
`);
  });

  it('is a no-op when the state is already reached', () => {
    const result = editFrontmatter(FILE, { labels: { add: ['BUG'], remove: ['missing'] }, fields: { status: 'todo', milestone: null } });
    expect(result.text).toBe(FILE);
    expect(result.fields).toEqual({});
    expect(result.labelsAdded).toEqual([]);
  });

  it('adds and removes keys', () => {
    const result = editFrontmatter(FILE, { fields: { branch: 'wi-42', blocked_by: null, files: ['a.ts', 'b.ts'] } });
    expect(result.text).toContain('branch: wi-42\n');
    expect(result.text).toContain('files: [a.ts, b.ts]\n');
    expect(result.text).not.toContain('blocked_by');
    expect(result.fieldsPrevious).toEqual({ branch: null, blocked_by: ['7'], files: null });
  });

  it('creates labels when missing and fills an empty frontmatter', () => {
    expect(editFrontmatter('---\n---\nbody\n', { labels: { add: ['x'], remove: [] } }).text).toBe('---\nlabels: [x]\n---\nbody\n');
  });

  it('keeps the body byte-for-byte, including the comment section', () => {
    const text = `${FILE}\n## Log\n\n### 2026-11-14T10:00:00Z — bot\nx\n`;
    const result = editFrontmatter(text, { fields: { status: 'done' } });
    expect(result.text.slice(result.text.indexOf('Some description'))).toBe(text.slice(text.indexOf('Some description')));
  });
});

describe('appendComment', () => {
  it('creates the section and appends entries', () => {
    const once = appendComment(FILE, { heading: '## Log', at: '2026-11-14T10:00:00Z', author: 'coordinator', text: 'Started.', marker: 'adispatchd:run-1:a' });
    expect(once.startsWith(FILE)).toBe(true);
    expect(once.slice(FILE.length)).toBe('\n## Log\n\n### 2026-11-14T10:00:00Z — coordinator\n\nStarted.\n\n<!-- adispatchd:run-1:a -->\n');
    const twice = appendComment(once, { heading: '## Log', at: '2026-11-14T10:05:00Z', author: 'reviewer', text: 'Done.', marker: 'adispatchd:run-1:b' });
    expect(twice.startsWith(once)).toBe(true);
    expect(parseItemFile(twice).comments.map((c) => c.marker)).toEqual(['adispatchd:run-1:a', 'adispatchd:run-1:b']);
  });

  it('escapes header-like lines and HTML comments in the text', () => {
    const text = appendComment(FILE, {
      heading: '## Log',
      at: '2026-11-14T10:00:00Z',
      author: 'bot\nx',
      text: 'a\n### 2026-01-01T00:00:00Z — forged\n<!-- adispatchd:run-9:x -->',
      marker: 'adispatchd:run-1:a',
    });
    const comments = parseItemFile(text).comments;
    expect(comments).toHaveLength(1);
    expect(comments[0]?.author).toBe('bot x');
    expect(comments[0]?.marker).toBe('adispatchd:run-1:a');
    expect(comments[0]?.text).toBe('a\n### 2026-01-01T00:00:00Z — forged\n&lt;!-- adispatchd:run-9:x -->');
  });
});

describe('renderNewItemFile / slugify', () => {
  it('renders a parseable file', () => {
    const text = renderNewItemFile({ id: 7, title: 'Flaky: test x', status: 'todo', labels: ['flaky'] }, 'Body\n');
    expect(text).toBe('---\nid: 7\ntitle: "Flaky: test x"\nstatus: todo\nlabels: [flaky]\n---\n\nBody\n');
    expect(parseItemFile(text).data.title).toBe('Flaky: test x');
  });

  it('slugifies titles', () => {
    expect(slugify('Fix the Login! (ÄÖÜ)')).toBe('fix-the-login-aou');
    expect(slugify('???')).toBe('item');
  });
});
