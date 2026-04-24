import { Request } from 'express';
import { prisma } from '../index';

export interface AuditEvent {
  id?: string;
  actorUserId: string;
  action: string;
  resource?: string;
  resourceId?: string;
  metadata?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  createdAt?: Date;
}

export interface AuditLogFilters {
  actorUserId?: string;
  action?: string;
  resource?: string;
  startDate?: Date;
  endDate?: Date;
  page?: number;
  limit?: number;
}

export interface AuditLogResult {
  logs: any[];
  total: number;
  page: number;
  totalPages: number;
}

/**
 * Log an audit event to persistent storage
 */
export async function logAuditEvent(event: AuditEvent): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorUserId: event.actorUserId,
        action: event.action,
        resource: event.resource,
        resourceId: event.resourceId,
        metadata: event.metadata || {},
        ipAddress: event.ipAddress,
        userAgent: event.userAgent
      }
    });
  } catch (error) {
    console.error('Failed to log audit event:', error);
    throw error;
  }
}

/**
 * Get audit logs with filtering and pagination using persistent storage
 */
export async function getAuditLogs(filters: AuditLogFilters = {}): Promise<AuditLogResult> {
  const {
    actorUserId,
    action,
    resource,
    startDate,
    endDate,
    page = 1,
    limit = 50
  } = filters;

  try {
    // Build where clause for efficient database queries
    const where: any = {};

    if (actorUserId) {
      where.actorUserId = actorUserId;
    }

    if (action) {
      where.action = action;
    }

    if (resource) {
      where.resource = resource;
    }

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) {
        where.createdAt.gte = startDate;
      }
      if (endDate) {
        where.createdAt.lte = endDate;
      }
    }

    // Get total count for pagination
    const total = await prisma.auditLog.count({ where });

    // Calculate pagination
    const skip = (page - 1) * limit;
    const totalPages = Math.ceil(total / limit);

    // Fetch paginated results with ordering
    const logs = await prisma.auditLog.findMany({
      where,
      include: {
        actor: {
          select: {
            id: true,
            email: true,
            role: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      },
      skip,
      take: Math.min(limit, 100) // Maximum 100 per page
    });

    return {
      logs,
      total,
      page,
      totalPages
    };
  } catch (error) {
    console.error('Failed to fetch audit logs:', error);
    throw error;
  }
}

/**
 * Get a single audit log by ID using persistent storage
 */
export async function getAuditLogById(id: string): Promise<any | null> {
  try {
    const auditLog = await prisma.auditLog.findUnique({
      where: { id },
      include: {
        actor: {
          select: {
            id: true,
            email: true,
            role: true
          }
        }
      }
    });

    return auditLog;
  } catch (error) {
    console.error('Failed to fetch audit log by ID:', error);
    throw error;
  }
}

/**
 * Express middleware for audit logging
 */
export function auditLogger(action: string, resource?: string) {
  return (req: Request, res: any, next: any) => {
    const originalSend = res.send;
    
    res.send = function(data: any) {
      // Log the event after response is sent
      setTimeout(async () => {
        try {
          const user = (req as any).user;
          if (user) {
            await logAuditEvent({
              actorUserId: user.id,
              action,
              resource,
              resourceId: req.params.id,
              metadata: {
                method: req.method,
                path: req.path,
                statusCode: res.statusCode,
                query: req.query,
                body: req.body
              },
              ipAddress: req.ip || req.connection.remoteAddress,
              userAgent: req.get('User-Agent')
            });
          }
        } catch (error) {
          console.error('Failed to log audit event:', error);
        }
      });
      
      return originalSend.call(this, data);
    };
    
    next();
  };
}
