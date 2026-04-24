import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import adminRoutes from '../routes/admin';

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const prisma = new PrismaClient();

describe('Admin Routes', () => {
  let adminToken: string;
  let userToken: string;
  let adminUserId: string;
  let regularUserId: string;
  let testAuditLogId: string;

  beforeAll(async () => {
    // Create admin user
    const adminUser = await prisma.user.create({
      data: {
        email: 'admin@example.com',
        password: 'hashedpassword',
        role: 'admin'
      }
    });
    adminUserId = adminUser.id;
    adminToken = jwt.sign(
      { id: adminUser.id, email: adminUser.email, role: 'admin' },
      process.env.JWT_SECRET || 'test-secret'
    );

    // Create regular user
    const regularUser = await prisma.user.create({
      data: {
        email: 'user@example.com',
        password: 'hashedpassword',
        role: 'user'
      }
    });
    regularUserId = regularUser.id;
    userToken = jwt.sign(
      { id: regularUser.id, email: regularUser.email, role: 'user' },
      process.env.JWT_SECRET || 'test-secret'
    );

    // Create test audit log
    const auditLog = await prisma.auditLog.create({
      data: {
        actorUserId: adminUserId,
        action: 'TEST_ACTION',
        resource: 'test',
        metadata: { test: true }
      }
    });
    testAuditLogId = auditLog.id;
  });

  afterAll(async () => {
    // Clean up test data
    await prisma.auditLog.deleteMany({
      where: { actorUserId: { in: [adminUserId, regularUserId] } }
    });
    await prisma.user.deleteMany({
      where: { id: { in: [adminUserId, regularUserId] } }
    });
    await prisma.$disconnect();
  });

  describe('GET /api/admin/audit-logs', () => {
    it('should return audit logs for admin users', async () => {
      const response = await request(app)
        .get('/api/admin/audit-logs')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeInstanceOf(Array);
      expect(response.body.pagination).toBeDefined();
      expect(response.body.pagination.page).toBe(1);
      expect(response.body.pagination.limit).toBe(50);
    });

    it('should deny access for non-admin users', async () => {
      const response = await request(app)
        .get('/api/admin/audit-logs')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(403);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Admin role required');
    });

    it('should deny access without token', async () => {
      const response = await request(app)
        .get('/api/admin/audit-logs')
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('No token provided');
    });

    it('should filter by actorUserId', async () => {
      const response = await request(app)
        .get(`/api/admin/audit-logs?actorUserId=${adminUserId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.every((log: any) => log.actorUserId === adminUserId)).toBe(true);
    });

    it('should filter by action', async () => {
      const response = await request(app)
        .get('/api/admin/audit-logs?action=TEST_ACTION')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.every((log: any) => log.action === 'TEST_ACTION')).toBe(true);
    });

    it('should filter by resource', async () => {
      const response = await request(app)
        .get('/api/admin/audit-logs?resource=test')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.every((log: any) => log.resource === 'test')).toBe(true);
    });

    it('should filter by date range', async () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      const response = await request(app)
        .get(`/api/admin/audit-logs?startDate=${oneHourAgo.toISOString()}&endDate=${now.toISOString()}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      response.body.data.forEach((log: any) => {
        const logDate = new Date(log.createdAt);
        expect(logDate.getTime()).toBeGreaterThanOrEqual(oneHourAgo.getTime());
        expect(logDate.getTime()).toBeLessThanOrEqual(now.getTime());
      });
    });

    it('should handle pagination', async () => {
      const response = await request(app)
        .get('/api/admin/audit-logs?page=1&limit=10')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.length).toBeLessThanOrEqual(10);
      expect(response.body.pagination.page).toBe(1);
      expect(response.body.pagination.limit).toBe(10);
      expect(response.body.pagination.total).toBeDefined();
      expect(response.body.pagination.totalPages).toBeDefined();
    });

    it('should enforce maximum limit of 100', async () => {
      const response = await request(app)
        .get('/api/admin/audit-logs?limit=200')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.length).toBeLessThanOrEqual(100);
      expect(response.body.pagination.limit).toBe(100);
    });

    it('should include actor information', async () => {
      const response = await request(app)
        .get('/api/admin/audit-logs')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      if (response.body.data.length > 0) {
        const log = response.body.data[0];
        expect(log.actor).toBeDefined();
        expect(log.actor.id).toBeDefined();
        expect(log.actor.email).toBeDefined();
        expect(log.actor.role).toBeDefined();
      }
    });
  });

  describe('GET /api/admin/audit-logs/:id', () => {
    it('should return specific audit log for admin users', async () => {
      const response = await request(app)
        .get(`/api/admin/audit-logs/${testAuditLogId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBe(testAuditLogId);
      expect(response.body.data.action).toBe('TEST_ACTION');
      expect(response.body.data.actor).toBeDefined();
    });

    it('should deny access for non-admin users', async () => {
      const response = await request(app)
        .get(`/api/admin/audit-logs/${testAuditLogId}`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(403);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Admin role required');
    });

    it('should return 404 for non-existent audit log', async () => {
      const response = await request(app)
        .get('/api/admin/audit-logs/non-existent-id')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Audit log not found');
    });

    it('should deny access without token', async () => {
      const response = await request(app)
        .get(`/api/admin/audit-logs/${testAuditLogId}`)
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('No token provided');
    });
  });

  describe('Security Tests', () => {
    it('should reject invalid JWT tokens', async () => {
      const response = await request(app)
        .get('/api/admin/audit-logs')
        .set('Authorization', 'Bearer invalid-token')
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid token');
    });

    it('should reject malformed authorization header', async () => {
      const response = await request(app)
        .get('/api/admin/audit-logs')
        .set('Authorization', 'InvalidFormat token')
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('No token provided');
    });

    it('should sanitize query parameters', async () => {
      // Test SQL injection attempts
      const maliciousQueries = [
        "actorUserId='; DROP TABLE audit_logs; --",
        "action=1' OR '1'='1",
        "resource=admin%20OR%201=1"
      ];

      for (const query of maliciousQueries) {
        const response = await request(app)
          .get(`/api/admin/audit-logs?${query}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);

        // Should return valid response, not error
        expect(response.body.success).toBe(true);
        // Should not return all data (indicating successful injection)
        expect(response.body.data.length).toBeLessThan(1000);
      }
    });
  });

  describe('Performance Tests', () => {
    it('should handle concurrent requests', async () => {
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          request(app)
            .get('/api/admin/audit-logs')
            .set('Authorization', `Bearer ${adminToken}`)
        );
      }

      const startTime = Date.now();
      const responses = await Promise.all(promises);
      const endTime = Date.now();

      // All requests should succeed
      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
      });

      // Should complete within reasonable time (2 seconds)
      expect(endTime - startTime).toBeLessThan(2000);
    });

    it('should complete queries quickly with indexes', async () => {
      const startTime = Date.now();
      
      await request(app)
        .get(`/api/admin/audit-logs?actorUserId=${adminUserId}&limit=50`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const endTime = Date.now();
      
      // Should be fast due to indexing
      expect(endTime - startTime).toBeLessThan(500);
    });
  });
});
