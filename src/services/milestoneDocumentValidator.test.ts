import {
  validateDocumentUrl,
  validateContentHash,
  validateMilestoneDocument,
} from './milestoneDocumentValidator.js'

describe('validateDocumentUrl', () => {
  it('accepts a valid https URL', () => {
    expect(validateDocumentUrl('https://example.com/doc.pdf')).toEqual([])
  })

  it('rejects empty URL', () => {
    expect(validateDocumentUrl('')).toContain('url is required')
  })

  it('rejects http URL', () => {
    expect(validateDocumentUrl('http://example.com/doc')).toContain('url must use the https protocol')
  })

  it('rejects ftp URL', () => {
    expect(validateDocumentUrl('ftp://example.com/doc')).toContain('url must use the https protocol')
  })

  it('rejects data URI', () => {
    expect(validateDocumentUrl('data:text/html,<h1>hi</h1>')).toContain('url must use the https protocol')
  })

  it('rejects malformed URL', () => {
    expect(validateDocumentUrl('not-a-url')).toContain('url is not a valid URL')
  })

  it('rejects URL longer than 2048 chars', () => {
    const long = 'https://example.com/' + 'a'.repeat(2048)
    expect(validateDocumentUrl(long)).toContain('url must not exceed 2048 characters')
  })

  it('respects allowlist when ALLOWED_DOC_DOMAINS is set', () => {
    process.env.ALLOWED_DOC_DOMAINS = 'trusted.com'
    expect(validateDocumentUrl('https://untrusted.com/doc')).toContain(
      "url domain 'untrusted.com' is not in the allowed domains list"
    )
    expect(validateDocumentUrl('https://trusted.com/doc')).toEqual([])
    delete process.env.ALLOWED_DOC_DOMAINS
  })

  it('allowlist accepts subdomains', () => {
    process.env.ALLOWED_DOC_DOMAINS = 'trusted.com'
    expect(validateDocumentUrl('https://docs.trusted.com/file')).toEqual([])
    delete process.env.ALLOWED_DOC_DOMAINS
  })
})

describe('validateContentHash', () => {
  const validSha256 = 'a'.repeat(64)
  const validSha512 = 'b'.repeat(128)

  it('accepts valid sha256 hash', () => {
    expect(validateContentHash(validSha256, 'sha256')).toEqual([])
  })

  it('accepts valid sha512 hash', () => {
    expect(validateContentHash(validSha512, 'sha512')).toEqual([])
  })

  it('accepts undefined hash and algorithm', () => {
    expect(validateContentHash(undefined, undefined)).toEqual([])
  })

  it('rejects hash without algorithm', () => {
    expect(validateContentHash(validSha256, undefined)).toContain(
      'hashAlgorithm is required when contentHash is provided'
    )
  })

  it('rejects algorithm without hash', () => {
    expect(validateContentHash(undefined, 'sha256')).toContain(
      'contentHash is required when hashAlgorithm is provided'
    )
  })

  it('rejects non-hex hash', () => {
    expect(validateContentHash('gg'.repeat(32), 'sha256')).toContain(
      'contentHash must be a hexadecimal string'
    )
  })

  it('rejects wrong length hash for algorithm', () => {
    expect(validateContentHash('a'.repeat(32), 'sha256')).toContain(
      'contentHash length 32 does not match expected length 64 for sha256'
    )
  })

  it('rejects unsupported algorithm', () => {
    expect(validateContentHash('a'.repeat(32), 'md5')).toContain(
      "hashAlgorithm 'md5' is not supported. Supported: sha256, sha512"
    )
  })
})

describe('validateMilestoneDocument', () => {
  const valid = {
    vaultId: 'vault-1',
    label: 'Agreement',
    url: 'https://example.com/doc.pdf',
  }

  it('accepts valid input', () => {
    expect(validateMilestoneDocument(valid).valid).toBe(true)
  })

  it('accepts valid input with hash', () => {
    expect(
      validateMilestoneDocument({
        ...valid,
        contentHash: 'a'.repeat(64),
        hashAlgorithm: 'sha256',
      }).valid
    ).toBe(true)
  })

  it('rejects missing vaultId', () => {
    const result = validateMilestoneDocument({ ...valid, vaultId: '' })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('vaultId is required')
  })

  it('rejects missing label', () => {
    const result = validateMilestoneDocument({ ...valid, label: '' })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('label is required')
  })

  it('rejects missing url', () => {
    const result = validateMilestoneDocument({ ...valid, url: '' })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('url is required')
  })

  it('rejects http url', () => {
    const result = validateMilestoneDocument({ ...valid, url: 'http://example.com/doc' })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('url must use the https protocol')
  })

  it('collects multiple errors', () => {
    const result = validateMilestoneDocument({ vaultId: '', label: '', url: '' })
    expect(result.errors.length).toBeGreaterThan(1)
  })
})