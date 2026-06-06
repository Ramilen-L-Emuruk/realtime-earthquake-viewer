interface Props {
  lastUpdate: Date | null
  /** 更新がエラーで停止している場合 true（赤文字で表示） */
  error?: boolean
}

function formatDatetime(date: Date): string {
  const M = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${date.getFullYear()}/${M}/${d} ${h}:${m}:${s}`
}

// 地図左上に重ねて表示する更新時刻（黒背景）。通常は白文字、エラー停止時は赤文字。
export function MapUpdateTime({ lastUpdate, error = false }: Props) {
  const valid = lastUpdate && !Number.isNaN(lastUpdate.getTime())
  return (
    <div
      className={`absolute z-[1000] bg-black/80 text-xl font-mono px-2.5 py-1 rounded pointer-events-none ${
        error ? 'text-red-400' : 'text-white'
      }`}
      style={{
        top: 'max(0.5rem, env(safe-area-inset-top, 0px))',
        left: 'max(0.5rem, env(safe-area-inset-left, 0px))',
      }}
    >
      更新 {valid ? formatDatetime(lastUpdate) : '受信待機中…'}
    </div>
  )
}
