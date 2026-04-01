import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import knex, { Knex } from 'knex'
import { EventProcessor } from '../services/eventProcessor.js'
import { ParsedEvent } from '../types/horizonSync.js'

describe('Event Processor Idempotency', () => {
  let db: Knex
  let processor: EventProcessor

  beforeAll(async () => {
    db = knex({
      client: 'pg',
      connection: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/disciplr_test'
    })

    // Ensure migrations are up to date
    await db.migrate.latest()

    processor = new EventProcessor(db, {
      maxRetries: 3,
      retryBackoffMs: 100
    })
  })

  afterAll(async () => {
    await db.destroy()
  })

  beforeEach(async () => {
    // Clean tables
    await db('validations').del()
    await db('milestones').del()
    await db('vaults').del()
    await db('processed_events').del()
    await db('failed_events').del()
  })

  it('should process a vault_created event and ignore duplicates', async () => {
    const event: ParsedEvent = {
      eventId: 'tx1:op0',
      transactionHash: 'tx1',
      eventIndex: 0,
      ledgerNumber: 100,
      eventType: 'vault_created',
      payload: {
        vaultId: 'vault-unique-1',
        creator: 'GCREATOR',
        amount: '100',
        startTimestamp: new Date(),
        endTimestamp: new Date(Date.now() + 100000),
        successDestination: 'GSUCCESS',
        failureDestination: 'GFAIL',
        status: 'active'
      }
    }

    // 1st processing
    const result1 = await processor.processEvent(event)
    expect(result1.success).toBe(true)

    const vaultCount1 = await db('vaults').where({ id: 'vault-unique-1' }).count('* as count').first()
    expect(Number(vaultCount1?.count)).toBe(1)

    // 2nd processing (duplicate)
    const result2 = await processor.processEvent(event)
    expect(result2.success).toBe(true)

    const vaultCount2 = await db('vaults').where({ id: 'vault-unique-1' }).count('* as count').first()
    expect(Number(vaultCount2?.count)).toBe(1) // Should still be 1

    const processedEvents = await db('processed_events').where({ event_id: 'tx1:op0' }).count('* as count').first()
    expect(Number(processedEvents?.count)).toBe(1)
  })

  it('should maintain idempotency for milestone creation', async () => {
    // Create vault first
    await db('vaults').insert({
      id: 'vault-m',
      creator: 'GCREATOR',
      amount: '100',
      start_timestamp: new Date(),
      end_timestamp: new Date(Date.now() + 100000),
      success_destination: 'GSUCCESS',
      failure_destination: 'GFAIL',
      status: 'active',
      created_at: new Date()
    })

    const event: ParsedEvent = {
      eventId: 'tx2:op1',
      transactionHash: 'tx2',
      eventIndex: 1,
      ledgerNumber: 101,
      eventType: 'milestone_created',
      payload: {
        milestoneId: 'ms-unique-1',
        vaultId: 'vault-m',
        title: 'Milestone 1',
        description: 'First milestone',
        targetAmount: '50',
        deadline: new Date()
      }
    }

    await processor.processEvent(event)
    await processor.processEvent(event) // Duplicate

    const milestoneCount = await db('milestones').where({ id: 'ms-unique-1' }).count('* as count').first()
    expect(Number(milestoneCount?.count)).toBe(1)
  })

  it('should handle concurrent processing attempts gracefully', async () => {
    const event: ParsedEvent = {
        eventId: 'tx3:op0',
        transactionHash: 'tx3',
        eventIndex: 0,
        ledgerNumber: 102,
        eventType: 'vault_created',
        payload: {
          vaultId: 'vault-concurrent',
          creator: 'GCREATOR',
          amount: '100',
          startTimestamp: new Date(),
          endTimestamp: new Date(Date.now() + 100000),
          successDestination: 'GSUCCESS',
          failureDestination: 'GFAIL',
          status: 'active'
        }
    }

    // Fire off two processing attempts simultaneously
    const [res1, res2] = await Promise.all([
        processor.processEvent(event),
        processor.processEvent(event)
    ])

    // Both should report success (either it processed or it was a no-op due to already processed)
    expect(res1.success).toBe(true)
    expect(res2.success).toBe(true)

    const vaultCount = await db('vaults').where({ id: 'vault-concurrent' }).count('* as count').first()
    expect(Number(vaultCount?.count)).toBe(1)
  })
})
