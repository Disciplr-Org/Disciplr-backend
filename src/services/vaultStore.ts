import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { getPgPool } from '../db/pool.js'
import type { CreateVaultInput, PersistedMilestone, PersistedVault } from '../types/vaults.js'

const memoryVaults: PersistedVault[] = []

const mapVaultRow = (row: {
  id: string
  amount: string
  start_date: string
  end_date: string
  verifier: string
  success_destination: string
  failure_destination: string
  creator: string | null
  status: PersistedVault['status']
  created_at: string
}): Omit<PersistedVault, 'milestones'> => ({
  id: row.id,
  amount: row.amount,
  startDate: row.start_date,
  endDate: row.end_date,
  verifier: row.verifier,
  successDestination: row.success_destination,
  failureDestination: row.failure_destination,
  creator: row.creator,
  status: row.status,
  createdAt: row.created_at,
})

export const createVaultWithMilestones = async (
  input: CreateVaultInput,
  customClient?: PoolClient,
): Promise<{ vault: PersistedVault; clientUsed: PoolClient | null }> => {
  const pool = getPgPool()
  const client = customClient ?? (pool ? await pool.connect() : null)
  const releaseClient = Boolean(client && !customClient)

  const vaultId = randomUUID()
  const now = new Date().toISOString()
  const milestones: PersistedMilestone[] = input.milestones.map((milestone, index) => ({
    id: randomUUID(),
    vaultId,
    title: milestone.title,
    description: milestone.description?.trim() || null,
    dueDate: milestone.dueDate,
    amount: milestone.amount,
    sortOrder: index,
    createdAt: now,
  }))

  if (!client) {
    const vault: PersistedVault = {
      id: vaultId,
      amount: input.amount,
      startDate: input.startDate,
      endDate: input.endDate,
      verifier: input.verifier,
      successDestination: input.destinations.success,
      failureDestination: input.destinations.failure,
      creator: input.creator ?? null,
      status: 'draft',
      createdAt: now,
      milestones,
    }
    memoryVaults.push(vault)
    return { vault, clientUsed: null }
  }

  try {
    if (!customClient) {
      await client.query('BEGIN')
    }

    const vaultResult = await client.query<{
      id: string
      amount: string
      start_date: string
      end_date: string
      verifier: string
      success_destination: string
      failure_destination: string
      creator: string | null
      status: PersistedVault['status']
      created_at: string
    }>(
      `INSERT INTO vaults
        (id, amount, start_date, end_date, verifier, success_destination, failure_destination, creator, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft')
       RETURNING id, amount::text, start_date, end_date, verifier, success_destination, failure_destination, creator, status, created_at`,
      [
        vaultId,
        input.amount,
        input.startDate,
        input.endDate,
        input.verifier,
        input.destinations.success,
        input.destinations.failure,
        input.creator ?? null,
      ],
    )

    for (const milestone of milestones) {
      await client.query(
        `INSERT INTO milestones
          (id, vault_id, title, description, due_date, amount, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          milestone.id,
          milestone.vaultId,
          milestone.title,
          milestone.description,
          milestone.dueDate,
          milestone.amount,
          milestone.sortOrder,
        ],
      )
    }

    const vault: PersistedVault = {
      ...mapVaultRow(vaultResult.rows[0]),
      milestones,
    }

    if (!customClient) {
      await client.query('COMMIT')
    }

    return { vault, clientUsed: client }
  } catch (error) {
    if (!customClient) {
      await client.query('ROLLBACK')
    }
    throw error
  } finally {
    if (releaseClient && client) {
      client.release()
    }
  }
}

export const listVaults = async (): Promise<PersistedVault[]> => {
  const pool = getPgPool()
  if (!pool) {
    return memoryVaults.map((vault) => ({
      ...vault,
      milestones: vault.milestones.map((milestone) => ({ ...milestone })),
    }))
  }

  const vaultRows = await pool.query<{
    id: string
    amount: string
    start_date: string
    end_date: string
    verifier: string
    success_destination: string
    failure_destination: string
    creator: string | null
    status: PersistedVault['status']
    created_at: string
  }>('SELECT id, amount::text, start_date, end_date, verifier, success_destination, failure_destination, creator, status, created_at FROM vaults ORDER BY created_at DESC')

  const milestoneRows = await pool.query<{
    id: string
    vault_id: string
    title: string
    description: string | null
    due_date: string
    amount: string
    sort_order: number
    created_at: string
  }>('SELECT id, vault_id, title, description, due_date, amount::text, sort_order, created_at FROM milestones ORDER BY sort_order ASC')

  const milestonesByVault = new Map<string, PersistedMilestone[]>()
  for (const milestone of milestoneRows.rows) {
    const mapped: PersistedMilestone = {
      id: milestone.id,
      vaultId: milestone.vault_id,
      title: milestone.title,
      description: milestone.description,
      dueDate: milestone.due_date,
      amount: milestone.amount,
      sortOrder: milestone.sort_order,
      createdAt: milestone.created_at,
    }

    const existing = milestonesByVault.get(milestone.vault_id)
    if (existing) {
      existing.push(mapped)
    } else {
      milestonesByVault.set(milestone.vault_id, [mapped])
    }
  }

  const rows: Array<{
    id: string
    amount: string
    start_date: string
    end_date: string
    verifier: string
    success_destination: string
    failure_destination: string
    creator: string | null
    status: PersistedVault['status']
    created_at: string
  }> = vaultRows.rows

  return rows.map((row) => ({
    ...mapVaultRow(row),
    milestones: milestonesByVault.get(row.id) ?? [],
  }))
}

export const getVaultById = async (id: string): Promise<PersistedVault | null> => {
  const allVaults = await listVaults()
  return allVaults.find((vault) => vault.id === id) ?? null
}

export const resetVaultStore = (): void => {
  memoryVaults.length = 0
}

export const cancelVaultById = async (
  id: string,
): Promise<{ vault: PersistedVault; previousStatus: string } | { error: 'not_found' | 'invalid_state'; currentStatus?: string }> => {
  const vault = await getVaultById(id)
  if (!vault) {
    return { error: 'not_found' }
  }

  if (vault.status !== 'draft' && vault.status !== 'active') {
    return { error: 'invalid_state', currentStatus: vault.status }
  }

  const pool = getPgPool()
  if (pool) {
    await pool.query('UPDATE vaults SET status = $1 WHERE id = $2', ['cancelled', id])
  } else {
    // Modify in-memory store if DB is not available
    const memVault = memoryVaults.find(v => v.id === id)
    if (memVault) {
      memVault.status = 'cancelled'
    }
  }

  const previousStatus = vault.status
  const updatedVault = { ...vault, status: 'cancelled' as const }

  return { vault: updatedVault, previousStatus }
}

