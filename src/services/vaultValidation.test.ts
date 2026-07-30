/* eslint-env jest */
import { getClassicAddress } from './vaultValidation.js'

describe('getClassicAddress', () => {
  it('returns original address for valid classic address', () => {
    const classic = 'GAP3SREQTGBQADRB5QUVLWC4RZZ62MFMQZ5CCEYMMCVQF7GFREISGZGL'
    expect(getClassicAddress(classic)).toBe(classic)
  })

  it('decodes and returns classic address for valid muxed address', () => {
    const muxed = 'MAP3SREQTGBQADRB5QUVLWC4RZZ62MFMQZ5CCEYMMCVQF7GFREISHLPU'
    const expectedClassic = 'GAP3SREQTGBQADRB5QUVLWC4RZZ62MFMQZ5CCEYMMCVQF7GFREISGZGL'
    expect(getClassicAddress(muxed)).toBe(expectedClassic)
  })

  it('throws an error for malformed muxed address', () => {
    const malformed = 'M1234567890'
    expect(() => getClassicAddress(malformed)).toThrow('Invalid muxed address format')
  })

  it('returns original string for non-muxed, non-classic unrecognized strings', () => {
    const randomStr = 'random_string'
    expect(getClassicAddress(randomStr)).toBe(randomStr)
  })
})
