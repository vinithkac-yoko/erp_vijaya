import { describe, expect, it } from 'vitest';
import { TOOLS } from './catalog';
import { TOOLS as KIT_TOOLS } from '../../reference/artifacts/catalog';

// The kit keeps its own copy for its tests (reference/artifacts/catalog.ts); the app's is src/lib/catalog.ts.
// Until they are one file (milestone 9), this fails if one is edited without the other.
describe('the app catalog and the kit catalog agree', () => {
  it('have the same tools, with the same kind, roles and inputs', () => {
    expect(Object.keys(TOOLS).sort()).toEqual(Object.keys(KIT_TOOLS).sort());
    for (const [name, t] of Object.entries(TOOLS)) expect(t, name).toEqual(KIT_TOOLS[name]);
  });
});
