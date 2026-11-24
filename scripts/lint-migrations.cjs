const { readdirSync } = require('node:fs')
const path = require('node:path')

const migrationsDirectory = path.resolve(__dirname, '../db/migrations')
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith('.cjs'))
  .sort()

let hasErrors = false

for (const file of migrationFiles) {
  const migrationPath = path.join(migrationsDirectory, file)
  try {
    const migration = require(migrationPath)
    if (typeof migration.up !== 'function' || typeof migration.down !== 'function') {
      console.error(`${file}: migration must export up and down functions`)
      hasErrors = true
    }
  } catch (error) {
    console.error(`${file}: ${error.message}`)
    hasErrors = true
  }
}

if (hasErrors) {
  process.exitCode = 1
} else {
  console.log(`Validated ${migrationFiles.length} migration files`)
}
