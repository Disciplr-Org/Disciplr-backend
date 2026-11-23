import { Router, Request, Response, NextFunction } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireOrgAccess } from '../middleware/orgAuth.js'
import { AppError } from '../middleware/errorHandler.js'
import {
  getUserPreferences,
  upsertUserPreferences,
  deleteUserPreferences,
} from '../services/userNotificationPreferences.service.js'
import { isValidTimezone, isValidTimeFormat } from '../utils/quietHours.js'
import {
  getOrgNotificationPreferences,
  setOrgNotificationPreferences,
  UnknownPreferenceKeyError,
} from '../models/notificationPreferences.js'

export const notificationPreferencesRouter = Router()

notificationPreferencesRouter.use(authenticate)

/**
 * GET /api/users/me/notification-preferences
 * Returns the current user's notification preferences.
 */
notificationPreferencesRouter.get(
  '/',
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(AppError.unauthorized('Unauthenticated'))
    }

    try {
      const preferences = await getUserPreferences(req.user.userId)
      res.json(preferences)
    } catch (err) {
      return next(err)
    }
  },
)

/**
 * PUT /api/users/me/notification-preferences
 * Updates the current user's notification preferences.
 */
notificationPreferencesRouter.put(
  '/',
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(AppError.unauthorized('Unauthenticated'))
    }

    const { timezone, quiet_hours_enabled, quiet_hours_start, quiet_hours_end } = req.body

    // Validate timezone if provided
    if (timezone !== undefined) {
      if (typeof timezone !== 'string') {
        return next(AppError.badRequest('timezone must be a string'))
      }
      if (!isValidTimezone(timezone)) {
        return next(AppError.badRequest(`Invalid timezone: ${timezone}. Use a valid IANA timezone identifier.`))
      }
    }

    // Validate quiet_hours_enabled if provided
    if (quiet_hours_enabled !== undefined && typeof quiet_hours_enabled !== 'boolean') {
      return next(AppError.badRequest('quiet_hours_enabled must be a boolean'))
    }

    // Validate quiet_hours_start if provided
    if (quiet_hours_start !== undefined) {
      if (typeof quiet_hours_start !== 'string') {
        return next(AppError.badRequest('quiet_hours_start must be a string'))
      }
      if (!isValidTimeFormat(quiet_hours_start)) {
        return next(AppError.badRequest('quiet_hours_start must be in HH:MM format (e.g., "22:00")'))
      }
    }

    // Validate quiet_hours_end if provided
    if (quiet_hours_end !== undefined) {
      if (typeof quiet_hours_end !== 'string') {
        return next(AppError.badRequest('quiet_hours_end must be a string'))
      }
      if (!isValidTimeFormat(quiet_hours_end)) {
        return next(AppError.badRequest('quiet_hours_end must be in HH:MM format (e.g., "08:00")'))
      }
    }

    try {
      const updated = await upsertUserPreferences(req.user.userId, {
        timezone,
        quiet_hours_enabled,
        quiet_hours_start,
        quiet_hours_end,
      })
      res.json(updated)
    } catch (err) {
      return next(err)
    }
  },
)

/**
 * DELETE /api/users/me/notification-preferences
 * Resets the current user's notification preferences to defaults.
 */
notificationPreferencesRouter.delete(
  '/',
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(AppError.unauthorized('Unauthenticated'))
    }

    try {
      await deleteUserPreferences(req.user.userId)
      const defaults = await getUserPreferences(req.user.userId)
      res.json(defaults)
    } catch (err) {
      return next(err)
    }
  },
)

// ─── GET /api/orgs/:orgId/notification-preferences ─────────────────────────
// Any member can view the org's notification preferences.

notificationPreferencesRouter.get(
  '/:orgId/notification-preferences',
  requireOrgAccess('owner', 'admin', 'member'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const preferences = await getOrgNotificationPreferences(req.params.orgId)
      res.json(preferences)
    } catch (err) {
      next(err)
    }
  },
)

// ─── PUT /api/orgs/:orgId/notification-preferences ──────────────────────────
// Only owners and admins may change notification preferences.

notificationPreferencesRouter.put(
  '/:orgId/notification-preferences',
  requireOrgAccess('owner', 'admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    const { categories, channels } = req.body ?? {}

    if (categories !== undefined && (typeof categories !== 'object' || categories === null || Array.isArray(categories))) {
      return next(AppError.badRequest('categories must be an object of category to boolean'))
    }
    if (channels !== undefined && (typeof channels !== 'object' || channels === null || Array.isArray(channels))) {
      return next(AppError.badRequest('channels must be an object of channel to boolean'))
    }

    try {
      const preferences = await setOrgNotificationPreferences(req.params.orgId, { categories, channels })
      res.json(preferences)
    } catch (err) {
      if (err instanceof UnknownPreferenceKeyError) {
        return next(AppError.badRequest(err.message))
      }
      next(err)
    }
  },
)
