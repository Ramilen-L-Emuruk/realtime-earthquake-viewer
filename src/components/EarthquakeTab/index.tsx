import { memo, useLayoutEffect, useRef } from 'react'
import type { JMAQuake, JMALpgm, JMAEstimatedIntensity } from '../../types/earthquake'
import { EarthquakeCard } from './EarthquakeCard'
import { extractQuakeEventId, quakeEventKey } from '../../utils/quakeMerge'
import type { SeismoQuakeWave } from '../../hooks/useSeismoQuakeWaves'
import { lpgmMarkKey, type QuakeCardMarks } from '../../utils/quakeUpdateMark'
import { estimatedIntensityFor } from '../../utils/estimatedIntensity'
import type { LatLng } from '../../utils/stationCoords'
import { quakeCardScrollTarget, QUAKE_CARD_KEY_ATTR } from '../../utils/quakeCardScroll'
import { planFollowScroll } from '../../utils/ttsFollow'
import {
  type TelegramLoss, formatHistoryLossNotice, HISTORY_LOAD_MORE_FAILED_NOTICE,
  formatRateLimitedNotice, FETCH_THROTTLED_NOTICE,
} from '../../utils/telegramLoss'

interface Props {
  earthquakes: JMAQuake[]
  selectedId: string | null
  /**
   * いま読み上げが語っている地震の鍵（`quakeEventKey`。語っていなければ null）。
   * 読み上げが有効なあいだ、一覧はこのカードへ寄せる（→ `utils/quakeCardScroll.ts`）。
   */
  speakingKey: string | null
  /** 読み上げが有効か。無効なら、受信した時点で寄せる（→ `utils/quakeCardScroll.ts`）。 */
  followSpeech: boolean
  onSelect: (id: string) => void
  isLoading: boolean
  isLoadingMore: boolean
  hasMore: boolean
  onLoadMore: () => void
  error: string | null
  /**
   * 履歴取得で確定した損失。**カードが 1 件も無いときも出す** —— 出さないと
   * 「7 日のうち 6 日が落ちて 0 件」が「まったく静かな期間だった」と同じ画になる。
   */
  historyLoss: TelegramLoss
  /** 直近の「もっと見る」がまるごと失敗したか（押し直せば回復しうる側）。 */
  loadMoreFailed: boolean
  /**
   * いま配信元の上限に達していて、取得が待たされているか（→ `hooks/useFetchThrottled.ts`）。
   *
   * **損失ではない。** 枠が空けばそのまま取りに行くので、欠けは出ない。
   */
  fetchThrottled: boolean
  lpgmByEventId: ReadonlyMap<string, JMALpgm>
  /**
   * カードの更新の印。鍵は地震が `quakeEventKey`、長周期が {@link lpgmMarkKey}。
   * **同じ入れ物に入っているので、引くときは鍵の作り方を間違えないこと。**
   */
  updateMarks: ReadonlyMap<string, QuakeCardMarks>
  activeLpgmEventId: string | null
  onToggleLpgm: (eventId: string) => void
  /**
   * アプリが持っている推計震度分布図（IXAC41・地震ごとに 1 通）。どのカードのものかは
   * ここで引き当て、カードへはその地震の 1 通だけを渡す（→ `EarthquakeCard` の同名の props）。
   */
  estimatedIntensities: readonly JMAEstimatedIntensity[]
  /** 震度分布モードを開いている地震の `eventKey`。 */
  distributionQuakeKey: string | null
  onToggleDistribution: (eventKey: string) => void
  /** 未入電の一覧を開いている地震の `eventKey`。 */
  unreceivedQuakeKey: string | null
  onToggleUnreceived: (eventKey: string) => void
  /** 一覧の行をクリックしたときに、その場所へ地図を寄せる（1 点でも範囲でも）。 */
  onFocusMap: (positions: LatLng[]) => void
  /**
   * いま気象庁が書いた文を読み上げている主題（読んでいなければ null）。
   * 長周期の補足を読み上げているあいだ、そのカードの補足を開く。
   *
   * **任意にしない。** 渡し忘れても画面が動かないだけで例外もログも出ないので、
   * 型検査で止める唯一の機会がここ（→ audio-tts-spec.md §6）。
   */
  speakingTelegramTextSubject: string | null
  /**
   * 地震の鍵ごとの、自作地震計から読み返した合成波形（→ `hooks/useSeismoQuakeWaves`）。
   *
   * **鍵は `quakeEventKey`。** 選択・印と同じものを使う ——別の鍵で持つと、
   * 同じ分に起きた別の地震で片方のカードへ他方の波形が出る。
   */
  seismoWaves: ReadonlyMap<string, readonly SeismoQuakeWave[]>
}

