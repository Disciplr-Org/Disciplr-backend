import request from 'supertest';
import express from 'express';
import { requireJson, validateJsonPayload } from '../middleware/requireJson';

describe('Content-Type Enforcement Middleware', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    
    // Apply the middleware globally
    app.use(requireJson);
    app.use(express.json({ limit: '10mb' }));
    app.use(validateJsonPayload);
    
    // Test routes
    app.get('/test-get', (req, res) => {
      res.json({ success: true, message: 'GET request works' });
    });

    app.post('/test-post', (req, res) => {
      res.json({ success: true, message: 'POST request works', body: req.body });
    });

    app.put('/test-put', (req, res) => {
      res.json({ success: true, message: 'PUT request works', body: req.body });
    });

    app.patch('/test-patch', (req, res) => {
      res.json({ success: true, message: 'PATCH request works', body: req.body });
    });

    app.delete('/test-delete', (req, res) => {
      res.json({ success: true, message: 'DELETE request works' });
    });
  });

  describe('GET requests', () => {
    it('should allow GET requests without content-type', async () => {
      const response = await request(app)
        .get('/test-get')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'GET request works'
      });
    });

    it('should allow GET requests with any content-type', async () => {
      const response = await request(app)
        .get('/test-get')
        .set('Content-Type', 'text/plain')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'GET request works'
      });
    });
  });

  describe('DELETE requests', () => {
    it('should allow DELETE requests without content-type', async () => {
      const response = await request(app)
        .delete('/test-delete')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'DELETE request works'
      });
    });

    it('should allow DELETE requests with any content-type', async () => {
      const response = await request(app)
        .delete('/test-delete')
        .set('Content-Type', 'text/plain')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'DELETE request works'
      });
    });
  });

  describe('POST requests', () => {
    it('should allow POST requests with correct content-type and valid JSON', async () => {
      const testData = { message: 'Hello World' };
      const response = await request(app)
        .post('/test-post')
        .set('Content-Type', 'application/json')
        .send(testData)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'POST request works',
        body: testData
      });
    });

    it('should allow POST requests with application/json charset', async () => {
      const testData = { message: 'Hello World' };
      const response = await request(app)
        .post('/test-post')
        .set('Content-Type', 'application/json; charset=utf-8')
        .send(testData)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'POST request works',
        body: testData
      });
    });

    it('should reject POST requests without content-type when body is present', async () => {
      const response = await request(app)
        .post('/test-post')
        .send({ message: 'Hello World' })
        .expect(415);

      expect(response.body).toEqual({
        success: false,
        error: 'Unsupported Media Type',
        message: 'Content-Type header is required for requests with a body'
      });
    });

    it('should reject POST requests with incorrect content-type', async () => {
      const response = await request(app)
        .post('/test-post')
        .set('Content-Type', 'text/plain')
        .send('Hello World')
        .expect(415);

      expect(response.body).toEqual({
        success: false,
        error: 'Unsupported Media Type',
        message: 'Content-Type must be application/json'
      });
    });

    it('should reject POST requests with application/xml content-type', async () => {
      const response = await request(app)
        .post('/test-post')
        .set('Content-Type', 'application/xml')
        .send('<data>Hello</data>')
        .expect(415);

      expect(response.body).toEqual({
        success: false,
        error: 'Unsupported Media Type',
        message: 'Content-Type must be application/json'
      });
    });

    it('should reject POST requests with text/html content-type', async () => {
      const response = await request(app)
        .post('/test-post')
        .set('Content-Type', 'text/html')
        .send('<html>Hello</html>')
        .expect(415);

      expect(response.body).toEqual({
        success: false,
        error: 'Unsupported Media Type',
        message: 'Content-Type must be application/json'
      });
    });

    it('should reject POST requests with multipart/form-data content-type', async () => {
      const response = await request(app)
        .post('/test-post')
        .set('Content-Type', 'multipart/form-data')
        .field('message', 'Hello World')
        .expect(415);

      expect(response.body).toEqual({
        success: false,
        error: 'Unsupported Media Type',
        message: 'Content-Type must be application/json'
      });
    });

    it('should reject POST requests with invalid JSON', async () => {
      const response = await request(app)
        .post('/test-post')
        .set('Content-Type', 'application/json')
        .send('{"invalid": json}')
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Bad Request',
        message: 'Invalid JSON payload'
      });
    });

    it('should reject POST requests with malformed JSON', async () => {
      const response = await request(app)
        .post('/test-post')
        .set('Content-Type', 'application/json')
        .send('{"incomplete":')
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Bad Request',
        message: 'Invalid JSON payload'
      });
    });

    it('should allow POST requests with empty body and no content-type', async () => {
      const response = await request(app)
        .post('/test-post')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'POST request works',
        body: {}
      });
    });

    it('should allow POST requests with empty body and content-type', async () => {
      const response = await request(app)
        .post('/test-post')
        .set('Content-Type', 'application/json')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'POST request works',
        body: {}
      });
    });
  });

  describe('PUT requests', () => {
    it('should allow PUT requests with correct content-type and valid JSON', async () => {
      const testData = { message: 'Updated' };
      const response = await request(app)
        .put('/test-put')
        .set('Content-Type', 'application/json')
        .send(testData)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'PUT request works',
        body: testData
      });
    });

    it('should reject PUT requests without content-type when body is present', async () => {
      const response = await request(app)
        .put('/test-put')
        .send({ message: 'Updated' })
        .expect(415);

      expect(response.body).toEqual({
        success: false,
        error: 'Unsupported Media Type',
        message: 'Content-Type header is required for requests with a body'
      });
    });

    it('should reject PUT requests with incorrect content-type', async () => {
      const response = await request(app)
        .put('/test-put')
        .set('Content-Type', 'text/plain')
        .send('Updated')
        .expect(415);

      expect(response.body).toEqual({
        success: false,
        error: 'Unsupported Media Type',
        message: 'Content-Type must be application/json'
      });
    });
  });

  describe('PATCH requests', () => {
    it('should allow PATCH requests with correct content-type and valid JSON', async () => {
      const testData = { message: 'Patched' };
      const response = await request(app)
        .patch('/test-patch')
        .set('Content-Type', 'application/json')
        .send(testData)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'PATCH request works',
        body: testData
      });
    });

    it('should reject PATCH requests without content-type when body is present', async () => {
      const response = await request(app)
        .patch('/test-patch')
        .send({ message: 'Patched' })
        .expect(415);

      expect(response.body).toEqual({
        success: false,
        error: 'Unsupported Media Type',
        message: 'Content-Type header is required for requests with a body'
      });
    });

    it('should reject PATCH requests with incorrect content-type', async () => {
      const response = await request(app)
        .patch('/test-patch')
        .set('Content-Type', 'text/plain')
        .send('Patched')
        .expect(415);

      expect(response.body).toEqual({
        success: false,
        error: 'Unsupported Media Type',
        message: 'Content-Type must be application/json'
      });
    });
  });

  describe('Edge cases', () => {
    it('should handle requests with chunked transfer encoding', async () => {
      const testData = { message: 'Chunked data' };
      const response = await request(app)
        .post('/test-post')
        .set('Content-Type', 'application/json')
        .set('Transfer-Encoding', 'chunked')
        .send(testData)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'POST request works',
        body: testData
      });
    });

    it('should handle case-insensitive content-type matching', async () => {
      const testData = { message: 'Case insensitive' };
      const response = await request(app)
        .post('/test-post')
        .set('Content-Type', 'APPLICATION/JSON')
        .send(testData)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'POST request works',
        body: testData
      });
    });

    it('should handle content-type with extra whitespace', async () => {
      const testData = { message: 'Whitespace test' };
      const response = await request(app)
        .post('/test-post')
        .set('Content-Type', ' application/json ')
        .send(testData)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'POST request works',
        body: testData
      });
    });

    it('should handle zero-length content correctly', async () => {
      const response = await request(app)
        .post('/test-post')
        .set('Content-Type', 'application/json')
        .set('Content-Length', '0')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'POST request works',
        body: {}
      });
    });
  });

  describe('Security tests', () => {
    it('should prevent content-type bypass via alternate encodings', async () => {
      const response = await request(app)
        .post('/test-post')
        .set('Content-Type', 'application/json; charset=iso-8859-1')
        .send('{"message": "Test"}')
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('should reject content-type with parameters that are not charset', async () => {
      const response = await request(app)
        .post('/test-post')
        .set('Content-Type', 'application/json; boundary=something')
        .send('{"message": "Test"}')
        .expect(415);

      expect(response.body).toEqual({
        success: false,
        error: 'Unsupported Media Type',
        message: 'Content-Type must be application/json'
      });
    });
  });
});

