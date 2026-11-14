/**
 * Serialises the git operations on one clone (WI-40). One instance is shared
 * by all adapters of a process (the {@link SourceRegistry} owns it), so that
 * an adapter rebuilt on a config reload never runs git concurrently with its
 * predecessor on the same directory.
 */
export class KeyedSerializer {
  private readonly tails = new Map<string, Promise<unknown>>();

  /**
   * Run `fn` after every earlier task with the same key has settled. With a
   * `signal`, an abort while waiting rejects at once with the abort reason
   * and `fn` is skipped when its turn comes; an abort while `fn` runs rejects
   * at once too (`fn` itself decides what it stops, the next task waits for
   * it to settle).
   */
  run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const guarded = (): Promise<T> => (signal?.aborted ? Promise.reject(abortReason(signal)) : fn());
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(guarded, guarded);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    if (!signal) return next;
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(abortReason(signal));
      signal.addEventListener('abort', onAbort, { once: true });
      next.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }
}

/** The usual abort error of a signal (its reason, else an `AbortError`). */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('aborted', 'AbortError');
}
