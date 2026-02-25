import { app } from './app.js'
import { startDeadlineMonitor } from './services/monitor.js'

const PORT = process.env.PORT ?? 3000

app.listen(PORT, () => {
  console.log(`Disciplr API listening on http://localhost:${PORT}`)
  
  // Start the deadline monitor background service
  startDeadlineMonitor()
})
