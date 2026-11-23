import { jest } from '@jest/globals';
import { EmailNotificationProvider } from './email.provider.js';
import { _resetEnvForTesting, initEnv } from '../../config/index.js';

describe('EmailNotificationProvider', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    _resetEnvForTesting();
  });

  it('sends escaped HTML through the injected SMTP transport', async () => {
    initEnv({
      DATABASE_URL: 'postgresql://localhost/disciplr',
      DOWNLOAD_SECRET: 'a-secure-download-secret',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '465',
      SMTP_USER: 'smtp-user',
      SMTP_PASS: 'smtp-password',
      SMTP_FROM: 'noreply@example.com',
      SMTP_SECURE: 'true',
    });
    const sendMail = jest.fn().mockResolvedValue({});
    const transportFactory = jest.fn().mockResolvedValue({ sendMail });
    const provider = new EmailNotificationProvider(transportFactory);

    await provider.send('recipient@example.com', 'Hello\r\nthere', '<script>alert("xss")</script>');

    expect(transportFactory).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: { user: 'smtp-user', pass: 'smtp-password' },
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith({
      from: 'noreply@example.com',
      to: 'recipient@example.com',
      subject: 'Hello there',
      text: '<script>alert("xss")</script>',
      html: '<html><body><p>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</p></body></html>',
    });
  });

  it('retries on transient 4xx SMTP errors', async () => {
    const provider = new EmailNotificationProvider();
    const mockSend = jest
      .fn()
      .mockImplementationOnce(() => {
        const err: any = new Error('Transient 4xx');
        err.statusCode = 450;
        throw err;
      })
      .mockImplementationOnce(() => Promise.resolve());
    // @ts-ignore – accessing private method for test
    provider.performSend = mockSend;

    await expect(provider.send('test@example.com', 'Subject', 'Body')).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('does not retry on permanent 5xx SMTP errors', async () => {
    const provider = new EmailNotificationProvider();
    const mockSend = jest
      .fn()
      .mockImplementation(() => {
        const err: any = new Error('Permanent 5xx');
        err.statusCode = 550;
        throw err;
      });
    // @ts-ignore
    provider.performSend = mockSend;

    await expect(provider.send('test@example.com', 'Subject', 'Body')).rejects.toThrow('Permanent 5xx');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
