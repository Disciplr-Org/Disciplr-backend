import express from 'express';
import { getAuditLogs, getAuditLogById } from '../lib/audit-logs';
import { authenticateAdmin } from '../middleware/auth';

const router = express.Router();

/**
 * GET /api/admin/audit-logs
 * Get paginated audit logs with filtering
 */
router.get('/audit-logs', authenticateAdmin, async (req, res) => {
  try {
    const {
      actorUserId,
      action,
      resource,
      startDate,
      endDate,
      page = '1',
      limit = '50'
    } = req.query;

    const filters = {
      actorUserId: actorUserId as string,
      action: action as string,
      resource: resource as string,
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
      page: parseInt(page as string, 10),
      limit: Math.min(parseInt(limit as string, 10), 100) // Max 100 per page
    };

    const result = await getAuditLogs(filters);
    
    res.json({
      success: true,
      data: result.logs,
      pagination: {
        page: result.page,
        limit: filters.limit,
        total: result.total,
        totalPages: result.totalPages
      }
    });
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch audit logs'
    });
  }
});

/**
 * GET /api/admin/audit-logs/:id
 * Get a specific audit log by ID
 */
router.get('/audit-logs/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const auditLog = await getAuditLogById(id);
    
    if (!auditLog) {
      return res.status(404).json({
        success: false,
        error: 'Audit log not found'
      });
    }

    res.json({
      success: true,
      data: auditLog
    });
  } catch (error) {
    console.error('Error fetching audit log:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch audit log'
    });
  }
});

export default router;
