import { Request, Response, NextFunction } from 'express'
import { utcNow } from '../utils/timestamps.js'

/**
 * Middleware to mask PII in logs.
 * For this demo, it masks IP addresses and potentially sensitive fields in request bodies.
 */
export const privacyLogger = (req: Request, _res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const maskedIp = maskIp(ip)

    const timestamp = utcNow()
    const method = req.method
    const url = req.url

    // Simple body masking for PII fields identified in PRIVACY.md
    const sanitizedBody = sanitizeBody(req.body)

    console.log(`[${timestamp}] [IP: ${maskedIp}] ${method} ${url} - Body: ${JSON.stringify(sanitizedBody)}`)

    next()
}

function maskIp(ip: string): string {
    if (ip.includes(':')) {
        // IPv6
        return ip.split(':').slice(0, 3).join(':') + ':xxxx:xxxx:xxxx:xxxx:xxxx'
    }
    // IPv4
    const parts = ip.split('.')
    if (parts.length === 4) {
        return `${parts[0]}.${parts[1]}.x.x`
    }
    return 'x.x.x.x'
}

function sanitizeBody(body: unknown): unknown {
    if (Array.isArray(body)) {
        return body.map((item) => sanitizeBody(item))
    }

    if (!body || typeof body !== 'object') {
        return body
    }

    const sensitiveFields = new Set(['creator', 'successDestination', 'failureDestination', 'evidence', 'data'])
    const sanitized: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        if (sensitiveFields.has(key)) {
            sanitized[key] = '***MASKED***'
            continue
        }

        sanitized[key] = sanitizeBody(value)
    }

    return sanitized
}
