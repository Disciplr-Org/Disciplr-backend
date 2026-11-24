#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Environment variables defined in `src/config/env.ts` that are intentionally
 * omitted from `.env.example`. Keep this empty unless a variable is genuinely
 * internal-only.
 */
export const ALLOWLIST = new Set([]);

/**
 * Extract the top-level body of the `z.object({ ... })` call from `env.ts`
 * source text, returning `null` if no `z.object({` call is found.
 *
 * Tracks brace depth while skipping line comments, block comments, and
 * string/template literals so nested callbacks (e.g. `.transform(() => { ... })`)
 * do not prematurely close the object literal.
 */
function extractZodObjectBody(source) {
  const match = /\bz\s*\.\s*object\s*\(\s*\{/.exec(source);
  if (!match) {
    return null;
  }

  const startIndex = match.index + match[0].length;
  let depth = 1;
  let i = startIndex;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < source.length && depth > 0) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inSingle) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      i += 1;
      continue;
    }
    if (inTemplate) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") inTemplate = false;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i += 1;
      continue;
    }
    if (ch === "`") {
      inTemplate = true;
      i += 1;
      continue;
    }

    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex, i);
      }
    }
    i += 1;
  }

  return null;
}

/**
 * Extract all top-level environment variable keys from the `z.object({ ... })`
 * schema in `src/config/env.ts` source text.
 *
 * @param {string} source
 * @returns {string[]} Sorted, deduplicated list of variable names.
 */
export function extractEnvTsKeys(source) {
  const body = extractZodObjectBody(source) ?? source;
  const keys = new Set();

  let depth = 0;
  let inBlockComment = false;

  for (const rawLine of body.split(/\r?\n/)) {
    let line = rawLine;

    if (inBlockComment) {
      const endIdx = line.indexOf("*/");
      if (endIdx === -1) continue;
      line = line.slice(endIdx + 2);
      inBlockComment = false;
    }

    // Strip inline block comments and detect multi-line block comment openings
    let cleaned = "";
    let i = 0;
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    while (i < line.length) {
      const ch = line[i];
      const next = line[i + 1];

      if (!inSingle && !inDouble && !inTemplate) {
        if (ch === "/" && next === "/") {
          break;
        }
        if (ch === "/" && next === "*") {
          const closeIdx = line.indexOf("*/", i + 2);
          if (closeIdx === -1) {
            inBlockComment = true;
            break;
          }
          i = closeIdx + 2;
          continue;
        }
      }

      if (ch === "\\" && (inSingle || inDouble || inTemplate)) {
        cleaned += ch + (next ?? "");
        i += 2;
        continue;
      }
      if (ch === "'" && !inDouble && !inTemplate) inSingle = !inSingle;
      else if (ch === '"' && !inSingle && !inTemplate) inDouble = !inDouble;
      else if (ch === "`" && !inSingle && !inDouble) inTemplate = !inTemplate;

      cleaned += ch;
      i += 1;
    }

    if (depth === 0) {
      const keyMatch = /^\s*([A-Z][A-Z0-9_]+)\s*:/.exec(cleaned);
      if (keyMatch) {
        keys.add(keyMatch[1]);
      }
    }

    // Update brace depth for nested blocks (e.g. `.transform((v) => { ... })`)
    let s = false;
    let d = false;
    let t = false;
    for (let j = 0; j < cleaned.length; j += 1) {
      const ch = cleaned[j];
      if (ch === "\\" && (s || d || t)) {
        j += 1;
        continue;
      }
      if (ch === "'" && !d && !t) s = !s;
      else if (ch === '"' && !s && !t) d = !d;
      else if (ch === "`" && !s && !d) t = !t;
      else if (!s && !d && !t) {
        if (ch === "{") depth += 1;
        else if (ch === "}") depth = Math.max(0, depth - 1);
      }
    }
  }

  return [...keys].sort();
}

/**
 * Extract all environment variable keys documented in a `.env.example` file,
 * including commented-out optional examples such as `# OPTIONAL_VAR=value`.
 *
 * @param {string} source
 * @returns {string[]} Sorted, deduplicated list of variable names.
 */
export function extractEnvExampleKeys(source) {
  const keys = new Set();
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*(?:#\s*)?(?:export\s+)?([A-Z][A-Z0-9_]+)\s*=/.exec(line);
    if (match) {
      keys.add(match[1]);
    }
  }
  return [...keys].sort();
}

/**
 * Compare environment variable keys defined in `src/config/env.ts` against
 * those documented in `.env.example`, honouring an explicit allowlist.
 *
 * @param {{ envTsSource: string, envExampleSource: string, allowlist?: Iterable<string> }} params
 * @returns {{ envTsKeys: string[], envExampleKeys: string[], missingKeys: string[] }}
 */
export function findMissingEnvExampleKeys({
  envTsSource,
  envExampleSource,
  allowlist = ALLOWLIST,
}) {
  const envTsKeys = extractEnvTsKeys(envTsSource);
  const envExampleKeys = extractEnvExampleKeys(envExampleSource);
  const documented = new Set(envExampleKeys);
  const allowed = new Set(allowlist);

  const missingKeys = envTsKeys.filter(
    (key) => !documented.has(key) && !allowed.has(key),
  );

  return { envTsKeys, envExampleKeys, missingKeys };
}

/**
 * CLI runner. Returns process exit code (0 when all keys are documented, 1 otherwise).
 */
export function runCli({
  envTsPath,
  envExamplePath,
  allowlist = ALLOWLIST,
  stdout = console.log,
  stderr = console.error,
} = {}) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..");
  const resolvedEnvTs = envTsPath ?? path.join(repoRoot, "src", "config", "env.ts");
  const resolvedEnvExample = envExamplePath ?? path.join(repoRoot, ".env.example");

  const envTsSource = fs.readFileSync(resolvedEnvTs, "utf8");
  const envExampleSource = fs.readFileSync(resolvedEnvExample, "utf8");

  const { envTsKeys, missingKeys } = findMissingEnvExampleKeys({
    envTsSource,
    envExampleSource,
    allowlist,
  });

  if (missingKeys.length > 0) {
    stderr(
      `Missing ${missingKeys.length} environment variable(s) from .env.example (defined in src/config/env.ts):`,
    );
    for (const key of missingKeys) {
      stderr(`  - ${key}`);
    }
    return 1;
  }

  stdout(
    `OK: all ${envTsKeys.length} environment variables in src/config/env.ts are documented in .env.example.`,
  );
  return 0;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  process.exitCode = runCli();
}
