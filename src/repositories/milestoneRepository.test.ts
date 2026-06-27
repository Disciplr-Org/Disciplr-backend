import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Knex } from 'knex'
import { MilestoneRepository } from './milestoneRepository.js'
import {
  cleanAllTables,
  setupTestDatabase,
  teardownTestDatabase,
} from '../tests/helpers/testDatabase.js'

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip

const ids = {
  vaultA: 'repo-query-vault-a',
  vaultB: 'repo-query-vault-b',
  verifierA: 'repo-query-verifier-a',
  verifierB: 'repo-query-verifier-b',
}

let db: Knex
let repository: MilestoneRepository

type FakeMilestoneRow = {
  id: string
  vault_id: string
  title: string
  description: string | null
  due_date: string
  amount: string
  sort_order: number
  verifier_user_id: string | null
  created_at: string
  deleted_at: string | null
}

class FakeMilestoneQuery {
  private readonly whereClauses: Array<Record<string, unknown>> = []
  private readonly nullColumns: string[] = []
  private readonly orderClauses: Array<{ column: keyof FakeMilestoneRow; direction: 'asc' | 'desc' }> = []

  constructor(private readonly rows: FakeMilestoneRow[]) {}

  select() {
    return this
  }

  where(criteria: Record<string, unknown>) {
    this.whereClauses.push(criteria)
    return this
  }

  whereNull(column: string) {
    this.nullColumns.push(column)
    return this
  }

  orderBy(column: keyof FakeMilestoneRow, direction: 'asc' | 'desc') {
    this.orderClauses.push({ column, direction })
    return this
  }

