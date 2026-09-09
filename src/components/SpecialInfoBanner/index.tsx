import { useState } from 'react'
import type {
  EarthquakeInfoMeta, JMANankai, JMANankaiCommentary, JMAKohatsu, JMAQuakeNotice, JMAEarthquakeCount,
  TelegramOperationStatus,
} from '../../types/earthquake'
import { EarthquakeCountDetail, earthquakeCountHeadline } from './EarthquakeCountDetail'
import { log } from '../../utils/logger'
import { normalizeDmdataTelegramId } from '../../utils/dmdataId'

interface Props {
  nankai: JMANankai | null
  nankaiCommentary: JMANankaiCommentary | null
  kohatsu: JMAKohatsu | null
  quakeNotice: JMAQuakeNotice | null
  earthquakeCount: JMAEarthquakeCount | null
}

// 閉じた解説情報の電文 id を覚えておくキー。解説情報には解除電文が無く、定例解説は平常時にも
// 毎月届くため、読み終えた帯を手で閉じられるようにしている。リロードで復活しないよう永続化する。
// 保持するのは 1 件だけでよい（表示するのは常に最新の 1 通のみ）。
const COMMENTARY_DISMISSED_KEY = 'nankai-commentary-dismissed'

// 閉じたお知らせ（VZSE40）の電文 id。解説情報と同じ理由で永続化する。取消電文は届くが、
// 「入電停止は明日の 8 時から」のような予告は取り消されないまま期間が過ぎるため、
// 読み終えたら手で閉じられるようにしている。
const NOTICE_DISMISSED_KEY = 'quake-notice-dismissed'

// 閉じた地震回数の情報（VXSE60）の電文 id。群発は日をまたいで続き、そのあいだ報が重なる。
// 読み終えた帯を手で片付けられるようにしている。
//
// **覚えるのは報の id であって群発（`eventId`）ではない。** つまり閉じたあと続報が届けば
// 帯は出直す。続報は回数が増えた**新しい事実**なので、そのつもり —— 群発ごとに閉じたままに
// すると、1704 回が 3000 回になっても黙ることになる。公式サンプルの `NextAdvisory` が
// 次の発表を約 6 時間後としており、出直す頻度もその程度。
const COUNT_DISMISSED_KEY = 'earthquake-count-dismissed'

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

// お知らせ（VZSE40）の印。拡声器。地震そのものではなく「運用のお知らせ」なので、
// 他の 3 枚が使う警告・文書・情報のいずれとも重ならない形にする。
function NoticeIcon() {
  return (
    <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />
    </svg>
  )
}

