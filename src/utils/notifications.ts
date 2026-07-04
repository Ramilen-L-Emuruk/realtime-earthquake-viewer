/**
 * ブラウザ通知を表示する。Notification API 未対応・未許可の環境では何もしない。
 * tag が同じ通知は上書きされる（同一イベントの続報で通知が積み重ならないようにする）。
 */
export function showBrowserNotification(
  title: string,
  body: string,
  tag: string,
  requireInteraction = false,
) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  new Notification(title, {
    body,
    icon: `${import.meta.env.BASE_URL}icons/icon.svg`,
    tag,
    requireInteraction,
  })
}
