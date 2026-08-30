import { memo } from 'react'
import type { HypocenterIndex } from '../../utils/hypocenterCatalog'
import {
  catalogCompleteness,
  DEPTH_RAMP_MAX_KM,
  MAGNITUDE_RAMP_RANGE,
  type CatalogColorBy,
  type CatalogFilter,
  type CatalogSizeBy,
  formatMissingYears,
  type CatalogViewOptions,
} from '../../utils/hypocenterCatalogView'

// 長期震源カタログの操作パネル。**描くのは地図の担当**で、ここは条件を決めるだけ。
// 点群への変換は utils/hypocenterCatalogView.ts、描画は components/Map/HypocenterCatalogGL.tsx。

interface Props {
  index: HypocenterIndex | null
  filter: CatalogFilter
  onFilterChange: (next: CatalogFilter) => void
  view: CatalogViewOptions
  onViewChange: (next: CatalogViewOptions) => void
  /** いま地図に出ている点の数。 */
  pointCount: number
  loading: boolean
  error: string | null
  /** 取得できなかった年（昇順）。空でなければ件数はそのぶん少ない。 */
  missingYears: number[]
  onRetry: () => void
}


const COLOR_BY_LABEL: Record<CatalogColorBy, string> = {
  depth: '深さ',
  magnitude: 'マグニチュード',
  time: '発生年',
}

const SIZE_BY_LABEL: Record<CatalogSizeBy, string> = {
  fixed: '一定',
  magnitude: 'マグニチュードに比例',
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-card rounded-lg border border-border overflow-hidden mb-3">
      <div className="px-4 py-2.5 bg-panel border-b border-border">
        <h2 className="text-white text-sm font-bold">{title}</h2>
      </div>
      <div className="divide-y divide-border">{children}</div>
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 grow basis-32">
        <p className="text-white text-sm">{label}</p>
        {hint && <p className="text-secondary text-xs mt-0.5">{hint}</p>}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  )
}

const SELECT_CLASS =
  'bg-panel border border-border text-white text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500'

export const CatalogTab = memo(function CatalogTab({
  index,
  filter,
  onFilterChange,
  view,
  onViewChange,
  pointCount,
  loading,
  error,
  missingYears,
  onRetry,
}: Props) {
  const years = index?.years ?? []
  const completeness = index ? catalogCompleteness(index, filter) : null

  return (
    <div className="p-3">
      <Section title="期間">
        <Row label="開始" hint="期間を変えると、その期間で網羅されている下限にマグニチュードを合わせます">
          <select
            value={filter.fromYear}
            disabled={years.length === 0}
            onChange={(e) => {
              const v = Number(e.target.value)
              // 深さのスライダーと同じく押し合う。開始が終了を追い越した状態を作らせない
              // （作れてしまうと、完全性の判定と実際に読む年がずれる）。
              onFilterChange({ ...filter, fromYear: v, toYear: Math.max(v, filter.toYear) })
            }}
            className={SELECT_CLASS}
          >
            {years.map((y) => (
              <option key={y} value={y}>{y}年</option>
            ))}
          </select>
        </Row>
        <Row label="終了" hint="開始より前の年を選ぶと開始も動き、マグニチュードの下限を合わせ直します">
          <select
            value={filter.toYear}
            disabled={years.length === 0}
            onChange={(e) => {
              const v = Number(e.target.value)
              onFilterChange({ ...filter, toYear: v, fromYear: Math.min(v, filter.fromYear) })
            }}
            className={SELECT_CLASS}
          >
            {years.map((y) => (
              <option key={y} value={y}>{y}年</option>
            ))}
          </select>
        </Row>
      </Section>

      <Section title="絞り込み">
        <Row label="マグニチュード下限" hint={`M ${filter.minMagnitude.toFixed(1)} 以上`}>
          <input
            type="range"
            min={index?.minMagnitude ?? MAGNITUDE_RAMP_RANGE.min}
            max={MAGNITUDE_RAMP_RANGE.max}
            step={0.1}
            value={filter.minMagnitude}
            onChange={(e) => onFilterChange({ ...filter, minMagnitude: Number(e.target.value) })}
            className="w-32"
          />
        </Row>
        <Row label="深さの下限" hint={`${filter.minDepthKm} km 以深`}>
          <input
            type="range"
            min={0}
            max={DEPTH_RAMP_MAX_KM}
            step={10}
            value={filter.minDepthKm}
            onChange={(e) => {
              const v = Number(e.target.value)
              // 下限が上限を追い越すと 1 点も残らない。追い越したら上限を押し上げる。
              onFilterChange({ ...filter, minDepthKm: v, maxDepthKm: Math.max(v, filter.maxDepthKm) })
            }}
            className="w-32"
          />
        </Row>
        <Row label="深さの上限" hint={`${filter.maxDepthKm} km 以浅`}>
          <input
            type="range"
            min={0}
            max={DEPTH_RAMP_MAX_KM}
            step={10}
            value={filter.maxDepthKm}
            onChange={(e) => {
              const v = Number(e.target.value)
              onFilterChange({ ...filter, maxDepthKm: v, minDepthKm: Math.min(v, filter.minDepthKm) })
            }}
            className="w-32"
          />
        </Row>
      </Section>

      <Section title="見せ方">
        <Row label="色分け">
          <select
            value={view.colorBy}
            onChange={(e) => onViewChange({ ...view, colorBy: e.target.value as CatalogColorBy })}
            className={SELECT_CLASS}
          >
            {(Object.keys(COLOR_BY_LABEL) as CatalogColorBy[]).map((k) => (
              <option key={k} value={k}>{COLOR_BY_LABEL[k]}</option>
            ))}
          </select>
        </Row>
        <Row label="点の大きさ">
          <select
            value={view.sizeBy}
            onChange={(e) => onViewChange({ ...view, sizeBy: e.target.value as CatalogSizeBy })}
            className={SELECT_CLASS}
          >
            {(Object.keys(SIZE_BY_LABEL) as CatalogSizeBy[]).map((k) => (
              <option key={k} value={k}>{SIZE_BY_LABEL[k]}</option>
            ))}
          </select>
        </Row>
        <Row label="点の基準サイズ" hint={`${view.sizePx.toFixed(1)} px`}>
          <input
            type="range"
            min={1}
            max={8}
            step={0.5}
            value={view.sizePx}
            onChange={(e) => onViewChange({ ...view, sizePx: Number(e.target.value) })}
            className="w-32"
          />
        </Row>
      </Section>

      <Section title="表示中">
        <Row label="件数" hint={loading ? '読み込み中' : undefined}>
          <span className="text-white text-sm tabular-nums">{pointCount.toLocaleString()} 件</span>
        </Row>
      </Section>

      {(error || missingYears.length > 0) && (
        <div className="px-1 mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-xs text-red-400">
            {error ?? `${formatMissingYears(missingYears)} 年を取得できませんでした。件数はそのぶん少なく出ています。`}
          </p>
          <button
            onClick={onRetry}
            className="text-xs text-white bg-panel border border-border rounded px-2 py-1 hover:border-blue-500"
          >
            再試行
          </button>
        </div>
      )}

      {completeness?.belowComplete && (
        <p className="text-xs text-yellow-400 px-1 mb-3">
          {Math.min(filter.fromYear, filter.toYear)} 年からの期間で取りこぼしが無いのは M {completeness.completeMin.toFixed(1)} 以上です。
          それより小さい地震は古い年ほど記録に残っておらず、少なく見えます。
        </p>
      )}

      {index && (
        <p className="text-xs text-secondary px-1">
          出典: {index.source}（{index.license}）
        </p>
      )}
    </div>
  )
})
