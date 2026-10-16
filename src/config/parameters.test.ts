import { describe, expect, it } from 'vitest';
import { validateParameters, type ParameterDefinition } from './index.js';

const defs: Record<string, ParameterDefinition> = {
  name: { type: 'string', required: true, default: null, description: null },
  count: { type: 'number', required: false, default: 3, description: null },
  dry: { type: 'boolean', required: false, default: null, description: null },
  env: { type: 'enum', values: ['staging', 'production'], required: false, default: 'staging', description: null },
};

describe('validateParameters', () => {
  it('applies defaults and accepts typed values', () => {
    expect(validateParameters(defs, { name: 'x' })).toEqual({ ok: true, values: { name: 'x', count: 3, env: 'staging' } });
    expect(validateParameters(defs, { name: 'x', count: 5, dry: true, env: 'production' })).toEqual({
      ok: true,
      values: { name: 'x', count: 5, dry: true, env: 'production' },
    });
  });

  it('coerces form strings for number and boolean', () => {
    expect(validateParameters(defs, { name: 'x', count: '7.5', dry: 'false' })).toEqual({
      ok: true,
      values: { name: 'x', count: 7.5, dry: false, env: 'staging' },
    });
  });

  it('reports wrong types, unknown and missing parameters', () => {
    const result = validateParameters(defs, { count: 'abc', dry: 'yes', env: 'prod', extra: 1, name: 5 });
    expect(result).toEqual({
      ok: false,
      errors: [
        { parameter: 'extra', message: 'Unknown parameter' },
        { parameter: 'name', message: 'Expected a string' },
        { parameter: 'count', message: 'Expected a number' },
        { parameter: 'dry', message: 'Expected a boolean' },
        { parameter: 'env', message: 'Expected one of: staging, production' },
      ],
    });
    expect(validateParameters(defs, undefined)).toEqual({
      ok: false,
      errors: [{ parameter: 'name', message: 'Required parameter is missing' }],
    });
    expect(validateParameters(defs, { name: '' })).toMatchObject({ ok: false });
  });

  it('does not treat prototype keys as declared parameters', () => {
    expect(validateParameters({}, { toString: 'x' })).toEqual({
      ok: false,
      errors: [{ parameter: 'toString', message: 'Unknown parameter' }],
    });
  });
});