// 地震回数の印。棒グラフ（数を数えている情報であることを形で示す）。
function CountIcon() {
  return (
    <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
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

export function SpecialInfoBanner({ nankai, nankaiCommentary, kohatsu, quakeNotice, earthquakeCount }: Props) {
  if (!nankai && !nankaiCommentary && !kohatsu && !quakeNotice && !earthquakeCount) return null

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
        {earthquakeCount && <EarthquakeCountBanner count={earthquakeCount} />}
        {/* お知らせ（運用連絡）は最後。上の 4 枚は「いま起きている・起こりうる地震」の話で、
            こちらは観測点の入電停止・配信試験といった裏方の連絡。同時に出たときに
            事象の話を先に読ませる。 */}
        {quakeNotice && <NoticeBanner notice={quakeNotice} />}
      </div>
    </div>
  )
}

/**
 * 南海トラフ・後発地震の帯を開いたときの中身。
 *
 * **3 つの帯（臨時情報・解説情報・後発地震注意情報）で同じものを同じ順に出す。**
 * 別々に書いていたため「解説情報だけが要約を出していて、臨時情報と後発地震は出していない」
 * という食い違いができていた。項目を足すときはここへ足せば 3 つとも揃う。
 *
 * 並びの理由:
 * 1. **要約**（気象庁が書いた一文）—— 本文は 1000 字を超えることがあり、先に結論を置く
 * 2. **本文**
 * 3. **次の情報**（`NextAdvisory`）—— 続報を待つべきかの判断に直結する。**南海トラフだけが持つ**
 *    （後発地震注意情報の電文はこの要素を持たない）。見出しに「今後」「発表」を使わないのは、
 *    直後に来る電文の文が「今後は……発表します」で始まり、同じことを 2 回言って見えるため
 * 4. **この種類の情報について**（`Appendix`）—— 制度の解説。**電文ごとに変わらない固定文**で
 *    長いため畳んでおく。初めてこの情報を受け取る人には要るが、毎報そのまま積むと本文が埋もれる。
 *    「この情報について」ではなく「この種類の」と冠するのは、**今回届いた発表の補足ではなく
 *    制度そのものの説明**だと分かるようにするため
 */
function EarthquakeInfoDetail({ info, footer }: {
  info: EarthquakeInfoMeta & { body: string }
  footer: React.ReactNode
}) {
  const [appendixOpen, setAppendixOpen] = useState(false)
  return (
    <div className="px-3 pb-2">
      {info.summary && (
        <p className="text-white text-xs font-medium leading-relaxed whitespace-pre-wrap mb-1">{info.summary}</p>
      )}
      {info.body && (
        <p className="text-white/90 text-xs leading-relaxed whitespace-pre-wrap mb-1">{info.body}</p>
      )}
      {info.nextAdvisory && (
        <div className="mb-1 border-l-2 border-white/30 pl-2">
          <p className="text-white/60 text-[0.6875rem] font-bold mb-0.5">次の情報</p>
          <p className="text-white/90 text-xs leading-relaxed whitespace-pre-wrap">{info.nextAdvisory}</p>
        </div>
      )}
      {info.appendix && (
        <div className="mb-1">
          <button
            className="text-white/70 hover:text-white text-[0.6875rem] underline decoration-dotted underline-offset-2"
            onClick={() => setAppendixOpen(v => !v)}
          >
            この種類の情報について{appendixOpen ? '（閉じる）' : '（開く）'}
          </button>
          {appendixOpen && (
            <p className="text-white/80 text-[0.6875rem] leading-relaxed whitespace-pre-wrap mt-1">{info.appendix}</p>
          )}
        </div>
      )}
      {footer}
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

/**
 * 電文が自分で名乗っている運用種別（`Control/Status`）の印。訓練・試験のときだけ出す。
 *
 * **バナーで出る種別ほど訓練報の割合が高い。** 実電文を数えたところ、後発地震注意情報は
 * 訓練 5 / 通常 2、南海トラフ臨時情報は訓練 4 / 通常 4 だった（発表頻度が低いぶん、これまでに
 * 配信されたものに占める訓練の割合が大きい）。印が無いと、訓練の「巨大地震注意」が本物と
 * 同じ顔で出る。
 *
 * 本文にも「＊＊＊これは訓練です＊＊＊」と書かれることがあるが、**帯は畳まれていることが多い**
 * ので、開かなくても分かるところに出す。
 */
function OperationStatusBadge({ status }: { status?: TelegramOperationStatus }) {
  if (!status) return null
  return (
    <span
      className="text-xs font-bold px-1.5 py-0.5 rounded flex-shrink-0"
      style={{ backgroundColor: '#1f2937', color: '#fcd34d', border: '1px solid #d97706' }}
    >
      {status}報
    </span>
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
          <OperationStatusBadge status={nankai.operationStatus} />
          <span className="text-white text-sm font-bold leading-tight truncate">{nankai.headline}</span>
        </div>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <EarthquakeInfoDetail info={nankai} footer={
          <p className="text-white/60 text-xs">
            発表: {new Date(nankai.reportDateTime).toLocaleString('ja-JP')}
          </p>
        } />
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
          <OperationStatusBadge status={kohatsu.operationStatus} />
          <span className="text-white text-sm font-bold leading-tight truncate">{kohatsu.headline}</span>
        </div>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <EarthquakeInfoDetail info={kohatsu} footer={
          <p className="text-white/60 text-xs">
            発表: {new Date(kohatsu.reportDateTime).toLocaleString('ja-JP')}
            {' · '}{formatExpire(kohatsu.expireAt)}
          </p>
        } />
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
            <OperationStatusBadge status={commentary.operationStatus} />
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
        <EarthquakeInfoDetail info={commentary} footer={
          <p className="text-white/60 text-xs">
            発表: {new Date(commentary.reportDateTime).toLocaleString('ja-JP')}
          </p>
        } />
      )}
    </div>
  )
}

// 地震・津波に関するお知らせ（VZSE40）の帯。
//
// 中身は観測点の入電停止・配信試験・訓練の予告といった**運用連絡**で、地震そのものの発表ではない。
// そのため色は無彩色（slate）にして、他の 3 枚（黄／橙／赤＝段階の重さ・teal＝南海トラフの解説・
// 青＝後発地震）のどれとも警戒度を取り違えられないようにしている。
//
// 本文は `Body/Text` の自由文ひとつきり。要約も次回発表予定も持たないので `EarthquakeInfoDetail`
// は通さない。**改行と全角スペースをそのまま出す** —— 気象庁は「記」から始まる箇条書きを
// 全角スペースの字下げで組んでおり、詰めると期間や連絡先の対応が崩れる。
//
// 有効期限（発表から 7 日）は出さない。解説情報と同じく帯を常駐させないための表示上の都合で、
// 気象庁が定めた期限ではない。
function NoticeBanner({ notice }: { notice: JMAQuakeNotice }) {
  const [open, setOpen] = useState(false)
  const [dismissedId, setDismissedId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(NOTICE_DISMISSED_KEY)
    } catch (e) {
      log.debug('[quakeNotice] お知らせの既読状態を読めません', e)
      return null
    }
  })

  // 突き合わせる前に書式を揃える（解説情報と同じ理由。→ CommentaryBanner）
  if (dismissedId != null && normalizeDmdataTelegramId(dismissedId) === normalizeDmdataTelegramId(notice.id)) {
    return null
  }

  const dismiss = () => {
    try {
      localStorage.setItem(NOTICE_DISMISSED_KEY, notice.id)
    } catch (e) {
      log.debug('[quakeNotice] お知らせの既読状態を保存できません', e)
    }
    setDismissedId(notice.id)
  }

  return (
    <div className={`bg-slate-800/95 border-t-2 border-slate-400 ${SAFE_BOTTOM}`}>
      {/* 展開トグルと閉じるボタンを横に並べる（button の入れ子は不正な HTML になるため） */}
      <div className="w-full px-3 py-2 flex items-center gap-2">
        <button
          className="min-w-0 flex-1 flex items-center gap-2 text-left"
          onClick={() => setOpen(v => !v)}
        >
          <NoticeIcon />
          <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold text-white px-1.5 py-0.5 rounded bg-slate-500 flex-shrink-0">
              お知らせ
            </span>
            <OperationStatusBadge status={notice.operationStatus} />
            <span className="text-white text-sm font-bold leading-tight truncate">{notice.headline}</span>
          </div>
          <ChevronIcon open={open} />
        </button>
        <button
          className="flex-shrink-0 p-1 text-white/70 hover:text-white"
          onClick={dismiss}
          aria-label="お知らせを閉じる"
        >
          <CloseIcon />
        </button>
      </div>
      {open && (
        <div className="px-3 pb-2">
          {notice.body && (
            <p className="text-white/90 text-xs leading-relaxed whitespace-pre-wrap mb-1">{notice.body}</p>
          )}
          <p className="text-white/60 text-xs">
            発表: {new Date(notice.reportDateTime).toLocaleString('ja-JP')}
          </p>
        </div>
      )}
    </div>
  )
}

