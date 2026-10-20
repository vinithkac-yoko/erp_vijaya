import { beforeEach, describe, it, expect } from 'vitest';
import { isBlocked, recordFailure, recordSuccess, resetRateLimits } from './rate-limit';

describe('login rate limit', () => {
  beforeEach(resetRateLimits);

  it('blocks one person from one place after 5 misses, for 15 minutes', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i++) recordFailure('1.1.1.1', 'a@x', t0);
    expect(isBlocked('1.1.1.1', 'a@x', t0)).toBe(false);
    recordFailure('1.1.1.1', 'a@x', t0);
    expect(isBlocked('1.1.1.1', 'a@x', t0)).toBe(true);
    expect(isBlocked('1.1.1.1', 'a@x', t0 + 14 * 60_000)).toBe(true);
    expect(isBlocked('1.1.1.1', 'a@x', t0 + 15 * 60_000 + 1)).toBe(false);
  });
  it('does not lock the real user out because a stranger guessed from another place', () => {
    for (let i = 0; i < 10; i++) recordFailure('9.9.9.9', 'storekeeper@x');
    expect(isBlocked('9.9.9.9', 'storekeeper@x')).toBe(true);
    expect(isBlocked('2.2.2.2', 'storekeeper@x')).toBe(false);
  });
  it('blocks one place that tries many names', () => {
    for (let i = 0; i < 30; i++) recordFailure('7.7.7.7', `user${i}@x`);
    expect(isBlocked('7.7.7.7', 'someone-new@x')).toBe(true);
  });
  it('a good login clears that person\'s misses', () => {
    for (let i = 0; i < 4; i++) recordFailure('1.1.1.1', 'a@x');
    recordSuccess('1.1.1.1', 'a@x');
    recordFailure('1.1.1.1', 'a@x');
    expect(isBlocked('1.1.1.1', 'a@x')).toBe(false);
  });
});
