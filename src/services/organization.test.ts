import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import {
  OrganizationConflictError,
  OrganizationService,
  OrganizationValidationError,
} from './organization.js'
import { setupTestDatabase, teardownTestDatabase } from '../tests/helpers/testDatabase.js'
import type { Organization } from '../types/enterprise.js'

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip

type OrganizationRow = Organization & {
  id: string
  name: string
  slug: string
  metadata: string | null
  created_at: Date
  updated_at: Date
}

type Tables = {
  organizations: OrganizationRow[]
  teams: Array<{ id: string; organization_id: string; name: string; slug: string }>
  memberships: Array<{ id: string; organization_id: string; user_id: string; team_id: string | null; role: string }>
}

type Predicate<T> = (row: T) => boolean

class FakeOrganizationQuery<T extends Record<string, any>> {
  private readonly predicates: Predicate<T>[] = []
  private insertRows: Partial<T>[] | null = null
  private updatePatch: Partial<T> | null = null

  constructor(
    private readonly table: keyof Tables,
    private readonly tables: Tables,
  ) {}

  insert(row: Partial<T> | Partial<T>[]) {
    this.insertRows = Array.isArray(row) ? row : [row]
    return this
  }

  where(criteria: Partial<T>) {
    this.predicates.push((row) =>
      Object.entries(criteria).every(([key, value]) => row[key] === value),
    )
    return this
  }

  whereNot(criteria: Partial<T>) {
    this.predicates.push((row) =>
      Object.entries(criteria).every(([key, value]) => row[key] !== value),
    )
    return this
  }

  select() {
    return this
  }

  update(patch: Partial<T>) {
    this.updatePatch = patch
    return this
  }

  async returning() {
    if (this.insertRows) {
      return this.insertRows.map((row) => this.insertOne(row))
    }

    if (this.updatePatch) {
      const updated: T[] = []
      for (const row of this.rows()) {
        if (this.matches(row)) {
          Object.assign(row, this.updatePatch)
          updated.push({ ...row })
        }
      }
      return updated
    }

    throw new Error('returning called without insert or update')
  }

  async first() {
    return this.execute()[0] ?? null
  }

  async delete() {
    const before = this.rows().length
    const deleted = this.rows().filter((row) => this.matches(row))
    const kept = this.rows().filter((row) => !this.matches(row))
    this.setRows(kept)

    if (this.table === 'organizations') {
      const deletedIds = new Set(deleted.map((row) => row.id))
      this.tables.teams = this.tables.teams.filter((team) => !deletedIds.has(team.organization_id))
      this.tables.memberships = this.tables.memberships.filter(
        (membership) => !deletedIds.has(membership.organization_id),
      )
    }

    return before - kept.length
  }

  then<TResult1 = T[], TResult2 = never>(
    onfulfilled?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected)
  }

  private insertOne(row: Partial<T>) {
    const now = new Date()
    const inserted = {
      id: randomUUID(),
      created_at: now,
      updated_at: now,
      ...row,
    } as T

    this.rows().push(inserted)
    return { ...inserted }
  }

  private execute() {
    return this.rows().filter((row) => this.matches(row)).map((row) => ({ ...row }))
  }

  private matches(row: T) {
    return this.predicates.every((predicate) => predicate(row))
  }

  private rows(): T[] {
    return this.tables[this.table] as T[]
  }

  private setRows(rows: T[]) {
    ;(this.tables[this.table] as T[]) = rows
  }
}

function createFakeDb(tables: Tables) {
  return ((table: keyof Tables) => new FakeOrganizationQuery(table, tables)) as unknown as Knex
}

function createHarness() {
  const tables: Tables = {
    organizations: [],
    teams: [],
    memberships: [],
  }

  return {
    service: new OrganizationService(createFakeDb(tables)),
    tables,
  }
}

async function expectConflict(promise: Promise<unknown>, field: 'name' | 'slug') {
  await expect(promise).rejects.toBeInstanceOf(OrganizationConflictError)
  await expect(promise).rejects.toHaveProperty('field', field)
}

