/**
 * Component `notifications` – public API (WI-10): persisted central
 * orchestrator notifications with asynchronous webhook delivery (Spec §18).
 * Other components import from this module only.
 */
export {
  NotificationService,
  DEFAULT_NOTIFICATION_RETRY_DELAYS_MS,
  DEFAULT_NOTIFICATION_TIMEOUT_MS,
  summarize,
  webhookBody,
  type NotificationServiceOptions,
  type NotificationView,
} from './service.js';
