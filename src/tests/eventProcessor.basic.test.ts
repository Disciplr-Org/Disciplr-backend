import { EventProcessor } from '../services/eventProcessor.js'
import { HorizonOperation } from '../types/horizonSync.js'
import { db } from '../db/index.js'

describe('EventProcessor - Basic Functionality', () => {
  it('should be defined', () => {
    expect(EventProcessor).toBeDefined()
  })
})
