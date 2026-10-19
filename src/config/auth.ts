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

/**
 * True if the identity header of `auth.mode: trusted_header` can be forged by
 * any process on this host (including workers): no proxy secret is required
 * and every trusted proxy is a loopback address (e.g. Tailscale Serve). Such
 * setups must not unlock sensitive actions (WI-27).
 */
export function isIdentityForgeableLocally(auth: AuthConfig): boolean {
  if (auth.mode !== 'trusted_header' || auth.trustedHeader.proxySecretEnv !== null) return false;
  return auth.trustedHeader.trustedProxies.every(isLoopbackProxyEntry);
}
