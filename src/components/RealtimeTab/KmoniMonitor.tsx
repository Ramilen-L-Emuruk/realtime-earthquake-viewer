import { useState, useEffect } from 'react'
import { formatKmoniDatetime } from '../../utils/formatters'

const KMONI_BASE = 'https://www.kmoni.bosai.go.jp/webservice/image/rendered/all'

/**
 * 強震モニタ（防災科研）のリアルタイム震度画像を毎秒更新で表示する。
 * 地図エリアいっぱいに表示するため、黒背景に object-contain で中央配置する。
 */
export function KmoniMonitor() {
  const [imgSrc, setImgSrc] = useState('')
  const [currentTime, setCurrentTime] = useState(new Date())
  const [imgError, setImgError] = useState(false)
  // 最初の画像が読み込まれるまでは画像を隠してローディング表示にする
  const [imgLoaded, setImgLoaded] = useState(false)

  useEffect(() => {
    const tick = () => {
      const now = new Date()
      setCurrentTime(now)
      const ts = formatKmoniDatetime(now)
      setImgSrc(`${KMONI_BASE}/${ts}-01.png?_=${now.getTime()}`)
      setImgError(false)
    }

    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="relative h-full w-full bg-black flex items-center justify-center overflow-hidden">
      {imgError ? (
        <div className="flex flex-col items-center justify-center gap-2">
          <p className="text-secondary text-sm">画像を読み込めませんでした</p>
          <p className="text-secondary text-xs">強震モニタへの接続を確認中...</p>
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
              onLoad={() => setImgLoaded(true)}
              onError={() => setImgError(true)}
            />
          )}
        </>
      )}

      {/* 出典・時刻のオーバーレイ */}
      <div className="absolute bottom-1 left-2 right-2 flex items-center justify-between text-[10px] text-secondary pointer-events-none">
        <span>出典: 防災科研 強震モニタ</span>
        <span>{currentTime.toLocaleTimeString('ja-JP')}</span>
      </div>
    </div>
  )
}
