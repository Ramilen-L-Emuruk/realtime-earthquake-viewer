import { useState, useEffect, useRef } from 'react'

const KMONI_BASE = 'http://www.kmoni.bosai.go.jp/data/map_img/RealTimeImg/jma_s'

function buildKmoniUrl(now: Date): string {
  const d = new Date(now.getTime() - 2000)
  const y = d.getFullYear()
  const M = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  const dateStr = `${y}${M}${day}`
  const tsStr = `${dateStr}${h}${m}${s}`
  return `${KMONI_BASE}/${dateStr}/${tsStr}.jma_s.gif`
}

export function KmoniMonitor() {
  const [imgSrc, setImgSrc] = useState('')
  const [currentTime, setCurrentTime] = useState(new Date())
  const [imgLoaded, setImgLoaded] = useState(false)
  const [showError, setShowError] = useState(false)
  const loadedRef = useRef(false)

  useEffect(() => {
    const tick = () => {
      const now = new Date()
      setCurrentTime(now)
      setImgSrc(buildKmoniUrl(now))
    }

    tick()
    const id = setInterval(tick, 1000)

    // 10秒以内に1枚も表示されなければエラー表示（onError はリクエストキャンセル時に発火しないため）
    const timeout = setTimeout(() => {
      if (!loadedRef.current) setShowError(true)
    }, 10_000)

    return () => {
      clearInterval(id)
      clearTimeout(timeout)
    }
  }, [])

  return (
    <div className="relative h-full w-full bg-black flex items-center justify-center overflow-hidden">
      {showError ? (
        <div className="flex flex-col items-center justify-center gap-2">
          <p className="text-secondary text-sm">画像を読み込めませんでした</p>
          <p className="text-secondary text-xs">強震モニタサーバーへの接続を確認しています</p>
        </div>
      ) : (
        <>
          {!imgLoaded && (
            <div className="flex flex-col items-center justify-center gap-2">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-secondary text-xs">強震モニタを読み込み中...</p>
            </div>
          )}
          {imgSrc && (
            <img
              src={imgSrc}
              alt="強震モニタ リアルタイム震度"
              className={`max-h-full max-w-full object-contain ${imgLoaded ? 'block' : 'hidden'}`}
              onLoad={() => {
                loadedRef.current = true
                setImgLoaded(true)
                setShowError(false)
              }}
              onError={() => {
                // リクエストキャンセル時は発火しないため、エラー判定は timeout に委ねる
              }}
            />
          )}
        </>
      )}

      <div className="absolute bottom-1 left-2 right-2 flex items-center justify-between text-[10px] text-secondary pointer-events-none">
        <span>出典: 防災科研 強震モニタ</span>
        <span>{currentTime.toLocaleTimeString('ja-JP')}</span>
      </div>
    </div>
  )
}
