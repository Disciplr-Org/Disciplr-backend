export const UserRole = {
  USER: 'USER',
  VERIFIER: 'VERIFIER',
  ADMIN: 'ADMIN',
} as const

export const VaultStatus = {
  ACTIVE: 'ACTIVE',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const

export class PrismaClient {}
