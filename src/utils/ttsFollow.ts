/**
 * 読み上げに合わせてカードを追従させるための計算。
 *
 * 2 つの役割を持つ。どちらも DOM に触らない純関数で、呼び出し側（`TsunamiTab`）が
 * 矩形の採取とスクロールの実行を担う（テスト環境の jsdom はレイアウトを持たないため）。
 *
 * 1. **いま読んでいる箇所を知る** — 読み上げ文を組むときに「この語はどの区域・観測点を
 *    指すか」を一緒に持たせておき（{@link SpeechSegment}）、チャンクごとに引き当てる
 *    （{@link mapChunksToRefs}）。
 * 2. **どれだけ動かすかを決める** — 視野内なら動かさず、外に出たときだけ、これから読む
 *    箇所も併せて視野に入る位置へ送る（{@link planFollowScroll}）。
 *
 * **名前の文字列照合は使わない。** 津波予報区 69 件と観測点 213 件のあいだには包含関係が
 * 37 組あり（観測点⊂観測点 18・観測点⊂区域 16・区域⊂観測点 3）、「清水 ⊂ 土佐清水」の
 * ようにオフセット一致もある。さらに読み上げが使う区域名は観測情報の `districtName`、
 * カードの行は `area.name` で、`matchesArea` が code を優先して照合していることからも
 * 両者が食い違う経路が想定されている。文面を組む側で参照を持たせればどちらも起きない。
 */

import { log } from './logger'

/**
 * 読み上げの語が指す対象。
 *
 * 用途は 2 つあり、**どの対象がどちらに使われるかは決まっている**。
 *
 * | 種別 | 用途 |
 * |---|---|
 * | `grade` / `area` / `station` | 津波カードの行を引く（追従スクロール） |
 * | `quakeRegion` / `quakeFact` | 地震情報で「実際に声になった内容」を記録する（続報の差分） |
 *
 * `grade` は等級のカードそのもの（「大津波警報」「津波警報」の見出し）を指す。等級を言った
 * 時点でそのカードの頭に合わせられるようにするためで、区域名を読み始める前に画面が整う。
 *
 * 地震側の 2 つは画面を動かさない。**追従を始めるかどうかの判定には
 * {@link hasFollowTarget} を使うこと**（`refs` が空でないことで判定すると、地震情報の
 * 読み上げが津波カードの追従を起動する）。
 */
export type SpeechRef =
  | { kind: 'grade'; grade: string }
  | { kind: 'area'; code?: string; name: string }
  | { kind: 'station'; name: string }
  | { kind: 'quakeRegion'; name: string; scale: number }
  | { kind: 'quakeFact'; fact: QuakeFact; value: string }

/**
 * 地震情報が伝える「震度の地域以外の事実」。続報で変化したものだけを読むための単位。
 * 値そのものではなく何についての事実かを表すので、`magnitude` は 7.4 でも 7.6 でも同じキー。
 */
export type QuakeFact = 'hypocenterName' | 'magnitude' | 'depth' | 'domesticTsunami'

/**
 * 読み上げ文の断片と、その断片が指す対象。
 * 断片を順に連結したものが読み上げ文になる（{@link joinSegments}）。
 */
export interface SpeechSegment {
  text: string
  refs: SpeechRef[]
}

/** 参照を持たない断片を作る（定型文・助詞など）。 */
export function plain(text: string): SpeechSegment {
  return { text, refs: [] }
}

/** 断片を連結して読み上げ文にする。 */
export function joinSegments(segments: readonly SpeechSegment[]): string {
  return segments.map(s => s.text).join('')
}

/** 同一の対象を指す参照か。 */
function sameRef(a: SpeechRef, b: SpeechRef): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'grade' && b.kind === 'grade') return a.grade === b.grade
  if (a.kind === 'area' && b.kind === 'area') {
    if (a.code && b.code) return a.code === b.code
    return a.name === b.name
  }
  if (a.kind === 'station' && b.kind === 'station') return a.name === b.name
  // 地震の区域は震度も含めて比べる。同じ区域を別の階級で挙げることは 1 つの文の中では
  // 起きないが、名前だけで同一とみなすと将来そうなったときに階級の低い側へ丸められる。
  if (a.kind === 'quakeRegion' && b.kind === 'quakeRegion') return a.name === b.name && a.scale === b.scale
  if (a.kind === 'quakeFact' && b.kind === 'quakeFact') return a.fact === b.fact && a.value === b.value
  return false
}

