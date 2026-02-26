import { EventProcessor } from '../services/eventProcessor'
import { ParsedEvent } from '../types/horizonSync'
import knex, { Knex } from 'knex'

describe('EventProcessor - Basic Functionality', () => {
  let db: Knex
  let processor: EventProcessor

  beforeAll(async () => {
    // Setup test database
    db = knex({
      client: 'pg',
      connection: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/disciplr_test'
    })

    // Run migrations
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
    // Clean tables before each test
    await db('validations').delete()
    await db('milestones').delete()
    await db('vaults').delete()
    await db('processed_events').delete()
    await db('failed_events').delete()
  })

  describe('Idempotency', () => {
    it('should process the same event only once', async () => {
      const event: ParsedEvent = {
        eventId: 'test-tx-hash:0',
        transactionHash: 'test-tx-hash',
        eventIndex: 0,
        ledgerNumber: 12345,
        eventType: 'vault_created',
        payload: {
          vaultId: 'vault-123',
          creator: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          amount: '1000.0000000',
          startTimestamp: new Date(),
          endTimestamp: new Date(Date.now() + 86400000),
          successDestination: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          failureDestination: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          status: 'active'
        }
      }

      // Process event first time
      const result1 = await processor.processEvent(event)
      expect(result1.success).toBe(true)

      // Check vault was created
      const vaults1 = await db('vaults').select('*')
      expect(vaults1).toHaveLength(1)

      // Process same event again
      const result2 = await processor.processEvent(event)
      expect(result2.success).toBe(true)

      // Check vault count is still 1 (not duplicated)
      const vaults2 = await db('vaults').select('*')
      expect(vaults2).toHaveLength(1)

      // Check processed_events has only one entry
      const processedEvents = await db('processed_events').select('*')
      expect(processedEvents).toHaveLength(1)
    })
  })

  describe('Vault Events', () => {
    it('should create a vault from vault_created event', async () => {
      const event: ParsedEvent = {
        eventId: 'test-tx-hash:0',
        transactionHash: 'test-tx-hash',
        eventIndex: 0,
        ledgerNumber: 12345,
        eventType: 'vault_created',
        payload: {
          vaultId: 'vault-123',
          creator: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          amount: '1000.0000000',
          startTimestamp: new Date('2024-01-01'),
          endTimestamp: new Date('2024-12-31'),
          successDestination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          failureDestination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          status: 'active'
        }
      }

      const result = await processor.processEvent(event)
      expect(result.success).toBe(true)

      const vault = await db('vaults').where({ id: 'vault-123' }).first()
      expect(vault).toBeDefined()
      expect(vault.creator).toBe('GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
      expect(vault.amount).toBe('1000.0000000')
      expect(vault.status).toBe('active')
    })

    it('should update vault status from vault_completed event', async () => {
      // First create a vault
      await db('vaults').insert({
        id: 'vault-123',
        creator: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        amount: '1000.0000000',
        start_timestamp: new Date('2024-01-01'),
        end_timestamp: new Date('2024-12-31'),
        success_destination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        failure_destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        status: 'active',
        created_at: new Date()
      })

      const event: ParsedEvent = {
        eventId: 'test-tx-hash:1',
        transactionHash: 'test-tx-hash',
        eventIndex: 1,
        ledgerNumber: 12346,
        eventType: 'vault_completed',
        payload: {
          vaultId: 'vault-123',
          status: 'completed'
        }
      }

      const result = await processor.processEvent(event)
      expect(result.success).toBe(true)

      const vault = await db('vaults').where({ id: 'vault-123' }).first()
      expect(vault.status).toBe('completed')
    })
  })

  describe('Milestone Events', () => {
    it('should create a milestone from milestone_created event', async () => {
      // First create a vault
      await db('vaults').insert({
        id: 'vault-123',
        creator: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        amount: '1000.0000000',
        start_timestamp: new Date('2024-01-01'),
        end_timestamp: new Date('2024-12-31'),
        success_destination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        failure_destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        status: 'active',
        created_at: new Date()
      })

      const event: ParsedEvent = {
        eventId: 'test-tx-hash:2',
        transactionHash: 'test-tx-hash',
        eventIndex: 2,
        ledgerNumber: 12347,
        eventType: 'milestone_created',
        payload: {
          milestoneId: 'milestone-456',
          vaultId: 'vault-123',
          title: 'First Milestone',
          description: 'Complete first task',
          targetAmount: '500.0000000',
          deadline: new Date('2024-06-30')
        }
      }

      const result = await processor.processEvent(event)
      expect(result.success).toBe(true)

      const milestone = await db('milestones').where({ id: 'milestone-456' }).first()
      expect(milestone).toBeDefined()
      expect(milestone.vault_id).toBe('vault-123')
      expect(milestone.title).toBe('First Milestone')
      expect(milestone.target_amount).toBe('500.0000000')
    })

    it('should fail to create milestone if vault does not exist', async () => {
      const event: ParsedEvent = {
        eventId: 'test-tx-hash:3',
        transactionHash: 'test-tx-hash',
        eventIndex: 3,
        ledgerNumber: 12348,
        eventType: 'milestone_created',
        payload: {
          milestoneId: 'milestone-456',
          vaultId: 'non-existent-vault',
          title: 'First Milestone',
          description: 'Complete first task',
          targetAmount: '500.0000000',
          deadline: new Date('2024-06-30')
        }
      }

      const result = await processor.processEvent(event)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Vault not found')

      // Check milestone was not created
      const milestones = await db('milestones').select('*')
      expect(milestones).toHaveLength(0)

      // Check event was moved to dead letter queue
      const failedEvents = await db('failed_events').where({ event_id: event.eventId })
      expect(failedEvents).toHaveLength(1)
    })
  })

  describe('Validation Events', () => {
    it('should create a validation from milestone_validated event', async () => {
      // First create a vault and milestone
      await db('vaults').insert({
        id: 'vault-123',
        creator: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        amount: '1000.0000000',
        start_timestamp: new Date('2024-01-01'),
        end_timestamp: new Date('2024-12-31'),
        success_destination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        failure_destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        status: 'active',
        created_at: new Date()
      })

      await db('milestones').insert({
        id: 'milestone-456',
        vault_id: 'vault-123',
        title: 'First Milestone',
        description: 'Complete first task',
        target_amount: '500.0000000',
        current_amount: '0',
        deadline: new Date('2024-06-30'),
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date()
      })

      const event: ParsedEvent = {
        eventId: 'test-tx-hash:4',
        transactionHash: 'test-tx-hash',
        eventIndex: 4,
        ledgerNumber: 12349,
        eventType: 'milestone_validated',
        payload: {
          validationId: 'validation-789',
          milestoneId: 'milestone-456',
          validatorAddress: 'GVALIDATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          validationResult: 'approved',
          evidenceHash: 'hash-abc123',
          validatedAt: new Date()
        }
      }

      const result = await processor.processEvent(event)
      expect(result.success).toBe(true)

      const validation = await db('validations').where({ id: 'validation-789' }).first()
      expect(validation).toBeDefined()
      expect(validation.milestone_id).toBe('milestone-456')
      expect(validation.validator_address).toBe('GVALIDATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
      expect(validation.validation_result).toBe('approved')
    })
  })

  describe('Transaction Rollback', () => {
    it('should rollback all changes on failure', async () => {
      const event: ParsedEvent = {
        eventId: 'test-tx-hash:5',
        transactionHash: 'test-tx-hash',
        eventIndex: 5,
        ledgerNumber: 12350,
        eventType: 'milestone_created',
        payload: {
          milestoneId: 'milestone-999',
          vaultId: 'non-existent-vault',
          title: 'Should Fail',
          description: 'This should fail',
          targetAmount: '100.0000000',
          deadline: new Date('2024-06-30')
        }
      }

      const result = await processor.processEvent(event)
      expect(result.success).toBe(false)

      // Check no milestone was created
      const milestones = await db('milestones').select('*')
      expect(milestones).toHaveLength(0)

      // Check no processed_events entry was created
      const processedEvents = await db('processed_events').select('*')
      expect(processedEvents).toHaveLength(0)
    })
  })

  describe('Reprocess Failed Events', () => {
    it('should reprocess a failed event after fixing the issue', async () => {
      // Create an event that will fail (vault doesn't exist)
      const event: ParsedEvent = {
        eventId: 'test-tx-hash:6',
        transactionHash: 'test-tx-hash',
        eventIndex: 6,
        ledgerNumber: 12351,
        eventType: 'milestone_created',
        payload: {
          milestoneId: 'milestone-reprocess',
          vaultId: 'vault-reprocess',
          title: 'Reprocess Test',
          description: 'Test reprocessing',
          targetAmount: '100.0000000',
          deadline: new Date('2024-06-30')
        }
      }

      // Process event - should fail
      const result1 = await processor.processEvent(event)
      expect(result1.success).toBe(false)

      // Check event is in dead letter queue
      const failedEvents1 = await db('failed_events').where({ event_id: event.eventId })
      expect(failedEvents1).toHaveLength(1)

      // Now create the vault
      await db('vaults').insert({
        id: 'vault-reprocess',
        creator: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        amount: '1000.0000000',
        start_timestamp: new Date('2024-01-01'),
        end_timestamp: new Date('2024-12-31'),
        success_destination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        failure_destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        status: 'active',
        created_at: new Date()
      })

      // Reprocess the failed event
      const result2 = await processor.reprocessFailedEvent(event.eventId)
      expect(result2.success).toBe(true)

      // Check milestone was created
      const milestone = await db('milestones').where({ id: 'milestone-reprocess' }).first()
      expect(milestone).toBeDefined()

      // Check event was removed from dead letter queue
      const failedEvents2 = await db('failed_events').where({ event_id: event.eventId })
      expect(failedEvents2).toHaveLength(0)
    })
  })
})
