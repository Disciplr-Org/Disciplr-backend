export interface NotificationProvider {
  name: string
  send(recipient: string, subject: string, body: string): Promise<void>
}