/**
 * 追従（カードのスクロール）の対象になる参照を含むか。
 *
 * 対象は津波カードの行を引ける 3 種だけ。地震情報の参照（`quakeRegion` / `quakeFact`）は
 * 「声になったか」の記録用で、引き当てるカードを持たない。**`refs.length > 0` で判定しては
 * いけない**——地震情報の読み上げが津波カードの追従セッションを起こし、区域名が偶然一致した
 * 行を掴んで画面を動かす。
 */
export function hasFollowTarget(segments: readonly SpeechSegment[] | undefined): boolean {
  return segments?.some(s => s.refs.some(r => r.kind === 'grade' || r.kind === 'area' || r.kind === 'station')) ?? false
}

/**
 * 読み上げのチャンク（`splitIntoChunks` の結果）ごとに、そのチャンクが指す対象を返す。
 * 戻り値の長さは `chunks` と同じで、対象を持たないチャンクは空配列になる。
 *
 * チャンクの位置は全文からの検索で確定する。`splitIntoChunks` は分割後に trim するため、
 * 断片の文字数を単純に積み上げても境界が合わない。
 *
 * **種類が混ざったチャンクでは、より具体的な対象だけを返す**（観測点 ＞ 区域 ＞ 等級）。
 * 5 文字未満のチャンクを前と結合する規則（`MIN_CHUNK`）により「岩手県、宮古で1.2メートル、」
 * のような形が生まれるが、カード上の区域行は観測点の行を内側に抱えていて背が高い。両方を
 * 対象にすると範囲が視野の高さを超えて {@link planFollowScroll} が区域の先頭へ揃え直すだけに
 * なり、読んでいる観測点が画面に出てこない。等級のカードは区域行をすべて抱えているので、
 * 同じ理由で区域より優先度が低い。
 */
export function mapChunksToRefs(
  segments: readonly SpeechSegment[],
  chunks: readonly string[],
): SpeechRef[][] {
  const full = joinSegments(segments)

  // 断片の文字範囲（全文に対する [start, end)）を先に求める
  const spans: { start: number; end: number; refs: SpeechRef[] }[] = []
  let offset = 0
  for (const seg of segments) {
    spans.push({ start: offset, end: offset + seg.text.length, refs: seg.refs })
    offset += seg.text.length
  }

  const result: SpeechRef[][] = []
  let cursor = 0
  for (const chunk of chunks) {
    const start = full.indexOf(chunk, cursor)
    if (start < 0) {
      // 全文に無いチャンク（呼び出し側が別の文面を渡した）。取り違えるより空で返す。
      // ここに来ると以降のチャンクも `cursor` が進まないまま探すことになり、追従が丸ごと
      // 沈黙する。症状（画面が動かない）からは原因を切り分けられないので記録を残す。
      log.warn('[ttsFollow] 読み上げ文に無いチャンクを渡された（追従を見送る）', { chunk })
      result.push([])
      continue
    }
    const end = start + chunk.length
    cursor = end

    const refs: SpeechRef[] = []
    for (const span of spans) {
      if (span.end <= start || span.start >= end) continue
      for (const ref of span.refs) {
        if (!refs.some(r => sameRef(r, ref))) refs.push(ref)
      }
    }

    const stations = refs.filter(r => r.kind === 'station')
    const areas = refs.filter(r => r.kind === 'area')
    result.push(stations.length > 0 ? stations : areas.length > 0 ? areas : refs)
  }
  return result
}

