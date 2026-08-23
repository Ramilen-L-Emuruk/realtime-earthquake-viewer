import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import type { EewEpicenter } from '../../hooks/useEewLayerData'
import { getIntensityColor, getIntensityLabelWithOrAbove } from '../../utils/intensity'
import { formatMagnitude, formatDepth } from '../../utils/formatters'
import { attachMarkerClaim, type PopupHandle } from './gl/popupRegistry'
import { badgeHtml, escapeHtml } from './gl/popupHtml'

// EEW（緊急地震速報）の震源(×印・点滅)を描画する MapLibre 版（Leaflet 版 JapanMap の
// EEW 震源マーカー相当）。全モードで表示し、リアルタイム震度モード以外は半透明にする。
// 複数 EEW 時は全震源を表示する。
// 仮定震源要素（単独観測点処理）の震源は控えめに描いて確定震源と区別する
// （予報円を出さない・カードで M/深さを隠すのと同じ扱いを地図にも与える）。
// 区別は「不透明度を下げる」だけでなく「点滅の振幅を浅くする」ことでも付ける。
// Marker の不透明度と点滅アニメーションは乗算されるため、下げるだけでは
// 点滅の谷で消えてしまい「たまに薄く見える」状態になる（下記 CSS クラスの出し分け）。
//
// クリックで震源名・第何報・M・深さ・予想最大震度・警報種別を出す（地震情報の震源マーカーと対）。
//
// 震源 id をキーに差分更新する。特に fullOpacity（モード切替由来）だけが変わったときに
// 全マーカーを作り直すと、EEW発報中にタブを切り替えるだけで震源×印が一瞬消えてしまうため、
// opacity だけの変化は marker.setOpacity() で済ませ、マーカー自体は作り直さない。

/**
 * 仮定震源要素の×印の不透明度倍率。確定震源より控えめにするが、点滅
 * （`eew-blink-assumed`・谷 0.45）と乗算されるため下げすぎない。
 * kyoshin モードではこちらが採られる（1 × 0.7）。
 */
const ASSUMED_OPACITY_RATIO = 0.7
/**
 * 同・下限。**地震/津波モードでは実質こちらが採用される**（元が 0.4 なので倍率だけだと
 * 0.28 まで落ち、点滅の谷と掛かって 0.13 になる）。このモードでは確定震源との差を
 * 不透明度ではなく点滅の振幅で付ける。
 */
const ASSUMED_OPACITY_MIN = 0.35
/** kyoshin モード以外の×印の不透明度。 */
const DIMMED_OPACITY = 0.4

/**
 * ×印に渡す不透明度。`fullOpacity` は kyoshin モードかどうか（それ以外は半透明）。
 * 点滅アニメーション（`eew-blink` / `eew-blink-assumed`）の opacity と**乗算される**ので、
 * 実際の見え方はこの値そのものではない。積の関係は `EewEpicentersGL.test.ts` が固定している。
 *
 * 仮定震源が確定震源より薄いのは**濃い側だけ**。確定は谷が深いため（1 → 0.1／0.4 → 0.04）、
 * **点滅の谷ではどのモードでも仮定の方が濃くなる**（kyoshin 0.315 対 0.1／他 0.158 対 0.04）。
 * 逆転を消すには、**この 2 軸（不透明度・点滅の振幅）の中では**仮定を「谷で消える」ところまで
 * 戻すしかない。意図した引き換えとして扱っている。線の色や太さで差を付ければ逆転を避けつつ
 * 視認性も保てるが、現状は採っていない（区別は不透明度と点滅だけで付ける方針）。
 */
export function crossOpacity(isAssumed: boolean, fullOpacity: boolean): number {
  const base = fullOpacity ? 1 : DIMMED_OPACITY
  return isAssumed ? Math.max(base * ASSUMED_OPACITY_RATIO, ASSUMED_OPACITY_MIN) : base
}

interface Props {
  epicenters: EewEpicenter[]
  iconScale: number
  /** リアルタイム震度モードのとき不透明、それ以外は半透明（0.4）。 */
  fullOpacity: boolean
}

