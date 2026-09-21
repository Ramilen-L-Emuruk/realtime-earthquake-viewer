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
 * | `quakeObserved` | 地震情報で「その報が運んでいた観測点・市町村」を記録する（区域より下の階層の差分） |
 * | `unreceivedNote` | 未入電の説明文（「…では、震度5弱以上と推定されますが、未入電です。」）。**名前を指さない** |
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
  | { kind: 'quakeRegion'; name: string; scale: number; unreceived?: boolean }
  | { kind: 'quakeFact'; fact: QuakeFact; value: string }
  | { kind: 'quakeObserved'; observed: SpokenObservation }
  | { kind: 'unreceivedNote' }
  | { kind: 'telegramText' }
  | { kind: 'borrowedHypocenter' }

/**
 * `unreceivedNote` は**未入電モードの自動開閉のためだけ**に置いてある印。
 *
 * 未入電の文は「地名の列挙」＋「では、震度5弱以上と推定されますが、未入電です。」という形で、
 * 後半は地名を含まないため参照を持たなかった。すると {@link unreceivedChunkRange} の範囲が
 * 地名の最後で終わり、**「なぜ未入電なのか」を説明している最中に地図とカードが通常表示へ戻る**
 * （実測で起きていた —— 全 66 チャンクのうち範囲が 53〜63 で、64 の「震度5弱以上と推定されますが、」
 * を読み始めた時点で閉じていた）。
 *
 * **名前を持たせないのは、既読の記録に混ぜないため。** `quakeRegion` で足すと、その名前が
 * 「声にした区域」として記録され、続報の差分から落ちる（{@link applySpokenRefs} は
 * `quakeRegion` / `quakeFact` だけを見るので、この種類は素通りする）。
 *
 * `telegramText` も同じ役目で、**気象庁が書いた文を読んでいるあいだ、その表示を開いておく**
 * ためだけの印（→ {@link hasTelegramTextFollowTarget}）。どの電文の文かは参照ではなく
 * セッションの `subject` が持つ —— 参照に種別を持たせると、既読の記録へ混ざる形が増える。
 *
 * `borrowedHypocenter` も同じ役目。**津波の読み上げが、その津波の原因地震の震源を語っている
 * あいだ、その地震のカードを見せる**ための印（→ `utils/borrowFromTsunami.ts`）。震源そのものは
 * `quakeFact` で別に記録されるので、この印は既読へ混ざらない（{@link applySpokenRefs} は
 * `quakeRegion` / `quakeFact` だけを見る）。どの地震かは参照ではなくセッションの主題が持つ。
 */

/**
 * 声になった報が運んでいた観測点・市町村。**区域より下の階層の差分を出すため**だけに持つ。
 *
 * 読み上げの地域名は一次細分区域までしか下りないので、区域の最大震度が据え置きのまま
 * 観測点だけが増えた続報は差分が空になる（実例は `docs/spec/audio-tts-spec.md` 改訂履歴
 * 2026-09-17）。それを「変わりはありません」と言い切ってしまわないよう、下の階層の変化を
 * 見るための材料をここへ置く。
 *
 * **配列の参照をそのまま持つ。集合（Map）へ組み直さない。** 電文の `points` / `cities` は
 * 地震カードが既に持っている配列で、こちらはそれを指すだけなのでメモリは増えない
 * （`QuakeSpokenState` は最大 100 地震ぶんを抱えるので、1 件あたり数百〜千の観測点を持つ
 * 大きな地震では Map を毎回作る作りが効いてくる）。
 * 突き合わせは続報が届いた瞬間の 1 回だけで足りる（→ `ttsText.ts` の `observationChange`）。
 *
 * **型を `EarthquakePoint` / `JMAQuakeCity` で書かない。** このファイルは読み上げの追従を
 * 計算する純関数の置き場で、電文の型へ依存させたくない。必要な分だけを構造で書けば実物は
 * そのまま渡せる。
 *
 * **記録を進めるのは声になった時点**（地震側の他の参照と同じ規律 → {@link applySpokenRefs}）。
 * 受信時に進めると、割り込みで鳴らなかった報の観測点まで「伝えた」ことになり、次の報で
 * 「変わりはありません」と嘘を言う。
 */
