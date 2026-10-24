// Data store for the deployed Disciplr API.
// - If DATABASE_URL is set, uses Postgres (the real `vaults` / `milestones` tables created by
//   `npm run migrate:latest`, and `activity_log`, all owned by migrations).
// - Explicit memory mode or non-production without a URL uses demo memory.
// - Postgres failures and production without a URL fail closed.
import { randomUUID, randomBytes } from 'node:crypto'
import { createStoreProvider } from './store-bootstrap.mjs'
import { seed } from './demo-data.mjs'
import { parseAmount, formatAmount } from './amount.mjs'
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
  constructor() { const s = seed(); this.vaults = s.vaults; this.activity = s.activity; this.transitionLocks = new Map(); this.evidence = [] }
  async init() {}
  async listVaults({ creator, status, limit, cursor } = {}) {
    let filtered = this.vaults.filter((v) => (!creator || v.creator === creator) && (!status || v.status === status))
    
    // Apply cursor filter
    if (cursor) {
      filtered = filtered.filter((v) => {
        const cmp = v.createdAt.localeCompare(cursor.timestamp)
        return cmp < 0 || (cmp === 0 && v.id < cursor.id)
      })
    }
    
    // Sort by (created_at DESC, id DESC)
    filtered.sort((a, b) => {
      const cmp = b.createdAt.localeCompare(a.createdAt)
      return cmp !== 0 ? cmp : b.id.localeCompare(a.id)
    })
    
    // Apply limit + 1 to check for next page
    const pageSize = limit || 25
    const page = filtered.slice(0, pageSize + 1)
    const hasMore = page.length > pageSize
    const items = hasMore ? page.slice(0, pageSize) : page
    
    return {
      items: items.map((v) => this._attachEvidence(v)),
      hasMore,
      lastItem: items.length > 0 ? items[items.length - 1] : null,
    }
  }
  async getVault(id) {
    const v = this.vaults.find((v) => v.id === id)
    return v ? this._attachEvidence(v) : null
  }
  _attachEvidence(vault) {
    const vaultEvidence = this.evidence.filter((e) => e.vaultId === vault.id)
    return {
      ...vault,
      milestones: vault.milestones.map((m) => {
        const mEvidence = vaultEvidence.filter((e) => e.milestoneId === m.id)
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
          .slice(0, 10)
        return {
          ...m,
          evidence: mEvidence,
          latestEvidenceHash: mEvidence.length > 0 ? mEvidence[0].sha256 : null,
        }
      }),
    }
  }

  // Aggregate statistics for dashboard without loading all vaults.
  async aggregateStats({ creator, verifier } = {}) {
    const filtered = this.vaults.filter((v) => (!creator || v.creator === creator) && (!verifier || v.verifier === verifier))
    const totalVaults = filtered.length
    const active = filtered.filter(v => v.status === 'active').length
    const completed = filtered.filter(v => v.status === 'completed').length
    const failed = filtered.filter(v => v.status === 'failed').length
    const totalLocked = formatAmount(filtered.filter(v => v.status === 'active').reduce((sum, v) => sum + parseAmount(v.amount), 0n))
    const totalReleased = formatAmount(filtered.filter(v => v.status === 'completed').reduce((sum, v) => sum + parseAmount(v.amount), 0n))
    const totalRedirected = formatAmount(filtered.filter(v => v.status === 'failed').reduce((sum, v) => sum + parseAmount(v.amount), 0n))
    return { totalVaults, active, completed, failed, totalLocked, totalReleased, totalRedirected }
  }

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
  async listActivity({ vaultId, limit, cursor } = {}) {
    let filtered = this.activity.filter((a) => !vaultId || a.vaultId === vaultId)
    
    // Apply cursor filter
    if (cursor) {
      filtered = filtered.filter((a) => {
        const cmp = a.createdAt.localeCompare(cursor.timestamp)
        return cmp < 0 || (cmp === 0 && a.id < cursor.id)
      })
    }
    
    // Sort by (created_at DESC, id DESC)
    filtered.sort((a, b) => {
      const cmp = b.createdAt.localeCompare(a.createdAt)
      return cmp !== 0 ? cmp : b.id.localeCompare(a.id)
    })
    
    // Apply limit + 1 to check for next page
    const pageSize = limit || 25
    const page = filtered.slice(0, pageSize + 1)
    const hasMore = page.length > pageSize
    const items = hasMore ? page.slice(0, pageSize) : page
    
    return {
      items,
      hasMore,
      lastItem: items.length > 0 ? items[items.length - 1] : null,
    }
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
  async addMilestoneEvidence({ id, vaultId, milestoneId, url, sha256, note, submittedBy, verified = false }) {
    const evidence = {
      id,
      vaultId,
      milestoneId,
      url,
      sha256,
      note: note || null,
      submittedBy,
      verified,
      createdAt: iso(Date.now()),
    }
    this.evidence.push(evidence)
    return evidence
  }
}