  then<TResult1 = FakeMilestoneRow[], TResult2 = never>(
    onfulfilled?: ((value: FakeMilestoneRow[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected)
  }

  private execute() {
    return this.rows
      .filter((row) =>
        this.whereClauses.every((clause) =>
          Object.entries(clause).every(([column, value]) => row[column as keyof FakeMilestoneRow] === value),
        ),
      )
      .filter((row) => this.nullColumns.every((column) => row[column as keyof FakeMilestoneRow] === null))
      .sort((left, right) => {
        for (const { column, direction } of this.orderClauses) {
          const leftValue = left[column]
          const rightValue = right[column]
          if (leftValue === rightValue) continue
          const result = String(leftValue).localeCompare(String(rightValue))
          return direction === 'asc' ? result : -result
        }

        return 0
      })
  }
}

function createRepositoryWithRows(rows: FakeMilestoneRow[]) {
  const fakeDb = ((table: string) => {
    if (table !== 'milestones') {
      throw new Error(`Unexpected table ${table}`)
    }

    return new FakeMilestoneQuery(rows)
  }) as unknown as Knex

  const fakeDbWithRaw = fakeDb as unknown as { raw: (sql: string) => string }
  fakeDbWithRaw.raw = (sql: string) => sql

  return new MilestoneRepository(fakeDb)
}

function fakeMilestone(overrides: Partial<FakeMilestoneRow>): FakeMilestoneRow {
  return {
    id: 'milestone',
    vault_id: ids.vaultA,
    title: 'Milestone',
    description: null,
    due_date: '2030-06-01T00:00:00.000Z',
    amount: '10.0000000',
    sort_order: 0,
    verifier_user_id: ids.verifierA,
    created_at: '2030-01-01T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  }
}

async function seedVerifier(userId: string) {
  await db('verifiers').insert({
    user_id: userId,
    display_name: userId,
    metadata: {},
    status: 'approved',
    approved_at: new Date('2030-01-01T00:00:00.000Z'),
  })
}

async function seedVault(id: string, verifierUserId: string) {
  await db('vaults').insert({
    id,
    creator: `${id}-creator`,
    amount: '100.0000000',
    start_date: new Date('2030-01-01T00:00:00.000Z'),
    end_date: new Date('2030-12-31T00:00:00.000Z'),
    verifier: verifierUserId,
    success_destination: `${id}-success`,
    failure_destination: `${id}-failure`,
    status: 'draft',
    created_at: new Date('2030-01-01T00:00:00.000Z'),
    updated_at: new Date('2030-01-01T00:00:00.000Z'),
  })
}

async function seedMilestone(options: {
  id: string
  vaultId: string
  verifierUserId?: string | null
  deletedAt?: Date | null
  sortOrder?: number
}) {
  const dueDate = new Date('2030-06-01T00:00:00.000Z')

  await db('milestones').insert({
    id: options.id,
    vault_id: options.vaultId,
    title: options.id,
    description: `${options.id} description`,
    target_amount: '10.0000000',
    current_amount: '0.0000000',
    deadline: dueDate,
    due_date: dueDate,
    amount: '10.0000000',
    sort_order: options.sortOrder ?? 0,
    verifier_user_id: options.verifierUserId ?? null,
    status: 'pending',
    deleted_at: options.deletedAt ?? null,
    created_at: new Date('2030-01-01T00:00:00.000Z'),
    updated_at: new Date('2030-01-01T00:00:00.000Z'),
  })
}

async function seedBaseRecords() {
  await seedVerifier(ids.verifierA)
  await seedVerifier(ids.verifierB)
  await seedVault(ids.vaultA, ids.verifierA)
  await seedVault(ids.vaultB, ids.verifierB)
}

describe('MilestoneRepository milestone query filters', () => {
  test('listByVaultId excludes soft-deleted milestones by default', async () => {
    const repository = createRepositoryWithRows([
      fakeMilestone({ id: 'visible-vault-milestone', sort_order: 1 }),
      fakeMilestone({
        id: 'deleted-vault-milestone',
        sort_order: 2,
        deleted_at: '2030-02-01T00:00:00.000Z',
      }),
      fakeMilestone({
        id: 'other-vault-milestone',
        vault_id: ids.vaultB,
        verifier_user_id: ids.verifierB,
        sort_order: 3,
      }),
    ])

    const visible = await repository.listByVaultId(ids.vaultA)
    expect(visible.map((milestone) => milestone.id)).toEqual(['visible-vault-milestone'])

    const withDeleted = await repository.listByVaultId(ids.vaultA, { includeDeleted: true })
    expect(withDeleted.map((milestone) => milestone.id)).toEqual([
      'visible-vault-milestone',
      'deleted-vault-milestone',
    ])
  })

  test('listByVerifierUserId only returns non-deleted milestones assigned to that verifier', async () => {
    const repository = createRepositoryWithRows([
      fakeMilestone({ id: 'assigned-to-a', sort_order: 1 }),
      fakeMilestone({ id: 'assigned-to-b', verifier_user_id: ids.verifierB, sort_order: 2 }),
      fakeMilestone({ id: 'unassigned', verifier_user_id: null, sort_order: 3 }),
      fakeMilestone({
        id: 'deleted-assigned-to-a',
        deleted_at: '2030-02-01T00:00:00.000Z',
        sort_order: 4,
      }),
    ])

    expect((await repository.listByVerifierUserId(ids.verifierA)).map((milestone) => milestone.id))
      .toEqual(['assigned-to-a'])
    expect((await repository.listByVerifierUserId(ids.verifierB)).map((milestone) => milestone.id))
      .toEqual(['assigned-to-b'])
  })

  test('includeDeleted returns deleted assignments for explicit admin reads', async () => {
    const repository = createRepositoryWithRows([
      fakeMilestone({ id: 'active-assigned-to-a', sort_order: 1 }),
      fakeMilestone({
        id: 'deleted-assigned-to-a',
        deleted_at: '2030-02-01T00:00:00.000Z',
        sort_order: 2,
      }),
    ])

    expect((await repository.listByVerifierUserId(ids.verifierA)).map((milestone) => milestone.id))
      .toEqual(['active-assigned-to-a'])
    expect(
      (await repository.listByVerifierUserId(ids.verifierA, { includeDeleted: true }))
        .map((milestone) => milestone.id),
    ).toEqual(['active-assigned-to-a', 'deleted-assigned-to-a'])
  })

  test('restored milestones return to default vault and verifier reads', async () => {
    const rows = [
      fakeMilestone({
        id: 'restored-milestone',
        deleted_at: '2030-02-01T00:00:00.000Z',
        sort_order: 1,
      }),
    ]
    const repository = createRepositoryWithRows(rows)

    expect(await repository.listByVaultId(ids.vaultA)).toHaveLength(0)
    expect(await repository.listByVerifierUserId(ids.verifierA)).toHaveLength(0)

    rows[0].deleted_at = null

    expect((await repository.listByVaultId(ids.vaultA)).map((milestone) => milestone.id))
      .toEqual(['restored-milestone'])
    expect((await repository.listByVerifierUserId(ids.verifierA)).map((milestone) => milestone.id))
      .toEqual(['restored-milestone'])
  })
})

describeWithDatabase('MilestoneRepository milestone queries (test DB harness)', () => {
  beforeAll(async () => {
    db = await setupTestDatabase()
    repository = new MilestoneRepository(db)
  })

  beforeEach(async () => {
    await cleanAllTables(db)
    await db('verifiers').whereIn('user_id', [ids.verifierA, ids.verifierB]).delete()
    await seedBaseRecords()
  })

  afterAll(async () => {
    if (db) {
      await cleanAllTables(db)
      await db('verifiers').whereIn('user_id', [ids.verifierA, ids.verifierB]).delete()
      await teardownTestDatabase(db)
    }
  })

  test('listByVaultId excludes soft-deleted milestones by default', async () => {
    await seedMilestone({
      id: 'visible-vault-milestone',
      vaultId: ids.vaultA,
      verifierUserId: ids.verifierA,
      sortOrder: 1,
    })
    await seedMilestone({
      id: 'deleted-vault-milestone',
      vaultId: ids.vaultA,
      verifierUserId: ids.verifierA,
      deletedAt: new Date('2030-02-01T00:00:00.000Z'),
      sortOrder: 2,
    })
    await seedMilestone({
      id: 'other-vault-milestone',
      vaultId: ids.vaultB,
      verifierUserId: ids.verifierB,
      sortOrder: 3,
    })

    const visible = await repository.listByVaultId(ids.vaultA)
    expect(visible.map((milestone) => milestone.id)).toEqual(['visible-vault-milestone'])

    const withDeleted = await repository.listByVaultId(ids.vaultA, { includeDeleted: true })
    expect(withDeleted.map((milestone) => milestone.id)).toEqual([
      'visible-vault-milestone',
      'deleted-vault-milestone',
    ])
    expect(withDeleted.find((milestone) => milestone.id === 'deleted-vault-milestone')?.deletedAt)
      .not.toBeNull()
  })

  test('listByVerifierUserId only returns milestones assigned to that verifier', async () => {
    await seedMilestone({
      id: 'assigned-to-a',
      vaultId: ids.vaultA,
      verifierUserId: ids.verifierA,
      sortOrder: 1,
    })
    await seedMilestone({
      id: 'assigned-to-b',
      vaultId: ids.vaultA,
      verifierUserId: ids.verifierB,
      sortOrder: 2,
    })
    await seedMilestone({
      id: 'unassigned',
      vaultId: ids.vaultA,
      verifierUserId: null,
      sortOrder: 3,
    })
    await seedMilestone({
      id: 'deleted-assigned-to-a',
      vaultId: ids.vaultA,
      verifierUserId: ids.verifierA,
      deletedAt: new Date('2030-02-01T00:00:00.000Z'),
      sortOrder: 4,
    })

    const assignedToA = await repository.listByVerifierUserId(ids.verifierA)
    expect(assignedToA.map((milestone) => milestone.id)).toEqual(['assigned-to-a'])

    const assignedToB = await repository.listByVerifierUserId(ids.verifierB)
    expect(assignedToB.map((milestone) => milestone.id)).toEqual(['assigned-to-b'])
  })

  test('listByVerifierUserId can include deleted assigned milestones explicitly', async () => {
    await seedMilestone({
      id: 'active-assigned-to-a',
      vaultId: ids.vaultA,
      verifierUserId: ids.verifierA,
      sortOrder: 1,
    })
    await seedMilestone({
      id: 'deleted-assigned-to-a',
      vaultId: ids.vaultA,
      verifierUserId: ids.verifierA,
      deletedAt: new Date('2030-02-01T00:00:00.000Z'),
      sortOrder: 2,
    })

    const defaultRead = await repository.listByVerifierUserId(ids.verifierA)
    expect(defaultRead.map((milestone) => milestone.id)).toEqual(['active-assigned-to-a'])

    const withDeleted = await repository.listByVerifierUserId(ids.verifierA, {
      includeDeleted: true,
    })
    expect(withDeleted.map((milestone) => milestone.id)).toEqual([
      'active-assigned-to-a',
      'deleted-assigned-to-a',
    ])
  })

  test('restored milestones return to default vault and verifier reads', async () => {
    await seedMilestone({
      id: 'restored-milestone',
      vaultId: ids.vaultA,
      verifierUserId: ids.verifierA,
      deletedAt: new Date('2030-02-01T00:00:00.000Z'),
      sortOrder: 1,
    })

    expect(await repository.listByVaultId(ids.vaultA)).toHaveLength(0)
    expect(await repository.listByVerifierUserId(ids.verifierA)).toHaveLength(0)

    await db('milestones').where({ id: 'restored-milestone' }).update({ deleted_at: null })

    expect((await repository.listByVaultId(ids.vaultA)).map((milestone) => milestone.id))
      .toEqual(['restored-milestone'])
    expect((await repository.listByVerifierUserId(ids.verifierA)).map((milestone) => milestone.id))
      .toEqual(['restored-milestone'])
  })
})
