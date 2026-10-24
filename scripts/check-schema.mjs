import pg from 'pg'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { Pool } = pg

export const REQUIRED_SCHEMA = {
  enums: {
    vault_status: ['active', 'completed', 'failed'],
    milestone_status: ['pending', 'completed', 'failed'],
  },
  columns: {
    vaults: ['name', 'verifier', 'start_date', 'end_date', 'deleted_at'],
    milestones: ['sort_order', 'amount', 'due_date', 'deadline', 'target_amount', 'deleted_at'],
  },
}

/**
 * Validates actual schema against required schema.
 * Pure comparison logic suitable for unit testing with mocked schema info.
 *
 * @param {{ columns: Record<string, string[] | Set<string>>, enums: Record<string, string[] | Set<string>> }} actualSchema
 * @param {typeof REQUIRED_SCHEMA} requiredSchema
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSchema(actualSchema, requiredSchema = REQUIRED_SCHEMA) {
  const errors = []

  // Check enums
  for (const [enumName, requiredValues] of Object.entries(requiredSchema.enums || {})) {
    const actualValues = actualSchema.enums?.[enumName]
    if (!actualValues) {
      errors.push(`Missing enum type: "${enumName}"`)
      continue
    }
    const actualSet = actualValues instanceof Set ? actualValues : new Set(actualValues)
    for (const val of requiredValues) {
      if (!actualSet.has(val)) {
        errors.push(`Missing required enum value "${val}" in enum "${enumName}"`)
      }
    }
  }

  // Check table columns
  for (const [tableName, requiredColumns] of Object.entries(requiredSchema.columns || {})) {
    const actualColumns = actualSchema.columns?.[tableName]
    if (!actualColumns) {
      errors.push(`Missing table: "${tableName}"`)
      continue
    }
    const actualSet = actualColumns instanceof Set ? actualColumns : new Set(actualColumns)
    for (const col of requiredColumns) {
      if (!actualSet.has(col)) {
        errors.push(`Missing required column "${col}" in table "${tableName}"`)
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Introspects Postgres database to fetch columns and enums.
 *
 * @param {import('pg').Pool | import('pg').Client} client
 * @returns {Promise<{ columns: Record<string, string[]>, enums: Record<string, string[]> }>}
 */
export async function introspectSchema(client) {
  const columnsResult = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `)

  const columns = {}
  for (const row of columnsResult.rows) {
    if (!columns[row.table_name]) {
      columns[row.table_name] = []
    }
    columns[row.table_name].push(row.column_name)
  }

  const enumsResult = await client.query(`
    SELECT t.typname AS enum_name, e.enumlabel AS enum_value
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    ORDER BY e.enumsortorder
  `)

  const enums = {}
  for (const row of enumsResult.rows) {
    if (!enums[row.enum_name]) {
      enums[row.enum_name] = []
    }
    enums[row.enum_name].push(row.enum_value)
  }

  return { columns, enums }
}

/**
 * Runs the schema check against DATABASE_URL.
 */
export async function runCheck(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required to run check-schema.')
  }

  const pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
  })

  try {
    const actualSchema = await introspectSchema(pool)
    const { valid, errors } = validateSchema(actualSchema, REQUIRED_SCHEMA)

    if (!valid) {
      console.error('Schema check failed! The following requirements were missing:')
      for (const err of errors) {
        console.error(` - ${err}`)
      }
      return false
    }

    console.log('Schema check passed: all required enums and columns used by apilib/store.mjs are present.')
    return true
  } finally {
    await pool.end().catch(() => {})
  }
}

// CLI execution
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  runCheck().then((passed) => {
    if (!passed) {
      process.exit(1)
    }
    process.exit(0)
  }).catch((err) => {
    console.error('Error running check-schema:', err.message)
    process.exit(1)
  })
}
