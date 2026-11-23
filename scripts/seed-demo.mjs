import { pathToFileURL } from 'node:url'
import { seed } from '../apilib/demo-data.mjs'

export async function seedDemo(pool, { env = process.env, force = false } = {}) {
  if (env.NODE_ENV === 'production' && !force) {
    throw new Error('Demo seeding refused in production; pass --force to opt in')
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const data = seed()
    for (const vault of data.vaults) {
      const { rows } = await client.query(`INSERT INTO vaults
        (id, name, creator, amount, start_date, end_date, verifier, success_destination,
         failure_destination, status, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vault_status,$11,$12)
        ON CONFLICT (id) DO NOTHING RETURNING id`,
      [vault.id, vault.name, vault.creator, vault.amount, vault.startDate, vault.endDate,
        vault.verifier, vault.successDestination, vault.failureDestination, vault.status,
        vault.createdAt, vault.updatedAt])
      // Existing vaults belong to the operator: leave them and their children alone.
      if (!rows.length) continue
      for (const [index, milestone] of vault.milestones.entries()) {
        await client.query(`INSERT INTO milestones
          (id, vault_id, title, target_amount, amount, deadline, due_date, status, sort_order)
          VALUES ($1,$2,$3,$4,$4,$5,$5,$6::milestone_status,$7) ON CONFLICT (id) DO NOTHING`,
        [milestone.id, vault.id, milestone.title, milestone.amount, milestone.dueDate, milestone.status, index])
      }
      for (const activity of data.activity.filter((item) => item.vaultId === vault.id)) {
        await client.query(`INSERT INTO activity_log (id,type,vault_id,amount,status,hash,memo,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [activity.id, activity.type, activity.vaultId, activity.amount, activity.status,
          activity.hash, activity.memo, activity.createdAt])
      }
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

export async function main({ env = process.env, argv = process.argv.slice(2) } = {}) {
  if (env.NODE_ENV === 'production' && !argv.includes('--force')) {
    throw new Error('Demo seeding refused in production; pass --force to opt in')
  }
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required for demo seeding')
  const pg = (await import('pg')).default
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL,
    ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 2000, statement_timeout: 5000 })
  try { await seedDemo(pool, { env, force: argv.includes('--force') }) }
  finally { await pool.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => console.log('Demo seed complete')).catch((error) => {
    console.error(error.message.startsWith('Demo seeding refused') ? error.message : 'Demo seed failed; verify configuration and migrations')
    process.exitCode = 1
  })
}