export interface SpokenObservation {
  /** 電文の `points`（区域・都道府県の集約点も混ざる。観測点は `isArea` が偽のものだけ） */
  readonly points: readonly {
    readonly addr: string
    readonly code?: string
    readonly scale: number
    readonly isArea: boolean
    readonly pref: string
  }[]
  /** 電文の `cities`（市町村。DMDATA の XML 経路でのみ入る） */
  readonly cities: readonly {
    readonly name: string
    readonly code?: string
    readonly scale: number
    readonly pref: string
  }[]
}

/**
 * 地震情報が伝える「震度の地域以外の事実」。続報で変化したものだけを読むための単位。
 * 値そのものではなく何についての事実かを表すので、`magnitude` は 7.4 でも 7.6 でも同じキー。
 *
 * `maxScaleOnly` だけは毛色が違う。**地域名を 1 件も作れなかったときの代替**として
 * 最大震度を伝えたことを覚える枠で、値は震度そのもの。**値が変われば読み直す — 上がるときも
 * 下がるときも。** 区域側（`isUnspokenRegion`）は上がったときだけ読み直すので非対称だが、
 * 地域名を引けない状況ではこれが震度を伝える唯一の経路なので、下方修正も黙って捨てられない。
 * 他の 4 つと違い `tellableFacts` には載せない（理由は `ttsText.ts` の同関数のコメント）。
 */
export type QuakeFact = 'hypocenterName' | 'magnitude' | 'depth' | 'domesticTsunami' | 'maxScaleOnly'

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
  if (a.kind === 'quakeRegion' && b.kind === 'quakeRegion') return a.name === b.name && a.scale === b.scale && !a.unreceived === !b.unreceived
  if (a.kind === 'quakeFact' && b.kind === 'quakeFact') return a.fact === b.fact && a.value === b.value
  // 観測点の記録は 1 つの読み上げ文に高々 1 つしか載らないので、**参照が同じか**で足りる。
  // 中身（811 点になりうる）を突き合わせない —— ここは重複排除のための比較で、変化の検出は
  // `ttsText.ts` の `observationChange` が担う。
  if (a.kind === 'quakeObserved' && b.kind === 'quakeObserved') return a.observed === b.observed
  // 未入電の説明文の印は中身を持たないので、同じ種類なら同一。**扱わないと重複排除が効かない**
  // （`mapChunksToRefs` は `sameRef` で既出かを見るため、同じチャンクへ何度も積まれる）。
  if (a.kind === 'unreceivedNote' && b.kind === 'unreceivedNote') return true
  // 借りた震源の印も中身を持たないので、同じ種類なら同一（`unreceivedNote` と同じ理由）。
  if (a.kind === 'borrowedHypocenter' && b.kind === 'borrowedHypocenter') return true
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
 * その参照は「併せて視野に入れたい前置き」を持つか（→ {@link planFollowScroll} の `contextRects`）。
 *
 * - **区域**は等級カードの頭。区域行だけを上端へ揃えると、どの等級の話かが視野から消える
 * - **観測点**はその区域の見出し（沖合なら「沖合観測」の帯）。**読み上げ文は読点でチャンクが
 *   割れる**ので「石川県能登、」と「輪島港で〜」は別チャンクになり、観測点のチャンクへ進んだ
 *   時点で前置きが無いと直前に読んだ区域名が視野の外へ流れる
 * - **等級**は自分がカードの頭なので前置きを持たない
 *
 * 引く先（要素）は呼び出し側が登録する。ここで決めるのは**どの種別が前置きを持つか**だけ。
 */
export function hasFollowContext(ref: SpeechRef): boolean {
  return ref.kind === 'area' || ref.kind === 'station'
}

/**
 * その読み上げ文が「震度が届いていない地点」を含むか（未入電モードの自動開閉に使う）。
 *
 * **{@link hasFollowTarget} を広げないこと。** あちらは津波カードの行を引ける 3 種だけを
 * 通す門で、`quakeRegion` をわざと外してある。ここへ足すと地震情報の読み上げが津波カードの
 * 追従を起こす（同関数の注記）。別の述語として持つ。
 *
 * 判定は **`unreceived` の印が立った参照があるか**だけ。観測値の区域参照
 * （`unreceived` なし）では開かない —— 開く相手はカードの未入電トグルで、観測値の文では
 * 出すものが無い。
 */
