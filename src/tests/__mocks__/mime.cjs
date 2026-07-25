/**
 * Jest mime shim combining mime@1.x and mime@2.x APIs.
 *
 * Problem: send@0.19.2 (Express) needs mime@1.x API: mime.charsets, mime.lookup
 * superagent@10.3.0 (supertest) needs mime@2.x API: mime.define, mime.getType
 *
 * Self-contained shim that provides all required APIs without loading
 * the real mime package (avoids circular dependency through
 * moduleNameMapper).
 */

const types = {
  'application/json': ['json'],
  'application/xml': ['xml'],
  'application/x-www-form-urlencoded': ['form'],
  'text/html': ['html', 'htm'],
  'text/plain': ['txt'],
  'text/css': ['css'],
  'text/javascript': ['js', 'mjs'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/svg+xml': ['svg'],
  'application/octet-stream': ['bin'],
}

const extensions = {}
for (const [type, exts] of Object.entries(types)) {
  for (const ext of exts) {
    extensions[ext] = type
  }
}

const mime = {
  _types: { ...types },
  _extensions: { ...extensions },

  define(typeMap, force) {
    for (const [type, exts] of Object.entries(typeMap)) {
      if (force || !mime._types[type]) {
        mime._types[type] = exts
        for (const ext of exts) {
          mime._extensions[ext] = type
        }
      }
    }
  },

  getType(path) {
    if (!path || typeof path !== 'string') return null
    const ext = path.split('.').pop()?.toLowerCase()
    return ext ? mime._extensions[ext] ?? null : null
  },

  getExtension(type) {
    if (!type) return null
    return mime._types[type]?.[0] ?? null
  },

  // mime@1.x compat (send/Express)
  charsets: { lookup: () => 'UTF-8' },
  lookup: (path) => mime.getType(path),
  extension: (type) => mime.getExtension(type),
  load: () => {},
  Mime: class Mime {},
}

module.exports = mime