/**
 * 履歴について知らせる帯。
 *
 * **全画面のエラー表示（`error`）とは分ける。** あちらは 1 件も取れなかったときのもので、
 * こちらは取れた分のカードを覆ってはいけない。
 *
 * **色は 2 通り。**
 *
 * | `tone` | 意味 | 色 |
 * |---|---|---|
 * | `loss` | **何かが欠けている。** 生成データの取得失敗（`MapDataStatus`）と揃える | 琥珀 |
 * | `info` | **欠けていない。** いま待っているだけで、放っておけば取れる | 青 |
 *
 * **待ちを琥珀で出さないこと。** あれは損失の色で、並べると「取りこぼした」と読まれる。
 */
function HistoryNotice({ tone, children }: { tone: 'loss' | 'info'; children: React.ReactNode }) {
  const color = tone === 'info'
    ? 'border-sky-500/40 bg-sky-500/10 text-sky-300'
    : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
  return (
    <div className={`rounded-lg border px-2 py-1.5 text-xs roomy:text-sm roomy:px-3 roomy:py-2 ${color}`}>
      {children}
    </div>
  )
}

/** 縦にスクロールする最も近い祖先（タブごとの枠。`App.tsx` の `TAB_SCROLLER_CLASS`）。 */
function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflowY = getComputedStyle(p).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return p
  }
  return null
}

/**
 * 寄せる相手のカードを、一覧の枠の中で見える位置へ寄せる（→ docs/spec/quake-spec.md §8「一覧の寄せ方」）。
 *
 * **寄せるのは合図（`signature`）が変わったときだけ。** 相手が替わった・相手へ続報が届いた・
 * 取消が付いた、のいずれか。利用者がスクロールして読んでいる位置を、関係のない更新で動かさない。
 *
 * **寄せる量は津波カードの追従と同じ `planFollowScroll` が決める。** 収まっていれば動かさず、
 * 外れていればカードの頭を枠の上端から余白を取って揃え、枠より高いカードは頭に揃える。
 * 以前の `scrollIntoView({ block: 'nearest' })` は、枠より高いカードに対して「上端揃え・
 * 下端揃え・何もしない」のどれになるかが直前の位置で変わり、余白も取らずに縁を切っていた。
 *
 * **寄せられなかった合図は持ち越す。** 一覧がまだ描かれていない（読み込み中）・枠の高さが 0
 * （パネルを畳んでいる）ときは何もせず、次に描かれたときにやり直す。タブが隠れているだけなら
 * （`invisible`）寸法は保たれているので、その場で寄せる。
 */