/**
 * 予約したチャンクのうち、**実際に声になった**ものの添字を返す。
 *
 * 読み上げは割り込まれる（`speakWithVoicevox` は入口で既存の再生を止める）。合成は再生より
 * 先へ進むので、**予約が通ったことは鳴ったことを意味しない** ―― 長い文では全チャンクの予約が
 * 済んだ数秒後まで音は序盤を鳴らしている。予約時刻（`startAt`）を読み上げ終了時点の時計と
 * 比べることで、どこまで音になったかが分かる。
 *
 * **鳴り始めた最後のチャンクは数えない**（完走した場合を除く）。そのチャンクは途中で切られた
 * 可能性があり、区域名を言い終えたか判らない。数えないことの代償は「次の続報で 1 地域を
 * 読み直す」だけで、逆に数えてしまうと**その地域は二度と読まれない**。
 *
 * @param scheduled 予約の通知（`ChunkScheduledListener`）で受け取った添字と開始時刻
 * @param chunkCount チャンクの総数。最後まで鳴ったかの判定に使う
 * @param clock 読み上げが終わった時点の再生時計（`getSpeechClock`）。null なら何も鳴っていない
 */
export function spokenChunkIndices(
  scheduled: readonly { index: number; startAt: number }[],
  chunkCount: number,
  clock: number | null,
): number[] {
  // 時計が無い＝AudioContext が作られていない（合成が全滅した・VOICEVOX 未起動）。
  if (clock === null) return []
  const started = scheduled.filter(s => s.startAt <= clock).map(s => s.index)
  if (started.length === 0) return []
  const last = Math.max(...started)
  // 最後のチャンクが鳴り始めていれば完走とみなす（読み上げの完了は最終チャンクの再生終了で
  // 解決するため）。それ以外は、鳴り始めた最後の 1 つを落とす。
  if (last === chunkCount - 1) return started
  return started.filter(i => i !== last)
}

/**
 * 進行中の読み上げ 1 本ぶんの状態。
 *
 * **`chunks` と `schedule` は後から書き足される**（voicevox から予約の通知が届くたび）。
 * チャンクの境界ごとに React の状態を更新すると App から全タブが再描画されるため
 * （非表示タブの描画を 0 回に保つ設計。docs/spec/architecture-spec.md）、状態の更新は
 * 読み上げの開始と終了だけにして、途中の通知はこのオブジェクトへ直接積む。
 */
export interface SpeechFollowSession {
  readonly token: number
  readonly segments: SpeechSegment[]
  /** チャンク列。最初の予約通知で決まる（それまでは null） */
  chunks: readonly string[] | null
  /** 予約表。届いた順に積む。`index` は連番にならない（合成に失敗した分が欠ける） */
  schedule: { index: number; startAt: number }[]
}

/**
 * 読み上げの進行を画面へ伝える受け口。読み上げを出す側（`useLiveEventHandler`）が呼び、
 * 追従する側（`TsunamiTab`）が中身を用意する。
 *
 * **世代トークンを添えるのは、後始末が別の読み上げを消さないため。** 同じタブへの読み上げが
 * 続けて起きると、後の発話の最初の通知が前の発話の `end` より先に届きうる（先行合成が
 * 済んでいると割り込み側が即座に鳴り始める一方、割り込まれた側は完了を待っている）。
 * トークンが一致するときだけ状態を触る。
 */
export interface SpeechFollowApi {
  /** 読み上げを始める。以降の通知に添える世代トークンを返す */
  begin: (segments: SpeechSegment[]) => number
  /** チャンクの再生が予約された（`startAt` は AudioContext の時間軸） */
  schedule: (token: number, index: number, startAt: number, chunks: readonly string[]) => void
  /** 読み上げが終わった、または取り下げられた */
  end: (token: number) => void
  /**
   * 世代を問わず追従を打ち切る。
   *
   * リプレイの開始・切替で使う。**表示データが丸ごと入れ替わるのに、進行中の読み上げは
   * 止まらない**（`resetTracking` は予約の取り消しと参照のクリアだけで、鳴っている音は
   * 止めない）。追従だけを残すと、古い読み上げのチャンク進行に合わせて無関係なカードを
   * 動かし続けることになる。区域名や観測点名が新旧で重なれば、実在する別の行を掴む。
   */
  reset: () => void
}

/** {@link createSpeechFollowController} が返すもの。 */
export interface SpeechFollowController extends SpeechFollowApi {
  /** いま追従すべきセッション（無ければ null）。React の状態とは別に同期して読める */
  readonly current: SpeechFollowSession | null
}

