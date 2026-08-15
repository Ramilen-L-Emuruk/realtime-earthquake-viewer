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
// 重ね位置（absolute・z-index・セーフエリア）は App.tsx 側の地図左上ラッパーが持つ。
export function MapUpdateTime({ lastUpdate, error = false }: Props) {
  const valid = lastUpdate && !Number.isNaN(lastUpdate.getTime())
  return (
    <div
      className={`bg-black/80 font-mono rounded text-sm px-2 py-0.5 roomy:text-xl roomy:px-2.5 roomy:py-1 ${
        error ? 'text-red-400' : 'text-white'
      }`}
    >
      更新 {valid ? formatDatetime(lastUpdate) : '受信待機中…'}
    </div>
  )
}
