import { EmailNotificationProvider } from './email.provider.js';

describe('EmailNotificationProvider', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
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