/**
 * 未入電を指す参照か（地名そのものと、末尾の説明文）。
 *
 * **開始の判定と範囲の判定で同じ述語を使うこと。** 片方だけに説明文を入れると、説明文しか
 * 持たないチャンクで範囲が途切れる。
 */
function isUnreceivedRef(r: SpeechRef): boolean {
  return (r.kind === 'quakeRegion' && !!r.unreceived) || r.kind === 'unreceivedNote'
}

export function hasUnreceivedFollowTarget(segments: readonly SpeechSegment[] | undefined): boolean {
  return segments?.some(s => s.refs.some(isUnreceivedRef)) ?? false
}

/**
 * 気象庁が書いた文の読み上げか（＝その表示を開いておく対象か）。
 *
 * **門は他の 2 つと別に持つ。** 津波カードの追従（`hasFollowTarget`）や未入電モードの自動開閉
 * （`hasUnreceivedFollowTarget`）へ相乗りすると、気象庁の文を読んでいるあいだに津波カードが
 * 動いたり、未入電の一覧が開いたりする —— どれも別の参照を見るための門で、対象が違う。
 */
export function hasTelegramTextFollowTarget(segments: readonly SpeechSegment[] | undefined): boolean {
  return segments?.some(s => s.refs.some(r => r.kind === 'telegramText')) ?? false
}

/**
 * 借りた震源を読み上げているか（＝その地震のカードを見せる対象か）。
 *
 * **門は他の 3 つと別に持つ。** 津波カードの追従（`hasFollowTarget`）へ相乗りさせると、
 * 震源を語っているあいだも津波カードのスクロールが動こうとする。未入電・気象庁の文の門も
 * それぞれ別の参照を見るためのもので、対象が違う（同じ理由は `hasTelegramTextFollowTarget`）。
 */
export function hasBorrowedHypocenterFollowTarget(segments: readonly SpeechSegment[] | undefined): boolean {
  return segments?.some(s => s.refs.some(r => r.kind === 'borrowedHypocenter')) ?? false
}

/**
 * 気象庁が書いた文を読み上げたときに、画面へ開く先がある電文の種別。
 *
 * **入らないのは地震情報だけ。** あの付加文は元から畳んでおらず、開く相手がいない
 * （→ quake-spec.md §8「固定付加文（その他）…はそのまま出す」）。長周期地震動観測情報は
 * **畳んである**ので入る（同 §8「気象庁からの補足は畳んで置く」）—— 読み上げる 3 ブロックが
 * そのまま補足の中身で、開かなければ声だけが本文を伝えることになる。
 *
 * ここに無い種別では参照を付けない＝追従セッションを立てない。立ててしまうと、誰も反応しない
 * セッションが始まっては終わる状態になり、**症状が出ないぶん後から意図を確かめられない**。
 *
 * **「畳んでいるか」は種別ごとに実装を見て決める。** まとめて「畳んでいない」と扱うと、
 * 片方だけ当たっている状態に気づけない（長周期を外していたのがその形だった）。
 *
 * 一覧は開く側（`SpecialInfoBanner` の `speaking(...)`・`TsunamiTab` の
 * `speakingTelegramText`・`EarthquakeCard` の補足）と対応する。食い違いは
 * `ttsFollow.test.ts` が検査する。
 */
export const TELEGRAM_TEXT_OPEN_TARGET_KINDS: ReadonlySet<string> = new Set([
  'nankai', 'nankaiCommentary', 'kohatsu', 'earthquakeCount', 'tsunami', 'lpgm',
])

/**
 * 気象庁が書いた文の読み上げの主題（`SpeechFollowSession.subject`）を作る。
 *
 * **開く側と読む側が同じ関数を通ること。** 文字列を手で組み立てると、片方だけ書式を変えた
 * ときに黙って開かなくなる（画面が動かないだけで、例外もログも出ない）。
 *
 * @param kind 電文の種別
 * @param target 同じ種別の表示が画面に複数あるとき、どれを開くかを決める識別子。
 *   **長周期地震動観測情報だけが渡す** —— 地震カードは複数並ぶので、種別だけでは
 *   どのカードの補足を開くか決まらない。バナーと津波の面は画面に 1 つしか無いので要らない。
 */
export function telegramTextSubject(kind: string, target?: string): string {
  // **`target !== undefined` で見る。** 真偽で見ると空文字が「渡していない」と同じ扱いになり、
  // 識別子を読めなかった電文どうしが同じ主題へ潰れる（`eventId` は要素が無ければ空文字になる）。
  return target !== undefined ? `telegramText:${kind}:${target}` : `telegramText:${kind}`
}

