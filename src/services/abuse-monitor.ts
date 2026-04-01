import { createHash } from 'node:crypto'

/**
 * Configuration for the Abuse Monitor Heuristics.
 * Tuning these values allows for a balance between security and UX.
 */
export interface AbuseMonitorConfig {
  readonly penaltyScoreLimit: number   // Score at which an ID is flagged
  readonly decayRate: number           // How quickly the score drops over time (0-1)
  readonly maxEntries?: number         // Maximum number of tracked actors
  readonly cleanupTtlMs?: number       // Time since last seen before record is purged
}

export interface AbuseSignal {
  readonly id: string           // Raw IP or UserID (will be sanitized)
  readonly weight?: number      // Importance of the signal (default: 1)
  readonly type: 'request' | 'auth_fail' | 'invalid_xdr'
}

/**
 * AbuseMonitor: Tracks and evaluates behavior signals to identify malicious actors.
 * Designed to reduce false positives via a weighted scoring system and confidence decay.
 */
export class AbuseMonitor {
  private readonly scores: Map<string, { score: number; lastSeen: number }> = new Map()
  private readonly config: AbuseMonitorConfig

  constructor(config?: Partial<AbuseMonitorConfig>) {
    this.config = {
      penaltyScoreLimit: 100,
      decayRate: 0.1,
      maxEntries: 10000,
      cleanupTtlMs: 3600000, // Default 1 hour
      ...config,
    }
  }

  /**
   * Record an activity signal. 
   * @returns boolean - True if the actor should be throttled/blocked.
   */
  public record(signal: AbuseSignal): boolean {
    const sanitizedId = this.sanitizeIdentifier(signal.id)
    const now = Date.now()
    
    // Prevent Map exhaustion
    if (!this.scores.has(sanitizedId) && this.scores.size >= (this.config.maxEntries ?? 10000)) {
      return false 
    }

    const record = this.scores.get(sanitizedId) || { score: 0, lastSeen: now }

    // 1. Decay the score based on elapsed time (reduces false positives over time)
    const elapsedSeconds = (now - record.lastSeen) / 1000
    let currentScore = Math.max(0, record.score - (elapsedSeconds * this.config.decayRate))

    // 2. Weight signals
    const weight = signal.weight ?? (signal.type === 'auth_fail' ? 10 : 1)
    currentScore += weight

    // 3. Update state
    this.scores.set(sanitizedId, { score: currentScore, lastSeen: now })

    const isAbusive = currentScore >= this.config.penaltyScoreLimit

    if (isAbusive) {
      this.logAbuse(sanitizedId, currentScore, signal.type)
    }

    return isAbusive
  }

  /**
   * Detirministic PII Masking.
   * Replaces sensitive identifiers with an opaque token.
   */
  private sanitizeIdentifier(id: string): string {
    return createHash('sha256')
      .update(id)
      .digest('hex')
      .substring(0, 12)
  }

  private logAbuse(hashedId: string, score: number, type: string): void {
    // Structured logging without PII leakage
    console.warn(JSON.stringify({
      event: 'ABUSE_LIMIT_REACHED',
      actor_hash: hashedId,
      confidence_score: Math.floor(score),
      trigger_type: type,
      timestamp: new Date().toISOString()
    }))
  }

  /**
   * Clean up old records to prevent memory leaks.
   */
  public cleanup(): void {
    const now = Date.now()
    const ttl = this.config.cleanupTtlMs ?? 3600000
    for (const [id, record] of this.scores.entries()) {
      if (now - record.lastSeen > ttl) {
        this.scores.delete(id)
      }
    }
  }
}