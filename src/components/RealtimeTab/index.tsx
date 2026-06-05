// リアルタイムタブの右パネル。強震モニタ画像は地図エリアの KmoniMonitor が担当し、
// ここでは説明・震度スケール凡例・注記を表示する。

const SCALE_LEGEND = [
  { label: '1', color: '#7bb4c8' },
  { label: '2', color: '#0070c8' },
  { label: '3', color: '#00b050' },
  { label: '4', color: '#f5e600' },
  { label: '5弱', color: '#ffa000' },
  { label: '5強', color: '#ff6600' },
  { label: '6弱', color: '#f00000' },
  { label: '6強', color: '#a50021' },
  { label: '7', color: '#9d0099' },
]

export function RealtimeTab() {
  return (
    <div className="p-3 space-y-3">
      <div>
        <h2 className="text-white font-bold text-sm mb-1">リアルタイム震度モニタ</h2>
        <p className="text-secondary text-xs leading-relaxed">
          防災科研の強震モニタ。1秒ごとに更新されます。
        </p>
      </div>

      {/* 震度スケール凡例 */}
      <div className="bg-card rounded-lg p-3 border border-border">
        <p className="text-white text-xs font-bold mb-2">震度スケール</p>
        <div className="flex gap-2 flex-wrap">
          {SCALE_LEGEND.map((item) => (
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

      {/* 注記 */}
      <div className="bg-card rounded-lg p-3 border border-border">
        <p className="text-secondary text-xs leading-relaxed">
          ※ 強震モニタは防災科学技術研究所が提供するリアルタイム地震動観測システムです。
          表示される震度は気象庁震度階に基づく推定値であり、気象庁が発表する震度とは異なる場合があります。
        </p>
      </div>
    </div>
  )
}
