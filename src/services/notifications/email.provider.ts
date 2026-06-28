import { NotificationProvider } from './provider.js'
import { retryWithBackoff, DEFAULT_RETRY_CONFIG, isRetryable } from '../../utils/retry.js'
import { recordBounce } from './bounceStore.js'

/**
 * EmailNotificationProvider implements the NotificationProvider interface.
 * It sends email notifications. Currently this is a stub that simulates latency.
 * Transient SMTP 4xx errors are retried using exponential backoff with jitter.
 * 5xx errors are considered permanent and are not retried, preserving dead‑letter semantics.
 */
export class EmailNotificationProvider implements NotificationProvider {
  readonly name = 'email';

  /**
   * Classify whether an error represents a permanent bounce
   */
  private isPermanentBounce(error: Error): boolean {
    const msg = (error && error.message || '').toLowerCase()

    // Common SMTP permanent bounce indicators
    if (msg.includes('550') || msg.includes('554') || msg.includes('5.1.1')) {
      return true
    }

    // Typical human readable bounce phrases
    if (msg.includes('user unknown') || msg.includes('recipient not found') || msg.includes('mailbox unavailable') || msg.includes('user not found')) {
      return true
    }

    return false
  }

  async send(recipient: string, subject: string, body: string): Promise<void> {
    // Wrap the actual send operation in the shared retry utility
    const operation = async () => {
      // In a real implementation, call the SMTP / provider SDK here.
      // Simulate network latency for the stubbed provider.
      await new Promise((resolve) => setTimeout(resolve, 50))

      // For now, we log the send; the real provider should replace this.
      console.log(`[EmailProvider] Sent to ${recipient}: ${subject}`)
    }

    try {
      await retryWithBackoff(operation, DEFAULT_RETRY_CONFIG, (err) => {
        // Treat classified permanent bounces as non-retryable
        if (this.isPermanentBounce(err)) {
          ;(err as any).nonRetryable = true
          // record the bounce for later inspection and to stop retries
          try { recordBounce(recipient, err.message) } catch (_) { /* ignore */ }
          return false
        }

        // Otherwise fall back to the shared isRetryable predicate
        return isRetryable(err)
      })
    } catch (err) {
      // If the error was classified non-retryable, mark the property on the error
      if (err && (err as any).nonRetryable) {
        throw err
      }
      // Re-throw other errors as-is
      throw err
    }
  }
}
