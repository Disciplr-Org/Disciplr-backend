import { describe, expect, it } from '@jest/globals'
import type { EnterpriseResponse } from '../types/enterprise.js'

describe('EnterpriseResponse Discriminated Union', () => {
  it('narrows wrapped response using wrapped discriminant key', () => {
    const wrappedRes: EnterpriseResponse<string> = {
      wrapped: true,
      data: 'hello world',
    }

    if (wrappedRes.wrapped) {
      expect(wrappedRes.data).toBe('hello world')
    } else {
      throw new Error('Should have narrowed to wrapped: true')
    }
  })

  it('narrows unwrapped response using wrapped discriminant key', () => {
    const unwrappedRes: EnterpriseResponse<number> = {
      wrapped: false,
      value: 42,
    }

    if (!unwrappedRes.wrapped) {
      expect(unwrappedRes.value).toBe(42)
    } else {
      throw new Error('Should have narrowed to wrapped: false')
    }
  })

  it('enforces compile-time exhaustiveness checking via discriminant', () => {
    function unwrap<T>(res: EnterpriseResponse<T>): T {
      switch (res.wrapped) {
        case true:
          return res.data
        case false:
          return res.value
      }
    }

    const wrapped: EnterpriseResponse<string> = { wrapped: true, data: 'wrapped_payload' }
    const unwrapped: EnterpriseResponse<string> = { wrapped: false, value: 'unwrapped_payload' }

    expect(unwrap(wrapped)).toBe('wrapped_payload')
    expect(unwrap(unwrapped)).toBe('unwrapped_payload')
  })
})
