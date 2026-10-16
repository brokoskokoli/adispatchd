/**
 * Redacted view of the configuration for API responses, logs and the CLI
 * (Spec §18, §20.4): literal webhook URLs may embed tokens and are masked.
 */
import { REDACTED } from '../core/index.js';
import type { LoadedConfig } from './model.js';

/**
 * Deep copy of `config` that is safe to expose: literal notification URLs are
 * replaced by `[REDACTED]`. Environment variable *names* stay visible.
 */
export function toPublicConfig(config: LoadedConfig): LoadedConfig {
  const copy = JSON.parse(JSON.stringify(config)) as LoadedConfig;
  const channels = copy.global.notifications.channels.map((channel) => ({
    ...channel,
    url: channel.url === null ? null : REDACTED,
  }));
  return { ...copy, global: { ...copy.global, notifications: { ...copy.global.notifications, channels } } };
}
