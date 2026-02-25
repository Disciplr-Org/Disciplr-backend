import type { RequestHandler } from 'express'

const getUserIdFromAuthorizationHeader = (authorizationHeader: string | undefined): string | null => {
  if (!authorizationHeader) {
    return null
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader)
  if (!match) {
    return null
  }

  const token = match[1].trim()
  if (!token) {
    return null
  }

  if (token.startsWith('user:')) {
    return token.slice('user:'.length)
  }

  return token
}

export const requireUserAuth: RequestHandler = (req, res, next) => {
  const headerUserId = req.header('x-user-id')?.trim()
  const bearerUserId = getUserIdFromAuthorizationHeader(req.header('authorization'))
  const userId = headerUserId || bearerUserId

  if (!userId) {
    res.status(401).json({
      error: 'Authentication required. Provide x-user-id header or Authorization: Bearer user:<user-id>.',
    })
    return
  }

  req.authUser = { userId }
  next()
}
