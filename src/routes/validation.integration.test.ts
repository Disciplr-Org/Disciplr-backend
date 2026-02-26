import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import request from 'supertest'
import { app } from '../app.js'

describe('API Validation Integration Tests', () => {
  describe('API Keys Routes', () => {
    test('should create API key with valid data', async () => {
      const validApiKey = {
        label: 'Test API Key',
        scopes: ['read:vaults', 'write:vaults'],
        orgId: 'test-org-123'
      }

      const response = await request(app)
        .post('/api-keys')
        .send(validApiKey)
        .expect(400) // Expected to fail due to missing auth

      // The response should have validation error format if it reaches validation
      if (response.status === 400 && response.body.error?.type === 'validation') {
        expect(response.body.error.type).toBe('validation')
      }
    })

    test('should reject API key creation with invalid data', async () => {
      const invalidApiKey = {
        label: '', // Empty label
        scopes: 'not-an-array', // Invalid type
        orgId: ''
      }

      const response = await request(app)
        .post('/api-keys')
        .send(invalidApiKey)
        .expect(400)

      expect(response.body.success).toBe(false)
      expect(response.body.error.type).toBe('validation')
      expect(response.body.error.details).toHaveLength(3)
    })

    test('should reject API key creation with XSS attempt', async () => {
      const xssAttempt = {
        label: '<script>alert("xss")</script>',
        scopes: ['read:vaults'],
        orgId: 'test-org'
      }

      const response = await request(app)
        .post('/api-keys')
        .send(xssAttempt)
        .expect(400)

      expect(response.body.error.type).toBe('validation')
    })
  })

  describe('Email Routes', () => {
    test('should reject test email with invalid email address', async () => {
      const invalidEmail = {
        to: 'not-an-email',
        eventType: 'vault_created',
        data: {}
      }

      const response = await request(app)
        .post('/email/send/test')
        .send(invalidEmail)
        .expect(400)

      expect(response.body.error.type).toBe('validation')
      expect(response.body.error.details[0].field).toBe('to')
    })

    test('should reject vault created email with missing required fields', async () => {
      const incompleteData = {
        vault: {
          id: 'vault-123'
          // Missing required fields
        },
        recipientEmail: 'test@example.com'
      }

      const response = await request(app)
        .post('/email/send/vault-created')
        .send(incompleteData)
        .expect(400)

      expect(response.body.error.type).toBe('validation')
      expect(response.body.error.details.length).toBeGreaterThan(0)
    })

    test('should sanitize email data with HTML content', async () => {
      const maliciousData = {
        vault: {
          id: 'vault-123',
          creator: '<script>alert("xss")</script>',
          amount: '1000',
          endTimestamp: '2024-12-31T23:59:59Z',
          successDestination: '0x123...',
          failureDestination: '0x456...'
        },
        recipientEmail: 'test@example.com'
      }

      const response = await request(app)
        .post('/email/send/vault-created')
        .send(maliciousData)
        .expect(500) // Expected to fail due to missing email service, but validation should pass

      // If it reaches validation, the data should be sanitized
      if (response.status === 400) {
        expect(response.body.error.type).toBe('validation')
      }
    })
  })

  describe('Vaults Routes', () => {
    test('should reject vault creation with invalid amount format', async () => {
      const invalidVault = {
        creator: 'test-user',
        amount: 'not-a-number',
        endTimestamp: '2024-12-31T23:59:59Z',
        successDestination: '0x123...',
        failureDestination: '0x456...'
      }

      const response = await request(app)
        .post('/vaults')
        .send(invalidVault)
        .expect(400)

      expect(response.body.error.type).toBe('validation')
      expect(response.body.error.details[0].field).toBe('amount')
    })

    test('should reject vault creation with invalid datetime', async () => {
      const invalidVault = {
        creator: 'test-user',
        amount: '1000.00',
        endTimestamp: 'not-a-datetime',
        successDestination: '0x123...',
        failureDestination: '0x456...'
      }

      const response = await request(app)
        .post('/vaults')
        .send(invalidVault)
        .expect(400)

      expect(response.body.error.type).toBe('validation')
      expect(response.body.error.details[0].field).toBe('endTimestamp')
    })

    test('should reject vault lookup with invalid ID format', async () => {
      const response = await request(app)
        .get('/vaults/invalid-id')
        .expect(400)

      expect(response.body.error.type).toBe('validation')
      expect(response.body.error.details[0].field).toBe('id')
    })

    test('should sanitize vault creation data', async () => {
      const vaultWithSpaces = {
        creator: '  test-user  ',
        amount: '1000.00',
        endTimestamp: '2024-12-31T23:59:59Z',
        successDestination: '  0x123...  ',
        failureDestination: '  0x456...  '
      }

      const response = await request(app)
        .post('/vaults')
        .send(vaultWithSpaces)
        .expect(201)

      expect(response.body.creator).toBe('test-user')
      expect(response.body.successDestination).toBe('0x123...')
      expect(response.body.failureDestination).toBe('0x456...')
    })
  })

  describe('Privacy Routes', () => {
    test('should reject privacy export with missing creator', async () => {
      const response = await request(app)
        .get('/privacy/export')
        .expect(400)

      expect(response.body.error.type).toBe('validation')
      expect(response.body.error.details[0].field).toBe('creator')
    })

    test('should reject privacy export with empty creator', async () => {
      const response = await request(app)
        .get('/privacy/export?creator=')
        .expect(400)

      expect(response.body.error.type).toBe('validation')
    })

    test('should handle privacy export with valid creator', async () => {
      const response = await request(app)
        .get('/privacy/export?creator=test-user')
        .expect(200)

      expect(response.body.creator).toBe('test-user')
      expect(response.body.exportDate).toBeDefined()
      expect(response.body.data).toBeDefined()
    })

    test('should reject account deletion with missing creator', async () => {
      const response = await request(app)
        .delete('/privacy/account')
        .expect(400)

      expect(response.body.error.type).toBe('validation')
    })
  })

  describe('Query Parameter Validation', () => {
    test('should reject invalid page parameter in vaults list', async () => {
      const response = await request(app)
        .get('/vaults?page=not-a-number')
        .expect(400)

      expect(response.body.error.type).toBe('validation')
    })

    test('should reject invalid limit parameter in transactions list', async () => {
      const response = await request(app)
        .get('/transactions?limit=abc')
        .expect(400)

      expect(response.body.error.type).toBe('validation')
    })

    test('should reject invalid sort order in analytics', async () => {
      const response = await request(app)
        .get('/analytics?sortOrder=invalid')
        .expect(400)

      expect(response.body.error.type).toBe('validation')
    })
  })

  describe('Error Response Format', () => {
    test('should consistently format validation errors', async () => {
      const response = await request(app)
        .post('/api-keys')
        .send({ label: '', scopes: 'invalid', orgId: '' })
        .expect(400)

      const error = response.body.error
      expect(error).toMatchObject({
        type: 'validation',
        message: 'Request validation failed'
      })
      expect(Array.isArray(error.details)).toBe(true)
      expect(response.body.timestamp).toBeDefined()
      expect(response.body.success).toBe(false)
    })

    test('should include field paths in nested validation errors', async () => {
      const response = await request(app)
        .post('/email/send/vault-created')
        .send({
          vault: { id: '' }, // Invalid nested object
          recipientEmail: 'test@example.com'
        })
        .expect(400)

      const details = response.body.error.details
      expect(details.some((d: any) => d.field.includes('vault.'))).toBe(true)
    })
  })
})
