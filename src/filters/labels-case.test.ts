import { describe, expect, it } from 'vitest';
import type { SourceItem } from '../core/index.js';
import { GITHUB_FIELD_DEFINITIONS } from '../sources/index.js';
import { createItemFieldSource, evaluateFilter, resolveItemPriority } from './index.js';

const item: SourceItem = {
  sourceId: 'repo',
  itemId: '7',
  key: 'repo:7',
  url: 'https://github.com/o/r/issues/7',
  type: 'issue',
  fields: { labels: ['Ready-For-Coding', 'priority:High'], title: 'Fix Login' },
};

const fields = () => createItemFieldSource(item, { definitions: GITHUB_FIELD_DEFINITIONS });

describe('GitHub labels compare case-insensitively (WI-13)', () => {
  it('in filters (contains, in)', async () => {
    expect((await evaluateFilter({ field: 'labels', operator: 'contains', value: 'ready-for-coding' }, fields())).value).toBe(true);
    expect((await evaluateFilter({ field: 'labels', operator: 'in', value: ['READY-FOR-CODING', 'x'] }, fields())).value).toBe(true);
    expect((await evaluateFilter({ field: 'labels', operator: 'contains', value: 'ready' }, fields())).value).toBe(false);
  });

  it('in item_priority rules', async () => {
    const result = await resolveItemPriority(
      { rules: [{ when: { field: 'labels', operator: 'contains', value: 'priority:high' }, value: 50 }], default: 0 },
      fields(),
    );
    expect(result.priority).toBe(50);
  });

  it('other string fields stay case-sensitive', async () => {
    expect((await evaluateFilter({ field: 'title', operator: 'contains', value: 'login' }, fields())).value).toBe(false);
  });
});
