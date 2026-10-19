import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from '../config/testing/fixtures.js';
import { toWorkflowView } from './serialize.js';

describe('toWorkflowView', () => {
  const temps: TempConfigDir[] = [];
  afterEach(async () => {
    while (temps.length) await temps.pop()?.cleanup();
  });

  it('lists secret names with their delivery (WI-18), never values', async () => {
    const t = await createTempConfigDir({
      ...BASE_FILES,
      'workflows/w.yaml': [
        'id: w',
        'trigger: { type: manual }',
        'execute:',
        '  type: shell',
        '  command: /bin/true',
        '  secrets:',
        '    GH_TOKEN: { identity: coder, delivery: file }',
        '    OTHER: { identity: coder }',
        'on_success:',
        '  - type: shell',
        '    command: /bin/true',
        '    secrets:',
        '      HOOK_TOKEN: { identity: maintainer, delivery: file }',
        '',
      ].join('\n'),
    });
    temps.push(t);
    const loaded = await loadConfig(t.dir, { dataDir: t.dataDir });
    if (!loaded.ok) throw new Error('invalid config');
    const config = loaded.config.workflows.w!;
    const view = toWorkflowView(
      { config, enabled: true, priority: config.priority, maxConcurrent: config.maxConcurrent, overrides: {} },
      { activeRuns: 0, activeBlocks: 0, cron: null, diagnosis: undefined },
    );
    expect(view.execute).toMatchObject({ secrets: ['GH_TOKEN', 'OTHER'], secretDelivery: { GH_TOKEN: 'file', OTHER: 'env' } });
    expect(JSON.stringify(view.execute)).not.toContain('coder');
    // All declared secrets incl. shell actions, with identity and delivery (WI-18).
    expect(view.secrets).toEqual([
      { where: 'execute', name: 'GH_TOKEN', identity: 'coder', delivery: 'file', variable: 'GH_TOKEN_FILE' },
      { where: 'execute', name: 'OTHER', identity: 'coder', delivery: 'env', variable: 'OTHER' },
      { where: 'on_success.0', name: 'HOOK_TOKEN', identity: 'maintainer', delivery: 'file', variable: 'HOOK_TOKEN_FILE' },
    ]);
  });
});
