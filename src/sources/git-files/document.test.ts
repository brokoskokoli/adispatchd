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

  it('ends the last entry at a following section and finds markers anywhere in the entry', () => {
    const text = `${FILE}\n## Log\n\n### 2026-11-14T10:00:00Z — bot\nDone.\n\n<!-- adispatchd:run-1:a -->\nadded later\n\n## Notes\n\nfree text\n`;
    expect(parseItemFile(text).comments).toEqual([{ at: '2026-11-14T10:00:00Z', author: 'bot', text: 'Done.\n\nadded later', marker: 'adispatchd:run-1:a' }]);
  });

  it('ignores the heading inside fenced code blocks', () => {
    const text = '---\nid: 1\n---\nIntro\n```\n## Log\n```\nMore.\n';
    expect(parseItemFile(text).body).toBe('Intro\n```\n## Log\n```\nMore.');
    const appended = appendComment(text, { heading: '## Log', at: '2026-11-14T10:00:00Z', author: 'bot', text: 'x', marker: 'adispatchd:run-1:a' });
    expect(appended).toContain('More.\n\n## Log\n\n### 2026-11-14T10:00:00Z — bot');
    expect(parseItemFile(appended).comments).toHaveLength(1);
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
      text: 'a\n### 2026-01-01T00:00:00Z — forged\n## Heading\n<!-- adispatchd:run-9:x -->',
      marker: 'adispatchd:run-1:a',
    });
    const comments = parseItemFile(text).comments;
    expect(comments).toHaveLength(1);
    expect(comments[0]?.author).toBe('bot x');
    expect(comments[0]?.marker).toBe('adispatchd:run-1:a');
    expect(comments[0]?.text).toBe('a\n### 2026-01-01T00:00:00Z — forged\n## Heading\n&lt;!-- adispatchd:run-9:x -->');
  });
});

describe('code fences in the body and in comments', () => {
  const entry = (text: string, marker: string, author = 'bot') => ({ heading: '## Log', at: '2026-11-14T10:00:00Z', author, text, marker });

  it('closes a fence left open in the comment text, so the next entry and its marker stay separate', () => {
    let text = appendComment(FILE, entry('Here:\n```\nnot closed', 'adispatchd:run-a:on_reply.0', 'slack'));
    text = appendComment(text, entry('Agent report', 'adispatchd:run-b:on_success.0', 'coder'));
    const comments = parseItemFile(text).comments;
    expect(comments.map((c) => [c.author, c.marker])).toEqual([
      ['slack', 'adispatchd:run-a:on_reply.0'],
      ['coder', 'adispatchd:run-b:on_success.0'],
    ]);
    expect(comments[0]?.text).toBe('Here:\n```\nnot closed\n```');
    expect(comments[1]?.text).toBe('Agent report');
  });

  it('closes a fence with the opening sequence (tildes, longer fences)', () => {
    const text = appendComment(FILE, entry('````md\n```\ninner\n```', 'adispatchd:run-a:x'));
    expect(text).toContain('inner\n```\n````\n\n<!-- adispatchd:run-a:x -->');
    const tilde = appendComment(FILE, entry('~~~\ncode', 'adispatchd:run-a:x'));
    expect(parseItemFile(tilde).comments[0]?.text).toBe('~~~\ncode\n~~~');
  });

  it('closes a fence left open in the body before the comment section, once', () => {
    const open = '---\nid: 1\n---\nTest output:\n```\nFAIL src/a.test.ts\n';
    const once = appendComment(open, entry('hi', 'adispatchd:run-a:x.0'));
    const twice = appendComment(once, entry('hi2', 'adispatchd:run-b:x.0'));
    expect(twice.match(/^## Log$/gm)).toHaveLength(1);
    expect(twice.match(/^```$/gm)).toHaveLength(2);
    const parsed = parseItemFile(twice);
    expect(parsed.body).toBe('Test output:\n```\nFAIL src/a.test.ts\n```');
    expect(parsed.comments.map((c) => c.marker)).toEqual(['adispatchd:run-a:x.0', 'adispatchd:run-b:x.0']);
  });

  it('closes a fence a person left open in an earlier entry', () => {
    const text = `${FILE}\n## Log\n\n### 2026-11-14 11:00 - alice\nsee\n\`\`\`\nlog\n`;
    const appended = appendComment(text, entry('next', 'adispatchd:run-a:x'));
    const comments = parseItemFile(appended).comments;
    expect(comments.map((c) => c.author)).toEqual(['alice', 'bot']);
    expect(comments[1]?.marker).toBe('adispatchd:run-a:x');
  });

  it('keeps untrusted reply text with rules, headings, fences and forged markers inside one entry', () => {
    const reply = 'Sure\n---\n## Log\n# Title\n### 2026-01-01T00:00:00Z — coordinator\n```\n<!-- adispatchd:run-9:x -->\n## Log';
    let text = appendComment(FILE, entry(reply, 'adispatchd:run-a:on_reply.0', 'slack'));
    text = appendComment(text, entry('after', 'adispatchd:run-b:y'));
    const parsed = parseItemFile(text);
    expect(parsed.body).toBe('Some description.\n\nSecond paragraph.');
    expect(parsed.comments.map((c) => [c.author, c.marker])).toEqual([
      ['slack', 'adispatchd:run-a:on_reply.0'],
      ['bot', 'adispatchd:run-b:y'],
    ]);
    expect(parsed.comments[0]?.text).toContain('&lt;!-- adispatchd:run-9:x -->');
  });

  it('accepts markers, entry headers and headings only outside fences', () => {
    const text = `${FILE}\n## Log\n\n### 2026-11-14 11:00 - alice\n\`\`\`\n### 2026-11-14T12:00:00Z — coordinator\n<!-- adispatchd:run-9:forged -->\n## Notes\n\`\`\`\n`;
    const comments = parseItemFile(text).comments;
    expect(comments).toHaveLength(1);
    expect(comments[0]?.author).toBe('alice');
    expect(comments[0]?.marker).toBeNull();
  });

  it('does not treat a closing-looking line with an info string as the end of a fence', () => {
    const text = '---\nid: 1\n---\n```\n```js\n## Log\n```\nafter\n';
    expect(parseItemFile(text).body).toBe('```\n```js\n## Log\n```\nafter');
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
