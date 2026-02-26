import request from 'supertest'
import { app } from '../app.js'
import { addToDLQ, resetDLQTable } from '../services/dlq.js'
import { setupTestEnvironment } from './setup.js'

setupTestEnvironment()

beforeEach(() => {
  resetDLQTable()
})

describe('DLQ API', () => {
  describe('GET /api/dlq', () => {
    it('returns empty list', async () => {
      const response = await request(app).get('/api/dlq')

      expect(response.status).toBe(200)
      expect(response.body.entries).toEqual([])
    })

    it('returns all entries', async () => {
      addToDLQ('webhook', { url: 'https://example.com' }, new Error('Failed'))
      addToDLQ('email', { to: 'user@example.com' }, new Error('SMTP error'))

      const response = await request(app).get('/api/dlq')

      expect(response.status).toBe(200)
      expect(response.body.entries).toHaveLength(2)
    })

    it('filters by job type', async () => {
      addToDLQ('webhook', { url: 'https://example.com' }, new Error('Failed'))
      addToDLQ('email', { to: 'user@example.com' }, new Error('SMTP error'))

      const response = await request(app).get('/api/dlq?jobType=webhook')

      expect(response.status).toBe(200)
      expect(response.body.entries).toHaveLength(1)
      expect(response.body.entries[0].jobType).toBe('webhook')
    })
  })

  describe('GET /api/dlq/metrics', () => {
    it('returns metrics', async () => {
      addToDLQ('webhook', { url: 'https://example.com' }, new Error('Failed'))
      addToDLQ('email', { to: 'user@example.com' }, new Error('SMTP error'))

      const response = await request(app).get('/api/dlq/metrics')

      expect(response.status).toBe(200)
      expect(response.body.total).toBe(2)
      expect(response.body.pending).toBe(2)
      expect(response.body.byJobType).toEqual({ webhook: 1, email: 1 })
    })
  })

  describe('GET /api/dlq/:id', () => {
    it('returns entry by id', async () => {
      const entry = addToDLQ('webhook', { url: 'https://example.com' }, new Error('Failed'))

      const response = await request(app).get(`/api/dlq/${entry.id}`)

      expect(response.status).toBe(200)
      expect(response.body.entry.id).toBe(entry.id)
    })

    it('returns 404 for non-existent id', async () => {
      const response = await request(app).get('/api/dlq/non-existent')

      expect(response.status).toBe(404)
    })
  })

  describe('POST /api/dlq/:id/discard', () => {
    it('discards entry', async () => {
      const entry = addToDLQ('webhook', { url: 'https://example.com' }, new Error('Failed'))

      const response = await request(app).post(`/api/dlq/${entry.id}/discard`)

      expect(response.status).toBe(200)
      expect(response.body.entry.status).toBe('discarded')
    })

    it('returns 404 for non-existent id', async () => {
      const response = await request(app).post('/api/dlq/non-existent/discard')

      expect(response.status).toBe(404)
    })
  })

  describe('POST /api/dlq/test', () => {
    it('creates test DLQ entry', async () => {
      const response = await request(app).post('/api/dlq/test').send({
        jobType: 'test-webhook',
        payload: { url: 'https://example.com' },
        errorMessage: 'Test error',
      })

      expect(response.status).toBe(201)
      expect(response.body.entry.jobType).toBe('test-webhook')
      expect(response.body.entry.errorMessage).toBe('Test error')
    })
  })
})
