import { beforeAll, beforeEach, afterAll, describe, expect, it } from '@jest/globals'
import type { Knex } from 'knex'
import http from 'node:http'
import { EventProcessor } from '../services/eventProcessor.js'
import { setupTestDatabase, teardownTestDatabase, cleanAllTables } from './helpers/testDatabase.js'
import { addSubscriber, resetSubscribers, signPayload } from '../services/webhooks.js'
import { mockVaultCreatedEvent, mockVaultCompletedEvent } from './fixtures/horizonEvents.js'

describe('Webhook Delivery Pipeline (E2E)', () => {
  let db: Knex
  let processor: EventProcessor
  let server: http.Server
  let sinkPort: number
  let receivedRequests: any[] = []
  let sinkStatusQueue: number[] = []

  beforeAll(async () => {
    db = await setupTestDatabase()
    processor = new EventProcessor(db, { maxRetries: 3, retryBackoffMs: 50 })

    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => {
        body += chunk.toString()
      })
      req.on('end', () => {
        receivedRequests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body
        })

        const status = sinkStatusQueue.shift() ?? 200
        res.writeHead(status)
        res.end()
      })
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.2', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') {
          sinkPort = addr.port
        }
        resolve()
      })
    })
  })

  afterAll(async () => {
    await teardownTestDatabase(db)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(async () => {
    await cleanAllTables(db)
    resetSubscribers()
    receivedRequests = []
    sinkStatusQueue = []
  })

  it('successfully delivers a signed webhook when an event matches the subscriber filter', async () => {
    const secret = 'super-secret'
    const targetUrl = `http://127.0.0.2:${sinkPort}/hook`
    
    addSubscriber(targetUrl, secret, ['vault_completed'])
    
    const createResult = await processor.processEvent(mockVaultCreatedEvent)
    expect(createResult.success).toBe(true)
    
    const completedResult = await processor.processEvent(mockVaultCompletedEvent)
    expect(completedResult.success).toBe(true)
    
    await new Promise(resolve => setTimeout(resolve, 250))
    
    expect(receivedRequests).toHaveLength(1)
    const req = receivedRequests[0]
    expect(req.method).toBe('POST')
    expect(req.headers['x-disciplr-event']).toBe('vault_completed')
    expect(req.headers['x-disciplr-event-id']).toBe(mockVaultCompletedEvent.eventId)
    
    const signature = req.headers['x-disciplr-signature']
    const expectedSig = signPayload(secret, req.body)
    expect(signature).toBe(expectedSig)
    
    const parsedBody = JSON.parse(req.body)
    expect(parsedBody.eventType).toBe('vault_completed')
    expect(parsedBody.eventId).toBe(mockVaultCompletedEvent.eventId)
    expect(parsedBody.data).toEqual(mockVaultCompletedEvent.payload)
  })

  it('retries delivery when the sink initially fails and eventually succeeds', async () => {
    const secret = 'retry-secret'
    addSubscriber(`http://127.0.0.2:${sinkPort}/retry`, secret, ['vault_completed'])
    
    sinkStatusQueue.push(503, 200)
    
    await processor.processEvent(mockVaultCreatedEvent)
    await processor.processEvent(mockVaultCompletedEvent)
    
    await new Promise(resolve => setTimeout(resolve, 2000))
    
    expect(receivedRequests.length).toBeGreaterThanOrEqual(2)
    expect(receivedRequests[0].url).toBe('/retry')
    expect(receivedRequests[1].url).toBe('/retry')
  }, 10000)

  it('detects a signature mismatch if validated against the wrong secret', async () => {
    const secret = 'correct-secret'
    addSubscriber(`http://127.0.0.2:${sinkPort}/sig`, secret, ['vault_completed'])
    
    await processor.processEvent(mockVaultCreatedEvent)
    await processor.processEvent(mockVaultCompletedEvent)
    
    await new Promise(resolve => setTimeout(resolve, 250))
    
    expect(receivedRequests).toHaveLength(1)
    const req = receivedRequests[0]
    
    const wrongSig = signPayload('wrong-secret', req.body)
    expect(req.headers['x-disciplr-signature']).not.toBe(wrongSig)
  })

  it('does not deliver if the event type does not match the subscriber filter', async () => {
    addSubscriber(`http://127.0.0.2:${sinkPort}/nomatch`, 'secret', ['vault_failed'])
    
    await processor.processEvent(mockVaultCreatedEvent)
    await processor.processEvent(mockVaultCompletedEvent)
    
    await new Promise(resolve => setTimeout(resolve, 250))
    
    expect(receivedRequests).toHaveLength(0)
  })

  it('rejects an SSRF-blocked URL and does not attempt delivery', () => {
    expect(() => {
      addSubscriber('http://127.0.0.1/hook', 'secret', ['vault_completed'])
    }).toThrow('Webhook URL not permitted')
    expect(() => {
      addSubscriber('http://localhost/hook', 'secret', ['vault_completed'])
    }).toThrow('Webhook URL not permitted')
  })
})
