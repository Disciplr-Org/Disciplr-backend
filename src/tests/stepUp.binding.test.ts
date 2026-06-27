import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { requireStepUp } from '../middleware/stepUp.js'
import { AuthService } from '../services/auth.service.js'
import { UserRole } from '../types/user.js'

const START_TIME = new Date('2026-06-27T00:00:00.000Z').getTime()
const realDateNow = Date.now

function setNow(ms: number) {
  Date.now = () => ms
}

function buildProtectedApp(userId: string, action: string) {
  const app = express()
  app.use(express.json())
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = { userId, role: UserRole.ADMIN }
    next()
  })
  app.post('/dangerous-action', requireStepUp(300, action), (_req, res) => {
    res.status(200).json({ ok: true, action })
  })
  return app
}

describe('step-up token binding and replay window', () => {
  beforeEach(() => {
    setNow(START_TIME)
    AuthService.clearStepUpSessionsForTesting()
  })

  afterEach(() => {
    Date.now = realDateNow
    AuthService.clearStepUpSessionsForTesting()
  })

  it('accepts a token bound to the same user and action, then rejects replay', async () => {
    const app = buildProtectedApp('user-a', 'admin.users.delete')
    const challenge = await AuthService.issueStepUpChallenge('user-a', 'admin.users.delete')

    await request(app)
      .post('/dangerous-action')
      .set('x-step-up-session-id', challenge.nonce)
      .expect(200)

    const replay = await request(app)
      .post('/dangerous-action')
      .set('x-step-up-session-id', challenge.nonce)
      .expect(401)

    expect(replay.body.stepUpRequired).toBe(true)
  })

  it('does not let user B replay user A step-up token', async () => {
    const userAToken = await AuthService.issueStepUpChallenge('user-a', 'admin.users.delete')
    const userBApp = buildProtectedApp('user-b', 'admin.users.delete')

    await request(userBApp)
      .post('/dangerous-action')
      .set('x-step-up-session-id', userAToken.nonce)
      .expect(401)

    const userAApp = buildProtectedApp('user-a', 'admin.users.delete')
    await request(userAApp)
      .post('/dangerous-action')
      .set('x-step-up-session-id', userAToken.nonce)
      .expect(200)
  })

  it('does not let an action X token authorize action Y', async () => {
    const challenge = await AuthService.issueStepUpChallenge('user-a', 'api_keys.revoke')
    const actionYApp = buildProtectedApp('user-a', 'admin.users.delete')

    await request(actionYApp)
      .post('/dangerous-action')
      .set('x-step-up-session-id', challenge.nonce)
      .expect(401)

    const actionXApp = buildProtectedApp('user-a', 'api_keys.revoke')
    await request(actionXApp)
      .post('/dangerous-action')
      .set('x-step-up-session-id', challenge.nonce)
      .expect(200)
  })

  it('rejects replay just after expiry while accepting a fresh boundary token', async () => {
    const app = buildProtectedApp('user-a', 'admin.users.delete')
    const fresh = await AuthService.issueStepUpChallenge('user-a', 'admin.users.delete')
    setNow(fresh.expiresAt - 1)

    await request(app)
      .post('/dangerous-action')
      .set('x-step-up-session-id', fresh.nonce)
      .expect(200)

    setNow(START_TIME)
    const expired = await AuthService.issueStepUpChallenge('user-a', 'admin.users.delete')
    setNow(expired.expiresAt + 1)

    const response = await request(app)
      .post('/dangerous-action')
      .set('x-step-up-session-id', expired.nonce)
      .expect(401)

    expect(response.body.stepUpRequired).toBe(true)
  })

  it('binds WebAuthn assertion recording to the challenge action', async () => {
    const challenge = await AuthService.issueStepUpChallenge('user-a', 'api_keys.revoke')

    const wrongAction = await AuthService.recordStepUpAssertion(challenge.nonce, 'user-a', 'admin.users.delete')
    const correctAction = await AuthService.recordStepUpAssertion(challenge.nonce, 'user-a', 'api_keys.revoke')

    expect(wrongAction).toBe(false)
    expect(correctAction).toBe(true)
  })
})
