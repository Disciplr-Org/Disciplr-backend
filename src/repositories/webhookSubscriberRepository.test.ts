import { describe, it, expect, jest } from '@jest/globals'
import type { Knex } from 'knex'
import { initEnv } from '../config/env.js'

initEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  DOWNLOAD_SECRET: 'test-download-secret-at-least-16-chars',
  FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
})

const { WebhookSubscriberRepository } = await import('./webhookSubscriberRepository.js')

function makeRow(events: unknown): Record<string, unknown> {
  return {
    id: 'subscriber-1',
    organization_id: 'org-1',
    url: 'https://hooks.example.test/webhook',
    secret: 'a-valid-secret-key',
    previous_secret: null,
    rotated_at: null,
    events,
    active: true,
    schema_version: 1,
    field_policy: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
  }
}

function makeDb(row: Record<string, unknown>): Knex {
  const query = {
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(row),
  }
  return jest.fn().mockReturnValue(query) as unknown as Knex
}

describe('WebhookSubscriberRepository event decoding', () => {
  it('decodes JSON text returned for the events column', async () => {
    const repo = new WebhookSubscriberRepository(makeDb(makeRow('["vault_created"]')))

    await expect(repo.findById('subscriber-1')).resolves.toMatchObject({
      id: 'subscriber-1',
      events: ['vault_created'],
    })
  })

  it('uses an empty event list for malformed JSON or null values', async () => {
    const malformed = new WebhookSubscriberRepository(makeDb(makeRow('not-json')))
    const missing = new WebhookSubscriberRepository(makeDb(makeRow(null)))

    await expect(malformed.findById('subscriber-1')).resolves.toMatchObject({ events: [] })
    await expect(missing.findById('subscriber-1')).resolves.toMatchObject({ events: [] })
  })
})
