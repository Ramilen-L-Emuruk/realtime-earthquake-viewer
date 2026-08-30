import { memo } from 'react'
import { RangeSlider } from '../RangeSlider'
import { Toggle } from '../Toggle'
import { DescriptionTip } from '../DescriptionTip'
import type { HypocenterIndex } from '../../utils/hypocenterCatalog'
import {
  catalogCompleteness,
  DEPTH_FILTER_MAX_KM,
  depthBoundLabel,
  MAGNITUDE_FILTER_RANGE,
  magnitudeBoundLabel,
  LATITUDE_FILTER_RANGE,
  LONGITUDE_FILTER_RANGE,
  latBoundLabel,
  lngBoundLabel,
  type CatalogColorBy,
  type CatalogFilter,
  formatMissingYears,
  rangeLabel,
  type CatalogViewOptions,
} from '../../utils/hypocenterCatalogView'

// 長期震源カタログの操作パネル。**描くのは地図の担当**で、ここは条件を決めるだけ。
// 点群への変換は utils/hypocenterCatalogView.ts、描画は components/Map/HypocenterCatalogGL.tsx。
//
// 絞り込みは 5 つとも**二つまみのスライダー 1 本**（期間・マグニチュード・深さ・緯度・経度。
// `RangeSlider`）。上下を別の行に分けると、どちらが範囲のどちら側か読み取りづらく、いま選んでいる
// 幅も見えない。**緯度・経度・深さの 3 つで直方体を切り出せる。**
// 説明文は常時表示せず、ラベルをホバー・タップしたときに出す（設定タブと同じ `DescriptionTip`）。

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

/** 左にラベル・右にコントロールの行。説明文はラベルをホバー・タップしたときだけ出す。 */
function Row({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    // data-settings-row は説明の吹き出しが基準にする矩形の目印（`DescriptionTip` 参照）。
    <div data-settings-row className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 grow basis-32">
        {description
          ? <DescriptionTip label={label} description={description} />
          : <p className="text-white text-sm">{label}</p>}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  )
}

/**
 * スライダー 1 本ぶんの行。**ラベルの右に、いま選んでいる範囲を出す。**
 *
 * つまみを見ただけでは値が読めないので、数値は常に出す（説明文だけがホバーへ隠れる）。
 */
