import { resetApiKeysTable } from '../services/apiKeys.js'
import { resetDLQTable } from '../services/dlq.js'

export const setupTestEnvironment = () => {
  beforeEach(() => {
    resetApiKeysTable()
    resetDLQTable()
  })
}
