export interface Notification {
  id: string
  user_id: string
  type: string
  title: string
  message: string
  data?: any
  read_at: string | null
  created_at: string
}

export interface CreateNotificationInput {
  user_id: string
  type: string
  title: string
  message: string
  data?: any
}
