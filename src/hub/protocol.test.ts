import { describe, expect, it } from 'vitest';
import { LineBuffer, LineTooLongError, MAX_LINE_BYTES, encodeMessage, parseClientMessage, parseServerMessage } from './protocol.js';

describe('slot protocol', () => {
  it('round-trips valid messages', () => {
    expect(parseClientMessage('{"t":"hello","v":1,"workspace":"a","pid":3,"leases":["x","x","y"]}')).toEqual({
      t: 'hello',
      v: 1,
      workspace: 'a',
      pid: 3,
      leases: ['x', 'y'],
    });
    expect(parseClientMessage(encodeMessage({ t: 'acquire', id: 1, lease: 'a:1' }))).toEqual({ t: 'acquire', id: 1, lease: 'a:1' });
    expect(parseServerMessage(encodeMessage({ t: 'denied', id: 2, reason: 'x', active: 1, max: 2, paused: false }))).toMatchObject({ t: 'denied', id: 2 });
  });

  it('rejects malformed input', () => {
    for (const line of ['', 'nope', '[]', '{"t":"acquire","id":"1","lease":"k"}', '{"t":"acquire","id":1,"lease":"bad key"}', '{"t":"heartbeat","leases":[1]}', '{"t":"x"}']) {
      expect(parseClientMessage(line), line).toBeNull();
    }
    expect(parseServerMessage('{"t":"state","active":"1","max":2,"paused":false}')).toBeNull();
  });

  it('splits lines across chunks and caps their length', () => {
    const b = new LineBuffer();
    expect(b.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(b.push(':2}\n\n')).toEqual(['{"b":2}']);
    expect(() => new LineBuffer().push('x'.repeat(MAX_LINE_BYTES + 1))).toThrow(LineTooLongError);
  });
});
