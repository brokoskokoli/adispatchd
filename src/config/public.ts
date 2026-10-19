/**
 * Redacted view of the configuration for API responses, logs and the CLI
 * (Spec §18, §20.4): literal webhook URLs may embed tokens and are masked.
 */
import { REDACTED } from '../core/index.js';
import type { LoadedConfig } from './model.js';

/**
 * URL of an external link without its query string and fragment (they may
 * carry a token); both are replaced by `[REDACTED]` when present.
 */
export function redactExternalLinkUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search ? `?${REDACTED}` : ''}${url.hash ? `#${REDACTED}` : ''}`;
  } catch {
    return REDACTED;
  }
}

/**
 * Deep copy of `config` that is safe to expose: literal notification URLs are
 * replaced by `[REDACTED]`. Environment variable *names* stay visible.
 * `ui.external_links` (WI-25): disabled entries are dropped, query strings
 * and fragments of the remaining URLs are redacted (the UI gets the enabled
 * links with their full URL separately as `externalLinks`).
 */
export function toPublicConfig(config: LoadedConfig): LoadedConfig {
  const copy = JSON.parse(JSON.stringify(config)) as LoadedConfig;
  const channels = copy.global.notifications.channels.map((channel) => ({
    ...channel,
    url: channel.url === null ? null : REDACTED,
  }));
  const externalLinks = copy.global.ui.externalLinks
    .filter((link) => link.enabled)
    .map((link) => ({ ...link, url: redactExternalLinkUrl(link.url) }));
  return {
    ...copy,
    global: {
      ...copy.global,
      notifications: { ...copy.global.notifications, channels },
      ui: { ...copy.global.ui, externalLinks },
    },
  };
}
