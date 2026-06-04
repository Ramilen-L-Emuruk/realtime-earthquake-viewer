import { useState, useEffect, useRef } from 'react'

const WEBHOOK_SERVER = 'http://localhost:3001'
const AUTO_DISMISS_MS = 5 * 60 * 1000

export interface WebhookAlertState {
  isActive: boolean
  triggeredAt: Date | null
  message: string | null
  dismiss: () => void
}

export function useWebhookAlert(): WebhookAlertState {
  const [isActive, setIsActive] = useState(false)
  const [triggeredAt, setTriggeredAt] = useState<Date | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)

  const activate = (msg?: string) => {
    setIsActive(true)
    setTriggeredAt(new Date())
    setMessage(msg ?? null)
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    dismissTimerRef.current = setTimeout(() => setIsActive(false), AUTO_DISMISS_MS)
  }

  const dismiss = () => {
    setIsActive(false)
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('ha_alert') === '1') {
      activate(params.get('message') ?? undefined)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retryDelay = 5000

    const connect = () => {
      try {
        const es = new EventSource(`${WEBHOOK_SERVER}/sse`)
        eventSourceRef.current = es

        es.addEventListener('earthquake-alert', (e: Event) => {
          const msgEvent = e as MessageEvent<string>
          try {
            const data = JSON.parse(msgEvent.data) as { message?: string }
            activate(data.message)
          } catch {
            activate()
          }
        })

        es.addEventListener('dismiss', () => dismiss())

        es.onerror = () => {
          es.close()
          retryDelay = Math.min(retryDelay * 1.5, 60000)
          retryTimer = setTimeout(connect, retryDelay)
        }

        es.onopen = () => {
          retryDelay = 5000
        }
      } catch {
        retryTimer = setTimeout(connect, retryDelay)
      }
    }

    connect()

    return () => {
      if (retryTimer) clearTimeout(retryTimer)
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
      eventSourceRef.current?.close()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { isActive, triggeredAt, message, dismiss }
}
