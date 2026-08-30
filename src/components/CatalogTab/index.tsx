import { memo } from 'react'
import { YearRangeSlider } from './YearRangeSlider'
import { Toggle } from '../Toggle'
import type { HypocenterIndex } from '../../utils/hypocenterCatalog'
import {
  catalogCompleteness,
  DEPTH_FILTER_MAX_KM,
  depthBoundLabel,
  MAGNITUDE_FILTER_RANGE,
  type CatalogColorBy,
  type CatalogFilter,
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
  /**
   * 絞り込みを変えた直後で、件数と点群がまだ追いついていないか。
   *
   * **これが無いと「効いていない」と誤解される。** ラベルは即座に変わるのに件数は遅れて動くため、
   * 何も出さないと変更が無視されたように見える（期間以外のスライダーでは `loading` も立たない）。
   */
  pending: boolean
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
  pending,
  error,
  missingYears,
  onRetry,
}: Props) {
  const years = index?.years ?? []
  // **収録の両端をスライダーの端にする。** 索引が来るまでは選んでいる値をそのまま端にして
  // おく（つまみが範囲外に置かれると、ブラウザが勝手に丸めて値が飛ぶ）。
  const firstYear = years[0] ?? filter.fromYear
  const lastYear = years[years.length - 1] ?? filter.toYear
  const completeness = index ? catalogCompleteness(index, filter) : null

  return (
    <div className="p-3">
      <Section title="期間">
        <div className="px-4 py-3">
          <div className="flex items-baseline justify-between mb-1">
            <p className="text-white text-sm tabular-nums">
              {filter.fromYear}年 〜 {filter.toYear}年
            </p>
            <p className="text-secondary text-xs tabular-nums">{filter.toYear - filter.fromYear + 1}年ぶん</p>
          </div>
          <YearRangeSlider
            label="期間"
            min={firstYear}
            max={lastYear}
            from={filter.fromYear}
            to={filter.toYear}
            disabled={years.length === 0}
            onChange={(fromYear, toYear) => onFilterChange({ ...filter, fromYear, toYear })}
          />
          <p className="text-secondary text-xs mt-1">
            古い側の年を変えると、その期間で網羅されている下限にマグニチュードを合わせます
          </p>
        </div>
      </Section>

      <Section title="絞り込み">
        <Row label="マグニチュード下限" hint={`M ${filter.minMagnitude.toFixed(1)} 以上`}>
          <input
            type="range"
            min={index?.minMagnitude ?? MAGNITUDE_FILTER_RANGE.min}
            max={MAGNITUDE_FILTER_RANGE.max}
            step={0.1}
            value={filter.minMagnitude}
            onChange={(e) => onFilterChange({ ...filter, minMagnitude: Number(e.target.value) })}
            className="w-32"
          />
        </Row>
        <Row label="深さの下限" hint={depthBoundLabel(filter.minDepthKm, 'min')}>
          <input
            type="range"
            min={0}
            max={DEPTH_FILTER_MAX_KM}
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
        <Row label="深さの上限" hint={depthBoundLabel(filter.maxDepthKm, 'max')}>
          <input
            type="range"
            min={0}
            max={DEPTH_FILTER_MAX_KM}
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
        <Row label="強調表示" hint="マグニチュードが大きいほど点を大きくします（下の基準サイズに対して、M3 で 0.6 倍・M9 で 4.2 倍）">
          <Toggle
            label="強調表示"
            checked={view.sizeBy === 'magnitude'}
            onChange={(v) => onViewChange({ ...view, sizeBy: v ? 'magnitude' : 'fixed' })}
          />
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
        <Row label="件数" hint={loading ? '読み込み中' : pending ? '更新中' : undefined}>
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
