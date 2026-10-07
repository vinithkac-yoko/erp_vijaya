import { describe, it, expect } from 'vitest';
import { health } from '@/server/health';

describe('health (real Postgres)', () => {
  it('is ok when the config is set, the database answers and every guard is in place', async () => {
    expect(await health()).toEqual({ ok: true, config: 'ok', database: 'ok', guards: { expected: expect.any(Number), missing: [] } });
  });
});
