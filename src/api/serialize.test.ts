import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from '../config/testing/fixtures.js';
import { toWorkflowView } from './serialize.js';

describe('toWorkflowView', () => {
  const temps: TempConfigDir[] = [];
  afterEach(async () => {
    while (temps.length) await temps.pop()?.cleanup();
  });

  it('lists secret names with their delivery (WI-18), never values or identities', async () => {
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
  });
});
