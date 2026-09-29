// 自作地震計（`seismo-host/`）の観測点の震度を、地図の左上へ重ねる。
//
// **観測点 1 つにつき 1 行の帯。** 周りに並ぶもの（更新時刻・取得状況）がどれも 1 行なので、
// ここだけ段を積むと浮く。見出し（「自作地震計」）は置かず、**観測点名と出どころが
// 気象庁の発表でないことを示す**（「自宅」「合成」は電文には現れない語）。
//
// **押せない**（`pointer-events-none`）。地図のレイヤーは作らず、座標も使わない。
// 重ね位置（absolute・z-index・セーフエリア）は App.tsx 側の地図左上ラッパーが持つ。

import type { SeismoStationState } from '../../hooks/useSeismoStation'
import { readableTextColor } from '../../utils/contrast'

import { seismoOverlayRows } from './seismoOverlayRows'

interface Props {
  readonly stations: readonly SeismoStationState[]
}

/** 帯 1 本ぶんの見た目。**周りの帯（`MapUpdateTime` ほか）と揃える。** */
const ROW_CLASS =
  'bg-black/80 rounded text-sm px-2 py-0.5 roomy:text-xl roomy:px-2.5 roomy:py-1' +
  ' pointer-events-none flex items-center gap-1.5 roomy:gap-2'

/** 震度バッジ。**行の高さを変えない**よう `leading-none` で詰める。 */
const BADGE_CLASS = 'font-bold leading-none rounded px-1.5 py-1 min-w-[1.25rem] text-center'

export function SeismoOverlay({ stations }: Props) {
  const rows = seismoOverlayRows(stations)
  // **震度が 1 件も届いていなければ出さない。** 接続の状態では判定しない ——
  // 短い切断なら状態層が 5 秒は値を保つので消えず、長い切断なら消える。
  // ここで別に接続を見ると、同じ事実に判定が 2 つできる。
  //
  // 空の帯を常駐させないのも同じ理由。「揺れていない」と「繋がっていない」が
  // 見分けられなくなる（繋がらない理由は設定タブの 1 行が受け持つ）。
  if (rows.length === 0) return null

  return (
    <>
      {rows.map((row) => (
        <div key={row.stationId} className={ROW_CLASS}>
          {row.gradeLabel !== null && row.gradeColor !== null ? (
            <span
              className={BADGE_CLASS}
              style={{ background: row.gradeColor, color: readableTextColor(row.gradeColor) }}
            >
              {row.gradeLabel}
            </span>
          ) : (
            <span className={`${BADGE_CLASS} bg-neutral-700 text-secondary`}>—</span>
          )}
          {/* **観測点名だけ幅を切る。** 名前は利用者が管理コンソールで自由に付けるので、
              長いものを入れると右上（更新時刻）と横で当たる —— どちらも絶対配置で
              押し合わないため、重なると両方読めなくなる。 */}
          <span className="text-white truncate max-w-[8rem] roomy:max-w-[14rem]">
            {row.displayName}
          </span>
          <span className="font-mono text-white tabular-nums">{row.valueText ?? '—'}</span>
          <span className="text-xs text-secondary roomy:text-base">{row.sourceText}</span>
        </div>
      ))}
    </>
  )
}