function RangeRow({
  label,
  description,
  valueText,
  children,
}: {
  label: string
  description: string
  valueText: string
  children: React.ReactNode
}) {
  return (
    <div data-settings-row className="px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <DescriptionTip label={label} description={description} />
        <p className="text-secondary text-xs tabular-nums">{valueText}</p>
      </div>
      <div className="mt-1">{children}</div>
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
      <Section title="絞り込み">
        <RangeRow
          label="期間"
          description="表示する年の範囲です。古い側の年を変えると、その期間で網羅されている下限にマグニチュードを合わせます（観測網が疎だった時代は小さい地震が記録に残っていないため）"
          valueText={`${filter.fromYear}年 〜 ${filter.toYear}年（${filter.toYear - filter.fromYear + 1}年ぶん）`}
        >
          <RangeSlider
            label="期間"
            ends={['開始', '終了']}
            min={firstYear}
            max={lastYear}
            step={1}
            from={filter.fromYear}
            to={filter.toYear}
            disabled={years.length === 0}
            onChange={(fromYear, toYear) => onFilterChange({ ...filter, fromYear, toYear })}
          />
        </RangeRow>

        <RangeRow
          label="マグニチュード"
          description="表示する規模の範囲です。端に置くとその側の制限を外します。期間の古い側を昔へ動かすと、その期間で記録に残っている下限まで自動で引き上がります"
          valueText={rangeLabel(
            magnitudeBoundLabel(filter.minMagnitude, 'min'),
            magnitudeBoundLabel(filter.maxMagnitude, 'max'),
          )}
        >
          <RangeSlider
            label="マグニチュード"
            min={MAGNITUDE_FILTER_RANGE.min}
            max={MAGNITUDE_FILTER_RANGE.max}
            step={0.1}
            from={filter.minMagnitude}
            to={filter.maxMagnitude}
            onChange={(minMagnitude, maxMagnitude) => onFilterChange({ ...filter, minMagnitude, maxMagnitude })}
          />
        </RangeRow>

        <RangeRow
          label="深さ"
          description="表示する震源の深さの範囲です。端に置くとその側の制限を外します"
          valueText={rangeLabel(depthBoundLabel(filter.minDepthKm, 'min'), depthBoundLabel(filter.maxDepthKm, 'max'))}
        >
          <RangeSlider
            label="深さ"
            min={0}
            max={DEPTH_FILTER_MAX_KM}
            step={10}
            from={filter.minDepthKm}
            to={filter.maxDepthKm}
            onChange={(minDepthKm, maxDepthKm) => onFilterChange({ ...filter, minDepthKm, maxDepthKm })}
          />
        </RangeRow>

        <RangeRow
          label="緯度"
          description="表示する南北の範囲です。経度・深さと合わせて、直方体で切り出せます。端に置くとその側の制限を外します"
          valueText={rangeLabel(latBoundLabel(filter.minLat, 'min'), latBoundLabel(filter.maxLat, 'max'))}
        >
          <RangeSlider
            label="緯度"
            min={LATITUDE_FILTER_RANGE.min}
            max={LATITUDE_FILTER_RANGE.max}
            step={0.5}
            from={filter.minLat}
            to={filter.maxLat}
            onChange={(minLat, maxLat) => onFilterChange({ ...filter, minLat, maxLat })}
          />
        </RangeRow>

        <RangeRow
          label="経度"
          description="表示する東西の範囲です。端に置くとその側の制限を外します"
          valueText={rangeLabel(lngBoundLabel(filter.minLng, 'min'), lngBoundLabel(filter.maxLng, 'max'))}
        >
          <RangeSlider
            label="経度"
            min={LONGITUDE_FILTER_RANGE.min}
            max={LONGITUDE_FILTER_RANGE.max}
            step={0.5}
            from={filter.minLng}
            to={filter.maxLng}
            onChange={(minLng, maxLng) => onFilterChange({ ...filter, minLng, maxLng })}
          />
        </RangeRow>
      </Section>

      <Section title="見せ方">
        <Row label="色分け" description="点の色を何で決めるかです。深さは浅いほど暖色、マグニチュードは大きいほど暖色、発生年は新しいほど明るくなります">
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
        <Row label="強調表示" description="マグニチュードが大きいほど点を大きくします。下の基準サイズに対して、M3 で 0.6 倍・M9 で 4.2 倍です">
          <Toggle
            label="強調表示"
            checked={view.sizeBy === 'magnitude'}
            onChange={(v) => onViewChange({ ...view, sizeBy: v ? 'magnitude' : 'fixed' })}
          />
        </Row>
        <Row label="点の基準サイズ" description="点の直径です。強調表示がオンのときは、この大きさに倍率が掛かります">
          {/* **値は隠さない。** 隠してよいのは説明文だけ（スライダーを見ても px は読めない）。 */}
          <span className="text-secondary text-xs tabular-nums">{view.sizePx.toFixed(1)} px</span>
          <input
            type="range"
            aria-label="点の基準サイズ"
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
        <Row
          label="件数"
          description={
            loading ? '年ごとのデータを取得しています'
              : pending ? '絞り込みを変えた直後です。数えなおしが終わると入れ替わります'
                : '地図に出ている点の数です'
          }
        >
          <span className="text-white text-sm tabular-nums">{pointCount.toLocaleString()} 件</span>
          {(loading || pending) && (
            <span className="text-secondary text-xs">{loading ? '読み込み中' : '更新中'}</span>
          )}
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
