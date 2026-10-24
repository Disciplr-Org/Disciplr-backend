// Data store for the deployed Disciplr API.
// - If DATABASE_URL is set, uses Postgres (the real `vaults` / `milestones` tables created by
//   `npm run migrate:latest`, and `activity_log`, all owned by migrations).
// - Explicit memory mode or non-production without a URL uses demo memory.
// - Postgres failures and production without a URL fail closed.
import { randomUUID, randomBytes } from 'node:crypto'
import { createStoreProvider } from './store-bootstrap.mjs'
import { seed } from './demo-data.mjs'
import { wrapPoolForTiming } from './log.mjs'
const iso = (d) => new Date(d).toISOString()
const hex = (n) => randomBytes(n).toString('hex')

// Raised by transition() when the vault/milestone state no longer allows the requested change
// (e.g. a concurrent request got there first). Routes map it to 409.
export class StoreConflictError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'StoreConflictError'
    this.details = details
  }
}

// Applies a transition result ({ conflict?, error?, vaultStatus?, milestoneUpdates?, activities? })
// to a vault snapshot and returns the resulting vault (pure; no persistence).
function applyTransition(current, result) {
  if (!result || typeof result !== 'object') throw new Error('Transition callback must return an object.')
  if (result.conflict) throw new StoreConflictError(result.error || 'Concurrent update detected', { vaultId: current.id, vaultStatus: current.status })
  const next = new Map()
  for (const u of Array.isArray(result.milestoneUpdates) ? result.milestoneUpdates : []) {
    if (!current.milestones.some((m) => m.id === u.id)) throw new Error(`Milestone ${u.id} not found while applying transition.`)
    next.set(u.id, u.status)
  }
  return {
    ...current,
    status: result.vaultStatus ?? current.status,
    milestones: current.milestones.map((m) => ({ ...m, status: next.has(m.id) ? next.get(m.id) : m.status })),
  }
}

