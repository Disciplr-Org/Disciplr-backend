declare module 'nodemailer' {
  export function createTransport(options: unknown): {
    sendMail(options: unknown): Promise<unknown>
  }
}
