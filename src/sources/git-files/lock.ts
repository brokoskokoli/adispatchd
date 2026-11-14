/**
 * Serialises the git operations on one clone (WI-40). One instance is shared
 * by all adapters of a process (the {@link SourceRegistry} owns it), so that
 * an adapter rebuilt on a config reload never runs git concurrently with its
 * predecessor on the same directory.
 */
export class KeyedSerializer {
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Run `fn` after every earlier task with the same key has settled. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
