export type SuppressionReason = 'hard_bounce' | 'soft_bounce_cap' | 'complaint'

export interface SuppressionInfo {
  suppressed: boolean
  reason?: SuppressionReason
  at?: string
}

export interface SoftBounceRecord {
  count: number
  lastAt: string
}

export interface BounceEntry {
  type: 'hard' | 'soft'
  reason?: string
  at: string
}

const bounces: Map<string, BounceEntry> = new Map()
const softBounceCounts: Map<string, SoftBounceRecord> = new Map()
const complaints: Map<string, string> = new Map()

let softBounceCap = 3

export function setSoftBounceCap(cap: number): void {
  if (cap < 1) throw new Error('soft bounce cap must be at least 1')
  softBounceCap = cap
}

export function getSoftBounceCap(): number {
  return softBounceCap
}

export function recordBounce(recipient: string, reason?: string): void {
  const isPermanent = isPermanentBounceReason(reason)
  if (isPermanent) {
    bounces.set(recipient, { type: 'hard', reason, at: new Date().toISOString() })
  } else {
    recordSoftBounce(recipient, reason)
  }
}

export function recordHardBounce(recipient: string, reason?: string): void {
  bounces.set(recipient, { type: 'hard', reason, at: new Date().toISOString() })
}

export function recordSoftBounce(recipient: string, reason?: string): void {
  const existing = softBounceCounts.get(recipient)
  const count = existing ? existing.count + 1 : 1
  softBounceCounts.set(recipient, { count, lastAt: new Date().toISOString() })

  if (count >= softBounceCap) {
    bounces.set(recipient, { type: 'hard', reason: `soft_bounce_cap_exceeded (${count}/${softBounceCap})`, at: new Date().toISOString() })
  }
}

export function recordComplaint(recipient: string): void {
  complaints.set(recipient, new Date().toISOString())
}

export function hasBounced(recipient: string): boolean {
  return bounces.has(recipient)
}

export function isSuppressed(recipient: string): boolean {
  if (complaints.has(recipient)) return true
  const bounce = bounces.get(recipient)
  if (bounce && bounce.type === 'hard') return true
  const soft = softBounceCounts.get(recipient)
  if (soft && soft.count >= softBounceCap) return true
  return false
}

export function getSuppressionInfo(recipient: string): SuppressionInfo {
  if (complaints.has(recipient)) {
    return { suppressed: true, reason: 'complaint', at: complaints.get(recipient) }
  }
  const bounce = bounces.get(recipient)
  if (bounce && bounce.type === 'hard') {
    return { suppressed: true, reason: 'hard_bounce', at: bounce.at }
  }
  const soft = softBounceCounts.get(recipient)
  if (soft && soft.count >= softBounceCap) {
    return { suppressed: true, reason: 'soft_bounce_cap', at: soft.lastAt }
  }
  return { suppressed: false }
}

export function getSoftBounceCount(recipient: string): number {
  return softBounceCounts.get(recipient)?.count ?? 0
}

export function getBounces(): Array<{ recipient: string; reason?: string; at: string }> {
  const out: Array<{ recipient: string; reason?: string; at: string }> = []
  for (const [recipient, info] of bounces.entries()) {
    out.push({ recipient, reason: info.reason, at: info.at })
  }
  return out
}

export function getComplaints(): Array<{ recipient: string; at: string }> {
  const out: Array<{ recipient: string; at: string }> = []
  for (const [recipient, at] of complaints.entries()) {
    out.push({ recipient, at })
  }
  return out
}

export function clearBounces(): void {
  bounces.clear()
  softBounceCounts.clear()
  complaints.clear()
}

function isPermanentBounceReason(reason?: string): boolean {
  if (!reason) return false
  const msg = reason.toLowerCase()
  if (msg.includes('550') || msg.includes('554') || msg.includes('5.1.1')) return true
  if (msg.includes('user unknown') || msg.includes('recipient not found') ||
      msg.includes('mailbox unavailable') || msg.includes('user not found')) return true
  return false
}

export default {
  recordBounce,
  recordHardBounce,
  recordSoftBounce,
  recordComplaint,
  hasBounced,
  isSuppressed,
  getSuppressionInfo,
  getSoftBounceCount,
  getSoftBounceCap,
  setSoftBounceCap,
  getBounces,
  getComplaints,
  clearBounces,
}
