import { createHmac } from 'node:crypto'
import { URL } from 'node:url'
import { describe, expect, test } from '@jest/globals'
import { EvidenceReferenceValidationError, validateSignedObjectStorageUrl } from '../services/evidence.js'

const SECRET = 'local-s3-test-secret'
const NOW = Date.parse('2026-06-24T00:00:00.000Z')
const EXPIRES = Math.floor((NOW + 10 * 60 * 1000) / 1000)

function signPathAndExpiry(pathname: string, expires: number): string {
  return createHmac('sha256', SECRET)
    .update(`${pathname}:${expires}`)
    .digest('hex')
}

function createSignedEvidenceUrl(key = 'orgs/org-a/evidence/verification-1.pdf'): string {
  const pathname = `/${key}`
  const signature = signPathAndExpiry(pathname, EXPIRES)
  return `https://local-s3.example.test${pathname}?Expires=${EXPIRES}&signature=${signature}`
}

function verifyLocalSignature(url: URL): boolean {
  const expires = Number(url.searchParams.get('Expires'))
  const signature = url.searchParams.get('signature')
  return signature === signPathAndExpiry(url.pathname, expires)
}

describe('evidence signed URL validation policy', () => {
  test('accepts an unexpired signed evidence URL scoped to the expected org and key', () => {
    const key = 'orgs/org-a/evidence/verification-1.pdf'
    const expiry = validateSignedObjectStorageUrl(createSignedEvidenceUrl(key), {
      now: NOW,
      expectedOrgId: 'org-a',
      expectedKey: key,
      signatureVerifier: verifyLocalSignature,
    })

    expect(expiry.toISOString()).toBe(new Date(EXPIRES * 1000).toISOString())
  })

  test('rejects a signed URL after its expiry window', () => {
    expect(() =>
      validateSignedObjectStorageUrl(createSignedEvidenceUrl(), {
        now: EXPIRES * 1000 + 1,
        expectedOrgId: 'org-a',
        signatureVerifier: verifyLocalSignature,
      }),
    ).toThrow(EvidenceReferenceValidationError)
  })

  test('rejects a URL whose object key was tampered after signing', () => {
    const tampered = createSignedEvidenceUrl().replace(
      '/orgs/org-a/evidence/verification-1.pdf',
      '/orgs/org-a/evidence/verification-2.pdf',
    )

    expect(() =>
      validateSignedObjectStorageUrl(tampered, {
        now: NOW,
        expectedOrgId: 'org-a',
        signatureVerifier: verifyLocalSignature,
      }),
    ).toThrow('signature verification failed')
  })

  test('rejects a URL whose signature was tampered', () => {
    const url = new URL(createSignedEvidenceUrl())
    url.searchParams.set('signature', 'deadbeef')

    expect(() =>
      validateSignedObjectStorageUrl(url.toString(), {
        now: NOW,
        expectedOrgId: 'org-a',
        signatureVerifier: verifyLocalSignature,
      }),
    ).toThrow('signature verification failed')
  })

  test('rejects a signed URL outside the expected organization scope', () => {
    const key = 'orgs/org-b/evidence/verification-1.pdf'

    expect(() =>
      validateSignedObjectStorageUrl(createSignedEvidenceUrl(key), {
        now: NOW,
        expectedOrgId: 'org-a',
        signatureVerifier: verifyLocalSignature,
      }),
    ).toThrow('outside the expected organization scope')
  })
})
