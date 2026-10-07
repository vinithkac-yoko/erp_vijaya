import { FlatCompat } from '@eslint/eslintrc';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

// Business tables are reached only through the Tool Gateway (VIJAYA prompt §3.1). Nothing outside the folders
// listed in `allowed` may import the Prisma client or the database module.
const noDb = {
  paths: [{ name: '@prisma/client', message: 'Go through the Tool Gateway (src/server/tools).' }],
  patterns: [{ group: ['@/server/db', '**/server/db'], message: 'Go through the Tool Gateway (src/server/tools).' }],
};
const allowed = ['src/server/db.ts', 'src/server/tools/**', 'src/server/auth/**', 'src/server/health.ts', 'src/server/guards.ts', 'src/server/errors.ts',
  'prisma/**', 'tests/**', 'e2e/**', 'src/**/*.test.ts'];

export default [
  { ignores: ['.next/**', 'node_modules/**', 'reference/**', 'evals/**', 'prompts/**', '.claude/**', 'next-env.d.ts'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  { rules: { 'no-restricted-imports': ['error', noDb], '@typescript-eslint/no-unused-vars': ['warn', { ignoreRestSiblings: true }] } },
  { files: allowed, rules: { 'no-restricted-imports': 'off' } },
];