describe('OrganizationService lifecycle and uniqueness guards', () => {
  let service: OrganizationService
  let tables: Tables

  beforeEach(() => {
    const harness = createHarness()
    service = harness.service
    tables = harness.tables
  })

  test('creates, reads, and lists organizations with normalized input', async () => {
    const created = await service.createOrganization({
      name: '  Acme Grants  ',
      slug: 'acme-grants',
      metadata: { tier: 'pro' },
    })

    expect(created.id).toBeTruthy()
    expect(created.name).toBe('Acme Grants')
    expect(created.slug).toBe('acme-grants')
    expect(created.metadata).toBe(JSON.stringify({ tier: 'pro' }))
    expect(await service.getOrganizationById(created.id)).toMatchObject({ id: created.id })
    expect(await service.getOrganizationBySlug('acme-grants')).toMatchObject({ id: created.id })
    expect(await service.listOrganizations()).toHaveLength(1)
  })

  test('rejects duplicate organization names and slugs before insert', async () => {
    await service.createOrganization({ name: 'Acme', slug: 'acme' })

    await expectConflict(
      service.createOrganization({ name: 'Acme', slug: 'acme-labs' }),
      'name',
    )
    await expectConflict(
      service.createOrganization({ name: 'Acme Labs', slug: 'acme' }),
      'slug',
    )

    expect(tables.organizations).toHaveLength(1)
  })

  test('renames organizations while blocking name and slug collisions', async () => {
    const alpha = await service.createOrganization({ name: 'Alpha', slug: 'alpha' })
    const beta = await service.createOrganization({ name: 'Beta', slug: 'beta' })

    const renamed = await service.renameOrganization(alpha.id, 'Alpha Prime', 'alpha-prime')
    expect(renamed).toMatchObject({ id: alpha.id, name: 'Alpha Prime', slug: 'alpha-prime' })

    await expectConflict(service.renameOrganization(alpha.id, beta.name, 'alpha-next'), 'name')
    await expectConflict(service.renameOrganization(alpha.id, 'Alpha Next', beta.slug), 'slug')
    expect(await service.getOrganizationById(alpha.id)).toMatchObject({
      name: 'Alpha Prime',
      slug: 'alpha-prime',
    })
  })

  test('updates metadata and returns null for missing organizations', async () => {
    const org = await service.createOrganization({ name: 'Acme', slug: 'acme' })

    const updated = await service.updateOrganization(org.id, { metadata: { region: 'latam' } })
    expect(updated?.metadata).toBe(JSON.stringify({ region: 'latam' }))
    expect(await service.updateOrganization(randomUUID(), { name: 'Ghost' })).toBeNull()
  })

  test('rejects invalid create, read, and update input', async () => {
    await expect(service.createOrganization({ name: '', slug: 'empty-name' }))
      .rejects.toBeInstanceOf(OrganizationValidationError)
    await expect(service.createOrganization({ name: 'Bad Slug', slug: 'Bad Slug' }))
      .rejects.toBeInstanceOf(OrganizationValidationError)
    await expect(service.getOrganizationById('   '))
      .rejects.toBeInstanceOf(OrganizationValidationError)

    const org = await service.createOrganization({ name: 'Acme', slug: 'acme' })
    await expect(service.updateOrganization(org.id, {}))
      .rejects.toBeInstanceOf(OrganizationValidationError)
  })

  test('deletes organizations and cascades local related rows', async () => {
    const org = await service.createOrganization({ name: 'Acme', slug: 'acme' })
    const other = await service.createOrganization({ name: 'Other', slug: 'other' })
    tables.teams.push(
      { id: 'team-1', organization_id: org.id, name: 'Ops', slug: 'ops' },
      { id: 'team-2', organization_id: other.id, name: 'Ops', slug: 'ops' },
    )
    tables.memberships.push(
      { id: 'member-1', organization_id: org.id, user_id: 'alice', team_id: null, role: 'admin' },
      { id: 'member-2', organization_id: other.id, user_id: 'bob', team_id: null, role: 'member' },
    )

    expect(await service.deleteOrganization(org.id)).toBe(true)
    expect(await service.getOrganizationById(org.id)).toBeNull()
    expect(tables.teams.map((team) => team.id)).toEqual(['team-2'])
    expect(tables.memberships.map((membership) => membership.id)).toEqual(['member-2'])
    expect(await service.deleteOrganization(org.id)).toBe(false)
  })
})

describeWithDatabase('OrganizationService lifecycle and uniqueness guards (test DB harness)', () => {
  let db: Knex
  let service: OrganizationService

  beforeAll(async () => {
    db = await setupTestDatabase()
    service = new OrganizationService(db)
  })

  beforeEach(async () => {
    await db('memberships').delete()
    await db('teams').delete()
    await db('organizations').delete()
  })

  afterAll(async () => {
    if (db) {
      await db('memberships').delete()
      await db('teams').delete()
      await db('organizations').delete()
      await teardownTestDatabase(db)
    }
  })

  test('enforces name and slug uniqueness through service guards', async () => {
    await service.createOrganization({ name: 'Acme', slug: 'acme' })

    await expectConflict(
      service.createOrganization({ name: 'Acme', slug: 'acme-foundation' }),
      'name',
    )
    await expectConflict(
      service.createOrganization({ name: 'Acme Foundation', slug: 'acme' }),
      'slug',
    )

    expect(await db('organizations')).toHaveLength(1)
  })

  test('hard delete uses database cascade for teams and memberships', async () => {
    const org = await service.createOrganization({ name: 'Cascade Org', slug: 'cascade-org' })
    await db('teams').insert({
      organization_id: org.id,
      name: 'Operations',
      slug: 'operations',
    })
    await db('memberships').insert({
      organization_id: org.id,
      user_id: 'cascade-user',
      role: 'admin',
    })

    expect(await service.deleteOrganization(org.id)).toBe(true)

    expect(await db('organizations').where({ id: org.id })).toHaveLength(0)
    expect(await db('teams').where({ organization_id: org.id })).toHaveLength(0)
    expect(await db('memberships').where({ organization_id: org.id })).toHaveLength(0)
  })
})