describe('Middleware Integration Tests', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    
    // Apply middleware like in the main app
    app.use(requireJson);
    app.use(express.json({ limit: '10mb' }));
    app.use(validateJsonPayload);
    
    // Auth routes simulation
    app.post('/api/auth/login', (req, res) => {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Email and password are required'
        });
      }
      res.json({
        success: true,
        data: { token: 'mock-token', user: { email, role: 'user' } }
      });
    });

    // Vault routes simulation
    app.post('/api/vaults', (req, res) => {
      const { name } = req.body;
      if (!name) {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Vault name is required'
        });
      }
      res.status(201).json({
        success: true,
        data: { id: 'vault-123', name }
      });
    });

    // Job enqueue simulation
    app.post('/api/jobs/enqueue', (req, res) => {
      const { type, payload } = req.body;
      if (!type || !payload) {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Job type and payload are required'
        });
      }
      res.status(201).json({
        success: true,
        data: { id: 'job-123', type, payload, status: 'queued' }
      });
    });
  });

  it('should enforce content-type on auth login endpoint', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'text/plain')
      .send('email=test@example.com&password=secret')
      .expect(415);

    expect(response.body).toEqual({
      success: false,
      error: 'Unsupported Media Type',
      message: 'Content-Type must be application/json'
    });
  });

  it('should enforce content-type on vault creation endpoint', async () => {
    const response = await request(app)
      .post('/api/vaults')
      .set('Content-Type', 'application/xml')
      .send('<vault><name>Test</name></vault>')
      .expect(415);

    expect(response.body).toEqual({
      success: false,
      error: 'Unsupported Media Type',
      message: 'Content-Type must be application/json'
    });
  });

  it('should enforce content-type on job enqueue endpoint', async () => {
    const response = await request(app)
      .post('/api/jobs/enqueue')
      .set('Content-Type', 'multipart/form-data')
      .field('type', 'test-job')
      .field('payload', '{"data": "test"}')
      .expect(415);

    expect(response.body).toEqual({
      success: false,
      error: 'Unsupported Media Type',
      message: 'Content-Type must be application/json'
    });
  });

  it('should work correctly with valid JSON on all endpoints', async () => {
    // Test auth login
    const authResponse = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send({ email: 'test@example.com', password: 'secret' })
      .expect(200);

    expect(authResponse.body.success).toBe(true);

    // Test vault creation
    const vaultResponse = await request(app)
      .post('/api/vaults')
      .set('Content-Type', 'application/json')
      .send({ name: 'Test Vault' })
      .expect(201);

    expect(vaultResponse.body.success).toBe(true);

    // Test job enqueue
    const jobResponse = await request(app)
      .post('/api/jobs/enqueue')
      .set('Content-Type', 'application/json')
      .send({ type: 'test-job', payload: { data: 'test' } })
      .expect(201);

    expect(jobResponse.body.success).toBe(true);
  });
});
