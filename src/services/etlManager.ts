import { StellarETLService } from './stellarETLService.js'

export class ETLManager {
  private static instance: ETLManager
  private etlService: StellarETLService
  private isInitialized: boolean = false

  private constructor() {
    this.etlService = new StellarETLService()
  }

  static getInstance(): ETLManager {
    if (!ETLManager.instance) {
      ETLManager.instance = new ETLManager()
    }
    return ETLManager.instance
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.log('ETL Manager already initialized')
      return
    }

    console.log('Initializing ETL Manager...')
    
    // Start the ETL service
    await this.etlService.startETL()
    
    this.isInitialized = true
    console.log('ETL Manager initialized successfully')
  }

  async shutdown(): Promise<void> {
    if (!this.isInitialized) {
      console.log('ETL Manager not initialized')
      return
    }

    console.log('Shutting down ETL Manager...')
    
    // Stop the ETL service
    await this.etlService.stopETL()
    
    this.isInitialized = false
    console.log('ETL Manager shut down successfully')
  }

  getETLService(): StellarETLService {
    return this.etlService
  }

  isRunning(): boolean {
    return this.isInitialized
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down ETL Manager...')
  await ETLManager.getInstance().shutdown()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down ETL Manager...')
  await ETLManager.getInstance().shutdown()
  process.exit(0)
})