function useQuakeCardScroll(
  listRef: React.RefObject<HTMLDivElement | null>,
  target: { key: string; signature: string } | null,
): void {
  const appliedRef = useRef<string | null>(null)
  // 見張りのコールバックから最新の相手を読むため（レンダーごとに書き換える）。
  const targetRef = useRef(target)
  targetRef.current = target
  const observerRef = useRef<{ observer: ResizeObserver; scroller: HTMLElement } | null>(null)

  // 寄せを試みる。寄せられない回（一覧が無い・枠の高さが 0・カード要素が無い）は合図を書かずに返す。
  const tryApply = useRef(() => {
    const t = targetRef.current
    if (!t || appliedRef.current === t.signature) return
    const list = listRef.current
    if (!list) return
    const scroller = scrollParentOf(list)
    if (!scroller) return
    // **枠の寸法の変化を見張る。** パネルの開閉・比率の変更は CSS 変数だけで起き、この一覧を
    // 描き直さない（props が変わらないので memo が止める）。描き直しを待つ形だと、畳んでいる間に
    // 届いた取消へ、開き直しても寄らない（津波タブと同じ穴。あちらも ResizeObserver で塞いでいる）。
    // 見張りを持たない環境（テストの jsdom）では張らない。そのときは描き直しのたびに拾い直すだけになる。
    if (typeof ResizeObserver === 'function' && observerRef.current?.scroller !== scroller) {
      observerRef.current?.observer.disconnect()
      const observer = new ResizeObserver(() => tryApply.current())
      observer.observe(scroller)
      observerRef.current = { observer, scroller }
    }
    if (scroller.clientHeight <= 0) return
    const card = list.querySelector<HTMLElement>(`[${QUAKE_CARD_KEY_ATTR}="${CSS.escape(t.key)}"]`)
    if (!card) return
    appliedRef.current = t.signature
    const view = scroller.getBoundingClientRect()
    const rect = card.getBoundingClientRect()
    const next = planFollowScroll({
      viewTop: view.top,
      viewBottom: view.top + scroller.clientHeight,
      currentRects: [{ top: rect.top, bottom: rect.bottom }],
      upcomingRects: [],
      currentScrollTop: scroller.scrollTop,
      maxScrollTop: scroller.scrollHeight - scroller.clientHeight,
    })
    if (next !== null) scroller.scrollTo({ top: next, behavior: 'smooth' })
  })

  // 依存を持たせない: 寄せられなかった合図を、次のレンダーでも拾い直すため（判定は軽い）。
  useLayoutEffect(() => { tryApply.current() })
  useLayoutEffect(() => () => { observerRef.current?.observer.disconnect() }, [])
}

