/**
 * Helpers about `auth` (WI-26) used by validation, startup warnings and WI-27.
 */
import { BlockList, isIP } from 'node:net';
import type { AuthConfig } from './model.js';

/** True if a `trusted_proxies` entry only covers loopback addresses (127.0.0.0/8, ::1). */
export function isLoopbackProxyEntry(entry: string): boolean {
  const [ip, bits] = entry.trim().split('/');
  if (!ip) return false;
  const family = isIP(ip);
  if (family === 4) return ip.startsWith('127.') && (bits === undefined || Number(bits) >= 8);
  if (family === 6) {
    const loopback = new BlockList();
    loopback.addAddress('::1', 'ipv6');
    loopback.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');
    const mapped = /^::ffff:/i.test(ip);
    return loopback.check(ip, 'ipv6') && (bits === undefined || Number(bits) >= (mapped ? 104 : 128));
  }
  return false;
}

/** True if a `trusted_proxies` entry (address or CIDR range) contains a loopback address (127.0.0.1, ::1, ::ffff:127.0.0.1). */
export function coversLoopback(entry: string): boolean {
  const [ip, prefix] = entry.trim().split('/');
  const family = isIP(ip ?? '');
  if (family === 0) return false;
  const list = new BlockList();
  const type = family === 4 ? 'ipv4' : 'ipv6';
  try {
    if (prefix === undefined) list.addAddress(ip as string, type);
    else list.addSubnet(ip as string, Number(prefix), type);
  } catch {
    return false;
  }
  return list.check('127.0.0.1', 'ipv4') || list.check('::1', 'ipv6') || (family === 6 && list.check('::ffff:127.0.0.1', 'ipv6'));
}

/**
 * True if the identity header of `auth.mode: trusted_header` can be forged by
 * any process on this host (including workers): no proxy secret is required
 * and at least one trusted proxy entry covers a loopback address (e.g.
 * Tailscale Serve) – local processes can connect through it. Such setups must
 * not unlock sensitive actions (WI-27: `ui_actions: true` is an error).
 */
export function isIdentityForgeableLocally(auth: AuthConfig): boolean {
  if (auth.mode !== 'trusted_header' || auth.trustedHeader.proxySecretEnv !== null) return false;
  return auth.trustedHeader.trustedProxies.some(coversLoopback);
}
