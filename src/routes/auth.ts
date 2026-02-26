import { Router } from 'express'
import { AuthService } from '../services/auth.service.js'
import { registerSchema, loginSchema, refreshSchema } from '../lib/validation.js'

export const authRouter = Router()

authRouter.post('/register', async (req, res) => {
  const result = registerSchema.safeParse(req.body)
  if (!result.success) {
    return res.status(400).json({ error: result.error.format() })
  }

  try {
    const user = await AuthService.register(result.data)
    res.status(201).json(user)
  } catch (error: any) {
    res.status(400).json({ error: error.message })
  }
})

authRouter.post('/login', async (req, res) => {
  const result = loginSchema.safeParse(req.body)
  if (!result.success) {
    return res.status(400).json({ error: result.error.format() })
  }

  try {
    const data = await AuthService.login(result.data)
    res.json(data)
  } catch (error: any) {
    res.status(401).json({ error: error.message })
  }
})

authRouter.post('/refresh', async (req, res) => {
  const result = refreshSchema.safeParse(req.body)
  if (!result.success) {
    return res.status(400).json({ error: result.error.format() })
  }

  try {
    const data = await AuthService.refresh(result.data.refreshToken)
    res.json(data)
  } catch (error: any) {
    res.status(401).json({ error: error.message })
  }
})

authRouter.post('/logout', async (req, res) => {
  const { refreshToken } = req.body
  if (refreshToken) {
    await AuthService.logout(refreshToken)
  }
  res.status(204).send()
})
