import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is not set'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  APP_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof schema>;

/** Names of the settings that are missing or invalid. Empty when the app is configured. */
export function configProblems(source: NodeJS.ProcessEnv = process.env): string[] {
  const r = schema.safeParse(source);
  return r.success ? [] : [...new Set(r.error.issues.map((i) => String(i.path[0])))];
}

export function env(source: NodeJS.ProcessEnv = process.env): Env {
  const r = schema.safeParse(source);
  if (!r.success) {
    const names = [...new Set(r.error.issues.map((i) => String(i.path[0])))].join(', ');
    throw new Error(`Vijaya Stores is not set up correctly. Check these settings: ${names}.`);
  }
  return r.data;
}
