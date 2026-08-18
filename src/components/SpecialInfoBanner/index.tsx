import { useState } from 'react'
import type { JMANankai, JMAKohatsu } from '../../types/earthquake'

interface Props {
  nankai: JMANankai | null
  kohatsu: JMAKohatsu | null
}

function NankaiIcon() {
  return (
    <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
    </svg>
  )
}

function KohatsuIcon() {
  return (
    <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function nankaiColors(kindName: string): { bg: string; border: string; badge: string } {
  if (kindName === '巨大地震警戒') return { bg: 'bg-red-900/95',    border: 'border-red-500',    badge: 'bg-red-500' }
  if (kindName === '巨大地震注意') return { bg: 'bg-orange-900/95', border: 'border-orange-400', badge: 'bg-orange-400' }
  return                                  { bg: 'bg-yellow-900/95', border: 'border-yellow-400', badge: 'bg-yellow-400' }
}

function formatExpire(isoTime: string): string {
  const d = new Date(isoTime)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mn = String(d.getMinutes()).padStart(2, '0')
  return `${mm}/${dd} ${hh}:${mn}まで有効`
}

// 下端の safe-area（ホームインジケータ）を避けるための余白。両バナーの根要素に同じものを付ける。
// **色の付いた箱の内側に置くこと。** 外側のラッパーに置くと帯ごと持ち上がり、下に地図が覗いて
// 隙間に見える。避けたいのは押せる領域と文字であって、背景色は画面下端まで届いてよい。
// last: … 2 枚同時に出うるため、余白が要るのは下端に接する最後の 1 枚だけ。上のバナーにも入れると
//   帯と帯の間に隙間ができる。並び順を JS 側で数えると種類が増えたときに追従漏れを起こすので、
//   :last-child に判定させて実際に最後へ描画された要素だけに効かせる。
// side: … 左右分割時だけ地図が画面全高を占めてバナーが画面下端に接する。縦積み時は地図の下に
//   つまみ・パネル・ナビが続くので下端には届かず、余白を入れると地図の中に不要な隙間ができる
//   （env() は要素の位置に関わらず値を返すため条件が要る）。
const SAFE_BOTTOM = 'side:last:[padding-bottom:env(safe-area-inset-bottom,0px)]'

export function SpecialInfoBanner({ nankai, kohatsu }: Props) {
  if (!nankai && !kohatsu) return null

  return (
    // z-[99999]: 区域集約震度バッジ（QuakeRegionFillGL）は scale（JMA震度階級の数値コード、震度7=70）
    // × 1000 で最大 zIndex 70000 まで積むため、それより確実に高い値にして常に最前面に出す。
    <div className="absolute bottom-0 left-0 right-0 z-[99999] pointer-events-none">
      {/* max-h で高さが制約されるためこの要素自身がスクロール領域になる。overflow-y だけを auto に
          すると overflow-x も auto に格上げされ横スクロールしてしまうため、明示的に塞ぐ。
          単位は vh ではなく dvh。vh は iOS の PWA だとビューポートではなく画面全体の高さを指すため。
          SAFE_BOTTOM の last: がここの直接の子を数えるので、バナー以外をこの中に足さないこと。 */}
      <div className="pointer-events-auto max-h-[40dvh] overflow-y-auto overflow-x-hidden overscroll-x-none">
        {nankai && <NankaiBanner nankai={nankai} />}
        {kohatsu && <KohatsuBanner kohatsu={kohatsu} />}
      </div>
    </div>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-4 h-4 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
      fill="none" viewBox="0 0 24 24" stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  )
}

function NankaiBanner({ nankai }: { nankai: JMANankai }) {
  const [open, setOpen] = useState(false)
  const { bg, border, badge } = nankaiColors(nankai.kindName)

  return (
    <div className={`${bg} border-t-2 ${border} ${SAFE_BOTTOM}`}>
      <button
        className="w-full px-3 py-2 flex items-center gap-2 text-left"
        onClick={() => setOpen(v => !v)}
      >
        <NankaiIcon />
        <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
          <span className={`text-xs font-bold text-white px-1.5 py-0.5 rounded ${badge}`}>
            {nankai.kindName}
          </span>
          <span className="text-white text-sm font-bold leading-tight truncate">{nankai.headline}</span>
        </div>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <div className="px-3 pb-2">
          {nankai.body && (
            <p className="text-white/90 text-xs leading-relaxed whitespace-pre-wrap mb-1">{nankai.body}</p>
          )}
          <p className="text-white/60 text-xs">
            発表: {new Date(nankai.reportDateTime).toLocaleString('ja-JP')}
          </p>
        </div>
      )}
    </div>
  )
}

function KohatsuBanner({ kohatsu }: { kohatsu: JMAKohatsu }) {
  const [open, setOpen] = useState(false)

  return (
    <div className={`bg-blue-900/95 border-t-2 border-blue-400 ${SAFE_BOTTOM}`}>
      <button
        className="w-full px-3 py-2 flex items-center gap-2 text-left"
        onClick={() => setOpen(v => !v)}
      >
        <KohatsuIcon />
        <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold text-white px-1.5 py-0.5 rounded bg-blue-500 flex-shrink-0">
            後発地震注意
          </span>
          <span className="text-white text-sm font-bold leading-tight truncate">{kohatsu.headline}</span>
        </div>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <div className="px-3 pb-2">
          {kohatsu.body && (
            <p className="text-white/90 text-xs leading-relaxed whitespace-pre-wrap mb-1">{kohatsu.body}</p>
          )}
          <p className="text-white/60 text-xs">
            発表: {new Date(kohatsu.reportDateTime).toLocaleString('ja-JP')}
            {' · '}{formatExpire(kohatsu.expireAt)}
          </p>
        </div>
      )}
    </div>
  )
}
