import { useState, useEffect } from 'react'
import { formatKmoniDatetime } from '../../utils/formatters'

const KMONI_BASE = 'https://www.kmoni.bosai.go.jp/webservice/image/rendered/all'

export function RealtimeTab() {
  const [imgSrc, setImgSrc] = useState('')
  const [currentTime, setCurrentTime] = useState(new Date())
  const [imgError, setImgError] = useState(false)

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
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 pt-4 pb-2 flex-shrink-0">
        <h2 className="text-white font-bold text-sm mb-1">リアルタイム震度モニタ</h2>
        <p className="text-secondary text-xs">
          防災科研の強震モニタ。1秒ごとに更新されます。
        </p>
      </div>

      <div className="flex-1 flex flex-col items-center justify-start px-4 pb-4 overflow-y-auto">
        {/* Kmoni image */}
        <div className="w-full max-w-2xl bg-black rounded-lg overflow-hidden border border-border">
          {!imgError ? (
            <img
              src={imgSrc}
              alt="強震モニタ リアルタイム震度"
              className="w-full"
              onError={() => setImgError(true)}
            />
          ) : (
            <div className="h-48 flex flex-col items-center justify-center gap-2">
              <p className="text-secondary text-sm">画像を読み込めませんでした</p>
              <p className="text-secondary text-xs">強震モニタへの接続を確認中...</p>
            </div>
          )}
        </div>

        <div className="w-full max-w-2xl mt-2 flex items-center justify-between text-xs text-secondary">
          <span>出典: 防災科研 強震モニタ</span>
          <span>{currentTime.toLocaleTimeString('ja-JP')}</span>
        </div>

        {/* Color scale legend */}
        <div className="w-full max-w-2xl mt-4 bg-card rounded-lg p-3 border border-border">
          <p className="text-white text-xs font-bold mb-2">震度スケール</p>
          <div className="flex gap-2 flex-wrap">
            {[
              { label: '1', color: '#7bb4c8' },
              { label: '2', color: '#0070c8' },
              { label: '3', color: '#00b050' },
              { label: '4', color: '#f5e600' },
              { label: '5弱', color: '#ffa000' },
              { label: '5強', color: '#ff6600' },
              { label: '6弱', color: '#f00000' },
              { label: '6強', color: '#a50021' },
              { label: '7', color: '#9d0099' },
            ].map(item => (
              <div key={item.label} className="flex items-center gap-1">
                <div
                  className="w-4 h-4 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: item.color }}
                />
                <span className="text-xs text-secondary">{item.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Notes */}
        <div className="w-full max-w-2xl mt-3 bg-card rounded-lg p-3 border border-border">
          <p className="text-secondary text-xs leading-relaxed">
            ※ 強震モニタは防災科学技術研究所が提供するリアルタイム地震動観測システムです。
            表示される震度は気象庁震度階に基づく推定値であり、気象庁が発表する震度とは異なる場合があります。
          </p>
        </div>
      </div>
    </div>
  )
}
