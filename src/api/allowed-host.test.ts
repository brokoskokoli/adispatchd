import { describe, expect, it } from 'vitest';
import { isAllowedHost } from './index.js';

describe('isAllowedHost (WI-13: Host header without port)', () => {
  it('matches entries with :443 or :80 when the Host header has no port (HTTPS reverse proxy)', () => {
    expect(isAllowedHost('adispatchd.example.com', ['adispatchd.example.com:443'])).toBe(true);
    expect(isAllowedHost('adispatchd.example.com', ['adispatchd.example.com:80'])).toBe(true);
    expect(isAllowedHost('Adispatchd.Example.com', ['adispatchd.example.com'])).toBe(true);
  });

  it('keeps explicit ports exact', () => {
    expect(isAllowedHost('adispatchd.example.com', ['adispatchd.example.com:8443'])).toBe(false);
    expect(isAllowedHost('adispatchd.example.com:8443', ['adispatchd.example.com:443'])).toBe(false);
    expect(isAllowedHost('adispatchd.example.com:8443', ['adispatchd.example.com:8443'])).toBe(true);
    expect(isAllowedHost('adispatchd.example.com:8443', ['adispatchd.example.com'])).toBe(true);
    expect(isAllowedHost('other.example.com', ['adispatchd.example.com:443'])).toBe(false);
  });
});
