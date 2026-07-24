import { describe, expect, it } from '@jest/globals'
import { z } from 'zod'
import { buildValidationError, flattenZodErrors, formatIssuePath, formatValidationError } from '../lib/validation.js'

describe('validation helpers', () => {
  it('formats top-level field paths', () => {
    expect(formatIssuePath(['email'])).toBe('email')
  })

  it('formats nested array paths', () => {
    expect(formatIssuePath(['milestones', 1, 'dueDate'])).toBe('milestones[1].dueDate')
  })

  it('ignores unsupported path segments', () => {
    expect(formatIssuePath(['meta', Symbol('hidden'), 'value'])).toBe('meta.value')
  })

  it('flattens zod issues into client-friendly field entries', () => {
    const schema = z.object({
      email: z.string().email(),
      milestones: z.array(z.object({ dueDate: z.string().min(1) })),
    })

    const result = schema.safeParse({
      email: 'bad',
      milestones: [{ dueDate: '' }],
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(flattenZodErrors(result.error)).toEqual([
        expect.objectContaining({ path: 'email', code: 'invalid_format' }),
        expect.objectContaining({ path: 'milestones[0].dueDate', code: 'too_small' }),
      ])
    }
  })

  it('maps root-level issues to root', () => {
    const schema = z.string().refine((value) => value === 'ok', 'must equal ok')
    const result = schema.safeParse('bad')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(flattenZodErrors(result.error)).toEqual([
        { path: 'root', message: 'must equal ok', code: 'custom' },
      ])
    }
  })

  it('wraps formatted fields in the standard error envelope', () => {
    expect(buildValidationError([{ path: 'email', message: 'Invalid email', code: 'invalid_format' }])).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request payload',
        fields: [{ path: 'email', message: 'Invalid email', code: 'invalid_format' }],
      },
    })
  })

  it('formats zod errors into the standard error envelope', () => {
    const result = z.object({ refreshToken: z.string() }).safeParse({})

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(formatValidationError(result.error)).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request payload',
          fields: [
            expect.objectContaining({
              path: 'refreshToken',
              code: 'invalid_type',
            }),
          ],
        },
      })
    }
  })
})
