import { describe, expect, it } from 'vitest';
import {
  parseCpuTime,
  parseEngineSize,
  parseEngineStats,
  parseInspectPids,
  parseMeminfo,
  parsePsOutput,
  parseVmStat,
  processName,
} from './parse.js';

describe('parseCpuTime', () => {
  it('parses macOS MM:SS.cc (minutes may exceed 59) and H:MM:SS.cc', () => {
    expect(parseCpuTime('0:00.37')).toBeCloseTo(0.37);
    expect(parseCpuTime('21:27.67')).toBeCloseTo(21 * 60 + 27.67);
    expect(parseCpuTime('125:01.50')).toBeCloseTo(125 * 60 + 1.5);
    expect(parseCpuTime('1:02:03.45')).toBeCloseTo(3723.45);
  });

  it('parses Linux HH:MM:SS and D-HH:MM:SS', () => {
    expect(parseCpuTime('00:00:00')).toBe(0);
    expect(parseCpuTime('00:01:23')).toBe(83);
    expect(parseCpuTime('12:00:01')).toBe(43_201);
    expect(parseCpuTime('3-04:05:06')).toBe(3 * 86_400 + 4 * 3600 + 5 * 60 + 6);
  });

  it('rejects malformed values', () => {
    for (const v of ['', 'abc', '12', '1:2:3:4', '-', '1-', '1:xx']) expect(parseCpuTime(v), v).toBeNull();
  });
});

