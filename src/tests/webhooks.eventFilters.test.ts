import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { WebhookSubscriber } from '../services/webhooks.js'

const subscribers: WebhookSubscriber[] = []

mock.module('../repositories/webhookSubscriberRepository.js', () => ({
  WebhookSubscriberRepository: class {
    async findByOrg(organizationId: string) {
      return subscribers.filter((subscriber) =>
        subscriber.organizationId === organizationId && subscriber.active
      )
    }

    async findByEvent(organizationId: string, eventType: string) {
      return subscribers.filter((subscriber) =>
        subscriber.organizationId === organizationId &&
        subscriber.active &&
        (subscriber.events.length === 0 || subscriber.events.includes(eventType))
      )
    }

    async create(data: {
      organizationId: string
      url: string
      secret: string
      events: string[]
    }) {
      const subscriber: WebhookSubscriber = {
        id: randomUUID(),
        organizationId: data.organizationId,
        url: data.url,
        secret: data.secret,
        events: [...data.events],
        active: true,
        createdAt: new Date('2030-01-01T00:00:00.000Z').toISOString(),
      }
      subscribers.push(subscriber)
      return subscriber
    }

    async remove(id: string) {
      const index = subscribers.findIndex((subscriber) => subscriber.id === id)
      if (index === -1) return false
      subscribers.splice(index, 1)
      return true
    }
  },
}))

const {
  addSubscriber,
  dispatchWebhookEvent,
  validateSubscriberEvents,
} = await import('../services/webhooks.js')

const organizationId = 'org-webhook-filters'

function makePayload(eventType: string) {
  return {
    eventId: `tx-${eventType}:0`,
    eventType,
    timestamp: new Date('2030-01-01T00:00:00.000Z').toISOString(),
    data: { vaultId: 'vault-1' },
    organizationId,
  }
}

describe('webhook event filters', () => {
  beforeEach(() => {
    subscribers.length = 0
    global.fetch = mock(async () => ({ status: 200 }) as Response)
  })

  test('empty filter subscribes to all known event types for backward compatibility', async () => {
    await addSubscriber(organizationId, 'https://hooks.example.com/all', 'secret', [])

    const results = await dispatchWebhookEvent(makePayload('vault_failed'))

    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(true)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  test('single event filter only delivers matching events', async () => {
    await addSubscriber(
      organizationId,
      'https://hooks.example.com/completed',
      'secret',
      ['vault_completed'],
    )

    const matching = await dispatchWebhookEvent(makePayload('vault_completed'))
    const nonMatching = await dispatchWebhookEvent(makePayload('vault_created'))

    expect(matching).toHaveLength(1)
    expect(nonMatching).toHaveLength(0)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  test('unknown event types are rejected before subscriber storage', async () => {
    await expect(
      addSubscriber(
        organizationId,
        'https://hooks.example.com/bad',
        'secret',
        ['vault_created', 'vault_staked'],
      ),
    ).rejects.toThrow(/Unsupported webhook event type\(s\): vault_staked/)

    expect(subscribers).toHaveLength(0)
  })

  test('non-matching events short-circuit before signing or HTTP delivery', async () => {
    await addSubscriber(
      organizationId,
      'https://hooks.example.com/failed-only',
      'secret',
      ['vault_failed'],
    )

    const results = await dispatchWebhookEvent(makePayload('vault_cancelled'))

    expect(results).toEqual([])
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('validation deduplicates event filters before persistence', async () => {
    expect(validateSubscriberEvents(['vault_created', 'vault_created', 'vault_failed']))
      .toEqual(['vault_created', 'vault_failed'])

    const subscriber = await addSubscriber(
      organizationId,
      'https://hooks.example.com/dedupe',
      'secret',
      ['vault_created', 'vault_created'],
    )
    expect(subscriber.events).toEqual(['vault_created'])
  })
})
