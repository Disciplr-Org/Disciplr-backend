/**
 * tests/contentType.test.ts
 *
 * Content-Type enforcement tests for JSON endpoints.
 * Tests middleware behavior in isolation without full app dependencies.
 */

import { describe, it, expect, beforeEach } from '@jest/globals'
import express, { type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import { requireJson, requireJsonForMethods } from '../src/middleware/requireJson.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const createTestApp = (middleware: any) => {
  const app = express()
  
  // Add the middleware to test
  app.use(middleware)
  
  // Add a simple JSON body parser after our middleware
  app.use(express.json())
  
  // Test endpoints
  app.get('/test', (req, res) => {
    res.json({ method: 'GET', received: req.body })
  })
  
  app.post('/test', (req, res) => {
    res.json({ method: 'POST', received: req.body })
  })
  
  app.put('/test', (req, res) => {
    res.json({ method: 'PUT', received: req.body })
  })
  
  app.patch('/test', (req, res) => {
    res.json({ method: 'PATCH', received: req.body })
  })
  
  app.delete('/test', (req, res) => {
    res.json({ method: 'DELETE', received: req.body })
  })
  
  return app
}

const validJsonBody = { test: 'data', number: 42 }
const invalidJson = '{ "invalid": json }' // Missing quotes around value

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('requireJson middleware', () => {
  describe('GET requests (should pass through)', () => {
    it('allows GET requests without Content-Type header', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app).get('/test')
      
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ method: 'GET', received: {} })
    })

    it('allows GET requests with any Content-Type header', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app)
        .get('/test')
        .set('Content-Type', 'text/plain')
        .send('some text')
      
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ method: 'GET', received: {} })
    })
  })

  describe('HEAD and OPTIONS requests (should pass through)', () => {
    it('allows HEAD requests without Content-Type header', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app).head('/test')
      
      expect(res.status).toBe(200)
    })

    it('allows OPTIONS requests without Content-Type header', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app).options('/test')
      
      expect(res.status).toBe(200)
    })
  })

  describe('POST requests with body', () => {
    it('allows POST with application/json Content-Type and valid JSON', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app)
        .post('/test')
        .set('Content-Type', 'application/json')
        .send(validJsonBody)
      
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ method: 'POST', received: validJsonBody })
    })

    it('allows POST with application/json; charset=utf-8', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app)
        .post('/test')
        .set('Content-Type', 'application/json; charset=utf-8')
        .send(validJsonBody)
      
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ method: 'POST', received: validJsonBody })
    })

    it('rejects POST without Content-Type header when body is present', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app)
        .post('/test')
        .send(validJsonBody)
      
      expect(res.status).toBe(415)
      expect(res.body).toEqual({
        error: 'Unsupported Media Type: Content-Type must be application/json'
      })
    })

    it('rejects POST with text/plain Content-Type', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app)
        .post('/test')
        .set('Content-Type', 'text/plain')
        .send('some text data')
      
      expect(res.status).toBe(415)
      expect(res.body).toEqual({
        error: 'Unsupported Media Type: Content-Type must be application/json'
      })
    })

    it('rejects POST with application/x-www-form-urlencoded', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app)
        .post('/test')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('key=value')
      
      expect(res.status).toBe(415)
      expect(res.body.error.includes('Content-Type must be application/json'))
    })

    it('rejects POST with multipart/form-data', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app)
        .post('/test')
        .set('Content-Type', 'multipart/form-data')
        .field('key', 'value')
      
      expect(res.status).toBe(415)
      expect(res.body.error.includes('Content-Type must be application/json'))
    })

    it('rejects POST with malformed JSON payload', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app)
        .post('/test')
        .set('Content-Type', 'application/json')
        .send(invalidJson)
      
      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('error')
      // Express JSON parser error - should contain information about malformed JSON
      expect(typeof res.body.error).toBe('string')
      expect(res.body.error.length).toBeGreaterThan(0)
    })
  })

  describe('PUT requests with body', () => {
    it('allows PUT with application/json Content-Type', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app)
        .put('/test')
        .set('Content-Type', 'application/json')
        .send(validJsonBody)
      
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ method: 'PUT', received: validJsonBody })
    })

    it('rejects PUT with invalid Content-Type', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app)
        .put('/test')
        .set('Content-Type', 'text/xml')
        .send('<xml>data</xml>')
      
      expect(res.status).toBe(415)
      expect(res.body.error.includes('Content-Type must be application/json'))
    })
  })

  describe('PATCH requests with body', () => {
    it('allows PATCH with application/json Content-Type', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app)
        .patch('/test')
        .set('Content-Type', 'application/json')
        .send(validJsonBody)
      
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ method: 'PATCH', received: validJsonBody })
    })

    it('rejects PATCH with invalid Content-Type', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app)
        .patch('/test')
        .set('Content-Type', 'text/csv')
        .send('a,b,c\n1,2,3')
      
      expect(res.status).toBe(415)
      expect(res.body.error.includes('Content-Type must be application/json'))
    })
  })

  describe('DELETE requests with body', () => {
    it('allows DELETE with application/json Content-Type', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app)
        .delete('/test')
        .set('Content-Type', 'application/json')
        .send(validJsonBody)
      
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ method: 'DELETE', received: validJsonBody })
    })

    it('rejects DELETE with invalid Content-Type when body is present', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app)
        .delete('/test')
        .set('Content-Type', 'text/plain')
        .send('delete reason')
      
      expect(res.status).toBe(415)
      expect(res.body.error.includes('Content-Type must be application/json'))
    })
  })

  describe('Requests without body', () => {
    it('allows POST without Content-Type when no body is sent', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app).post('/test').send('')
      
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ method: 'POST', received: {} })
    })

    it('allows PUT without Content-Type when no body is sent', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app).put('/test').send('')
      
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ method: 'PUT', received: {} })
    })

    it('allows PATCH without Content-Type when no body is sent', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app).patch('/test').send('')
      
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ method: 'PATCH', received: {} })
    })

    it('allows DELETE without Content-Type when no body is sent', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app).delete('/test').send('')
      
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ method: 'DELETE', received: {} })
    })
  })

  describe('Charset handling', () => {
    it('allows UTF-8 charset', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app)
        .post('/test')
        .set('Content-Type', 'application/json; charset=utf-8')
        .send(validJsonBody)
      
      expect(res.status).toBe(200)
    })

    it('allows JSON with charset parameter case variations', async () => {
      const app = createTestApp(requireJson)
      
      const testCases = [
        'application/json; charset=UTF-8',
        'application/json; charset=utf-8',
        'application/json;CHARSET=utf-8',
        'application/json ; charset=utf-8'
      ]

      for (const contentType of testCases) {
        const res = await request(app)
          .post('/test')
          .set('Content-Type', contentType)
          .send(validJsonBody)
        
        expect(res.status).toBe(200)
      }
    })

    it('rejects non-UTF-8 charset', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app)
        .post('/test')
        .set('Content-Type', 'application/json; charset=iso-8859-1')
        .send(validJsonBody)
      
      expect(res.status).toBe(415)
      expect(res.body).toEqual({
        error: 'Unsupported Media Type: Only UTF-8 charset is supported for JSON'
      })
    })
  })

  describe('Content-Type variations', () => {
    it('accepts application/json with additional parameters', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app)
        .post('/test')
        .set('Content-Type', 'application/json; charset=utf-8; boundary=something')
        .send(validJsonBody)
      
      expect(res.status).toBe(200)
    })

    it('accepts content type with whitespace', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app)
        .post('/test')
        .set('Content-Type', ' application/json ')
        .send(validJsonBody)
      
      expect(res.status).toBe(200)
    })

    it('rejects content types that contain application/json but are not valid', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app)
        .post('/test')
        .set('Content-Type', 'text/application-json')
        .send(validJsonBody)
      
      expect(res.status).toBe(415)
      expect(res.body.error.includes('Content-Type must be application/json'))
    })
  })

  describe('Security edge cases', () => {
    it('rejects attempts to bypass with multiple Content-Type headers', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app)
        .post('/test')
        .set('Content-Type', 'application/json')
        .set('Content-Type', 'text/plain') // This should override the first
        .send(validJsonBody)
      
      expect(res.status).toBe(415)
    })

    it('handles malformed Content-Type header gracefully', async () => {
      const app = createTestApp(requireJson)
      const res = await request(app)
        .post('/test')
        .set('Content-Type', '')
        .send(validJsonBody)
      
      expect(res.status).toBe(415)
      expect(res.body.error.includes('Content-Type must be application/json'))
    })
  })
})

