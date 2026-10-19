/**
 * WI-14 review: the re-check before `on_start` fails closed for cheap fields
 * the source could not determine on the fresh item (`item.unknownFields`),
 * while `unknown` from expensive fields keeps the run going.
 */
import { describe, expect, it } from 'vitest';
import type { FilterNode, SourceAdapter, SourceItem } from '../core/index.js';
import type { WorkflowConfig } from '../config/index.js';
import { GITHUB_FIELD_DEFINITIONS, projectFieldDefinitions } from '../sources/index.js';
import { verifyItemFor } from './planner.js';

const adapter = {
  fieldDefinitions: () => [...GITHUB_FIELD_DEFINITIONS, ...projectFieldDefinitions({ Status: 'single_select' })],
} as unknown as SourceAdapter;

function verify(filter: FilterNode, item: Partial<SourceItem>): Promise<boolean> {
  const workflow = { id: 'w', filter } as unknown as WorkflowConfig;
  const check = verifyItemFor(workflow, adapter);
  if (!check) throw new Error('expected a re-check');
  return Promise.resolve(check({ sourceId: 's', itemId: '1', key: 's:1', url: '', type: 'issue', fields: {}, ...item }));
}

const READY: FilterNode = { field: 'project.Status', operator: 'equals', value: 'Ready' };
const NOT_BLOCKED: FilterNode = { field: 'dependencies.blocked_by_open', operator: 'equals', value: 0 };

describe('verifyItemFor (re-check before on_start)', () => {
  it('keeps a matching item and cancels a non-matching one', async () => {
    expect(await verify(READY, { fields: { 'project.Status': 'Ready' } })).toBe(true);
    expect(await verify(READY, { fields: { 'project.Status': 'Todo' } })).toBe(false);
  });

  it('cancels when a cheap field is unknown with a source reason (fail closed)', async () => {
    const unknownFields = { 'project.Status': 'GitHub project o/3 unavailable: forbidden' };
    expect(await verify(READY, { unknownFields })).toBe(false);
    expect(await verify({ not: READY }, { unknownFields })).toBe(false);
    expect(await verify({ all: [READY, NOT_BLOCKED] }, { unknownFields })).toBe(false);
  });

  it('does not cancel when only expensive fields are unknown', async () => {
    expect(await verify(NOT_BLOCKED, {})).toBe(true);
    expect(await verify({ all: [READY, NOT_BLOCKED] }, { fields: { 'project.Status': 'Ready' } })).toBe(true);
  });

  it('ignores unknown source fields that do not decide the result', async () => {
    const unknownFields = { 'project.Status': 'unavailable' };
    // `any` is already true through labels: the unknown project field does not matter.
    const filter: FilterNode = { any: [READY, { field: 'labels', operator: 'contains', value: 'go' }] };
    expect(await verify(filter, { fields: { labels: ['go'] }, unknownFields })).toBe(true);
    // Unknown only through the expensive field, the source-unknown field is not in the filter.
    expect(await verify(NOT_BLOCKED, { unknownFields })).toBe(true);
  });
});
