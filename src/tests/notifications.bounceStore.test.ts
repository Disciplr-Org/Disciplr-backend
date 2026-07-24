import {
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
} from '../services/notifications/bounceStore.js'

describe('bounceStore – suppression contract', () => {
  beforeEach(() => {
    clearBounces()
    setSoftBounceCap(3)
  })

  describe('hard bounce suppression', () => {
    it('suppresses an address immediately after a hard bounce', () => {
      recordHardBounce('hard@example.com', '550 User unknown')
      expect(isSuppressed('hard@example.com')).toBe(true)
    })

    it('returns suppression reason as hard_bounce', () => {
      recordHardBounce('hard@example.com', '550 User unknown')
      const info = getSuppressionInfo('hard@example.com')
      expect(info.suppressed).toBe(true)
      expect(info.reason).toBe('hard_bounce')
      expect(info.at).toBeDefined()
    })

    it('recordBounce with permanent SMTP code triggers hard bounce', () => {
      recordBounce('perm@example.com', '550 Mailbox unavailable')
      expect(isSuppressed('perm@example.com')).toBe(true)
      const info = getSuppressionInfo('perm@example.com')
      expect(info.reason).toBe('hard_bounce')
    })

    it('recordBounce with 554 code triggers hard bounce', () => {
      recordBounce('perm554@example.com', '554 Transaction failed')
      expect(isSuppressed('perm554@example.com')).toBe(true)
    })

    it('recordBounce with 5.1.1 code triggers hard bounce', () => {
      recordBounce('perm511@example.com', '5.1.1 Bad destination mailbox address')
      expect(isSuppressed('perm511@example.com')).toBe(true)
    })

    it('recordBounce with human-readable bounce phrase triggers hard bounce', () => {
      recordBounce('unknown@example.com', 'user not found')
      expect(isSuppressed('unknown@example.com')).toBe(true)
    })

    it('hasBounced returns true after hard bounce', () => {
      recordHardBounce('hb@example.com', '550')
      expect(hasBounced('hb@example.com')).toBe(true)
    })

    it('subsequent send to hard-bounced address is blocked', () => {
      recordHardBounce('blocked@example.com', '550 User unknown')
      expect(isSuppressed('blocked@example.com')).toBe(true)
      expect(getSuppressionInfo('blocked@example.com').reason).toBe('hard_bounce')
    })
  })

  describe('soft bounce retry cap and suppression', () => {
    it('does not suppress below the soft-bounce cap', () => {
      recordSoftBounce('soft@example.com', '450 Mailbox full')
      expect(isSuppressed('soft@example.com')).toBe(false)
      expect(getSoftBounceCount('soft@example.com')).toBe(1)
    })

    it('does not suppress after (cap - 1) soft bounces', () => {
      for (let i = 0; i < 2; i++) {
        recordSoftBounce('soft@example.com', '450 Mailbox full')
      }
      expect(isSuppressed('soft@example.com')).toBe(false)
      expect(getSoftBounceCount('soft@example.com')).toBe(2)
    })

    it('suppresses exactly at the soft-bounce cap', () => {
      for (let i = 0; i < 3; i++) {
        recordSoftBounce('soft@example.com', '450 Mailbox full')
      }
      expect(isSuppressed('soft@example.com')).toBe(true)
      const info = getSuppressionInfo('soft@example.com')
      expect(info.reason).toBe('soft_bounce_cap')
    })

    it('recordBounce with non-permanent reason counts as soft bounce', () => {
      recordBounce('retry@example.com', '450 Temporary failure')
      expect(getSoftBounceCount('retry@example.com')).toBe(1)
      expect(isSuppressed('retry@example.com')).toBe(false)
    })

    it('recordBounce with non-permanent reason eventually suppresses at cap', () => {
      for (let i = 0; i < 3; i++) {
        recordBounce('retry@example.com', '450 Temporary failure')
      }
      expect(isSuppressed('retry@example.com')).toBe(true)
    })

    it('recordBounce with no reason counts as soft bounce', () => {
      recordBounce('nreason@example.com')
      expect(getSoftBounceCount('nreason@example.com')).toBe(1)
      expect(isSuppressed('nreason@example.com')).toBe(false)
    })

    it('hasBounced returns true once soft bounces reach cap', () => {
      for (let i = 0; i < 3; i++) {
        recordSoftBounce('hb@example.com')
      }
      expect(hasBounced('hb@example.com')).toBe(true)
    })

    it('respects custom soft-bounce cap', () => {
      setSoftBounceCap(2)
      recordSoftBounce('custom@example.com')
      expect(isSuppressed('custom@example.com')).toBe(false)
      recordSoftBounce('custom@example.com')
      expect(isSuppressed('custom@example.com')).toBe(true)
    })

    it('respects soft-bounce cap of 1', () => {
      setSoftBounceCap(1)
      recordSoftBounce('once@example.com')
      expect(isSuppressed('once@example.com')).toBe(true)
    })

    it('rejects soft-bounce cap below 1', () => {
      expect(() => setSoftBounceCap(0)).toThrow('soft bounce cap must be at least 1')
      expect(() => setSoftBounceCap(-5)).toThrow('soft bounce cap must be at least 1')
    })

    it('getSoftBounceCap returns the configured value', () => {
      setSoftBounceCap(5)
      expect(getSoftBounceCap()).toBe(5)
    })

    it('getSoftBounceCount returns 0 for unknown address', () => {
      expect(getSoftBounceCount('unknown@example.com')).toBe(0)
    })
  })

  describe('complaint suppression', () => {
    it('suppresses immediately on complaint regardless of bounce history', () => {
      recordComplaint('complaint@example.com')
      expect(isSuppressed('complaint@example.com')).toBe(true)
    })

    it('returns suppression reason as complaint', () => {
      recordComplaint('complaint@example.com')
      const info = getSuppressionInfo('complaint@example.com')
      expect(info.suppressed).toBe(true)
      expect(info.reason).toBe('complaint')
      expect(info.at).toBeDefined()
    })

    it('complaint suppresses even if no bounces exist', () => {
      recordComplaint('clean@example.com')
      expect(isSuppressed('clean@example.com')).toBe(true)
      expect(hasBounced('clean@example.com')).toBe(false)
    })

    it('complaint suppresses an address with partial soft bounces', () => {
      recordSoftBounce('partial@example.com')
      recordSoftBounce('partial@example.com')
      expect(isSuppressed('partial@example.com')).toBe(false)

      recordComplaint('partial@example.com')
      expect(isSuppressed('partial@example.com')).toBe(true)
      expect(getSuppressionInfo('partial@example.com').reason).toBe('complaint')
    })

    it('complaint suppresses an address that already had a hard bounce', () => {
      recordHardBounce('dual@example.com', '550')
      expect(isSuppressed('dual@example.com')).toBe(true)

      recordComplaint('dual@example.com')
      expect(isSuppressed('dual@example.com')).toBe(true)
      expect(getSuppressionInfo('dual@example.com').reason).toBe('complaint')
    })

    it('complaint is listed in getComplaints', () => {
      recordComplaint('listed@example.com')
      const complaints = getComplaints()
      expect(complaints).toHaveLength(1)
      expect(complaints[0].recipient).toBe('listed@example.com')
      expect(complaints[0].at).toBeDefined()
    })
  })

  describe('suppression query – short-circuit contract', () => {
    it('returns suppressed: false for unknown address', () => {
      const info = getSuppressionInfo('unknown@example.com')
      expect(info.suppressed).toBe(false)
      expect(info.reason).toBeUndefined()
    })

    it('isSuppressed returns false for unknown address', () => {
      expect(isSuppressed('unknown@example.com')).toBe(false)
    })

    it('complaint takes precedence over hard bounce in suppression info', () => {
      recordHardBounce('precedence@example.com', '550')
      recordComplaint('precedence@example.com')
      expect(getSuppressionInfo('precedence@example.com').reason).toBe('complaint')
    })

    it('hard bounce takes precedence over soft bounce in suppression info', () => {
      recordSoftBounce('mixed@example.com')
      recordSoftBounce('mixed@example.com')
      recordHardBounce('mixed@example.com', '550')
      expect(getSuppressionInfo('mixed@example.com').reason).toBe('hard_bounce')
    })

    it('non-suppressed address with soft bounces below cap is queryable', () => {
      recordSoftBounce('partial@example.com')
      expect(isSuppressed('partial@example.com')).toBe(false)
      expect(getSoftBounceCount('partial@example.com')).toBe(1)
    })
  })

  describe('clearBounces resets all state', () => {
    it('clears hard bounces', () => {
      recordHardBounce('a@example.com', '550')
      clearBounces()
      expect(isSuppressed('a@example.com')).toBe(false)
      expect(hasBounced('a@example.com')).toBe(false)
    })

    it('clears soft bounce counts', () => {
      recordSoftBounce('b@example.com')
      recordSoftBounce('b@example.com')
      recordSoftBounce('b@example.com')
      clearBounces()
      expect(isSuppressed('b@example.com')).toBe(false)
      expect(getSoftBounceCount('b@example.com')).toBe(0)
    })

    it('clears complaints', () => {
      recordComplaint('c@example.com')
      clearBounces()
      expect(isSuppressed('c@example.com')).toBe(false)
      expect(getComplaints()).toHaveLength(0)
    })

    it('getBounces returns empty after clear', () => {
      recordHardBounce('d@example.com', '550')
      clearBounces()
      expect(getBounces()).toHaveLength(0)
    })
  })

  describe('getBounces returns recorded bounces', () => {
    it('includes hard bounce entries', () => {
      recordHardBounce('hb1@example.com', '550 User unknown')
      const bounces = getBounces()
      expect(bounces).toHaveLength(1)
      expect(bounces[0].recipient).toBe('hb1@example.com')
      expect(bounces[0].reason).toBe('550 User unknown')
    })

    it('includes entries from recordBounce with permanent reason', () => {
      recordBounce('perm@example.com', '550 Mailbox full')
      const bounces = getBounces()
      expect(bounces).toHaveLength(1)
      expect(bounces[0].recipient).toBe('perm@example.com')
    })
  })

  describe('multiple addresses – isolation', () => {
    it('suppression of one address does not affect another', () => {
      recordHardBounce('suppressed@example.com', '550')
      expect(isSuppressed('suppressed@example.com')).toBe(true)
      expect(isSuppressed('clean@example.com')).toBe(false)
    })

    it('soft bounces for different addresses are tracked independently', () => {
      recordSoftBounce('a@example.com')
      recordSoftBounce('a@example.com')
      recordSoftBounce('b@example.com')

      expect(isSuppressed('a@example.com')).toBe(false)
      expect(getSoftBounceCount('a@example.com')).toBe(2)
      expect(getSoftBounceCount('b@example.com')).toBe(1)
    })

    it('complaints for different addresses are tracked independently', () => {
      recordComplaint('complaint1@example.com')
      expect(isSuppressed('complaint1@example.com')).toBe(true)
      expect(isSuppressed('complaint2@example.com')).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('recording a bounce for the same address multiple times accumulates', () => {
      recordSoftBounce('acc@example.com')
      recordSoftBounce('acc@example.com')
      expect(getSoftBounceCount('acc@example.com')).toBe(2)
      recordSoftBounce('acc@example.com')
      expect(isSuppressed('acc@example.com')).toBe(true)
    })

    it('hard bounce followed by clear then soft bounce restarts tracking', () => {
      recordHardBounce('restart@example.com', '550')
      expect(isSuppressed('restart@example.com')).toBe(true)
      clearBounces()
      expect(isSuppressed('restart@example.com')).toBe(false)

      recordSoftBounce('restart@example.com')
      expect(isSuppressed('restart@example.com')).toBe(false)
    })

    it('empty recipient string is a valid address key', () => {
      recordHardBounce('', '550')
      expect(isSuppressed('')).toBe(true)
    })

    it('recordBounce auto-classifies by reason content', () => {
      recordBounce('auto@example.com', 'recipient not found')
      expect(isSuppressed('auto@example.com')).toBe(true)
      expect(getSuppressionInfo('auto@example.com').reason).toBe('hard_bounce')
    })
  })
})
