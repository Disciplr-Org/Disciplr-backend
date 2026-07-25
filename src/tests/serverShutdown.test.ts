import supertest from 'supertest'
import { app } from '../app.js'
import { createShutdownHandler } from '../server/shutdown.js'

describe('shutdown drain', () => {
  test('waits for in-flight request to complete before closing', async () => {
    process.env.SHUTDOWN_DRAIN_MS = '1000'

    // Simple long-running handler
    app.get('/__test_long', (_req, res) => {
      setTimeout(() => {
        res.status(200).send('done')
      }, 200)
    })

    const server = app.listen(0)

    const fakeJobSystem = { stop: async () => {} }
    const fakeEtl = { stop: async () => {} }
    const closeDb = jest.fn()

    const shutdownHandler = createShutdownHandler({
      server,
      jobSystem: fakeJobSystem as any,
      etlWorker: fakeEtl as any,
      closeDb,
    })

    // Start a request and immediately trigger shutdown
    const reqPromise = supertest(server).get('/__test_long')

    // Give the request a few ms to start
    await new Promise((r) => setTimeout(r, 10))

    await shutdownHandler('SIGTERM')

    const res = await reqPromise
    expect(res.status).toBe(200)

    server.close()
  })
})
