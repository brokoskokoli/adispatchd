/**
 * Component `notifications` – public API (WI-10): persisted central
 * orchestrator notifications with asynchronous webhook delivery (Spec §18);
 * WI-39: Slack channels with a thread per (workflow, item), reminders and
 * replies via Socket Mode.
 * Other components import from this module only.
 */
export {
  NotificationService,
  DEFAULT_NOTIFICATION_RETRY_DELAYS_MS,
  DEFAULT_NOTIFICATION_TIMEOUT_MS,
  summarize,
  slackText,
  webhookBody,
  type NotificationServiceOptions,
  type NotificationView,
} from './service.js';
export {
  SlackWebClient,
  SlackApiError,
  SLACK_API_BASE_URL,
  DEFAULT_SLACK_TIMEOUT_MS,
  SLACK_MAX_TEXT_LENGTH,
  parseRetryAfter,
  type SlackWebClientOptions,
  type PostedMessage,
} from './slack-api.js';
export {
  SocketModeClient,
  defaultWebSocketFactory,
  SOCKET_MIN_BACKOFF_MS,
  SOCKET_MAX_BACKOFF_MS,
  SOCKET_HELLO_TIMEOUT_MS,
  type SocketEnvelope,
  type SocketState,
  type SocketStatus,
  type WebSocketFactory,
  type WebSocketLike,
  type SocketModeClientOptions,
} from './slack-socket.js';
export { escapeSlack, messageText, replyPlainText, threadHeadText, MAX_REPLY_TEXT_BYTES, TRUNCATION_MARKER, type ThreadHeadInput } from './slack-text.js';
export {
  ChatReplyService,
  REPLY_REACTIONS,
  type ChannelStatus,
  type ChatReplyServiceOptions,
  type ReplyTarget,
} from './replies.js';
