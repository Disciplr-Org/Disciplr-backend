import db from '../db/index.js'
import type { Knex } from 'knex'
import type { Organization, CreateOrganizationInput } from '../types/enterprise.js'

export interface UpdateOrganizationInput {
  name?: string
  slug?: string
  metadata?: Record<string, unknown> | null
}

export class OrganizationValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrganizationValidationError'
  }
}

export class OrganizationConflictError extends Error {
  constructor(readonly field: 'name' | 'slug') {
    super(`Organization ${field} already exists.`)
    this.name = 'OrganizationConflictError'
  }
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function requireNonBlank(value: string | undefined, field: string): string {
  if (typeof value !== 'string') {
    throw new OrganizationValidationError(`Organization ${field} is required.`)
  }

  const trimmed = value.trim()
  if (!trimmed) {
    throw new OrganizationValidationError(`Organization ${field} cannot be blank.`)
  }

  if (trimmed.length > 255) {
    throw new OrganizationValidationError(`Organization ${field} must be 255 characters or less.`)
  }

  return trimmed
}

function normalizeSlug(slug: string | undefined): string {
  const normalized = requireNonBlank(slug, 'slug')
  if (!SLUG_PATTERN.test(normalized)) {
    throw new OrganizationValidationError(
      'Organization slug must use lowercase letters, numbers, and single hyphens.',
    )
  }

  return normalized
}

function serializeMetadata(metadata: Record<string, unknown> | null | undefined): string | null {
  return metadata ? JSON.stringify(metadata) : null
}

export class OrganizationService {
  constructor(private readonly database: Knex = db) {}

  async createOrganization(input: CreateOrganizationInput): Promise<Organization> {
    const name = requireNonBlank(input.name, 'name')
    const slug = normalizeSlug(input.slug)

    await this.assertUniqueNameAndSlug(name, slug)

    const [org] = await this.database('organizations')
      .insert({
        name,
        slug,
        metadata: serializeMetadata(input.metadata),
      })
      .returning('*')
    return org
  }

  async getOrganizationById(id: string): Promise<Organization | null> {
    const organizationId = requireNonBlank(id, 'id')
    return this.database('organizations').where({ id: organizationId }).first()
  }

  async getOrganizationBySlug(slug: string): Promise<Organization | null> {
    return this.database('organizations').where({ slug: normalizeSlug(slug) }).first()
  }

  async listOrganizations(): Promise<Organization[]> {
    return this.database('organizations').select('*')
  }

  async updateOrganization(
    id: string,
    input: UpdateOrganizationInput,
  ): Promise<Organization | null> {
    const organizationId = requireNonBlank(id, 'id')
    const existing = await this.getOrganizationById(organizationId)
    if (!existing) {
      return null
    }

    const updates: Record<string, unknown> = {}
    const nextName = input.name === undefined ? existing.name : requireNonBlank(input.name, 'name')
    const nextSlug = input.slug === undefined ? existing.slug : normalizeSlug(input.slug)

    if (input.name !== undefined) {
      updates.name = nextName
    }
    if (input.slug !== undefined) {
      updates.slug = nextSlug
    }
    if (input.metadata !== undefined) {
      updates.metadata = serializeMetadata(input.metadata)
    }
    if (Object.keys(updates).length === 0) {
      throw new OrganizationValidationError('At least one organization field must be provided.')
    }

    await this.assertUniqueNameAndSlug(nextName, nextSlug, organizationId)

    updates.updated_at = new Date()
    const [updated] = await this.database('organizations')
      .where({ id: organizationId })
      .update(updates)
      .returning('*')

    return updated ?? null
  }

  async renameOrganization(
    id: string,
    name: string,
    slug?: string,
  ): Promise<Organization | null> {
    return this.updateOrganization(id, {
      name,
      ...(slug === undefined ? {} : { slug }),
    })
  }

  async deleteOrganization(id: string): Promise<boolean> {
    const organizationId = requireNonBlank(id, 'id')
    const deleted = await this.database('organizations').where({ id: organizationId }).delete()
    return deleted > 0
  }

  private async assertUniqueNameAndSlug(
    name: string,
    slug: string,
    excludeId?: string,
  ): Promise<void> {
    const byName = this.database('organizations').where({ name })
    if (excludeId) {
      byName.whereNot({ id: excludeId })
    }
    if (await byName.first()) {
      throw new OrganizationConflictError('name')
    }

    const bySlug = this.database('organizations').where({ slug })
    if (excludeId) {
      bySlug.whereNot({ id: excludeId })
    }
    if (await bySlug.first()) {
      throw new OrganizationConflictError('slug')
    }
  }
}

const organizationService = new OrganizationService()

export const createOrganization = async (input: CreateOrganizationInput): Promise<Organization> =>
  organizationService.createOrganization(input)

export const getOrganizationById = async (id: string): Promise<Organization | null> =>
  organizationService.getOrganizationById(id)

export const getOrganizationBySlug = async (slug: string): Promise<Organization | null> =>
  organizationService.getOrganizationBySlug(slug)

export const listOrganizations = async (): Promise<Organization[]> =>
  organizationService.listOrganizations()

export const updateOrganization = async (
  id: string,
  input: UpdateOrganizationInput,
): Promise<Organization | null> =>
  organizationService.updateOrganization(id, input)

export const renameOrganization = async (
  id: string,
  name: string,
  slug?: string,
): Promise<Organization | null> =>
  organizationService.renameOrganization(id, name, slug)

export const deleteOrganization = async (id: string): Promise<boolean> =>
  organizationService.deleteOrganization(id)
