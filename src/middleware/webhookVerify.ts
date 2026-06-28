import { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import { getEnv } from '../config/index.js'

// Simple in-memory store for nonces. In a multi-node setup, this should use Redis or similar.
const nonceCache = new Set<string>()

// Sweep old nonces occasionally to prevent memory leaks
setInterval(() => {
  const now = Date.now()
  const skewMs = getEnv().WEBHOOK_INBOUND_SKEW_MS
  
  for (const entry of nonceCache) {
    const [timestampStr] = entry.split(':')
    const timestamp = parseInt(timestampStr, 10)
    
    // If the timestamp is older than the allowed skew window, we can safely drop it
    if (Math.abs(now - timestamp) > skewMs) {
      nonceCache.delete(entry)
    }
  }
}, 60000).unref()

export const webhookVerify = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const env = getEnv()
    const secret = env.WEBHOOK_INBOUND_SECRET
    const skewMs = env.WEBHOOK_INBOUND_SKEW_MS

    if (!secret) {
      // If no secret is configured, reject all incoming webhooks for security
      res.status(500).json({ error: 'Webhook verification secret is not configured' })
      return
    }

    const signature = req.headers['x-webhook-signature'] as string
    const timestampHeader = req.headers['x-webhook-timestamp'] as string
    const nonce = req.headers['x-webhook-nonce'] as string

    if (!signature || !timestampHeader || !nonce) {
      res.status(401).json({ error: 'Missing required webhook headers' })
      return
    }

    const timestamp = parseInt(timestampHeader, 10)
    if (isNaN(timestamp)) {
      res.status(401).json({ error: 'Invalid timestamp header' })
      return
    }

    const now = Date.now()
    if (Math.abs(now - timestamp) > skewMs) {
      res.status(401).json({ error: 'Webhook request outside of allowed time window' })
      return
    }

    const cacheKey = `${timestamp}:${nonce}`
    if (nonceCache.has(cacheKey)) {
      res.status(401).json({ error: 'Replayed webhook request' })
      return
    }

    // Read the raw body
    const rawBody = await new Promise<string>((resolve, reject) => {
      let body = ''
      req.on('data', chunk => {
        body += chunk.toString()
        if (body.length > 500000) { // Safety limit: 500kb
           req.destroy()
           reject(new Error('Payload too large'))
        }
      })
      req.on('end', () => resolve(body))
      req.on('error', reject)
    })

    // Store raw body on req for downstream if needed, and parse json to req.body
    ;(req as any).rawBody = rawBody
    try {
      req.body = JSON.parse(rawBody)
    } catch {
      req.body = {} // or handle invalid JSON if needed
    }

    // Verify HMAC
    const expectedDigest = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${nonce}.${rawBody}`)
      .digest('hex')

    const expectedSignature = `sha256=${expectedDigest}`

    if (signature.length !== expectedSignature.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      res.status(401).json({ error: 'Invalid webhook signature' })
      return
    }

    nonceCache.add(cacheKey)
    next()
  } catch (err) {
    next(err)
  }
}
