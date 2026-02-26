export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
}

export interface LogEntry {
  timestamp: string
  level: LogLevel
  message: string
  context?: Record<string, any>
  error?: Error
  service?: string
}

export class Logger {
  private serviceName: string

  constructor(serviceName: string = 'DisciplrAPI') {
    this.serviceName = serviceName
  }

  private log(level: LogLevel, message: string, context?: Record<string, any>, error?: Error): void {
    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context,
      error,
      service: this.serviceName,
    }

    const logMessage = this.formatLogMessage(logEntry)

    switch (level) {
      case LogLevel.ERROR:
        console.error(logMessage)
        break
      case LogLevel.WARN:
        console.warn(logMessage)
        break
      case LogLevel.INFO:
        console.info(logMessage)
        break
      case LogLevel.DEBUG:
        console.debug(logMessage)
        break
    }

    if (error && error.stack) {
      console.error('Stack trace:', error.stack)
    }
  }

  private formatLogMessage(entry: LogEntry): string {
    const parts = [
      `[${entry.timestamp}]`,
      `[${entry.level.toUpperCase()}]`,
      entry.service ? `[${entry.service}]` : '',
      entry.message,
    ].filter(Boolean)

    let message = parts.join(' ')

    if (entry.context && Object.keys(entry.context).length > 0) {
      message += `\nContext: ${JSON.stringify(entry.context, null, 2)}`
    }

    if (entry.error) {
      message += `\nError: ${entry.error.message}`
    }

    return message
  }

  error(message: string, context?: Record<string, any>, error?: Error): void {
    this.log(LogLevel.ERROR, message, context, error)
  }

  warn(message: string, context?: Record<string, any>): void {
    this.log(LogLevel.WARN, message, context)
  }

  info(message: string, context?: Record<string, any>): void {
    this.log(LogLevel.INFO, message, context)
  }

  debug(message: string, context?: Record<string, any>): void {
    this.log(LogLevel.DEBUG, message, context)
  }

  emailError(message: string, context: { recipient: string; eventType?: string; vaultId?: string }, error?: Error): void {
    this.error(message, { ...context, component: 'email-service' }, error)
  }

  emailInfo(message: string, context: { recipient?: string; eventType?: string; vaultId?: string }): void {
    this.info(message, { ...context, component: 'email-service' })
  }

  queueError(message: string, context: { jobId?: string; eventType?: string; [key: string]: any }, error?: Error): void {
    this.error(message, { ...context, component: 'email-queue' }, error)
  }

  queueInfo(message: string, context: { jobId?: string; eventType?: string; [key: string]: any }): void {
    this.info(message, { ...context, component: 'email-queue' })
  }
}

export const logger = new Logger()
