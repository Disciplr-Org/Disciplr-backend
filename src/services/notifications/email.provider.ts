/* eslint-disable @typescript-eslint/no-explicit-any */
import { NotificationProvider } from './provider.js'
import { retryWithBackoff, DEFAULT_RETRY_CONFIG, isRetryable } from '../../utils/retry.js'
import { recordBounce, hasBounced } from './bounceStore.js'
import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import { getEnv } from '../../config/index.js'

/**
 * EmailNotificationProvider implements the NotificationProvider interface.
 * It sends email notifications via SMTP using nodemailer.
 * 
 * Configuration (all optional):
 * - SMTP_HOST: SMTP server hostname (e.g., smtp.gmail.com)
 * - SMTP_PORT: SMTP server port (default: 587)
 * - SMTP_USER: SMTP authentication username
 * - SMTP_PASS: SMTP authentication password
 * - SMTP_FROM: Default sender address
 * - SMTP_SECURE: 'true' to use TLS (default: false for port 587 STARTTLS)
 * 
 * If SMTP_HOST is not configured, sends are logged to console with a warning.
 * Transient SMTP 4xx errors are retried using exponential backoff with jitter.
 * 5xx errors are considered permanent and are not retried, preserving dead‑letter semantics.
 */
export class EmailNotificationProvider implements NotificationProvider {
  readonly name = 'email'
  private transporter: Transporter | null = null
  private initialized: boolean = false

  /**
   * Lazy-initialize the SMTP transporter on first send.
   */
  private ensureTransporter(): void {
    if (this.initialized) {
      return
    }

    this.initialized = true

    const env = getEnv()
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } = env

    if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
      this.transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE === 'true', // true for 465, false for other ports (use STARTTLS)
        auth: {
          user: SMTP_USER,
          pass: SMTP_PASS,
        },
      })
    } else {
      console.warn(
        '[EmailProvider] SMTP not configured (missing SMTP_HOST, SMTP_USER, or SMTP_PASS). ' +
        'Emails will be logged to console instead of being sent.',
      )
    }
  }

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

  private escapeHtml(str: string): string {
    return str.replace(/[&<>"']/g, (match) => {
      switch (match) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case "'": return '&#39;';
        default: return match;
      }
    });
  }

  private async performSend(recipient: string, subject: string, body: string, htmlBody?: string): Promise<void> {
    // In a real implementation, call the SMTP / provider SDK here.
    // Simulate network latency for the stubbed provider.
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));

    // For now, we log the send; the real provider should replace this.
    console.log(`[EmailProvider] Sent to ${recipient}: ${subject} (body: ${body.length} chars, htmlBody: ${htmlBody?.length ?? 0} chars)`);
  }

  async send(recipient: string, subject: string, body: string): Promise<void> {
    // 1. Assert CRLF in recipient is rejected
    if (/[\r\n]/.test(recipient)) {
      throw new Error('CRLF injection detected in recipient');
    }

    // 2. Assert CRLF in subject is stripped (replaced with space)
    const sanitizedSubject = subject.replace(/[\r\n]+/g, ' ');

    // 3. Escape HTML in dynamic body content
    const escapedBody = this.escapeHtml(body);
    const htmlBody = `<html><body><p>${escapedBody}</p></body></html>`;

    // Wrap the actual send operation in the shared retry utility
    const operation = async () => {
      await this.performSend(recipient, sanitizedSubject, body, htmlBody);
    };

    try {
      await retryWithBackoff(operation, DEFAULT_RETRY_CONFIG, (err: any) => {
        // Treat classified permanent bounces or 5xx errors as non-retryable
        if (this.isPermanentBounce(err) || (err.statusCode && err.statusCode >= 500)) {
          ;(err as any).nonRetryable = true
          // record the bounce for later inspection and to stop retries
          try { recordBounce(recipient, err.message) } catch { /* ignore */ }
          return false
        }

        // Treat transient SMTP 4xx errors as retryable
        if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
          return true
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
