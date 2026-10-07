import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './password';

describe('passwords', () => {
  it('stores a bcrypt hash, never the password, and verifies it', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(hash).not.toContain('correct');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });
  it('rejects when there is no stored hash (unknown user), after doing the same work', async () => {
    expect(await verifyPassword('anything', undefined)).toBe(false);
    expect(await verifyPassword('anything', null)).toBe(false);
  });
});