export class PgStore {
  kind = 'postgres'
  constructor(pool) { this.pool = pool }
  async init() {
    await this.pool.query('SELECT 1')
  }

  rowToVault(r, ms, evidence = []) {
    const milestones = ms.filter((m) => m.vault_id === r.id).sort((a, b) => a.sort_order - b.sort_order)
      .map((m) => {
        const mEvidence = evidence.filter((e) => e.milestone_id === m.id)
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .slice(0, 10)
          .map((e) => ({
            id: e.id,
            url: e.url,
            sha256: e.sha256,
            note: e.note || null,
            submittedBy: e.submitted_by,
            verified: e.verified || false,
            createdAt: iso(e.created_at),
          }))
        return {
          id: m.id,
          title: m.title,
          amount: formatAmount(parseAmount(m.amount)),
          dueDate: iso(m.due_date || m.deadline),
          status: m.status,
          evidence: mEvidence,
          latestEvidenceHash: mEvidence.length > 0 ? mEvidence[0].sha256 : null,
        }
      })
    return {
      id: r.id, name: r.name || `Vault ${r.id}`, creator: r.creator, amount: formatAmount(parseAmount(r.amount)), status: r.status, startDate: iso(r.start_date), endDate: iso(r.end_date),
      verifier: r.verifier, successDestination: r.success_destination, failureDestination: r.failure_destination,
      onchainStatus: r.onchain_status || null,
      createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
      milestones,
    }
  }
  async listVaults({ creator, status, limit, cursor } = {}) {
    const w = ['deleted_at IS NULL']; const p = []
    if (creator) { p.push(creator); w.push(`creator = $${p.length}`) }
    if (status) { p.push(status); w.push(`status = $${p.length}::vault_status`) }
    
    // Apply cursor WHERE clause for keyset pagination
    if (cursor) {
      p.push(cursor.timestamp, cursor.id)
      w.push(`(created_at, id) < ($${p.length - 1}, $${p.length})`)
    }
    
    const pageSize = limit || 25
    p.push(pageSize + 1)
    
    const { rows } = await this.pool.query(
      `SELECT * FROM vaults WHERE ${w.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${p.length}`,
      p
    )
    
    const hasMore = rows.length > pageSize
    const items = hasMore ? rows.slice(0, pageSize) : rows
    
    if (!items.length) return { items: [], hasMore: false, lastItem: null }
    
    const vaultIds = items.map((r) => r.id)
    const ms = (await this.pool.query('SELECT * FROM milestones WHERE vault_id = ANY($1) AND deleted_at IS NULL', [vaultIds])).rows
    const evidence = (await this.pool.query('SELECT * FROM milestone_evidence WHERE vault_id = ANY($1)', [vaultIds])).rows
    
    const vaults = items.map((r) => this.rowToVault(r, ms, evidence))
    return {
      items: vaults,
      hasMore,
      lastItem: items.length > 0 ? items[items.length - 1] : null,
    }
  }