/**
 * 追従セッションの世代管理。
 *
 * React から切り離してあるのは、**世代の取り違えがテストでしか捕まらない**ため。
 * 読み上げが続けて起きると、後の発話の最初の通知が前の発話の終了より先に届きうる
 * （割り込む側は先行合成が済んでいれば即座に鳴り出す一方、割り込まれた側はまだ完了を
 * 待っている）。`speakWithVoicevox` は割り込み時に完了を即座に解決して戻るので、
 * 呼び出し側の `await` の解決順も保証されない。
 *
 * @param onSessionChange セッションが変わったときに呼ばれる（React の状態更新に繋ぐ）。
 *   **開始と終了でしか呼ばない**。チャンクごとに呼ぶと全タブが再描画される。
 */
export function createSpeechFollowController(
  onSessionChange: (session: SpeechFollowSession | null) => void,
): SpeechFollowController {
  let token = 0
  let current: SpeechFollowSession | null = null

  const clear = () => {
    if (current === null) return
    current = null
    onSessionChange(null)
  }

  return {
    get current() { return current },
    begin: segments => {
      const session: SpeechFollowSession = { token: ++token, segments, chunks: null, schedule: [] }
      current = session
      onSessionChange(session)
      return session.token
    },
    schedule: (t, index, startAt, chunks) => {
      // 世代が違えば触らない。後から始まった読み上げに入れ替わっている
      if (!current || current.token !== t) return
      current.chunks = chunks
      current.schedule.push({ index, startAt })
    },
    end: t => {
      // **自分の世代でなければ消さない。** 無条件に消すと、後から始まった読み上げの追従が死ぬ
      if (!current || current.token !== t) return
      clear()
    },
    reset: clear,
  }
}

/** 追従の判定に使う矩形（ビューポート座標）。 */
export interface FollowRect {
  top: number
  bottom: number
}

export interface FollowScrollInput {
  /** 視野の上端。sticky バナーの高さぶん下げた値を渡す */
  viewTop: number
  /** 視野の下端 */
  viewBottom: number
  /** いま読んでいる箇所の矩形 */
  currentRects: readonly FollowRect[]
  /** これから読む箇所の矩形（読み上げ順） */
  upcomingRects: readonly FollowRect[]
  /**
   * いま読んでいる箇所と併せて視野に入れたい前置きの矩形（等級カードの帯など）。
   *
   * **動かすかどうかの判定には使わない。** 読んでいる箇所ではないので、これが視野の外に
   * あることを理由に送ってはいけない。送り先を決めるときだけ、収まる限り含める。
   */
  contextRects?: readonly FollowRect[]
  /** 判定の基準にする scrollTop（smooth スクロール中は「行き先」を渡す） */
  currentScrollTop: number
  /** 到達できる scrollTop の上限（`scrollHeight - clientHeight`） */
  maxScrollTop: number
}

// これ未満の移動は動かさない（丸め誤差で毎チャンク scrollTo を呼ばないため）。
const MIN_DELTA_PX = 1

/**
 * 送り先の上に残す余白。
 *
 * 合わせ先を視野の上端にぴったり貼り付けると、カードの縁が切り取られたように見えて窮屈。
 * 少し下げておくと、その上にある見出しや帯との間に息が入る。
 */
const FOLLOW_TOP_MARGIN_PX = 24

/** 矩形が視野に収まっているか。 */
function isInside(rect: FollowRect, viewTop: number, viewBottom: number): boolean {
  return rect.top >= viewTop && rect.bottom <= viewBottom
}

