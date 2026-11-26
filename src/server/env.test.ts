import { describe, it, expect } from 'vitest';
import { configProblems, env } from './env';

const good = { DATABASE_URL: 'postgresql://x', SESSION_SECRET: 'x'.repeat(32) } as unknown as NodeJS.ProcessEnv;

describe('env', () => {
  it('passes when the settings are there', () => {
    expect(configProblems(good)).toEqual([]);
    expect(env(good).DATABASE_URL).toBe('postgresql://x');
  });
  it('names what is missing, never the values', () => {
    expect(configProblems({} as NodeJS.ProcessEnv).sort()).toEqual(['DATABASE_URL', 'SESSION_SECRET']);
    expect(configProblems({ ...good, SESSION_SECRET: 'short' } as unknown as NodeJS.ProcessEnv)).toEqual(['SESSION_SECRET']);
    expect(() => env({ ...good, SESSION_SECRET: 'short-secret-value' } as unknown as NodeJS.ProcessEnv)).toThrow(/SESSION_SECRET/);
    expect(() => env({ ...good, SESSION_SECRET: 'short-secret-value' } as unknown as NodeJS.ProcessEnv)).not.toThrow(/short-secret-value/);
  });
});
