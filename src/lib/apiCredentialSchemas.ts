import { z } from 'zod'
import { ApiScope } from '../types/auth.js'

const MAX_LABEL_LENGTH = 100
const MAX_SCOPES_COUNT = 20
const MAX_REQUESTED_SCOPE_CHARS = 256

export const createApiKeySchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, 'label is required.')
    .max(MAX_LABEL_LENGTH, `label must be at most ${MAX_LABEL_LENGTH} characters.`),
  scopes: z
    .array(z.nativeEnum(ApiScope))
    .min(1, 'At least one scope is required.')
    .max(MAX_SCOPES_COUNT, `scopes must have at most ${MAX_SCOPES_COUNT} items.`)
    .refine((scopes) => new Set(scopes).size === scopes.length, 'scopes must not contain duplicates.'),
  orgId: z.string().trim().uuid('orgId must be a UUID.').optional(),
})

export const apiKeyIdParamSchema = z.object({
  id: z.string().trim().uuid('id must be a UUID.'),
})

// The OAuth router validates the client ID before looking up the key.
export const oauthTokenRequestSchema = z.object({
  grant_type: z.literal('client_credentials'),
  client_id: z.string().trim().uuid('client_id must be a UUID.'),
  client_secret: z.string().min(1, 'client_secret is required.').max(512),
  scope: z.string().max(MAX_REQUESTED_SCOPE_CHARS).optional(),
})