export class MemoryStore {
  kind = 'memory'
  constructor() { const s = seed(); this.vaults = s.vaults; this.activity = s.activity; this.transitionLocks = new Map() }
  async init() {}
  async listVaults({ creator, status } = {}) {
    return this.vaults.filter((v) => (!creator || v.creator === creator) && (!status || v.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async getVault(id) { return this.vaults.find((v) => v.id === id) || null }
  async createVault(v) { this.vaults.push(v); return v }
  async saveVault(v) { v.updatedAt = iso(Date.now()); return v }
  async addActivity(a) { this.activity.push(a); return a }
  async insertActivityTx(_tx, a) { return a }
  // Serialises read-check-write per vault so concurrent validate/fail requests cannot interleave.
  // fn receives a deep copy of the live vault; the vault, milestones and activity rows are applied
  // together only after every step succeeds.
  async transition(vaultId, fn) {
    const prev = this.transitionLocks.get(vaultId) ?? Promise.resolve()
    let release
    const mine = prev.then(() => new Promise((resolve) => { release = resolve }))
    this.transitionLocks.set(vaultId, mine)
    await prev
    try {
      const index = this.vaults.findIndex((v) => v.id === vaultId)
      if (index < 0) return null
      const current = this.vaults[index]
      const result = await fn(JSON.parse(JSON.stringify(current)))
      const vault = { ...applyTransition(current, result), updatedAt: iso(Date.now()) }
      const activities = Array.isArray(result.activities) ? result.activities : []
      for (const a of activities) await this.insertActivityTx(null, a)
      this.vaults[index] = vault
      this.activity.push(...activities)
      return { ...result, vaultStatus: vault.status, vault, activities }
    } finally {
      release()
      if (this.transitionLocks.get(vaultId) === mine) this.transitionLocks.delete(vaultId)
    }
  }
  async listActivity({ vaultId } = {}) {
    return this.activity.filter((a) => !vaultId || a.vaultId === vaultId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async getActivityByHash(hash) { return this.activity.find((a) => a.hash === hash) || null }
  async saveActivity(a) { return a }
  async expireOverdueVaults({ now = new Date(), batchSize = 100 } = {}) {
    const nowDate = new Date(now)
    const overdue = this.vaults
      .filter((v) => v.status === 'active' && !v.deletedAt && new Date(v.endDate) < nowDate)
      .sort((a, b) => new Date(a.endDate) - new Date(b.endDate))

    const batch = overdue.slice(0, batchSize)
    for (const v of batch) {
      v.status = 'failed'
      v.updatedAt = iso(nowDate)
      for (const m of v.milestones) {
        if (m.status !== 'completed') {
          m.status = 'failed'
        }
      }
      this.activity.push({
        id: randomUUID(),
        type: 'redirect',
        vaultId: v.id,
        amount: v.amount,
        status: 'simulated',
        hash: hex(32),
        memo: 'Deadline passed',
        createdAt: iso(nowDate),
      })
    }

    const remaining = overdue.length - batch.length
    return { processed: batch.length, remaining: Math.max(0, remaining) }
  }
}

export class PgStore {
  kind = 'postgres'
  constructor(pool) { this.pool = pool }
  async init() {
    await this.pool.query('SELECT 1')
  }

  rowToVault(r, ms) {
    return {
      id: r.id, name: r.name || `Vault ${r.id}`, creator: r.creator, amount: String(Number(r.amount)), status: r.status, startDate: iso(r.start_date), endDate: iso(r.end_date),
      verifier: r.verifier, successDestination: r.success_destination, failureDestination: r.failure_destination,
      onchainStatus: r.onchain_status || null,
      createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
      milestones: ms.filter((m) => m.vault_id === r.id).sort((a, b) => a.sort_order - b.sort_order)
        .map((m) => ({ id: m.id, title: m.title, amount: String(Number(m.amount)), dueDate: iso(m.due_date || m.deadline), status: m.status })),
    }
  }
  async listVaults({ creator, status } = {}) {
    const w = ['deleted_at IS NULL']; const p = []
    if (creator) { p.push(creator); w.push(`creator = $${p.length}`) }
    if (status) { p.push(status); w.push(`status = $${p.length}::vault_status`) }
    const { rows } = await this.pool.query(`SELECT * FROM vaults WHERE ${w.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, p)
    if (!rows.length) return []
    const ms = (await this.pool.query('SELECT * FROM milestones WHERE vault_id = ANY($1) AND deleted_at IS NULL', [rows.map((r) => r.id)])).rows
    return rows.map((r) => this.rowToVault(r, ms))
  }
  async getVault(id) {
    const { rows } = await this.pool.query('SELECT * FROM vaults WHERE id = $1 AND deleted_at IS NULL', [id])
    if (!rows[0]) return null
    const ms = (await this.pool.query('SELECT * FROM milestones WHERE vault_id = $1 AND deleted_at IS NULL', [id])).rows
    return this.rowToVault(rows[0], ms)
  }
  async createVault(v) {
    const c = await this.pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(`INSERT INTO vaults (id, name, creator, amount, start_date, end_date, verifier, success_destination, failure_destination, status, created_at, updated_at, onchain_status)
        VALUES ($1,$11,$2,$3,$4,$5,$6,$7,$8,$9::vault_status,$10,$10,$12)`,
      [v.id, v.creator, v.amount, v.startDate, v.endDate, v.verifier, v.successDestination, v.failureDestination, v.status, v.createdAt, v.name, v.onchainStatus || null])
      let i = 0
      for (const m of v.milestones) {
        await c.query(`INSERT INTO milestones (id, vault_id, title, target_amount, amount, deadline, due_date, status, sort_order)
          VALUES ($1,$2,$3,$4,$4,$5,$5,$6::milestone_status,$7)`, [m.id, v.id, m.title, m.amount, m.dueDate, m.status, i++])
      }
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    return v
  }
  async saveVault(v) {
    await this.pool.query('UPDATE vaults SET status=$2::vault_status, onchain_status=$3, updated_at=now() WHERE id=$1', [v.id, v.status, v.onchainStatus || null])
    for (const m of v.milestones) await this.pool.query('UPDATE milestones SET status=$2::milestone_status, updated_at=now() WHERE id=$1', [m.id, m.status])
    return v
  }
  async addActivity(a) {
    await this.pool.query('INSERT INTO activity_log (id,type,vault_id,amount,status,hash,memo,created_at,ledger) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [a.id, a.type, a.vaultId, a.amount, a.status, a.hash, a.memo, a.createdAt, a.ledger ?? null])
    return a
  }
  async insertActivityTx(client, a) {
    await client.query('INSERT INTO activity_log (id,type,vault_id,amount,status,hash,memo,created_at,ledger) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [a.id, a.type, a.vaultId, a.amount, a.status, a.hash, a.memo, a.createdAt, a.ledger ?? null])
    return a
  }
  // Locks the vault and its milestones (SELECT ... FOR UPDATE), lets fn decide the change against
  // the locked state, then writes milestones, vault status and activity in one transaction.
  async transition(vaultId, fn) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const vr = await client.query('SELECT * FROM vaults WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [vaultId])
      if (!vr.rows[0]) { await client.query('ROLLBACK'); return null }
      const mr = await client.query('SELECT * FROM milestones WHERE vault_id = $1 AND deleted_at IS NULL ORDER BY sort_order ASC FOR UPDATE', [vaultId])
      const current = this.rowToVault(vr.rows[0], mr.rows)
      const result = await fn(JSON.parse(JSON.stringify(current)))
      const vault = applyTransition(current, result)
      const before = new Map(current.milestones.map((m) => [m.id, m.status]))
      for (const m of vault.milestones) {
        if (before.get(m.id) === m.status) continue
        await client.query('UPDATE milestones SET status=$2::milestone_status, updated_at=now() WHERE id=$1', [m.id, m.status])
      }
      if (vault.status !== current.status) {
        await client.query('UPDATE vaults SET status=$2::vault_status, updated_at=now() WHERE id=$1', [vaultId, vault.status])
      }
      const activities = Array.isArray(result.activities) ? result.activities : []
      for (const a of activities) await this.insertActivityTx(client, a)
      await client.query('COMMIT')
      return { ...result, vaultStatus: vault.status, vault, activities }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }
  actRow(r) { return { id: r.id, type: r.type, vaultId: r.vault_id, amount: String(Number(r.amount)), status: r.status, hash: r.hash, memo: r.memo, ledger: r.ledger == null ? null : Number(r.ledger), createdAt: iso(r.created_at) } }
  async getActivityByHash(hash) {
    const { rows } = await this.pool.query('SELECT * FROM activity_log WHERE hash=$1 LIMIT 1', [hash])
    return rows[0] ? this.actRow(rows[0]) : null
  }
  async saveActivity(a) {
    await this.pool.query('UPDATE activity_log SET status=$2, memo=$3, ledger=$4 WHERE id=$1', [a.id, a.status, a.memo, a.ledger ?? null])
    return a
  }
  async listActivity({ vaultId } = {}) {
    const { rows } = vaultId
      ? await this.pool.query('SELECT * FROM activity_log WHERE vault_id=$1 ORDER BY created_at DESC LIMIT 200', [vaultId])
      : await this.pool.query('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 200')
    return rows.map((r) => this.actRow(r))
  }
  async expireOverdueVaults({ now = new Date(), batchSize = 100 } = {}) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const nowDate = new Date(now)
      const nowIso = iso(nowDate)

      // Lock up to batchSize active overdue vaults using SKIP LOCKED for concurrent safety
      const { rows: vaults } = await client.query(
        `SELECT id, amount FROM vaults
         WHERE status = 'active'::vault_status
           AND end_date < $1
           AND deleted_at IS NULL
         ORDER BY end_date ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [nowIso, batchSize],
      )

      if (vaults.length > 0) {
        const vaultIds = vaults.map((v) => v.id)

        // Mark vaults failed
        await client.query(
          `UPDATE vaults
           SET status = 'failed'::vault_status, updated_at = $1
           WHERE id = ANY($2)`,
          [nowIso, vaultIds],
        )

        // Mark non-completed milestones failed
        await client.query(
          `UPDATE milestones
           SET status = 'failed'::milestone_status, updated_at = $1
           WHERE vault_id = ANY($2)
             AND status <> 'completed'::milestone_status
             AND deleted_at IS NULL`,
          [nowIso, vaultIds],
        )

        // Insert redirect activity row for each expired vault
        for (const v of vaults) {
          const actId = randomUUID()
          const actHash = hex(32)
          await client.query(
            `INSERT INTO activity_log (id, type, vault_id, amount, status, hash, memo, created_at)
             VALUES ($1, 'redirect', $2, $3, 'simulated', $4, 'Deadline passed', $5)`,
            [actId, v.id, v.amount, actHash, nowIso],
          )
        }
      }

      // Count remaining active overdue vaults
      const { rows: remRows } = await client.query(
        `SELECT count(*)::int AS remaining
         FROM vaults
         WHERE status = 'active'::vault_status
           AND end_date < $1
           AND deleted_at IS NULL`,
        [nowIso],
      )

      await client.query('COMMIT')
      return { processed: vaults.length, remaining: remRows[0]?.remaining || 0 }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }
}

const makeProvider = () => createStoreProvider({
  makePool: async (config) => {
    const pool = new (await import('pg')).default.Pool(config)
    return wrapPoolForTiming(pool)
  },
  makePostgres: (pool) => new PgStore(pool),
  makeMemory: () => new MemoryStore(),
})
let provider = makeProvider()
let current
export function getStore() {
  current = provider()
  return current
}

// Test helper: drop the cached store (closing any Postgres pool) so the next getStore()
// re-reads DATABASE_URL / STORE_MODE.
export async function resetStore() {
  const old = current
  provider = makeProvider()
  current = undefined
  const store = await old?.catch(() => null)
  if (store?.pool) await store.pool.end().catch(() => {})
}