// 地震回数に関する情報（VXSE60）の帯。
//
// **タブのカードではなく帯にしている。** 群発は日をまたいで続く「状況」で、地震カードのように
// 1 件ずつ増える「出来事」ではない。しかも群発の最中は小さな地震で揺れ検知が繰り返し発火して
// リアルタイムタブへ画面を持っていくので、地震情報タブへ置くと**いちばん見たいときに見えない**。
// 帯は地図に重ねて出るのでどのタブからも読める。
//
// 色は青緑（cyan）。南海トラフの解説（teal）とは隣り合わないので紛れにくく、
// 段階の重さを表す黄／橙／赤とも、運用連絡の無彩色とも別に見える。
function EarthquakeCountBanner({ count }: { count: JMAEarthquakeCount }) {
  const [open, setOpen] = useState(false)
  const [dismissedId, setDismissedId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(COUNT_DISMISSED_KEY)
    } catch (e) {
      log.debug('[earthquakeCount] 既読状態を読めません', e)
      return null
    }
  })

  // 突き合わせる前に書式を揃える（解説情報と同じ理由。→ CommentaryBanner）
  if (dismissedId != null && normalizeDmdataTelegramId(dismissedId) === normalizeDmdataTelegramId(count.id)) {
    return null
  }

  const dismiss = () => {
    try {
      localStorage.setItem(COUNT_DISMISSED_KEY, count.id)
    } catch (e) {
      log.debug('[earthquakeCount] 既読状態を保存できません', e)
    }
    setDismissedId(count.id)
  }

  return (
    <div className={`bg-cyan-900/95 border-t-2 border-cyan-400 ${SAFE_BOTTOM}`}>
      {/* 展開トグルと閉じるボタンを横に並べる（button の入れ子は不正な HTML になるため） */}
      <div className="w-full px-3 py-2 flex items-center gap-2">
        <button
          className="min-w-0 flex-1 flex items-center gap-2 text-left"
          onClick={() => setOpen(v => !v)}
        >
          <CountIcon />
          <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold text-white px-1.5 py-0.5 rounded bg-cyan-600 flex-shrink-0">
              地震回数
            </span>
            <OperationStatusBadge status={count.operationStatus} />
            {/* **電文の見出しではなく累積の数字を出す。** 電文の見出しは「地震回数に関する情報を
                お知らせします。」で、畳んだままでは何も伝わらない */}
            <span className="text-white text-sm font-bold leading-tight truncate">
              {earthquakeCountHeadline(count)}
            </span>
          </div>
          <ChevronIcon open={open} />
        </button>
        <button
          className="flex-shrink-0 p-1 text-white/70 hover:text-white"
          onClick={dismiss}
          aria-label="地震回数を閉じる"
        >
          <CloseIcon />
        </button>
      </div>
      {open && <EarthquakeCountDetail count={count} />}
      {open && (
        <p className="px-3 pb-2 text-white/60 text-xs">
          発表: {new Date(count.reportDateTime).toLocaleString('ja-JP')}
        </p>
      )}
    </div>
  )
}
