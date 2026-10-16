import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeClock } from '../core/index.js';
import { schemaVersion } from './database.js';
import type { Persistence } from './persistence.js';
import { openTestPersistence } from './testing/helpers.js';

describe('NotificationRepository – per-channel deliveries (schema v2)', () => {
  let p: Persistence;
  let clock: FakeClock;
  let cleanup: () => void;

  beforeEach(() => {
    ({ p, clock, cleanup } = openTestPersistence());
  });
  afterEach(() => cleanup());

  it('migrates to v2 with the notification_deliveries table', () => {
    expect(schemaVersion(p.db)).toBe(2);
    expect(p.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'notification_deliveries'`).get()).toEqual({
      name: 'notification_deliveries',
    });
  });

  it('creates one pending delivery per channel and aggregates the state', () => {
    const { notification, deliveries } = p.notifications.createWithDeliveries('recovery_failed', { runId: 'r1' }, ['a', 'b', 'a']);
    expect(notification.deliveryState).toBe('pending');
    expect(deliveries.map((d) => [d.channelId, d.state, d.attempts])).toEqual([
      ['a', 'pending', 0],
      ['b', 'pending', 0],
    ]);
    expect(p.notifications.listDueDeliveries(clock.now()).map((d) => d.channelId)).toEqual(['a', 'b']);

    const [a, b] = deliveries;
    p.notifications.recordDeliveryAttempt(a!.id, { success: true, status: 204 });
    clock.advance(1000);
    const retryAt = new Date(clock.now().getTime() + 5000);
    p.notifications.recordDeliveryAttempt(b!.id, { success: false, error: 'HTTP 500', status: 500, nextAttemptAt: retryAt });
    let n = p.notifications.get(notification.id)!;
    expect(n.deliveryState).toBe('pending');
    expect(n.attempts).toBe(2);
    expect(n.lastError).toBe('HTTP 500');
    expect(n.nextAttemptAt).toBe(retryAt.toISOString());
    expect(p.notifications.listDueDeliveries(clock.now())).toHaveLength(0);
    expect(p.notifications.nextDeliveryDue()).toBe(retryAt.toISOString());

    p.notifications.recordDeliveryAttempt(b!.id, { success: false, error: 'HTTP 500', status: 500, nextAttemptAt: null });
    n = p.notifications.get(notification.id)!;
    expect(n.deliveryState).toBe('failed');
    expect(p.notifications.countByState()).toEqual({ pending: 0, delivered: 0, failed: 1 });

    // Manual requeue of the failed delivery.
    expect(p.notifications.requeueDelivery(a!.id)).toBeNull(); // delivered → not requeued
    expect(p.notifications.requeueDelivery(b!.id)?.state).toBe('pending');
    expect(p.notifications.get(notification.id)!.deliveryState).toBe('pending');
    p.notifications.recordDeliveryAttempt(b!.id, { success: true });
    n = p.notifications.get(notification.id)!;
    expect(n.deliveryState).toBe('delivered');
    expect(n.deliveredAt).not.toBeNull();
    expect(n.lastError).toBeNull();
  });

  it('stores notifications without subscribed channel as delivered', () => {
    const { notification, deliveries } = p.notifications.createWithDeliveries('retry_block_created', {}, []);
    expect(deliveries).toEqual([]);
    expect(notification.deliveryState).toBe('delivered');
    expect(notification.attempts).toBe(0);
  });

  it('retention deletes finished notifications with their deliveries', () => {
    const { notification } = p.notifications.createWithDeliveries('recovery_failed', {}, ['a']);
    const [d] = p.notifications.listDeliveries(notification.id);
    p.notifications.recordDeliveryAttempt(d!.id, { success: true });
    clock.advance(10_000);
    expect(p.retention.deleteNotifications(clock.now())).toBe(1);
    expect(p.notifications.getDelivery(d!.id)).toBeNull();
  });
});
