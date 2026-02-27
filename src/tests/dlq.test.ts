import { addToDLQ, discardDLQEntry, getDLQEntry, getDLQMetrics, listDLQEntries, resetDLQTable } from '../services/dlq.js'
import { setupTestEnvironment } from './setup.js'

setupTestEnvironment()

beforeEach(() => {
  resetDLQTable()
})

describe('DLQ service', () => {
  describe('addToDLQ', () => {
    it('adds failed job to DLQ', () => {
      const error = new Error('Connection timeout')
      const entry = addToDLQ('webhook', { url: 'https://example.com' }, error, 3)

      expect(entry.id).toBeDefined()
      expect(entry.jobType).toBe('webhook')
      expect(entry.errorMessage).toBe('Connection timeout')
      expect(entry.retryCount).toBe(3)
      expect(entry.status).toBe('pending')
    })
  })

  describe('listDLQEntries', () => {
    it('lists all entries', () => {
      addToDLQ('webhook', { url: 'https://example.com' }, new Error('Failed'))
      addToDLQ('email', { to: 'user@example.com' }, new Error('SMTP error'))

      const entries = listDLQEntries()
      expect(entries).toHaveLength(2)
    })

    it('filters by job type', () => {
      addToDLQ('webhook', { url: 'https://example.com' }, new Error('Failed'))
      addToDLQ('email', { to: 'user@example.com' }, new Error('SMTP error'))

      const entries = listDLQEntries({ jobType: 'webhook' })
      expect(entries).toHaveLength(1)
      expect(entries[0].jobType).toBe('webhook')
    })

    it('filters by status', () => {
      const entry = addToDLQ('webhook', { url: 'https://example.com' }, new Error('Failed'))
      addToDLQ('email', { to: 'user@example.com' }, new Error('SMTP error'))
      discardDLQEntry(entry.id)

      const pending = listDLQEntries({ status: 'pending' })
      expect(pending).toHaveLength(1)

      const discarded = listDLQEntries({ status: 'discarded' })
      expect(discarded).toHaveLength(1)
    })
  })

  describe('getDLQEntry', () => {
    it('retrieves entry by id', () => {
      const added = addToDLQ('webhook', { url: 'https://example.com' }, new Error('Failed'))
      const entry = getDLQEntry(added.id)

      expect(entry).not.toBeNull()
      expect(entry?.id).toBe(added.id)
    })

    it('returns null for non-existent id', () => {
      const entry = getDLQEntry('non-existent')
      expect(entry).toBeNull()
    })
  })

  describe('discardDLQEntry', () => {
    it('marks entry as discarded', () => {
      const added = addToDLQ('webhook', { url: 'https://example.com' }, new Error('Failed'))
      const discarded = discardDLQEntry(added.id)

      expect(discarded).not.toBeNull()
      expect(discarded?.status).toBe('discarded')
      expect(discarded?.resolvedAt).toBeDefined()
    })

    it('returns null for non-existent id', () => {
      const result = discardDLQEntry('non-existent')
      expect(result).toBeNull()
    })
  })

  describe('getDLQMetrics', () => {
    it('returns metrics for empty DLQ', () => {
      const metrics = getDLQMetrics()

      expect(metrics.total).toBe(0)
      expect(metrics.pending).toBe(0)
    })

    it('returns metrics with entries', () => {
      addToDLQ('webhook', { url: 'https://example.com' }, new Error('Failed'))
      addToDLQ('webhook', { url: 'https://example2.com' }, new Error('Failed'))
      const entry = addToDLQ('email', { to: 'user@example.com' }, new Error('SMTP error'))
      discardDLQEntry(entry.id)

      const metrics = getDLQMetrics()

      expect(metrics.total).toBe(3)
      expect(metrics.pending).toBe(2)
      expect(metrics.discarded).toBe(1)
      expect(metrics.byJobType.webhook).toBe(2)
      expect(metrics.byJobType.email).toBe(1)
    })
  })
})
