import { PrismaClient } from '@prisma/client';

// One client per process (also across dev hot reloads). Only src/server/tools, src/server/auth and the
// health check may import this file — enforced by ESLint (eslint.config.mjs).
const g = globalThis as unknown as { __prisma?: PrismaClient };
export const db = g.__prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') g.__prisma = db;
