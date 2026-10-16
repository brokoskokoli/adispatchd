/**
 * Decoupled, ordered delivery of executor notifications to listeners.
 *
 * Emitting never calls listeners synchronously: items are queued and
 * delivered on a later event-loop turn (`setImmediate`), so slow or throwing
 * consumers (e.g. SSE) cannot block or break log capture. Delivery order
 * equals emit order across all channels. Until {@link open} is called, items
 * are only queued — this lets the caller of `Executor.start()` subscribe
 * before any early output is delivered.
 */
import type { Logger, Unsubscribe } from '../core/index.js';

type Task = () => void;

export class Dispatcher {
  private readonly queue: Task[] = [];
  private scheduled = false;
  private opened = false;

  constructor(private readonly logger?: Logger) {}

  /** Start delivering (on the next turn) everything queued so far and all later items. */
  open(): void {
    this.opened = true;
    this.schedule();
  }

  /** Queue a task (listener fan-out or completion callback). */
  enqueue(task: Task): void {
    this.queue.push(task);
    this.schedule();
  }

  private schedule(): void {
    if (!this.opened || this.scheduled || this.queue.length === 0) return;
    this.scheduled = true;
    setImmediate(() => this.drain());
  }

  private drain(): void {
    this.scheduled = false;
    // Deliver what is queued now; items queued by listeners go to the next turn.
    const batch = this.queue.splice(0, this.queue.length);
    for (const task of batch) {
      try {
        task();
      } catch (err) {
        this.logger?.warn('executor listener threw', { error: err });
      }
    }
    this.schedule();
  }
}

/** A listener set whose fan-out goes through a {@link Dispatcher}. */
export class Channel<T> {
  private readonly listeners = new Set<(value: T) => void>();

  constructor(
    private readonly dispatcher: Dispatcher,
    private readonly logger?: Logger,
  ) {}

  subscribe(listener: (value: T) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(value: T): void {
    this.dispatcher.enqueue(() => {
      for (const listener of [...this.listeners]) {
        try {
          listener(value);
        } catch (err) {
          this.logger?.warn('executor listener threw', { error: err });
        }
      }
    });
  }
}
