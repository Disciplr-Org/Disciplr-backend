const bounces: Map<string, { reason?: string; at: string }> = new Map()

export function recordBounce(recipient: string, reason?: string): void {
  bounces.set(recipient, { reason, at: new Date().toISOString() })
}

export function hasBounced(recipient: string): boolean {
  return bounces.has(recipient)
}

export function getBounces(): Array<{ recipient: string; reason?: string; at: string }> {
  const out: Array<{ recipient: string; reason?: string; at: string }> = []
  for (const [recipient, info] of bounces.entries()) {
    out.push({ recipient, reason: info.reason, at: info.at })
  }
  return out
}

export function clearBounces(): void {
  bounces.clear()
}

export default {
  recordBounce,
  hasBounced,
  getBounces,
  clearBounces,
}
