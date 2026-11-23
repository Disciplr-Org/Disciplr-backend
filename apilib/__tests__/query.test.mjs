import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  QueryValidationError,
  validateStatus,
  validateCreator,
  validateVaultId,
} from '../query.mjs'

test('validateStatus', () => {
  assert.equal(validateStatus(undefined), undefined)
  assert.equal(validateStatus(null), undefined)
  assert.equal(validateStatus(''), undefined)
  assert.equal(validateStatus('   '), undefined)
  assert.equal(validateStatus('active'), 'active')
  assert.equal(validateStatus('completed'), 'completed')
  assert.equal(validateStatus('failed'), 'failed')

  assert.throws(() => validateStatus('bogus'), (err) => {
    assert(err instanceof QueryValidationError)
    assert.equal(err.status, 400)
    assert(err.message.includes('status'))
    assert(err.details[0].includes('status'))
    return true
  })

  assert.throws(() => validateStatus(['active', 'completed']), (err) => {
    assert(err instanceof QueryValidationError)
    assert.equal(err.status, 400)
    assert(err.details[0].includes('array'))
    return true
  })
})

test('validateCreator', () => {
  const validKey = 'GDLYZ73G3GEF36HBLEBFXOXAP5IXJDRQCRG47JCKR4XAXNOFCU44NZT2'
  assert.equal(validateCreator(undefined), undefined)
  assert.equal(validateCreator(null), undefined)
  assert.equal(validateCreator(''), undefined)
  assert.equal(validateCreator(validKey), validKey)

  assert.throws(() => validateCreator('notakey'), (err) => {
    assert(err instanceof QueryValidationError)
    assert.equal(err.status, 400)
    assert(err.details[0].includes('Stellar public key'))
    return true
  })

  assert.throws(() => validateCreator(['a', 'b']), (err) => {
    assert(err instanceof QueryValidationError)
    assert.equal(err.status, 400)
    assert(err.details[0].includes('array'))
    return true
  })
})

test('validateVaultId', () => {
  assert.equal(validateVaultId(undefined), undefined)
  assert.equal(validateVaultId(null), undefined)
  assert.equal(validateVaultId(''), undefined)
  assert.equal(validateVaultId('vault-abc-123'), 'vault-abc-123')
  assert.equal(validateVaultId('vault-1'), 'vault-1')

  assert.throws(() => validateVaultId('../../x'), (err) => {
    assert(err instanceof QueryValidationError)
    assert.equal(err.status, 400)
    assert(err.details[0].includes('vaultId'))
    return true
  })

  assert.throws(() => validateVaultId(['vault-1', 'vault-2']), (err) => {
    assert(err instanceof QueryValidationError)
    assert.equal(err.status, 400)
    assert(err.details[0].includes('array'))
    return true
  })
})