  // Aggregate statistics for dashboard without loading all vaults.
  async aggregateStats({ creator, verifier } = {}) {
    const w = ['deleted_at IS NULL']; const p = []
    if (creator) { p.push(creator); w.push(`creator = $${p.length}`) }
    if (verifier) { p.push(verifier); w.push(`verifier = $${p.length}`) }
    const q = `SELECT 
      count(*) AS total_vaults,
      count(*) FILTER (WHERE status = 'active'::vault_status) AS active,
      count(*) FILTER (WHERE status = 'completed'::vault_status) AS completed,
      count(*) FILTER (WHERE status = 'failed'::vault_status) AS failed,
      COALESCE(sum(amount) FILTER (WHERE status = 'active'::vault_status), 0) AS total_locked,
      COALESCE(sum(amount) FILTER (WHERE status = 'completed'::vault_status), 0) AS total_released,
      COALESCE(sum(amount) FILTER (WHERE status = 'failed'::vault_status), 0) AS total_redirected
    FROM vaults WHERE ${w.join(' AND ')}`
    const { rows } = await this.pool.query(q, p)
    const r = rows[0]
    return {
      totalVaults: Number(r.total_vaults),
      active: Number(r.active),
      completed: Number(r.completed),
      failed: Number(r.failed),
      totalLocked: formatAmount(parseAmount(String(r.total_locked))),
      totalReleased: formatAmount(parseAmount(String(r.total_released))),
      totalRedirected: formatAmount(parseAmount(String(r.total_redirected))),
    }
  }
  async getVault(id) {
    const { rows } = await this.pool.query('SELECT * FROM vaults WHERE id = $1 AND deleted_at IS NULL', [id])
    if (!rows[0]) return null
    const ms = (await this.pool.query('SELECT * FROM milestones WHERE vault_id = $1 AND deleted_at IS NULL', [id])).rows
    const evidence = (await this.pool.query('SELECT * FROM milestone_evidence WHERE vault_id = $1', [id])).rows
    return this.rowToVault(rows[0], ms, evidence)
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
  actRow(r) { return { id: r.id, type: r.type, vaultId: r.vault_id, amount: formatAmount(parseAmount(r.amount)), status: r.status, hash: r.hash, memo: r.memo, ledger: r.ledger == null ? null : Number(r.ledger), createdAt: iso(r.created_at) } }
  async getActivityByHash(hash) {
    const { rows } = await this.pool.query('SELECT * FROM activity_log WHERE hash=$1 LIMIT 1', [hash])
    return rows[0] ? this.actRow(rows[0]) : null
  }
  async saveActivity(a) {
    await this.pool.query('UPDATE activity_log SET status=$2, memo=$3, ledger=$4 WHERE id=$1', [a.id, a.status, a.memo, a.ledger ?? null])
    return a
  }
  async listActivity({ vaultId, limit, cursor } = {}) {
    const w = []; const p = []
    if (vaultId) { p.push(vaultId); w.push(`vault_id = $${p.length}`) }
    
    // Apply cursor WHERE clause for keyset pagination
    if (cursor) {
      p.push(cursor.timestamp, cursor.id)
      w.push(`(created_at, id) < ($${p.length - 1}, $${p.length})`)
    }
    
    const pageSize = limit || 25
    p.push(pageSize + 1)
    
    const whereClause = w.length > 0 ? `WHERE ${w.join(' AND ')}` : ''
    const { rows } = await this.pool.query(
      `SELECT * FROM activity_log ${whereClause} ORDER BY created_at DESC, id DESC LIMIT $${p.length}`,
      p
    )
    
    const hasMore = rows.length > pageSize
    const items = hasMore ? rows.slice(0, pageSize) : rows
    
    return {
      items: items.map((r) => this.actRow(r)),
      hasMore,
      lastItem: items.length > 0 ? items[items.length - 1] : null,
    }
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
  async addMilestoneEvidence({ id, vaultId, milestoneId, url, sha256, note, submittedBy, verified = false }) {
    const { rows } = await this.pool.query(
      `INSERT INTO milestone_evidence (id, vault_id, milestone_id, url, sha256, note, submitted_by, verified, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       RETURNING *`,
      [id, vaultId, milestoneId, url, sha256, note || null, submittedBy, verified]
    )
    return {
      id: rows[0].id,
      url: rows[0].url,
      sha256: rows[0].sha256,
      note: rows[0].note || null,
      submittedBy: rows[0].submitted_by,
      verified: rows[0].verified || false,
      createdAt: iso(rows[0].created_at),
    }
  }
}

const makeProvider = () => createStoreProvider({
  makePool: async (config) => new (await import('pg')).default.Pool(config),
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