describe('requireJsonForMethods middleware', () => {
  it('only enforces JSON for specified methods', async () => {
    const app = createTestApp(requireJsonForMethods(['POST', 'PUT']))
    
    // POST should be enforced
    const postRes = await request(app)
      .post('/test')
      .set('Content-Type', 'text/plain')
      .send('data')
    
    expect(postRes.status).toBe(415)
    
    // PUT should be enforced
    const putRes = await request(app)
      .put('/test')
      .set('Content-Type', 'text/plain')
      .send('data')
    
    expect(putRes.status).toBe(415)
    
    // PATCH should not be enforced
    const patchRes = await request(app)
      .patch('/test')
      .set('Content-Type', 'text/plain')
      .send('data')
    
    expect(patchRes.status).toBe(200)
    
    // DELETE should not be enforced
    const deleteRes = await request(app)
      .delete('/test')
      .set('Content-Type', 'text/plain')
      .send('data')
    
    expect(deleteRes.status).toBe(200)
  })

  it('allows empty method array (no enforcement)', async () => {
    const app = createTestApp(requireJsonForMethods([]))
    
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'text/plain')
      .send('data')
    
    expect(res.status).toBe(200)
  })
})

describe('Error response consistency', () => {
  it('returns consistent error format for all rejection scenarios', async () => {
    const app = createTestApp(requireJson)
    
    const scenarios = [
      {
        name: 'missing Content-Type',
        request: () => request(app).post('/test').send(validJsonBody)
      },
      {
        name: 'invalid Content-Type',
        request: () => request(app)
          .post('/test')
          .set('Content-Type', 'text/plain')
          .send('data')
      },
      {
        name: 'invalid charset',
        request: () => request(app)
          .post('/test')
          .set('Content-Type', 'application/json; charset=ascii')
          .send(validJsonBody)
      }
    ]

    for (const scenario of scenarios) {
      const res = await scenario.request()
      
      expect(res.status).toBe(415)
      expect(res.body).toHaveProperty('error')
      expect(typeof res.body.error).toBe('string')
      expect(res.body.error.length).toBeGreaterThan(0)
    }
  })
})
