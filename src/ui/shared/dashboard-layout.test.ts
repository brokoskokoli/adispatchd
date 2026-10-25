import { describe, expect, it } from 'vitest';
import {
  columnTemplate,
  coversRequest,
  formatTabParam,
  mergeViewRequests,
  narrowForWidget,
  parseTabParam,
  pollInterval,
  tabFromPaths,
  tabKeyTarget,
  tabStorageKey,
  widgetTitle,
} from './dashboard-layout.js';

describe('dashboard layout helpers (WI-32)', () => {
  it('builds relative column templates', () => {
    expect(columnTemplate([{ width: 1 }, { width: 3 }])).toBe('minmax(0, 1fr) minmax(0, 3fr)');
  });

  it('uses the 0.7.0 headings unless a title is set', () => {
    expect(widgetTitle({ widget: 'recent_runs', title: null, limit: 10, workflows: null })).toBe('Recently finished');
    expect(widgetTitle({ widget: 'scheduler', title: 'Steuerung' })).toBe('Steuerung');
    expect(widgetTitle({ widget: 'view', title: null, view: 'v', sections: null, limit: 50, refreshMs: 60_000 })).toBeNull();
    expect(widgetTitle({ widget: 'resources', title: null })).toBeNull();
  });

  it('merges view requests and checks coverage', () => {
    expect(mergeViewRequests([{ sections: ['A'], limit: 5 }, { sections: ['B', 'A'], limit: 15 }])).toEqual({ sections: ['A', 'B'], limit: 15 });
    expect(mergeViewRequests([{ sections: ['A'], limit: 5 }, { sections: null, limit: 1 }])).toEqual({ sections: null, limit: 5 });
    expect(coversRequest({ sections: null, limit: 50 }, { sections: ['A'], limit: 10 })).toBe(true);
    expect(coversRequest({ sections: ['A'], limit: 50 }, { sections: null, limit: 10 })).toBe(false);
    expect(coversRequest({ sections: ['A', 'B'], limit: 50 }, { sections: ['B'], limit: 60 })).toBe(false);
    expect(coversRequest({ sections: ['A', 'B'], limit: 50 }, { sections: ['B'], limit: 50 })).toBe(true);
    expect(pollInterval([60_000, 15_000])).toBe(15_000);
    expect(pollInterval([])).toBeNull();
  });

  it('narrows a merged view result for one widget', () => {
    const data = { rows: [], sections: [{ title: 'A', rows: [1, 2, 3] }, { title: 'B', rows: [4] }] };
    expect(narrowForWidget(data, { sections: ['B'], limit: 2 }).sections).toEqual([{ title: 'B', rows: [4] }]);
    expect(narrowForWidget(data, { sections: null, limit: 2 }).sections).toEqual([{ title: 'A', rows: [1, 2] }, { title: 'B', rows: [4] }]);
    expect(narrowForWidget({ rows: [1, 2, 3], totalRows: 9 }, { sections: null, limit: 2 })).toEqual({ rows: [1, 2], totalRows: 9 });
    expect(narrowForWidget({ rows: [1, 2, 3] }, { sections: null, limit: 2 })).toEqual({ rows: [1, 2], totalRows: 3 });
  });

  it('reads and writes the selected tabs of the URL', () => {
    const paths = parseTabParam('projekte/a, runs');
    expect(paths).toEqual([['projekte', 'a'], ['runs']]);
    expect(parseTabParam(undefined)).toEqual([]);
    expect(tabFromPaths(paths, [], ['pipeline', 'runs', 'projekte'])).toBe('projekte');
    expect(tabFromPaths(paths, ['projekte'], ['a', 'b'])).toBe('a');
    expect(tabFromPaths(paths, ['pipeline'], ['a', 'b'])).toBeNull();
    expect(tabFromPaths(paths, [], ['x'])).toBeNull();
    expect(formatTabParam([['projekte'], ['projekte', 'a'], ['other'], ['other']])).toBe('projekte/a,other');
    expect(formatTabParam([])).toBe('');
    expect(tabStorageKey(['projekte'], ['a', 'b'])).toBe('adispatchd.dashboard.tab:projekte/a|b');
  });

  it('moves between tabs with arrow keys, Home and End', () => {
    expect(tabKeyTarget('ArrowRight', 2, 3)).toBe(0);
    expect(tabKeyTarget('ArrowLeft', 0, 3)).toBe(2);
    expect(tabKeyTarget('Home', 2, 3)).toBe(0);
    expect(tabKeyTarget('End', 0, 3)).toBe(2);
    expect(tabKeyTarget('Enter', 0, 3)).toBeNull();
  });
});
