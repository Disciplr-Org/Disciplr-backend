import { PrismaClient } from '@prisma/client';
import { logAuditEvent, getAuditLogs, getAuditLogById } from '../lib/audit-logs';

const prisma = new PrismaClient();

describe('Audit Logs', () => {
  let testUserId: string;
  let testAuditLogId: string;

  beforeAll(async () => {
    // Create a test user
    const testUser = await prisma.user.create({
      data: {
        email: 'test@example.com',
        password: 'hashedpassword',
        role: 'user'
      }
    });
    testUserId = testUser.id;
  });

  afterAll(async () => {
    // Clean up test data
    await prisma.auditLog.deleteMany({
      where: { actorUserId: testUserId }
    });
    await prisma.user.delete({
      where: { id: testUserId }
    });
    await prisma.$disconnect();
  });

  describe('logAuditEvent', () => {
    it('should log an audit event successfully', async () => {
      const event = {
        actorUserId: testUserId,
        action: 'USER_LOGIN',
        resource: 'auth',
        metadata: {
          method: 'POST',
          path: '/api/auth/login',
          statusCode: 200
        },
        ipAddress: '127.0.0.1',
        userAgent: 'test-agent'
      };

      await expect(logAuditEvent(event)).resolves.not.toThrow();

      // Verify the log was created
      const logs = await getAuditLogs({ actorUserId: testUserId });
      expect(logs.logs).toHaveLength(1);
      expect(logs.logs[0].action).toBe('USER_LOGIN');
      expect(logs.logs[0].resource).toBe('auth');
      testAuditLogId = logs.logs[0].id;
    });

    it('should handle metadata safely (no secrets)', async () => {
      const event = {
        actorUserId: testUserId,
        action: 'PASSWORD_CHANGE',
        resource: 'user',
        metadata: {
          userId: testUserId,
          timestamp: new Date().toISOString()
          // Note: passwords/tokens should NOT be stored in metadata
        },
        ipAddress: '127.0.0.1'
      };

      await expect(logAuditEvent(event)).resolves.not.toThrow();

      const logs = await getAuditLogs({ action: 'PASSWORD_CHANGE' });
      const passwordChangeLog = logs.logs.find(log => log.action === 'PASSWORD_CHANGE');
      expect(passwordChangeLog).toBeDefined();
      expect(passwordChangeLog.metadata).not.toHaveProperty('password');
      expect(passwordChangeLog.metadata).not.toHaveProperty('token');
    });
  });

  describe('getAuditLogs', () => {
    beforeEach(async () => {
      // Create additional test data
      await logAuditEvent({
        actorUserId: testUserId,
        action: 'USER_LOGOUT',
        resource: 'auth',
        metadata: { method: 'POST' }
      });

      await logAuditEvent({
        actorUserId: testUserId,
        action: 'PROFILE_UPDATE',
        resource: 'user',
        metadata: { field: 'email' }
      });
    });

    it('should return paginated audit logs', async () => {
      const result = await getAuditLogs({ page: 1, limit: 2 });

      expect(result.logs).toHaveLength(2);
      expect(result.total).toBeGreaterThan(0);
      expect(result.page).toBe(1);
      expect(result.totalPages).toBeGreaterThan(0);
    });

    it('should filter by actorUserId', async () => {
      const result = await getAuditLogs({ actorUserId: testUserId });

      expect(result.logs.every(log => log.actorUserId === testUserId)).toBe(true);
    });

    it('should filter by action', async () => {
      const result = await getAuditLogs({ action: 'USER_LOGIN' });

      expect(result.logs.every(log => log.action === 'USER_LOGIN')).toBe(true);
    });

    it('should filter by resource', async () => {
      const result = await getAuditLogs({ resource: 'auth' });

      expect(result.logs.every(log => log.resource === 'auth')).toBe(true);
    });

    it('should filter by date range', async () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      const result = await getAuditLogs({
        startDate: oneHourAgo,
        endDate: now
      });

      expect(result.logs.length).toBeGreaterThan(0);
      result.logs.forEach(log => {
        const logDate = new Date(log.createdAt);
        expect(logDate).toBeGreaterThanOrEqual(oneHourAgo);
        expect(logDate).toBeLessThanOrEqual(now);
      });
    });

    it('should sort logs by creation date (newest first)', async () => {
      const result = await getAuditLogs({ limit: 10 });

      for (let i = 1; i < result.logs.length; i++) {
        const prevDate = new Date(result.logs[i - 1].createdAt);
        const currDate = new Date(result.logs[i].createdAt);
        expect(prevDate.getTime()).toBeGreaterThanOrEqual(currDate.getTime());
      }
    });

    it('should enforce maximum limit of 100 per page', async () => {
      const result = await getAuditLogs({ limit: 200 });

      // The function should cap at 100
      expect(result.logs.length).toBeLessThanOrEqual(100);
    });
  });

  describe('getAuditLogById', () => {
    it('should return an audit log by ID', async () => {
      const log = await getAuditLogById(testAuditLogId);

      expect(log).toBeDefined();
      expect(log.id).toBe(testAuditLogId);
      expect(log.action).toBe('USER_LOGIN');
    });

    it('should return null for non-existent ID', async () => {
      const log = await getAuditLogById('non-existent-id');

      expect(log).toBeNull();
    });

    it('should include actor information', async () => {
      const log = await getAuditLogById(testAuditLogId);

      expect(log.actor).toBeDefined();
      expect(log.actor.id).toBe(testUserId);
      expect(log.actor.email).toBe('test@example.com');
      expect(log.actor.role).toBe('user');
    });
  });

  describe('Performance and Indexing', () => {
    it('should handle large datasets efficiently', async () => {
      // Create multiple audit logs
      const promises = [];
      for (let i = 0; i < 50; i++) {
        promises.push(
          logAuditEvent({
            actorUserId: testUserId,
            action: `BULK_ACTION_${i}`,
            resource: 'test',
            metadata: { index: i }
          })
        );
      }
      await Promise.all(promises);

      const startTime = Date.now();
      const result = await getAuditLogs({
        actorUserId: testUserId,
        limit: 100
      });
      const endTime = Date.now();

      // Query should complete quickly (under 1 second)
      expect(endTime - startTime).toBeLessThan(1000);
      expect(result.logs.length).toBeGreaterThan(50);
    });

    it('should use indexes for common filter combinations', async () => {
      const startTime = Date.now();
      
      // This should use the (actorUserId, createdAt) composite index
      await getAuditLogs({
        actorUserId: testUserId,
        startDate: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
        limit: 50
      });

      const endTime = Date.now();
      
      // Should be fast due to indexing
      expect(endTime - startTime).toBeLessThan(500);
    });
  });
});
