# Email Notification System

This document describes the email notification system implemented for the Disciplr backend.

## Overview

The email notification system provides:
- Configurable email providers (AWS SES, SendGrid, Postmark)
- Background job processing with BullMQ
- Email templates for vault events
- Centralized error handling and logging
- Comprehensive testing suite

## Configuration

### Environment Variables

```bash
# Email Configuration
EMAIL_PROVIDER=ses                    # Options: ses, sendgrid, postmark
EMAIL_FROM=noreply@disciplr.com
EMAIL_FROM_NAME=Disciplr

# AWS SES Configuration (if using SES)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_aws_access_key
AWS_SECRET_ACCESS_KEY=your_aws_secret_key

# SendGrid Configuration (if using SendGrid)
SENDGRID_API_KEY=your_sendgrid_api_key

# Postmark Configuration (if using Postmark)
POSTMARK_SERVER_TOKEN=your_postmark_server_token

# Redis Configuration (for email queue)
REDIS_URL=redis://localhost:6379
```

## Email Events

The system supports the following email events:

### 1. Vault Created
- **Trigger**: When a new vault is created
- **Recipient**: Vault creator
- **Content**: Vault details and configuration

### 2. Deadline Approaching
- **Trigger**: When vault deadline is near
- **Recipient**: Vault participants
- **Content**: Time remaining and vault details

### 3. Funds Released
- **Trigger**: When funds are released from vault
- **Recipient**: Relevant stakeholders
- **Content**: Transaction details and destination

### 4. Funds Redirected
- **Trigger**: When funds are redirected to new destination
- **Recipient**: Relevant stakeholders
- **Content**: Original and new destinations, reason

### 5. Verification Requested
- **Trigger**: When verification is required
- **Recipient**: Users awaiting approval
- **Content**: Verification type and deadline

## API Endpoints

### Health Check
```
GET /api/email/health
```
Returns the health status of the email service.

### Queue Status
```
GET /api/email/queue/status
```
Returns the current status of the email queue.

### Send Test Email
```
POST /api/email/send/test
Content-Type: application/json

{
  "to": "recipient@example.com",
  "eventType": "vault_created",
  "data": {
    "vaultId": "test-vault",
    "amount": "1000"
  }
}
```

### Send Vault Created Notification
```
POST /api/email/send/vault-created
Content-Type: application/json

{
  "vault": {
    "id": "vault-123",
    "creator": "user-123",
    "amount": "1000",
    "startTimestamp": "2024-01-01T00:00:00Z",
    "endTimestamp": "2024-12-31T23:59:59Z",
    "successDestination": "success-wallet",
    "failureDestination": "failure-wallet",
    "status": "active",
    "createdAt": "2024-01-01T00:00:00Z"
  },
  "recipientEmail": "user@example.com"
}
```

### Send Deadline Approaching Notification
```
POST /api/email/send/deadline-approaching
Content-Type: application/json

{
  "vault": { /* vault object */ },
  "recipientEmail": "user@example.com",
  "timeRemaining": "2 days"
}
```

## Usage Examples

### Using Notification Service

```typescript
import { getNotificationService } from './services/notification-service.js'
import type { Vault } from './routes/vaults.js'

const notificationService = getNotificationService()

// Send vault created notification
await notificationService.notifyVaultCreated(vault, 'user@example.com')

// Send deadline approaching notification
await notificationService.notifyDeadlineApproaching(
  vault, 
  'user@example.com', 
  '2 days'
)

// Send custom notification
await notificationService.sendCustomNotification(
  'user@example.com',
  'vault_created',
  { customField: 'value' }
)
```

### Using Email Service Directly

```typescript
import { EmailService } from './services/email/index.js'
import { getEmailConfig } from './services/email/index.js'

const emailService = new EmailService(getEmailConfig())

// Send event email
const result = await emailService.sendEventEmail({
  type: 'vault_created',
  recipient: 'user@example.com',
  data: {
    vaultId: 'vault-123',
    amount: '1000'
  }
})

if (result.success) {
  console.log('Email sent:', result.messageId)
} else {
  console.error('Email failed:', result.error)
}
```

## Architecture

### Components

1. **Email Providers**: Abstract interface for different email services
   - `SESProvider`: AWS Simple Email Service
   - `SendGridProvider`: SendGrid API
   - `PostmarkProvider`: Postmark API

2. **Email Service**: Main service handling email sending and templates
   - Provider abstraction
   - Template rendering
   - Error handling

3. **Email Queue**: Background job processing
   - BullMQ for reliable job processing
   - Retry logic with exponential backoff
   - Priority-based job scheduling

4. **Notification Service**: High-level interface for vault events
   - Event-specific methods
   - Integration with existing vault system

5. **Logger**: Centralized logging service
   - Structured logging
   - Component-specific log methods
   - Error context tracking

### Queue Configuration

- **Max Attempts**: 3 retries with exponential backoff
- **Backoff Delay**: Starts at 2 seconds, doubles each retry
- **Concurrency**: 5 jobs processed simultaneously
- **Job Retention**: 100 completed jobs, 50 failed jobs

### Priority Levels

- **Verification Requested**: 10 (highest)
- **Deadline Approaching**: 8
- **Funds Released/Redirected**: 7
- **Vault Created**: 5 (default)

## Testing

### Unit Tests
- Email service provider tests
- Notification service tests
- Template rendering tests

### Integration Tests
- Queue processing tests
- End-to-end email sending tests
- Error handling tests

### Running Tests
```bash
# Run all tests
npm test

# Run specific test files
npm test src/services/email/email-service.test.ts
npm test src/services/notification-service.test.ts
npm test src/services/email/email-queue.integration.test.ts
```

## Error Handling

The system includes comprehensive error handling:

1. **Provider Errors**: Failed API calls, authentication issues
2. **Queue Errors**: Job processing failures, Redis connection issues
3. **Template Errors**: Missing data, rendering failures
4. **Configuration Errors**: Invalid provider settings, missing credentials

All errors are logged with context for debugging and monitoring.

## Monitoring

Monitor the following metrics:

- Queue depth (waiting jobs)
- Processing rate (jobs/second)
- Error rate (failed jobs/total jobs)
- Provider-specific metrics (delivery rates, bounces)

Use the `/api/email/queue/status` endpoint for real-time queue status.

## Security Considerations

1. **Credential Management**: Store email provider credentials securely
2. **Rate Limiting**: Implement rate limiting for email sending
3. **Input Validation**: Validate all email inputs and parameters
4. **Access Control**: Restrict access to email management endpoints

## Troubleshooting

### Common Issues

1. **Emails not sending**: Check provider credentials and configuration
2. **Queue not processing**: Verify Redis connection and worker status
3. **Templates not rendering**: Check template data structure
4. **High error rates**: Review logs for specific error patterns

### Debug Commands

```bash
# Check queue status
curl http://localhost:3000/api/email/queue/status

# Send test email
curl -X POST http://localhost:3000/api/email/send/test \
  -H "Content-Type: application/json" \
  -d '{"to":"test@example.com","eventType":"vault_created"}'

# Check service health
curl http://localhost:3000/api/email/health
```

## Future Enhancements

1. **Email Templates**: Support for custom HTML templates
2. **Analytics**: Email open and click tracking
3. **Unsubscribe Management**: User preference management
4. **Multi-language Support**: Localized email templates
5. **Webhook Support**: Real-time delivery status updates