/**
 * チャンクごとの参照から、「未入電を声にしているチャンク」の範囲を返す。
 *
 * 未入電の文は観測値の文の後ろに置いてあるので実際には連続するが、**範囲は実データから求める**
 * （最初と最後の位置）。順番を前提に「最後のチャンクまで」とすると、文の並びを変えたときに
 * 黙ってずれる。
 *
 * 未入電のチャンクが 1 つも無ければ `null`。
 */
export function unreceivedChunkRange(
  refsPerChunk: readonly (readonly SpeechRef[])[],
): { first: number; last: number } | null {
  let first = -1
  let last = -1
  refsPerChunk.forEach((refs, i) => {
    if (!refs.some(isUnreceivedRef)) return
    if (first < 0) first = i
    last = i
  })
  return first < 0 ? null : { first, last }
}

/**
 * チャンクごとの参照から、「借りた震源を声にしているチャンク」の範囲を返す。
 *
 * 未入電側（{@link unreceivedChunkRange}）と同じく**範囲は実データから求める**。震源の句は
 * 津波の読み上げ文の末尾に置いてあるが、「最後まで」と決め打つと文の並びを変えたときに
 * 黙ってずれる。
 *
 * 該当するチャンクが 1 つも無ければ `null`。
 */
export function borrowedHypocenterChunkRange(
  refsPerChunk: readonly (readonly SpeechRef[])[],
): { first: number; last: number } | null {
  let first = -1
  let last = -1
  refsPerChunk.forEach((refs, i) => {
    if (!refs.some(r => r.kind === 'borrowedHypocenter')) return
    if (first < 0) first = i
    last = i
  })
  return first < 0 ? null : { first, last }
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
 * @param clock 見た時点の再生時計（`getSpeechClock`）。null なら何も鳴っていない
 * @param finished 読み上げが終わった後に呼んでいるか。**既定値を置かない** ―― 省略できると、
 *   途中で呼ぶ経路が「完走した」と誤って伝えてしまい、鳴り終えていない最終チャンクを
 *   既読にする。渡し忘れは型検査で止める
 */
export function spokenChunkIndices(
  scheduled: readonly { index: number; startAt: number }[],
  chunkCount: number,
  clock: number | null,
  finished: boolean,
): number[] {
  // 時計が無い＝AudioContext が作られていない（合成が全滅した・VOICEVOX 未起動）。
  if (clock === null) return []
  const started = scheduled.filter(s => s.startAt <= clock).map(s => s.index)
  if (started.length === 0) return []
  const last = Math.max(...started)
  // 最後のチャンクが鳴り始めていれば完走とみなす（読み上げの完了は最終チャンクの再生終了で
  // 解決するため）。それ以外は、鳴り始めた最後の 1 つを落とす。
  //
  // **途中で見るとき（`finished` が false）はこの近道を通さない。** 最終チャンクが鳴り始めた
  // 直後に見ると「完走した」と扱ってしまい、そこへ割り込みが入れば声にならなかった内容が
  // 既読として残る ―― この関数が元々避けている事故そのもの。
  if (finished && last === chunkCount - 1) return started
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
  /**
   * この読み上げが何について語っているか（地震なら `quakeEventKey`）。
   *
   * **「いま選ばれている地震」で代用しないために持つ。** 読み上げは優先度の待ち行列を通るので、
   * 順番が回ってくるまでに別の地震の電文が届き、選択がそちらへ移っていることがある（選択は
   * 受信した瞬間に同期で動く）。追従する側が選択を見て対象を決めると、**A の未入電を読みながら
   * B の一覧を開く**。
   *
   * 津波の追従は使わない（カードは常に 1 件で、行は参照から直接引ける）。
   */
  readonly subject?: string
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
  /**
   * 読み上げを始める。以降の通知に添える世代トークンを返す。
   *
   * `subject` はこの読み上げが何について語っているか（→ {@link SpeechFollowSession.subject}）。
   */
  begin: (segments: SpeechSegment[], subject?: string) => number
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
    begin: (segments, subject) => {
      const session: SpeechFollowSession = { token: ++token, segments, subject, chunks: null, schedule: [] }
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