/**
 * 新しい scrollTop を返す（`null` は動かさない）。
 *
 * 判定は 3 段。
 *
 * 1. いま読んでいる箇所がすべて視野に収まっていれば**動かさない**。これが「1 行ずつ
 *    細かく送られる」のを防ぐ主要な歯止めで、続く区域が同じ画面に見えている間は一歩も動かない。
 *    **収まりの判定には送り先と同じ余白を見込む**（`FOLLOW_TOP_MARGIN_PX`）。判定を厳しく
 *    したまま送り先だけ下げると、余白のぶん足りないだけで毎チャンク送り直すことになる
 * 2. 視野から外れていれば送る。送り先は、いま読んでいる箇所に**前置き（`contextRects`）と
 *    これから読む箇所を足していき、視野の高さに収まる限り広げた範囲**の上端（＋余白）
 * 3. いま読んでいる箇所だけで視野の高さを超えるときは、その上端を視野の上端に合わせる
 *    （観測点を多く抱えた区域の行がこれに当たる）
 *
 * **前置きは `currentRects` へ混ぜてはいけない。** 混ぜると範囲の上端が常に前置きになり、
 * 等級のところで一度寄せた後は `desired` が現在位置と一致してしまう。区域行がどれだけ
 * 見切れていても動かなくなる（この形で一度作って実地震のリプレイで破綻した）。
 * 前置きは**これから読む箇所より先に**試す。後回しにすると、区域が多い等級カードでは
 * 続きの区域で視野が埋まり、等級の帯が入る余地が残らない。
 *
 * **2 で「まとめて送る」効果は、範囲の上端を視野の上端に置くことから来る**（最小移動で
 * 収める形にしない理由）。下に置いた分だけ視野の余地が続きの箇所で埋まり、次の数チャンクは
 * 1 の判定で動かないまま済む。したがって**下方にある未読は範囲の上端を変えない**。
 *
 * **行き先は到達できる範囲へ丸めてから返す。** `scrollTo` はブラウザ側で丸められるので、
 * 理論値を呼び出し側に持たせると「行き先に着いたか」の判定が永久に成立せず、補正が
 * ずれたまま積もる。丸めたうえで**実際に動く量**が 1px 以下なら動かさない（末尾に張り付いて
 * これ以上動けないときに毎チャンク `scrollTo` を呼ばないため）。
 */
export function planFollowScroll(input: FollowScrollInput): number | null {
  const { viewTop, viewBottom, currentRects, upcomingRects, currentScrollTop, maxScrollTop } = input
  if (currentRects.length === 0) return null

  // **余白を除いた高さで収まりを測る。** 送り先は上に余白を残す（`FOLLOW_TOP_MARGIN_PX`）ので、
  // 余白抜きの高さで「収まる」と判断すると、範囲の下端がその余白ぶん視野の外へはみ出す。
  const availableHeight = viewBottom - viewTop - FOLLOW_TOP_MARGIN_PX
  if (availableHeight <= 0) return null

  // 送り先が余白を取る分、収まりの判定もその位置を基準にする（判定と送り先を揃える）
  if (currentRects.every(r => isInside(r, viewTop + FOLLOW_TOP_MARGIN_PX, viewBottom))) return null

  let spanTop = Math.min(...currentRects.map(r => r.top))
  let spanBottom = Math.max(...currentRects.map(r => r.bottom))

  // 3: いま読んでいる箇所だけで収まらないときは足し込まず、その上端に揃えるだけ
  if (spanBottom - spanTop <= availableHeight) {
    // 前置きを先に試す。互いに独立なので、入らないものは飛ばすだけでよい
    for (const rect of input.contextRects ?? []) {
      const nextTop = Math.min(spanTop, rect.top)
      const nextBottom = Math.max(spanBottom, rect.bottom)
      if (nextBottom - nextTop > availableHeight) continue
      spanTop = nextTop
      spanBottom = nextBottom
    }
    // 2: これから読む箇所を読み上げ順に足していく。入らないものが出たらそこで打ち切る
    //    （順序を飛ばして先の箇所を含めると、間の箇所が画面外のまま読まれる）
    for (const rect of upcomingRects) {
      const nextTop = Math.min(spanTop, rect.top)
      const nextBottom = Math.max(spanBottom, rect.bottom)
      if (nextBottom - nextTop > availableHeight) break
      spanTop = nextTop
      spanBottom = nextBottom
    }
  }

  const desired = currentScrollTop + (spanTop - viewTop) - FOLLOW_TOP_MARGIN_PX
  const next = Math.min(Math.max(0, desired), Math.max(0, maxScrollTop))
  return Math.abs(next - currentScrollTop) > MIN_DELTA_PX ? next : null
}
