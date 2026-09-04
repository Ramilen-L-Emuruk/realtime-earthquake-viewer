import { useState } from 'react'
import type { JMANankai, JMANankaiCommentary, JMAKohatsu } from '../../types/earthquake'
import { log } from '../../utils/logger'
import { normalizeDmdataTelegramId } from '../../utils/dmdataId'

interface Props {
  nankai: JMANankai | null
  nankaiCommentary: JMANankaiCommentary | null
  kohatsu: JMAKohatsu | null
}

// 閉じた解説情報の電文 id を覚えておくキー。解説情報には解除電文が無く、定例解説は平常時にも
// 毎月届くため、読み終えた帯を手で閉じられるようにしている。リロードで復活しないよう永続化する。
// 保持するのは 1 件だけでよい（表示するのは常に最新の 1 通のみ）。
const COMMENTARY_DISMISSED_KEY = 'nankai-commentary-dismissed'

function NankaiIcon() {
  return (
    <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
    </svg>
  )
}

function CommentaryIcon() {
  return (
    <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
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

export function SpecialInfoBanner({ nankai, nankaiCommentary, kohatsu }: Props) {
  if (!nankai && !nankaiCommentary && !kohatsu) return null

  return (
    // z-[99999]: 区域集約震度バッジ（QuakeRegionFillGL）は scale（JMA震度階級の数値コード、震度7=70）
    // × 1000 で最大 zIndex 70000 まで積むため、それより確実に高い値にして常に最前面に出す。
    <div className="absolute bottom-0 left-0 right-0 z-[99999] pointer-events-none">
      {/* max-h で高さが制約されるためこの要素自身がスクロール領域になる。overflow-y だけを auto に
          すると overflow-x も auto に格上げされ横スクロールしてしまうため、明示的に塞ぐ。
          単位は vh ではなく dvh。vh は iOS の PWA だとビューポートではなく画面全体の高さを指すため。
          SAFE_BOTTOM の last: がここの直接の子を数えるので、バナー以外をこの中に足さないこと。 */}
      <div className="pointer-events-auto max-h-[40dvh] overflow-y-auto overflow-x-hidden overscroll-x-none">
        {/* 南海トラフの 2 枚（臨時情報とその解説情報）を隣り合わせる。臨時情報の発表期間中は
            解説情報が毎日届いて両方が同時に出るため、間に別の事象（後発地震＝北海道・三陸沖）を
            挟むと同じ事象の話が分断されて読みにくい。重さの順よりこちらを優先する。 */}
        {nankai && <NankaiBanner nankai={nankai} />}
        {nankaiCommentary && <CommentaryBanner commentary={nankaiCommentary} />}
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

// 南海トラフ地震関連解説情報の帯。
//
// 臨時情報（NankaiBanner）とは色もバッジも分けている。あちらの黄／橙／赤は段階の重さを表すが、
// 解説情報は段階を持たないため、警戒度を読み取られない情報色（teal）にしている。
//
// 有効期限は出さない。内部では発表から 7 日で畳んでいるが、それは帯を常駐させないための
// 表示上の都合であって、気象庁が期限を定めているわけではない（後発地震注意情報の 7 日とは違う）。
function CommentaryBanner({ commentary }: { commentary: JMANankaiCommentary }) {
  const [open, setOpen] = useState(false)
  // 閉じた電文 id。マウント時に一度だけ読む。別の解説情報に入れ替わっても id が違うので
  // 下の判定を通り、新しい電文はきちんと表示される。
  const [dismissedId, setDismissedId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(COMMENTARY_DISMISSED_KEY)
    } catch (e) {
      log.debug('[nankai] 解説情報の既読状態を読めません', e)
      return null
    }
  })

  // 突き合わせる前に書式を揃える。保存されている id は閉じた当時のもので、
  // 電文 id の書式を変えた版へ更新すると素の比較では外れる（＝閉じた帯が復活する）。
  if (dismissedId != null && normalizeDmdataTelegramId(dismissedId) === normalizeDmdataTelegramId(commentary.id)) {
    return null
  }

  const dismiss = () => {
    // 永続化できない環境（プライベートモード等・容量超過）でも、この場で閉じる動作は止めない。
    // ただし黙って諦めると「閉じてもリロードで復活する」問い合わせを追跡できないため記録する。
    try {
      localStorage.setItem(COMMENTARY_DISMISSED_KEY, commentary.id)
    } catch (e) {
      log.debug('[nankai] 解説情報の既読状態を保存できません', e)
    }
    setDismissedId(commentary.id)
  }

  return (
    <div className={`bg-teal-900/95 border-t-2 border-teal-400 ${SAFE_BOTTOM}`}>
      {/* 展開トグルと閉じるボタンを横に並べる。button の入れ子は不正な HTML になるため、
          他の帯のように全体を 1 つの button で覆うことはできない */}
      <div className="w-full px-3 py-2 flex items-center gap-2">
        <button
          className="min-w-0 flex-1 flex items-center gap-2 text-left"
          onClick={() => setOpen(v => !v)}
        >
          <CommentaryIcon />
          <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold text-white px-1.5 py-0.5 rounded bg-teal-500 flex-shrink-0">
              {commentary.serialName}
            </span>
            <span className="text-white text-sm font-bold leading-tight truncate">{commentary.headline}</span>
          </div>
          <ChevronIcon open={open} />
        </button>
        <button
          className="flex-shrink-0 p-1 text-white/70 hover:text-white"
          onClick={dismiss}
          aria-label="解説情報を閉じる"
        >
          <CloseIcon />
        </button>
      </div>
      {open && (
        <div className="px-3 pb-2">
          {commentary.summary && (
            <p className="text-white text-xs font-medium leading-relaxed whitespace-pre-wrap mb-1">{commentary.summary}</p>
          )}
          {commentary.body && (
            <p className="text-white/90 text-xs leading-relaxed whitespace-pre-wrap mb-1">{commentary.body}</p>
          )}
          <p className="text-white/60 text-xs">
            発表: {new Date(commentary.reportDateTime).toLocaleString('ja-JP')}
          </p>
        </div>
      )}
    </div>
  )
}