// 地震情報タブの右パネル。地震カードの一覧を表示し、クリックで地図表示対象を選択する。
// 地図そのものは App が常時表示する。
// React.memo 化の理由と props 参照安定性の要件は docs/spec/architecture-spec.md 参照。
export const EarthquakeTab = memo(function EarthquakeTab({ earthquakes, selectedId, speakingKey, followSpeech, onSelect, isLoading, isLoadingMore, hasMore, onLoadMore, error, historyLoss, loadMoreFailed, fetchThrottled, lpgmByEventId, updateMarks, activeLpgmEventId, onToggleLpgm, estimatedIntensities, distributionQuakeKey, onToggleDistribution, unreceivedQuakeKey, onToggleUnreceived, onFocusMap, speakingTelegramTextSubject, seismoWaves }: Props) {
  // **早期 return より前に置く**（フックの数を回ごとに変えないため）。一覧が無い回は寄せずに持ち越す。
  const listRef = useRef<HTMLDivElement>(null)
  useQuakeCardScroll(listRef, quakeCardScrollTarget({ earthquakes, selectedKey: selectedId, speakingKey, followSpeech }))
  // 履歴について知らせる帯。**4 つを別に持つ**（確定した損失／429 で見送った分／押し直せば
  // 回復しうる失敗／いま待っているだけ）。混ぜると、戻せない損失と戻せるものが同じ重さに見える。
  //
  // **待っているだけの告知は最後・青で出す。** 上の 3 つは「何かが欠けた・失敗した」だが、
  // これは欠けていない（枠が空けばそのまま取りに行く）。
  const notices: Array<{ text: string; tone: 'loss' | 'info' }> = [
    formatHistoryLossNotice(historyLoss),
    formatRateLimitedNotice(historyLoss),
    loadMoreFailed ? HISTORY_LOAD_MORE_FAILED_NOTICE : null,
  ].filter((t): t is string => t !== null).map(text => ({ text, tone: 'loss' as const }))
  if (fetchThrottled) notices.push({ text: FETCH_THROTTLED_NOTICE, tone: 'info' })
  // **1 件も無いときだけ読み込み中の画面にする。**
  // DMDSS 版は日ごとにアーカイブを読むので、全件が揃うのは数秒後になる
  // （→ `docs/spec/data-sources-spec.md` §2「窓ごとの上限を守る」）。取得側は
  // 取れた分から順に流しているので、`isLoading` だけで覆うと**その間ずっとスピナーのままになり、
  // 逐次に出す仕組みが画面へ一度も現れない**。
  if (isLoading && earthquakes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-secondary text-sm">データを取得中...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <div className="text-center">
          <p className="text-red-400 text-sm mb-2">データの取得に失敗しました</p>
          <p className="text-secondary text-xs">{error}</p>
        </div>
      </div>
    )
  }

  if (earthquakes.length === 0) {
    return (
      <div className="flex flex-col h-full">
        {notices.length > 0 && (
          <div className="p-2 space-y-1.5 roomy:p-3 roomy:space-y-2">
            {notices.map(n => <HistoryNotice key={n.text} tone={n.tone}>{n.text}</HistoryNotice>)}
          </div>
        )}
        <div className="flex-1 flex items-center justify-center">
          <p className="text-secondary text-sm">地震情報はありません</p>
        </div>
      </div>
    )
  }

  return (
    <div ref={listRef} className="p-2 space-y-1.5 roomy:p-3 roomy:space-y-2">
      {notices.map(n => <HistoryNotice key={n.text} tone={n.tone}>{n.text}</HistoryNotice>)}
      {earthquakes.map((quake, i) => (
        <EarthquakeCard
          // QUAKE-4: 続報で id 末尾の serial が変わるたびに EarthquakeCard がリマウントされ、
          // isSelected の副作用（強制スクロール）が発火してユーザー操作を妨害する。
          // eventKey は続報でも変わらないため、React の key・選択判定の両方をこれで安定させる
          // （どちらも quakeEventKey に統一。earthquake.time は同じ分に起きた別の地震と衝突する）。
          key={quakeEventKey(quake)}
          quake={quake}
          isLatest={i === 0}
          isSelected={quakeEventKey(quake) === selectedId}
          // **包まずにそのまま渡す。** ここで包むと毎レンダー新しい関数になり、
          // `EarthquakeCard` の memo が素通りする（地震の鍵はカード側で作る）。
          onSelect={onSelect}
          lpgm={lpgmByEventId.get(extractQuakeEventId(quake) ?? '')}
          marks={updateMarks.get(quakeEventKey(quake))}
          lpgmMarks={updateMarks.get(lpgmMarkKey(extractQuakeEventId(quake) ?? ''))}
          activeLpgmEventId={activeLpgmEventId}
          onToggleLpgm={onToggleLpgm}
          estimatedIntensity={estimatedIntensityFor(quake, estimatedIntensities)}
          distributionActive={quakeEventKey(quake) === distributionQuakeKey}
          onToggleDistribution={onToggleDistribution}
          unreceivedActive={quakeEventKey(quake) === unreceivedQuakeKey}
          onToggleUnreceived={onToggleUnreceived}
          onFocusMap={onFocusMap}
          speakingTelegramTextSubject={speakingTelegramTextSubject}
          seismoWaves={seismoWaves.get(quakeEventKey(quake))}
        />
      ))}
      {hasMore && (
        <button
          onClick={onLoadMore}
          disabled={isLoadingMore}
          className="w-full py-2.5 text-sm text-secondary hover:text-white bg-card border border-border hover:border-blue-600 rounded-lg transition-colors disabled:opacity-50"
        >
          {isLoadingMore ? '取得中…' : 'もっと見る'}
        </button>
      )}
      {!hasMore && earthquakes.length > 0 && (
        // 「すべての履歴」とは書かない。**止まる理由はバリアントで違う**（`useEarthquakes` の
        // `hasMore` の決め方 2 箇所）。DMDSS 版は遡れる日数の上限に達したときで、それより古い
        // 地震が無いことを意味しない（アーカイブは実測で 135 日以上残る）。標準版は配信元の
        // 応答が要求件数を下回ったとき＝その窓を使い切ったとき。
        // どちらも「これ以上は遡れない」ことは共通なので、文言は 1 つで足りる。
        <p className="text-center text-xs text-secondary py-2">これ以上は遡れません</p>
      )}
    </div>
  )
})
