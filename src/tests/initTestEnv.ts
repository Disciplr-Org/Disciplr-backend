/**
 * Side-effect import that initializes the validated env before any module
 * with import-time `getEnv()` calls (e.g. src/db/index.ts) is evaluated.
 *
 * Import this FIRST in suites whose import graph reaches such modules —
 * ESM evaluates dependencies in declaration order, so this module's body
 * runs before the modules imported after it.
 */
import { initEnv } from '../config/env.js'

process.env.DATABASE_URL ??=
  'postgresql://postgres:postgres@localhost:5432/postgres'

initEnv()
