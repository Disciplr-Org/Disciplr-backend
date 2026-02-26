import { app } from './app.js'
import { config } from './config/index.js'
import {
  createHorizonVaultEventListener,
  InMemoryVaultEventQueue,
  isHorizonListenerEnabled,
  loadHorizonListenerConfig,
} from './services/horizon/listener.js'

const server = app.listen(config.port, () => {
  console.log(`Disciplr API listening on http://localhost:${config.port}`)

  if (isHorizonListenerEnabled()) {
    const listenerConfig = loadHorizonListenerConfig()
    const eventQueue = new InMemoryVaultEventQueue()
    const horizonListener = createHorizonVaultEventListener({
      config: listenerConfig,
      queue: eventQueue,
    })

    horizonListener.start()

    const stopListener = () => {
      horizonListener.stop()
    }

    process.once('SIGINT', stopListener)
    process.once('SIGTERM', stopListener)
  }
})

process.once('SIGINT', () => {
  server.close()
})

process.once('SIGTERM', () => {
  server.close()
})
