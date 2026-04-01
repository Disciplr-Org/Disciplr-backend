import { db } from '../db/index.js'
import type { Organization, CreateOrganizationInput } from '../types/enterprise.js'

export const createOrganization = async (input: CreateOrganizationInput): Promise<Organization> => {
  const [org] = await db('organizations')
    .insert({
      name: input.name,
      slug: input.slug,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    })
    .returning('*')
  return org
}

export const getOrganizationById = async (id: string): Promise<Organization | null> => {
  return db('organizations').where({ id }).first()
}

export const getOrganizationBySlug = async (slug: string): Promise<Organization | null> => {
  return db('organizations').where({ slug }).first()
}

export const listOrganizations = async (): Promise<Organization[]> => {
  return db('organizations').select('*')
}
