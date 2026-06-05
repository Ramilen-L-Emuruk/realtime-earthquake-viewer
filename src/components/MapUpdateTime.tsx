interface Props {
  lastUpdate: Date | null
}

function formatDatetime(date: Date): string {
  const M = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${date.getFullYear()}/${M}/${d} ${h}:${m}:${s}`
}

// 地図左上に重ねて表示する更新時刻（黒背景・白文字）。
export function MapUpdateTime({ lastUpdate }: Props) {
  const valid = lastUpdate && !Number.isNaN(lastUpdate.getTime())
  return (
    <div className="absolute top-2 left-2 z-[1000] bg-black/80 text-white text-xs font-mono px-2 py-1 rounded pointer-events-none">
      更新 {valid ? formatDatetime(lastUpdate) : '受信待機中…'}
    </div>
  )
}