// 不透明度はここでは設定しない。element の style.opacity は Marker 自身が
// （地形に隠れたときの制御のため）毎フレーム上書きするので、Marker のオプションで渡す。
// style.cssText の丸ごと代入は Marker がポジショニングに使う transform を消してしまうため、
// 更新時は個別プロパティだけ触る。
function updateCrossEl(el: HTMLDivElement, iconScale: number, isAssumed: boolean): void {
  const s = Math.round(32 * iconScale)
  el.style.width = `${s}px`
  el.style.height = `${s}px`
  el.style.cursor = 'pointer'
  if (isAssumed) el.title = '震源未確定（単独観測点処理）'
  else el.removeAttribute('title')
  // eew-blink クラスで点滅（Leaflet 版 getEpicenterIcon(blink=true) と同じ CSS）。
  // 仮定震源要素は振幅の浅い eew-blink-assumed を使う（Marker 側の不透明度と乗算されても谷で消えない）。
  const blinkClass = isAssumed ? 'eew-blink-assumed' : 'eew-blink'
  el.innerHTML =
    `<svg viewBox="0 0 32 32" width="${s}" height="${s}" class="${blinkClass}" xmlns="http://www.w3.org/2000/svg">` +
    `<line x1="4" y1="4" x2="28" y2="28" stroke="#ff2222" stroke-width="4" stroke-linecap="round"/>` +
    `<line x1="28" y1="4" x2="4" y2="28" stroke="#ff2222" stroke-width="4" stroke-linecap="round"/></svg>`
}

function buildCrossEl(iconScale: number, isAssumed: boolean): HTMLDivElement {
  const el = document.createElement('div')
  updateCrossEl(el, iconScale, isAssumed)
  return el
}

function buildPopupHtml(ep: EewEpicenter): string {
  const isWarning = ep.severity === 'Warning'
  const kindColor = isWarning ? '#f87171' : '#fbbf24'
  // 予報級の電文は VXSE45「緊急地震速報（地震動予報）」。表示も実態に合わせる
  const kind = isWarning ? '警報' : '地震動予報'
  // 報番号は電文由来。最終報なら第N報より「最終報」の方が状態が伝わる。
  const serialText = ep.isFinal ? '最終報' : ep.serial ? `第${escapeHtml(ep.serial)}報` : ''
  // 単独観測点処理の初期報は震源が確定していない。数値を鵜呑みにしないよう明示する
  // （×印を薄く描く判定と同じ isAssumed を使い、判定を二重に持たない）。
  const provisional = ep.isAssumed
  const scaleLabel = getIntensityLabelWithOrAbove(ep.maxScale, ep.maxScaleOrAbove)
  return (
    `<div style="min-width:170px">` +
    `<div style="display:flex;align-items:baseline;gap:8px">` +
    `<span style="font-weight:700;font-size:13px">${escapeHtml(ep.name)}</span>` +
    (serialText ? `<span style="font-size:11px;color:#94a3b8">${serialText}</span>` : '') +
    `</div>` +
    // EEW-6: 仮定震源要素（単独観測点処理）は M・深さが未確定なので数値を隠す。
    // カード表示（RealtimeTab の EEWCard）と同じ扱いにする。
    `<div style="margin-top:2px;font-size:11px;color:#94a3b8">` +
    (provisional
      ? '震源調査中'
      : `${escapeHtml(formatMagnitude(ep.magnitude))} / 深さ ${escapeHtml(formatDepth(ep.depth))}`) +
    `</div>` +
    `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px">` +
    // 上限が定まらない報は「4以上」と出す。値だけにすると下限を断定した表示になる
    // （語を出す箇所の一覧は docs/spec/eew-spec.md §4）。
    `${badgeHtml(scaleLabel, getIntensityColor(ep.maxScale))}` +
    `<span style="color:#cbd5e1;white-space:nowrap">予想最大震度 ${escapeHtml(scaleLabel)}</span>` +
    `<span style="color:${kindColor};font-weight:700;white-space:nowrap">${kind}</span></div>` +
    (provisional
      ? `<div style="margin-top:4px;font-size:11px;color:#fbbf24">仮定震源要素（単独観測点処理・震源未確定）</div>`
      : '') +
    `</div>`
  )
}

