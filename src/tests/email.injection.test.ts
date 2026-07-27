import { describe, it, expect, mock } from "bun:test";
import { EmailNotificationProvider } from "../services/notifications/email.provider.js";

describe("EmailNotificationProvider Injection and Sanitization", () => {
  it("should reject recipient addresses containing CRLF characters to prevent header injection", async () => {
    const provider = new EmailNotificationProvider();
    
    // CRLF in recipient
    await expect(
      provider.send("recipient@example.com\r\nBcc: admin@example.com", "Subject", "Body")
    ).rejects.toThrow("CRLF injection detected in recipient");

    await expect(
      provider.send("recipient@example.com\nBcc: admin@example.com", "Subject", "Body")
    ).rejects.toThrow("CRLF injection detected in recipient");

    await expect(
      provider.send("recipient@example.com\rBcc: admin@example.com", "Subject", "Body")
    ).rejects.toThrow("CRLF injection detected in recipient");
  });

  it("should strip CRLF characters from the subject to prevent header injection", async () => {
    const provider = new EmailNotificationProvider();
    const mockSend = mock(() => Promise.resolve(undefined));
    // @ts-expect-error - access private performSend
    provider.performSend = mockSend;

    await provider.send(
      "test@example.com",
      "Subject Line\r\nWith CRLF\nAnd LF\rAnd CR",
      "Body content"
    );

    expect(mockSend).toHaveBeenCalledTimes(1);
    const args = mockSend.mock.calls[0];
    const sanitizedSubject = args[1];
    
    // Subject should have CRLF replaced with spaces
    expect(sanitizedSubject).not.toContain("\r");
    expect(sanitizedSubject).not.toContain("\n");
    expect(sanitizedSubject).toBe("Subject Line With CRLF And LF And CR");
  });

  it("should escape HTML special characters in the body to prevent HTML/script injection", async () => {
    const provider = new EmailNotificationProvider();
    const mockSend = mock(() => Promise.resolve(undefined));
    // @ts-expect-error - access private performSend
    provider.performSend = mockSend;

    const maliciousBody = "Vault <script>alert('XSS')</script> & dynamic \"fields\" 'test'";
    await provider.send("test@example.com", "Subject", maliciousBody);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const args = mockSend.mock.calls[0];
    const htmlBody = args[3]; // The 4th argument passed to performSend is the htmlBody

    // The script tags and special chars should be escaped in the HTML body
    expect(htmlBody).toContain("&lt;script&gt;alert(&#39;XSS&#39;)&lt;/script&gt;");
    expect(htmlBody).toContain("&amp;");
    expect(htmlBody).toContain("&quot;fields&quot;");
    expect(htmlBody).toContain("&#39;test&#39;");
    expect(htmlBody).not.toContain("<script>");
  });

  it("should render a benign body correctly", async () => {
    const provider = new EmailNotificationProvider();
    const mockSend = mock(() => Promise.resolve(undefined));
    // @ts-expect-error - access private performSend
    provider.performSend = mockSend;

    const benignBody = "This is a benign body with no HTML special characters.";
    await provider.send("test@example.com", "Subject", benignBody);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const args = mockSend.mock.calls[0];
    const htmlBody = args[3];

    expect(htmlBody).toContain(benignBody);
    expect(htmlBody).toBe(`<html><body><p>${benignBody}</p></body></html>`);
  });
});
