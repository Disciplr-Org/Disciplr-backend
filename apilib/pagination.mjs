// Cursor pagination helpers for keyset-based pagination over (created_at DESC, id DESC).
// Cursors are opaque base64url tokens encoding timestamp|id.

export function encodeCursor(createdAt, id) {
  if (!createdAt || !id) return null
  const payload = `${new Date(createdAt).toISOString()}|${id}`
  return Buffer.from(payload, 'utf8').toString('base64url')
}

export function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    const [timestamp, id] = decoded.split('|')
    if (!timestamp || !id) return null
    const ts = new Date(timestamp)
    if (isNaN(ts.getTime())) return null
    // Validate id is a reasonable format (alphanumeric, dashes, underscores)
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null
    return { timestamp: ts.toISOString(), id }
  } catch {
    return null
  }
}

export function parseLimit(value, defaultLimit = 25, min = 1, max = 100) {
  const num = parseInt(value, 10)
  if (!Number.isInteger(num) || num < min || num > max) return null
  return num
}
