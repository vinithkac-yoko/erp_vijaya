import { describe, it, expect } from 'vitest';
import { health } from '@/server/health';
import { checkGuards } from '@/server/guards';

describe('health (real Postgres)', () => {
  it('is ok when the config is set and the database answers', async () => {
    expect(await health()).toEqual({ ok: true, config: 'ok', database: 'ok', guards: { expected: 0, missing: [] } });
  });
  it('lists a guard trigger that is missing, by name', async () => {
    expect(await checkGuards(['trg_that_does_not_exist'])).toEqual({ expected: 1, missing: ['trg_that_does_not_exist'] });
  });
});
