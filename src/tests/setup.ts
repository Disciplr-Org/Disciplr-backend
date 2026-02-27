import { resetApiKeysTable } from '../services/apiKeys.js'

export const setupTestEnvironment = () => {
  beforeEach(() => {
    resetApiKeysTable()
  })
}
