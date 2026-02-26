import { Router } from 'express'
import { createAuditLog } from '../lib/audit-logs.js'

export const authRouter = Router()

type UserRole = 'user' | 'verifier' | 'admin'

type User = {
  id: string
  role: UserRole
  lastLoginAt: string | null
}

const users: User[] = []
const supportedRoles: UserRole[] = ['user', 'verifier', 'admin']

const getUserById = (userId: string): User | undefined => users.find((user) => user.id === userId)

const upsertUser = (userId: string): User => {
  const existing = getUserById(userId)
  if (existing) {
    return existing
  }

  const created: User = {
    id: userId,
    role: 'user',
    lastLoginAt: null,
  }
  users.push(created)
  return created
}

authRouter.post('/login', (req, res) => {
  const { userId } = req.body as { userId?: string }

  if (!userId) {
    res.status(400).json({ error: 'Missing required field: userId' })
    return
  }

  const now = new Date().toISOString()
  const user = upsertUser(userId)
  user.lastLoginAt = now

  const auditLog = createAuditLog({
    actor_user_id: user.id,
    action: 'auth.login',
    target_type: 'user',
    target_id: user.id,
    metadata: {
      userAgent: req.header('user-agent') ?? 'unknown',
      ip: req.ip,
    },
  })

  res.status(200).json({
    user,
    token: `mock-token-${user.id}`,
    auditLogId: auditLog.id,
  })
})

authRouter.post('/users/:id/role', (req, res) => {
  const actorRole = req.header('x-user-role')
  const actorId = req.header('x-user-id')

  if (actorRole !== 'admin') {
    res.status(403).json({ error: 'Only admin users can change roles' })
    return
  }

  if (!actorId) {
    res.status(400).json({ error: 'Missing x-user-id header' })
    return
  }

  const { role } = req.body as { role?: string }
  if (!role || !supportedRoles.includes(role as UserRole)) {
    res.status(400).json({ error: 'Invalid role. Supported roles: user, verifier, admin' })
    return
  }

  const user = upsertUser(req.params.id)
  const previousRole = user.role
  user.role = role as UserRole

  const auditLog = createAuditLog({
    actor_user_id: actorId,
    action: 'auth.role_changed',
    target_type: 'user',
    target_id: user.id,
    metadata: {
      previousRole,
      newRole: user.role,
    },
  })

  res.status(200).json({
    user,
    auditLogId: auditLog.id,
  })
})
