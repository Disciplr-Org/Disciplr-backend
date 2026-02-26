import { Queue, Worker, Job } from 'bullmq'
import { Redis } from 'ioredis'
import { EmailService } from './email-service.js'
import { logger } from '../logger.js'
import type { EmailEventPayload } from '../../types/email.js'

export interface EmailJobData {
  type: 'email'
  payload: EmailEventPayload
  retryCount?: number
}

export class EmailQueueService {
  private queue: Queue<EmailJobData>
  private worker: Worker<EmailJobData>
  private emailService: EmailService
  private redis: Redis

  constructor(emailService: EmailService, redisUrl: string = 'redis://localhost:6379') {
    this.emailService = emailService
    this.redis = new Redis(redisUrl)
    
    this.queue = new Queue<EmailJobData>('email-queue', {
      connection: this.redis,
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      },
    })

    this.worker = new Worker<EmailJobData>(
      'email-queue',
      this.processEmailJob.bind(this),
      {
        connection: this.redis,
        concurrency: 5,
      }
    )

    this.setupEventListeners()
  }

  private async processEmailJob(job: Job<EmailJobData>): Promise<void> {
    const { payload } = job.data
    
    try {
      const result = await this.emailService.sendEventEmail(payload)
      
      if (!result.success) {
        throw new Error(`Email sending failed: ${result.error}`)
      }

      logger.queueInfo('Email sent successfully', {
        jobId: job.id,
        recipient: payload.recipient,
        eventType: payload.type,
        messageId: result.messageId,
      })
    } catch (error) {
      logger.queueError('Failed to process email job', {
        jobId: job.id,
        recipient: payload.recipient,
        eventType: payload.type,
      }, error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  private setupEventListeners(): void {
    this.worker.on('completed', (job) => {
      console.log(`Email job ${job.id} completed successfully`)
    })

    this.worker.on('failed', (job, err) => {
      console.error(`Email job ${job?.id} failed:`, err)
    })

    this.worker.on('error', (err) => {
      console.error('Email queue worker error:', err)
    })

    this.queue.on('error', (err) => {
      console.error('Email queue error:', err)
    })
  }

  async addEmailJob(payload: EmailEventPayload, options?: { delay?: number }): Promise<void> {
    const jobData: EmailJobData = {
      type: 'email',
      payload,
    }

    await this.queue.add('send-email', jobData, {
      delay: options?.delay,
      priority: this.getPriority(payload.type),
    })
  }

  private getPriority(eventType: string): number {
    const priorities = {
      verification_requested: 10,
      deadline_approaching: 8,
      vault_created: 5,
      funds_released: 7,
      funds_redirected: 7,
    }
    return priorities[eventType as keyof typeof priorities] || 5
  }

  async getQueueStatus(): Promise<{
    waiting: number
    active: number
    completed: number
    failed: number
    delayed: number
  }> {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.queue.getWaiting(),
      this.queue.getActive(),
      this.queue.getCompleted(),
      this.queue.getFailed(),
      this.queue.getDelayed(),
    ])

    return {
      waiting: waiting.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
      delayed: delayed.length,
    }
  }

  async pauseQueue(): Promise<void> {
    await this.queue.pause()
    await this.worker.pause()
  }

  async resumeQueue(): Promise<void> {
    await this.queue.resume()
    await this.worker.resume()
  }

  async close(): Promise<void> {
    await this.worker.close()
    await this.queue.close()
    await this.redis.quit()
  }
}
