// Evidence submission tests for milestone evidence endpoint.
import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { createApp } from '../index.mjs'
import { MemoryStore, PgStore, resetStore } from '../../apilib/store.mjs'

const CREATOR = 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ'
const VERIFIER = 'GDLYZ73G3GEF36HBLEBFXOXAP5IXJDRQCRG47JCKR4XAXNOFCU44NZT2'

async function setupVault(app) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/vaults',
    payload: {
      name: 'Evidence Test Vault',
      creator: CREATOR,
      verifier: VERIFIER,
      amount: 1000,
      startDate: '2026-04-01T00:00:00.000Z',
      endDate: '2026-12-31T00:00:00.000Z',
      milestones: [
        { title: 'Milestone 1', amount: 500, dueDate: '2026-06-01T00:00:00.000Z' },
        { title: 'Milestone 2', amount: 500, dueDate: '2026-09-01T00:00:00.000Z' },
      ],
    },
  })
  expect(res.statusCode).toBe(201)
  const body = JSON.parse(res.body)
  return { vaultId: body.data.id, milestones: body.data.milestones }
}

async function runTests(storeName, getStore) {
  describe(`Evidence submission (${storeName})`, () => {
    let app

    beforeEach(async () => {
      await resetStore()
      app = createApp(getStore)
    })

    test('valid evidence from creator returns 201 and appears in vault detail', async () => {
      const { vaultId, milestones } = await setupVault(app)
      const mid = milestones[0].id

      const res = await app.inject({
        method: 'POST',
        url: `/api/vaults/${vaultId}/milestones/${mid}/evidence`,
        payload: {
          submitter: CREATOR,
          url: 'https://example.com/proof.pdf',
          sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
          note: 'MVP deployed',
        },
      })

      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.data.url).toBe('https://example.com/proof.pdf')
      expect(body.data.sha256).toBe('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')
      expect(body.data.note).toBe('MVP deployed')
      expect(body.data.submittedBy).toBe(CREATOR)
      expect(body.data.verified).toBe(false)

      const detailRes = await app.inject({ method: 'GET', url: `/api/vaults/${vaultId}` })
      expect(detailRes.statusCode).toBe(200)
      const detail = JSON.parse(detailRes.body)
      const m = detail.data.milestones.find((x) => x.id === mid)
      expect(m.evidence).toHaveLength(1)
      expect(m.evidence[0].sha256).toBe('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')
      expect(m.latestEvidenceHash).toBe('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')
    })

    test('non-creator submitter returns 403', async () => {
      const { vaultId, milestones } = await setupVault(app)
      const res = await app.inject({
        method: 'POST',
        url: `/api/vaults/${vaultId}/milestones/${milestones[0].id}/evidence`,
        payload: {
          submitter: VERIFIER,
          url: 'https://example.com/proof.pdf',
          sha256: 'a'.repeat(64),
        },
      })
      expect(res.statusCode).toBe(403)
    })

    test('vault not active returns 409', async () => {
      const { vaultId, milestones } = await setupVault(app)
      await app.inject({
        method: 'POST',
        url: `/api/vaults/${vaultId}/fail`,
        payload: { verifier: VERIFIER },
      })

      const res = await app.inject({
        method: 'POST',
        url: `/api/vaults/${vaultId}/milestones/${milestones[0].id}/evidence`,
        payload: {
          submitter: CREATOR,
          url: 'https://example.com/proof.pdf',
          sha256: 'a'.repeat(64),
        },
      })
      expect(res.statusCode).toBe(409)
    })

    test('completed milestone returns 409', async () => {
      const { vaultId, milestones } = await setupVault(app)
      const mid = milestones[0].id
      await app.inject({
        method: 'POST',
        url: `/api/vaults/${vaultId}/milestones/${mid}/validate`,
        payload: { verifier: VERIFIER },
      })

      const res = await app.inject({
        method: 'POST',
        url: `/api/vaults/${vaultId}/milestones/${mid}/evidence`,
        payload: {
          submitter: CREATOR,
          url: 'https://example.com/proof.pdf',
          sha256: 'a'.repeat(64),
        },
      })
      expect(res.statusCode).toBe(409)
    })

    test('unknown milestone returns 404', async () => {
      const { vaultId } = await setupVault(app)
      const res = await app.inject({
        method: 'POST',
        url: `/api/vaults/${vaultId}/milestones/fake-milestone/evidence`,
        payload: {
          submitter: CREATOR,
          url: 'https://example.com/proof.pdf',
          sha256: 'a'.repeat(64),
        },
      })
      expect(res.statusCode).toBe(404)
    })

    test('http:// URL returns 400', async () => {
      const { vaultId, milestones } = await setupVault(app)
      const res = await app.inject({
        method: 'POST',
        url: `/api/vaults/${vaultId}/milestones/${milestones[0].id}/evidence`,
        payload: {
          submitter: CREATOR,
          url: 'http://example.com/proof.pdf',
          sha256: 'a'.repeat(64),
        },
      })
      expect(res.statusCode).toBe(400)
      const body = JSON.parse(res.body)
      expect(body.details.some((d) => d.includes('HTTPS'))).toBe(true)
    })

    test('over-long URL returns 400', async () => {
      const { vaultId, milestones } = await setupVault(app)
      const res = await app.inject({
        method: 'POST',
        url: `/api/vaults/${vaultId}/milestones/${milestones[0].id}/evidence`,
        payload: {
          submitter: CREATOR,
          url: 'https://example.com/' + 'x'.repeat(2050),
          sha256: 'a'.repeat(64),
        },
      })
      expect(res.statusCode).toBe(400)
      const body = JSON.parse(res.body)
      expect(body.details.some((d) => d.includes('2048'))).toBe(true)
    })

    test('non-hex sha256 returns 400', async () => {
      const { vaultId, milestones } = await setupVault(app)
      const res = await app.inject({
        method: 'POST',
        url: `/api/vaults/${vaultId}/milestones/${milestones[0].id}/evidence`,
        payload: {
          submitter: CREATOR,
          url: 'https://example.com/proof.pdf',
          sha256: 'xyz' + 'a'.repeat(61),
        },
      })
      expect(res.statusCode).toBe(400)
      const body = JSON.parse(res.body)
      expect(body.details.some((d) => d.includes('hexadecimal'))).toBe(true)
    })

    test('short sha256 returns 400', async () => {
      const { vaultId, milestones } = await setupVault(app)
      const res = await app.inject({
        method: 'POST',
        url: `/api/vaults/${vaultId}/milestones/${milestones[0].id}/evidence`,
        payload: {
          submitter: CREATOR,
          url: 'https://example.com/proof.pdf',
          sha256: 'a'.repeat(32),
        },
      })
      expect(res.statusCode).toBe(400)
    })

    test('note over 1000 chars returns 400', async () => {
      const { vaultId, milestones } = await setupVault(app)
      const res = await app.inject({
        method: 'POST',
        url: `/api/vaults/${vaultId}/milestones/${milestones[0].id}/evidence`,
        payload: {
          submitter: CREATOR,
          url: 'https://example.com/proof.pdf',
          sha256: 'a'.repeat(64),
          note: 'x'.repeat(1001),
        },
      })
      expect(res.statusCode).toBe(400)
      const body = JSON.parse(res.body)
      expect(body.details.some((d) => d.includes('1000'))).toBe(true)
    })

    test('multiple submissions kept as history', async () => {
      const { vaultId, milestones } = await setupVault(app)
      const mid = milestones[0].id

      for (let i = 0; i < 3; i++) {
        await app.inject({
          method: 'POST',
          url: `/api/vaults/${vaultId}/milestones/${mid}/evidence`,
          payload: {
            submitter: CREATOR,
            url: `https://example.com/proof${i}.pdf`,
            sha256: `${'a'.repeat(63)}${i}`,
          },
        })
      }

      const detailRes = await app.inject({ method: 'GET', url: `/api/vaults/${vaultId}` })
      const detail = JSON.parse(detailRes.body)
      const m = detail.data.milestones.find((x) => x.id === mid)
      expect(m.evidence).toHaveLength(3)
      expect(m.evidence[0].url).toBe('https://example.com/proof2.pdf')
      expect(m.latestEvidenceHash).toBe(`${'a'.repeat(63)}2`)
    })

    test('evidence creates activity log entry', async () => {
      const { vaultId, milestones } = await setupVault(app)
      await app.inject({
        method: 'POST',
        url: `/api/vaults/${vaultId}/milestones/${milestones[0].id}/evidence`,
        payload: {
          submitter: CREATOR,
          url: 'https://example.com/proof.pdf',
          sha256: 'a'.repeat(64),
        },
      })

      const actRes = await app.inject({ method: 'GET', url: `/api/vaults/${vaultId}` })
      const detail = JSON.parse(actRes.body)
      const evidenceActivity = detail.data.activity.find((a) => a.type === 'evidence')
      expect(evidenceActivity).toBeDefined()
      expect(evidenceActivity.memo).toContain('Evidence submitted')
    })
  })
}

runTests('memory', async () => new MemoryStore())

if (process.env.DATABASE_URL) {
  const pg = await import('pg')
  const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL })
  runTests('postgres', async () => new PgStore(pool))
  afterAll(async () => { await pool.end() })
}
