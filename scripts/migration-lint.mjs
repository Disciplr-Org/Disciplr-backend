import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ALLOWLISTED_EMPTY_MIGRATIONS = new Set([
  '20260602115607_add_soft_delete_to_vaults_and_milestones.cjs',
])

export const ALLOWLISTED_DUPLICATE_TIMESTAMPS = new Set([
  '20260602000000',
  '20260602130000',
  '20260627000000',
  '20260627130000',
  '20260628000000',
  '20260629000000',
  '20260827000000',
])

function stripComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '')
}

export function isEmptyMigration(content) {
  const code = stripComments(content).trim()
  if (!code) return true

  // Check if both up and down functions have empty bodies
  const upMatch = code.match(/exports\.up\s*=\s*(?:async\s+)?(?:function[^{]*|\([^)]*\)\s*=>)\s*\{([^}]*)\}/)
  const downMatch = code.match(/exports\.down\s*=\s*(?:async\s+)?(?:function[^{]*|\([^)]*\)\s*=>)\s*\{([^}]*)\}/)

  if (upMatch && downMatch) {
    const upBody = upMatch[1].replace(/[\s;]/g, '')
    const downBody = downMatch[1].replace(/[\s;]/g, '')
    if (upBody === '' && downBody === '') {
      return true
    }
  }

  return false
}

export function lintMigrations(migrationsDir, options = {}) {
  const allowlistedEmpty = options.allowlistedEmpty instanceof Set
    ? options.allowlistedEmpty
    : new Set(options.allowlistedEmpty || ALLOWLISTED_EMPTY_MIGRATIONS)

  const allowlistedDuplicates = options.allowlistedDuplicates instanceof Set
    ? options.allowlistedDuplicates
    : new Set(options.allowlistedDuplicates || ALLOWLISTED_DUPLICATE_TIMESTAMPS)

  const errors = []
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => /^\d{14}_.*\.c?js$/.test(f))
    .sort()

  const timestampGroups = new Map()
  const emptyFiles = []

  for (const file of files) {
    const timestamp = file.slice(0, 14)
    if (!timestampGroups.has(timestamp)) {
      timestampGroups.set(timestamp, [])
    }
    timestampGroups.get(timestamp).push(file)

    const fullPath = path.join(migrationsDir, file)
    const content = fs.readFileSync(fullPath, 'utf8')

    if (isEmptyMigration(content)) {
      emptyFiles.push(file)
      if (!allowlistedEmpty.has(file)) {
        errors.push(`Empty migration not allowed: "${file}"`)
      }
    }
  }

  const duplicates = {}
  for (const [timestamp, group] of timestampGroups.entries()) {
    if (group.length > 1) {
      duplicates[timestamp] = group
      if (!allowlistedDuplicates.has(timestamp)) {
        errors.push(
          `Duplicate migration timestamp ${timestamp} found in migrations: ${group.join(', ')}`,
        )
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    summary: {
      total: files.length,
      empty: emptyFiles,
      duplicates,
    },
  }
}

// CLI execution
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const targetDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(process.cwd(), 'db/migrations')

  const result = lintMigrations(targetDir)
  if (!result.valid) {
    console.error('Migration lint failed:')
    for (const err of result.errors) {
      console.error(` - ${err}`)
    }
    process.exit(1)
  }

  console.log(`Migration lint passed (${result.summary.total} migrations checked).`)
  process.exit(0)
}
