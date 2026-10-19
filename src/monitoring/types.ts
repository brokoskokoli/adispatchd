/**
 * Data model of the resource monitor (WI-23), shared by the sampler, the
 * HTTP API (`GET /api/v1/system/metrics`, SSE `system.metrics`) and the UI.
 */
import type { ContainerEngine } from '../core/index.js';

/** Kind of a process group in a sample. */
export type ProcessGroupKind = 'daemon' | 'run' | 'hooks' | 'other' | 'rest';

/** CPU and memory of a group of processes at one point in time. */
export interface ProcessGroup {
  kind: ProcessGroupKind;
  /** Display text (command names only, never arguments). */
  label: string;
  /** Command name of an `other` group (several processes with the same name are merged). */
  name?: string;
  runId?: string;
  workflowId?: string;
  /** Source item of a run, if any. */
  itemKey?: string;
  /** CPU since the previous sample; 100 = one core. */
  cpuPercent: number;
  /** Resident memory (sum). */
  rssBytes: number;
  /** Number of host processes in the group. */
  count: number;
}

/** Free/total space of a monitored file system. */
export interface DiskUsage {
  path: string;
  freeBytes: number;
  totalBytes: number;
}

/** One measurement. */
export interface MetricsSample {
  /** ISO time of the measurement. */
  at: string;
  cpu: {
    /** Busy share of the total capacity of all cores since the previous sample (0–100). */
    totalPercent: number;
    cores: number;
    /** Load average 1, 5, 15 minutes. */
    load: [number, number, number];
  };
  memory: { totalBytes: number; availableBytes: number };
  disks: DiskUsage[];
  /**
   * Process groups: the daemon, one per active run, hooks/checks of the
   * daemon, the top foreign processes by name and the rest. Empty if the
   * process list could not be read.
   */
  processes: ProcessGroup[];
}

/** A supervised run whose processes are attributed to it. */
export interface MonitoredRun {
  runId: string;
  workflowId: string;
  itemKey: string | null;
  /** PID of the worker (process group leader). */
  pid: number;
  /** Process group of the worker. */
  pgid: number;
  /** Container of a container run (WI-19): its usage is added via `<engine> stats`. */
  container?: { engine: ContainerEngine; name: string };
}

/** What the sampler attributes processes to. */
export interface AttributionTargets {
  daemonPid: number;
  runs: readonly MonitoredRun[];
}

/** Settings read before every sample (live configuration). */
export interface MonitorSettings {
  enabled: boolean;
  intervalMs: number;
  retentionMs: number;
  topProcesses: number;
  minCpuPercent: number;
  /** Paths whose file system is monitored (data dir, workspace base dir); same file system → listed once. */
  diskPaths: readonly string[];
}
