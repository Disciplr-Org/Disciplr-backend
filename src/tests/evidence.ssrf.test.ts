import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import type { EvidenceDnsResolver } from '../services/evidence.js'

mock.module('../lib/prisma.js', () => ({
  prisma: {
    $queryRaw: mock(async () => []),
  },
}))

let validateEvidenceReferenceUrlSafety: typeof import('../services/evidence.js').validateEvidenceReferenceUrlSafety

beforeAll(async () => {
  ;({ validateEvidenceReferenceUrlSafety } = await import('../services/evidence.js'))
})

const publicResolver = (address = '93.184.216.34'): EvidenceDnsResolver =>
  async () => [{ address, family: address.includes(':') ? 6 : 4 }]

const futureUrl = (host: string, protocol = 'https') =>
  `${protocol}://${host}/evidence.pdf?Expires=${Math.floor(Date.now() / 1000) + 3600}`

describe('evidence SSRF guard', () => {
  afterEach(() => {
    delete process.env.EVIDENCE_ALLOWED_HOSTS
    delete process.env.WEBHOOK_ALLOWED_HOSTS
  })

  it('blocks loopback, RFC1918, link-local, and metadata IP references', async () => {
    const blocked = [
      futureUrl('127.0.0.1'),
      futureUrl('10.0.0.5'),
      futureUrl('172.16.4.5'),
      futureUrl('192.168.1.25'),
      futureUrl('169.254.1.10'),
      futureUrl('169.254.169.254'),
      `${futureUrl('2852039166')}`,
      `${futureUrl('0xa9fea9fe')}`,
      futureUrl('[::1]'),
      futureUrl('[::ffff:169.254.169.254]'),
      futureUrl('[fe80::1]'),
      futureUrl('[fc00::1]'),
    ]

    for (const url of blocked) {
      await expect(validateEvidenceReferenceUrlSafety(url, publicResolver())).rejects.toThrow(
        /not permitted|private or internal/,
      )
    }
  })

  it('blocks localhost-style rebinding hostnames before DNS lookup', async () => {
    await expect(validateEvidenceReferenceUrlSafety(futureUrl('localhost'), publicResolver())).rejects.toThrow(
      /not permitted/,
    )
    await expect(validateEvidenceReferenceUrlSafety(futureUrl('hook.localtest.me'), publicResolver())).rejects.toThrow(
      /not permitted/,
    )
  })

  it('re-checks every resolved DNS address to block rebinding to private IPs', async () => {
    const rebindingResolver: EvidenceDnsResolver = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.10.10.10', family: 4 },
    ]

    await expect(
      validateEvidenceReferenceUrlSafety(futureUrl('storage.example.com'), rebindingResolver),
    ).rejects.toThrow(/private or internal/)
  })

  it('enforces the evidence host allowlist while allowing public resolved hosts', async () => {
    process.env.EVIDENCE_ALLOWED_HOSTS = 'storage.example.com'

    await expect(
      validateEvidenceReferenceUrlSafety(futureUrl('tenant.storage.example.com'), publicResolver()),
    ).resolves.toBeUndefined()

    await expect(
      validateEvidenceReferenceUrlSafety(futureUrl('attacker.example.com'), publicResolver()),
    ).rejects.toThrow(/not allowlisted/)
  })

  it('falls back to WEBHOOK_ALLOWED_HOSTS for shared outbound URL policy', async () => {
    process.env.WEBHOOK_ALLOWED_HOSTS = 'hooks.example.com'

    await expect(
      validateEvidenceReferenceUrlSafety(futureUrl('evidence.hooks.example.com'), publicResolver()),
    ).resolves.toBeUndefined()

    await expect(
      validateEvidenceReferenceUrlSafety(futureUrl('storage.example.com'), publicResolver()),
    ).rejects.toThrow(/not allowlisted/)
  })

  it('rejects non-http schemes before DNS lookup', async () => {
    await expect(
      validateEvidenceReferenceUrlSafety('file:///etc/passwd?Expires=32503680000', publicResolver()),
    ).rejects.toThrow(/must use http or https/)
  })
})
