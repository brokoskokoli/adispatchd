/**
 * Periodic resource sampling with an in-memory ring buffer (WI-23).
 *
 * - The next measurement is scheduled only after the previous one finished,
 *   and {@link ResourceMonitor.sampleNow} returns the running measurement
 *   instead of starting a second one: measurements never overlap.
 * - Settings are read before every measurement (configuration reloads apply
 *   at the next tick); `enabled: false` stops sampling and clears the buffer.
 * - Samples older than `retention` are dropped; nothing is persisted (lost on restart).
 */
import {
  errorMessage,
  noopLogger,
  systemClock,
  systemTimers,
  type Clock,
  type Logger,
  type TimerHandle,
  type Timers,
} from '../core/index.js';
import type { SystemProbe } from './probe.js';
import { ResourceSampler } from './sampler.js';
import type { AttributionTargets, MetricsSample, MonitorSettings } from './types.js';

/** Hard cap of the ring buffer (validation limits `retention / interval` to the same value). */
export const MAX_BUFFERED_SAMPLES = 20_000;
/** Delay of the first real sample after the priming measurement (at most the interval). */
export const DEFAULT_PRIME_DELAY_MS = 5_000;
/** How often a disabled monitor checks whether it was enabled by a reload. */
export const DISABLED_RECHECK_MS = 30_000;

/** Options of {@link ResourceMonitor}. */
export interface ResourceMonitorOptions {
  /** Live settings (read before every measurement). */
  settings: () => MonitorSettings;
  /** Daemon PID and active runs (read before every measurement). */
  targets: () => AttributionTargets;
  /** OS access (ignored if `sampler` is given). */
  probe?: SystemProbe;
  sampler?: ResourceSampler;
  clock?: Clock;
  timers?: Timers;
  logger?: Logger;
  /** Called with every new sample (e.g. SSE `system.metrics`). Must return immediately. */
  onSample?: (sample: MetricsSample) => void;
  primeDelayMs?: number;
  maxSamples?: number;
}

/** See module docs. */
export class ResourceMonitor {
  private readonly sampler: ResourceSampler;
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly logger: Logger;
  private readonly primeDelayMs: number;
  private readonly maxSamples: number;
  private samples: MetricsSample[] = [];
  private timer: TimerHandle | undefined;
  private inFlight: Promise<MetricsSample | null> | undefined;
  private running = false;
  private active = false;

  constructor(private readonly options: ResourceMonitorOptions) {
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? systemTimers;
    this.logger = (options.logger ?? noopLogger).child({ component: 'monitoring' });
    if (!options.sampler && !options.probe) throw new Error('ResourceMonitor needs a probe or a sampler');
    this.sampler = options.sampler ?? new ResourceSampler({ probe: options.probe!, clock: this.clock, logger: options.logger ?? noopLogger });
    this.primeDelayMs = options.primeDelayMs ?? DEFAULT_PRIME_DELAY_MS;
    this.maxSamples = options.maxSamples ?? MAX_BUFFERED_SAMPLES;
  }

  /** Current settings (live configuration). */
  get settings(): MonitorSettings {
    return this.options.settings();
  }

  /** True while a measurement is running. */
  get busy(): boolean {
    return this.inFlight !== undefined;
  }

  /** Start periodic sampling (first measurement immediately, primes the deltas). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  /** Stop sampling and wait for a running measurement. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => undefined);
  }

  /** Buffered samples (oldest first), optionally only those taken after `since`. */
  list(since?: Date): MetricsSample[] {
    if (!since) return [...this.samples];
    const t = since.getTime();
    return this.samples.filter((s) => Date.parse(s.at) > t);
  }

  /** Latest sample, if any. */
  latest(): MetricsSample | null {
    return this.samples[this.samples.length - 1] ?? null;
  }

  /**
   * Measure now (also used by the timer). Returns the running measurement if
   * one is in progress – never two at once. `null` for the priming measurement
   * or when the measurement failed.
   */
  sampleNow(): Promise<MetricsSample | null> {
    if (this.inFlight) return this.inFlight;
    const settings = this.options.settings();
    const p = (async (): Promise<MetricsSample | null> => {
      try {
        const sample = await this.sampler.measure(this.options.targets(), settings);
        if (sample) this.add(sample, settings.retentionMs);
        return sample;
      } catch (err) {
        this.logger.warn('resource monitor: measurement failed', { error: errorMessage(err) });
        return null;
      }
    })();
    this.inFlight = p;
    void p.finally(() => {
      if (this.inFlight === p) this.inFlight = undefined;
    });
    return p;
  }

  private add(sample: MetricsSample, retentionMs: number): void {
    this.samples.push(sample);
    const cutoff = this.clock.now().getTime() - retentionMs;
    let drop = 0;
    while (drop < this.samples.length && Date.parse(this.samples[drop]!.at) < cutoff) drop++;
    drop = Math.max(drop, this.samples.length - this.maxSamples);
    if (drop > 0) this.samples.splice(0, drop);
    try {
      this.options.onSample?.(sample);
    } catch (err) {
      this.logger.warn('resource monitor: sample listener failed', { error: errorMessage(err) });
    }
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.timer = this.timers.setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    if (!this.running) return;
    const settings = this.options.settings();
    if (!settings.enabled) {
      if (this.active) {
        this.active = false;
        this.samples = [];
        this.sampler.reset();
      }
      this.schedule(DISABLED_RECHECK_MS);
      return;
    }
    // The first measurement after (re)activation only primes the deltas: the first real one follows soon.
    const priming = !this.active;
    this.active = true;
    await this.sampleNow();
    if (!this.running) return;
    const fresh = this.options.settings();
    this.schedule(priming ? Math.min(fresh.intervalMs, this.primeDelayMs) : fresh.intervalMs);
  }
}
