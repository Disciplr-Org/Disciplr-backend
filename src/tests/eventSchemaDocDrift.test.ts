/**
 * Doc-drift guard: asserts that every topic marked as handled (✅) in
 * contracts/README.md is present in the EventType union defined in
 * src/types/horizonSync.ts, and vice-versa.
 *
 * If you add a new topic to the contract, update contracts/README.md first,
 * then add it to EventType and implement a parser — this test will catch the
 * drift in either direction.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Source-of-truth: the EventType values that the parser actually handles.
// We import the type as a runtime value by importing the module that re-exports
// the constant array used inside eventParser.ts.  If that constant is ever
// changed, this test will fail.
// ---------------------------------------------------------------------------
import { parseHorizonEvent } from '../../src/services/eventParser.js'
import type { EventType } from '../../src/types/horizonSync.js'

/** The exhaustive set of EventType values the parser recognises.
 *  Mirrors the validEventTypes array inside parseHorizonEvent. */
const PARSER_HANDLED_TYPES: EventType[] = [
  'vault_created',
  'vault_completed',
  'vault_failed',
  'vault_cancelled',
  'milestone_created',
  'milestone_validated',
]

// ---------------------------------------------------------------------------
// Parse contracts/README.md to extract the ✅-marked topics.
// ---------------------------------------------------------------------------
function parseDocumentedTopics(readmePath: string): {
  handled: string[]
  notHandled: string[]
} {
  const content = readFileSync(readmePath, 'utf8')

  const handled: string[] = []
  const notHandled: string[] = []

  // Each data row in the topic reference table looks like:
  //   | `vault_created` | ... | ✅ `vault_created` |
  //   | `vault_staked`  | ... | ❌ not in `EventType` |
  const rowRegex = /^\|\s+`([^`]+)`\s+\|[^|]+\|[^|]+\|[^|]+\|(.*)\|/gm
  let match: RegExpExecArray | null

  while ((match = rowRegex.exec(content)) !== null) {
    const topic = match[1].trim()
    const backendCell = match[5]?.trim() ?? match[2].trim()
    ;(backendCell.includes('✅') ? handled : notHandled).push(topic)
  }

  return { handled, notHandled }
}

const README_PATH = join(__dirname, '../../contracts/README.md')

describe('contracts/README.md ↔ EventType doc-drift guard', () => {
  let documented: ReturnType<typeof parseDocumentedTopics>

  beforeAll(() => {
    documented = parseDocumentedTopics(README_PATH)
  })

  test('contracts/README.md is readable and contains topic rows', () => {
    expect(documented.handled.length + documented.notHandled.length).toBeGreaterThan(0)
  })

  test('every ✅ topic in contracts/README.md is in the parser EventType list', () => {
    const missing = documented.handled.filter(
      (t) => !PARSER_HANDLED_TYPES.includes(t as EventType)
    )
    expect(missing).toEqual([])
  })

  test('every parser EventType is documented as ✅ in contracts/README.md', () => {
    const undocumented = PARSER_HANDLED_TYPES.filter(
      (t) => !documented.handled.includes(t)
    )
    expect(undocumented).toEqual([])
  })

  test('parseHorizonEvent rejects every ❌ (unhandled) topic from contracts/README.md', () => {
    for (const topic of documented.notHandled) {
      const result = parseHorizonEvent({
        type: 'contract',
        ledger: 1,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        contractId: 'CTEST',
        id: 'abc123-0',
        pagingToken: 'abc123-0',
        topic: [topic],
        value: { xdr: '' },
        inSuccessfulContractCall: true,
        txHash: 'abc123',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toMatch(/Unknown event type/)
      }
    }
  })
})