interface EpicenterEntry {
  marker: maplibregl.Marker
  popup: maplibregl.Popup
  claim: PopupHandle
  isAssumed: boolean
}

export function EewEpicentersGL({ epicenters, iconScale, fullOpacity }: Props) {
  const map = useMapGL()
  const entriesRef = useRef<Map<string, EpicenterEntry>>(new Map())
  // 最新の fullOpacity を ref で持ち、下の主 effect（fullOpacity を deps に含めない）から
  // 新規マーカー生成時の初期 opacity 計算に使う。
  const fullOpacityRef = useRef(fullOpacity)
  fullOpacityRef.current = fullOpacity

  const opacityFor = (isAssumed: boolean): string =>
    String(crossOpacity(isAssumed, fullOpacityRef.current))

  // 震源一覧・アイコン倍率の変化で差分更新する。fullOpacity はここでは扱わない
  // （下の別 effect で marker.setOpacity() のみ行う）。
  useEffect(() => {
    if (!map) return
    const entries = entriesRef.current
    const seen = new Set<string>()
    for (const ep of epicenters) {
      seen.add(ep.id)
      const existing = entries.get(ep.id)
      // isAssumed（確定/未確定）が変わらない限り、位置・見た目・ポップアップだけ更新して使い回す。
      if (existing && existing.isAssumed === ep.isAssumed) {
        const el = existing.marker.getElement() as HTMLDivElement
        updateCrossEl(el, iconScale, ep.isAssumed)
        existing.marker.setLngLat([ep.position[1], ep.position[0]])
        existing.marker.setOpacity(opacityFor(ep.isAssumed))
        existing.popup.setHTML(buildPopupHtml(ep)).setOffset(Math.round(32 * iconScale) * 0.4)
        continue
      }
      if (existing) {
        existing.claim.remove()
        existing.marker.remove()
        entries.delete(ep.id)
      }
      const el = buildCrossEl(iconScale, ep.isAssumed)
      // maxWidth は既定（240px）だと 1 行に「バッジ・予想最大震度・区分」を並べたとき折り返す
      // （「予想最大震度 4以上」＋「地震動予報」で溢れる）。区域塗りのポップアップ
      // （gl/popupRegistry.ts の clickPopup）と同じ 280px に揃える。
      const popup = new maplibregl.Popup({
        closeButton: true,
        offset: Math.round(32 * iconScale) * 0.4,
        maxWidth: '280px',
      }).setHTML(buildPopupHtml(ep))
      // opacityWhenCovered は指定しない。このアプリは terrain（3D地形）を使っておらず
      // 「覆われたとき」が起きないため効果が無い一方、指定すると Marker がオクルージョン判定の
      // 経路に入り、ポップアップのクリックが効かなくなる（外すと開くことを実測で確認）。
      const marker = new maplibregl.Marker({ element: el, opacity: opacityFor(ep.isAssumed) })
        .setLngLat([ep.position[1], ep.position[0]])
        .setPopup(popup)
        .addTo(map)
      const claim = attachMarkerClaim(map, el)
      entries.set(ep.id, { marker, popup, claim, isAssumed: ep.isAssumed })
    }
    for (const [id, entry] of entries) {
      if (seen.has(id)) continue
      entry.claim.remove()
      entry.marker.remove()
      entries.delete(id)
    }
  }, [map, epicenters, iconScale])

  // fullOpacity（モード切替由来）だけの変化は setOpacity のみで反映し、マーカーは作り直さない。
  useEffect(() => {
    for (const entry of entriesRef.current.values()) {
      entry.marker.setOpacity(opacityFor(entry.isAssumed))
    }
    // opacityFor は fullOpacityRef 経由で最新値を読むだけの純関数的ヘルパーなので deps には不要。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullOpacity])

  useEffect(() => {
    const entries = entriesRef.current
    return () => {
      for (const entry of entries.values()) {
        entry.claim.remove()
        entry.marker.remove()
      }
      entries.clear()
    }
  }, [map])

  return null
}