describe('processName', () => {
  it('takes the basename of paths, cuts at the first whitespace, strips control characters and shortens', () => {
    expect(processName('/usr/libexec/logd')).toBe('logd');
    expect(processName('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')).toBe('Google');
    expect(processName('sleep --token=SECRET123 x')).toBe('sleep');
    expect(processName('kworker/0:1')).toBe('kworker/0:1');
    expect(processName('node')).toBe('node');
    expect(processName('a\u0007b\u001b')).toBe('a');
    expect(processName('   ')).toBe('?');
    const long = processName('x'.repeat(200));
    expect(long.length).toBe(48);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('parsePsOutput', () => {
  it('parses the Linux procps format (pid, ppid, pgid, etime, time, rss, ucomm)', () => {
    const text = [
      '      1       0       1 3-01:00:00 00:00:05  11520 systemd',
      '   4242       1    4242    02:03:04 1-02:03:04 204800 node',
      '   4300    4242    4300       00:42 00:00:12   3072 bash',
      '   4301    4300    4300       01:10 00:01:00   2048 kworker/0:1',
      '',
    ].join('\n');
    expect(parsePsOutput(text)).toEqual([
      { pid: 1, ppid: 0, pgid: 1, elapsedSeconds: 3 * 86_400 + 3600, cpuSeconds: 5, rssBytes: 11520 * 1024, name: 'systemd' },
      { pid: 4242, ppid: 1, pgid: 4242, elapsedSeconds: 7384, cpuSeconds: 93_784, rssBytes: 204_800 * 1024, name: 'node' },
      { pid: 4300, ppid: 4242, pgid: 4300, elapsedSeconds: 42, cpuSeconds: 12, rssBytes: 3072 * 1024, name: 'bash' },
      { pid: 4301, ppid: 4300, pgid: 4300, elapsedSeconds: 70, cpuSeconds: 60, rssBytes: 2048 * 1024, name: 'kworker/0:1' },
    ]);
  });

  it('parses the macOS format (ucomm: short accounting name, padded)', () => {
    const text = [
      '    1     0     1 01-02:35:19  21:27.67   8640 launchd         ',
      ' 1270     1  1270    05:01:02  19:47.97  97728 Google Chrome   ',
      ' 1400  1270  1270       00:09   0:10.69   3776 Google Chrome He',
    ].join('\n');
    const out = parsePsOutput(text);
    expect(out.map((p) => p.name)).toEqual(['launchd', 'Google', 'Google']);
    expect(out[1]!.cpuSeconds).toBeCloseTo(19 * 60 + 47.97);
    expect(out[0]!.elapsedSeconds).toBe(86_400 + 2 * 3600 + 35 * 60 + 19);
    expect(out[2]).toMatchObject({ pid: 1400, ppid: 1270, pgid: 1270, elapsedSeconds: 9, rssBytes: 3776 * 1024 });
  });

  it('never returns arguments, even from rewritten argv[0] / process titles (B1)', () => {
    // What `ps -o comm` shows for `exec -a "/bin/sleep --token=SECRET123 x" sleep` and process.title = "node --password=HUNTER2".
    const text = [
      '  501     1   501    00:03   0:00.00    800 /bin/sleep --token=SECRET123 x',
      '  502     1   502    00:03   0:00.00    800 sleep --token=SECRET123 x',
      '  503     1   503    00:03   0:00.10  40000 node --password=HUNTER2',
      '  504     1   504    00:03   0:00.10  40000 /usr/local/bin/my tool --api-key=abc',
    ].join('\n');
    const out = parsePsOutput(text);
    expect(out.map((p) => p.name)).toEqual(['sleep', 'sleep', 'node', 'my']);
    expect(JSON.stringify(out)).not.toMatch(/SECRET123|HUNTER2|api-key|--/);
  });

  it('skips headers and malformed lines', () => {
    const text = ['  PID  PPID  PGID ELAPSED  TIME   RSS UCOMM', 'garbage', ' 10 1 10 00:01 bad 5 x', ' 12 1 12 bad 00:00:01 5 x', ' 11 1 11 00:01 00:00:01 5 ok'].join('\n');
    expect(parsePsOutput(text).map((p) => p.pid)).toEqual([11]);
  });
});

describe('memory parsers', () => {
  it('reads MemTotal/MemAvailable from /proc/meminfo', () => {
    const text = ['MemTotal:       16303852 kB', 'MemFree:          513232 kB', 'MemAvailable:    9876543 kB', 'Buffers:  1 kB'].join('\n');
    expect(parseMeminfo(text)).toEqual({ totalBytes: 16_303_852 * 1024, availableBytes: 9_876_543 * 1024 });
    expect(parseMeminfo('MemTotal: 10 kB\n')).toBeNull();
  });

  it('computes free + inactive + speculative pages from vm_stat', () => {
    const text = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                                     5627.',
      'Pages active:                                 188972.',
      'Pages inactive:                               182995.',
      'Pages speculative:                              5281.',
      'Pages wired down:                             228073.',
    ].join('\n');
    expect(parseVmStat(text)).toBe((5627 + 182_995 + 5281) * 16_384);
    expect(parseVmStat('Pages free: 1.\n')).toBeNull();
    expect(parseVmStat('Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 1.\nPages inactive: 2.\n')).toBe(3 * 4096);
  });
});

describe('container engine output', () => {
  it('parses sizes of docker/podman', () => {
    expect(parseEngineSize('0B')).toBe(0);
    expect(parseEngineSize('512kB')).toBe(512_000);
    expect(parseEngineSize('12.5MiB')).toBe(Math.round(12.5 * 1024 ** 2));
    expect(parseEngineSize('1.5GB')).toBe(1_500_000_000);
    expect(parseEngineSize('x')).toBeNull();
  });

  it('parses docker stats lines and a podman array', () => {
    const docker = [
      '{"BlockIO":"0B / 0B","CPUPerc":"150.25%","Container":"abc","ID":"abc","MemPerc":"1.2%","MemUsage":"100MiB / 7.6GiB","Name":"adispatch-run-1","NetIO":"1kB / 0B","PIDs":"3"}',
      'not json',
      '{"CPUPerc":"--","MemUsage":"-- / --","Name":"adispatch-run-2"}',
    ].join('\n');
    expect(parseEngineStats(docker)).toEqual([
      { name: 'adispatch-run-1', cpuPercent: 150.25, memBytes: 100 * 1024 ** 2 },
      { name: 'adispatch-run-2', cpuPercent: 0, memBytes: 0 },
    ]);
    const podman = '[{"name":"adispatch-run-3","cpu_percent":"3.50%","mem_usage":"2.1MB / 2GB"}]';
    expect(parseEngineStats(podman)).toEqual([{ name: 'adispatch-run-3', cpuPercent: 3.5, memBytes: 2_100_000 }]);
  });

  it('parses inspect PIDs', () => {
    expect([...parseInspectPids('/adispatch-run-1 4711\n/adispatch-run-2 0\nbad\n')]).toEqual([
      ['adispatch-run-1', 4711],
      ['adispatch-run-2', 0],
    ]);
  });
});
