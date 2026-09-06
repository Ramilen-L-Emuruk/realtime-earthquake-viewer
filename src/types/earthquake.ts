export type IntensityScale = -1 | 10 | 20 | 30 | 40 | 45 | 50 | 55 | 60 | 70

/** 長周期地震動階級（1〜4）。階級 4 以上は EEW 特別警報の条件になる。 */
export type LpgmClass = 1 | 2 | 3 | 4

export interface Hypocenter {
  name: string
  latitude: number
  longitude: number
  depth: number
  magnitude: number
  /**
   * 規模が数値で求まらないときに気象庁が添える説明（`jmx_eb:Magnitude@description`）。
   *
   * **「Ｍ不明」と「Ｍ８を超える巨大地震」は別物。** 電文はどちらも本文 `NaN`・
   * `@condition="不明"` で送ってくる（電文解説資料 Ⅱ.32/33/36）ため、`magnitude` の側だけを
   * 見ても見分けられない。後者は M8 を超えて速報できないことを表し、同じ地震の津波情報では
   * 予想波高が「巨大」「高い」になる —— **最大級の地震ほど画面が「不明」の一語になる**。
   *
   * 津波側の `TsunamiSourceEarthquake.magnitudeCondition` と同じもの。値も原文のままで、
   * 全角の「Ｍ」を含む（表示はそのまま出し、読み上げは `magnitudeConditionSpeech` で直す）。
   */
  magnitudeCondition?: string
}

export interface EarthquakePoint {
  pref: string
  addr: string
  isArea: boolean
  scale: IntensityScale
  /**
   * 「震度5弱以上と推定されるが観測値が入電していない」地点（電文の「震度５弱以上未入電」）。
   *
   * **`scale` は下限の 45（5弱）が入る。** 揺れが強い地域ほど観測点からの通信が途絶え
   * やすく、最も震度が高いはずの市町村がこの形で届く。観測値と同じ顔で出すと、
   * 実際にはもっと強い可能性があることが伝わらない。
   */
  unreceived?: boolean
}

export type IssueType =
  | '震度速報'
  | '震源情報'
  | '震源・震度情報'
  | '各地の震度情報'
  | '顕著な地震の震源要素更新のお知らせ'
  | '遠地地震'
  | 'その他'

export type CorrectType =
  | 'なし'
  | '訂正'
  | '震度のみ訂正'
  | '震源を訂正'
  | '震度・震源を訂正'

export type DomesticTsunami =
  | 'なし'
  | '不明'
  | '調査中'
  | '海面変動の可能性'
  | '若干の海面変動'
  | '注意報'
  | '警報等'

export interface JMAQuake {
  kind: 'quake'
  id: string
  /**
   * 電文が配信する地震の識別子（DMDATA は 14 桁タイムスタンプ）。P2PQuake 経路では配信されない。
   *
   * **同一性判定には使わない。** 統合・選択・通知は `eventKey`、または `id` 文字列から抜く
   * `extractQuakeEventId`（`utils/quakeMerge.ts`）で行う。このフィールドを直接読むのは
   * `TsunamiTab` の原因地震リンクと `testScenarioReplay` の ID 再採番の 2 箇所だけ。
   *
   * **全経路・全種別（取消電文を含む）で埋めること。** 欠けると上の 2 箇所がその報だけ
   * 取りこぼす（XML 経路と取消電文で落ちていたのを 2026-09-04 に揃えた）。
   */
  eventId?: string
  time: string
  cancelled?: boolean
  cancelledAt?: Date
  /**
   * 取消しの概要（`Body/Text`）。取消電文でのみ入る。
   *
   * 電文解説資料は「情報形態が"取消"の場合に、取消しの概要等を本要素に記載する」と定めている
   * （Ⅱ.33 ほか）。**気象庁が書いた取り消しの理由**で、アプリが組み立てた文言ではない。
   */
  cancelText?: string
  issue: {
    source: string
    time: string
    type: IssueType
    correct: CorrectType
  }
  earthquake: {
    time: string
    hypocenter: Hypocenter
    /**
     * 電文全体の最大震度。**「5弱以上・未入電」（電文の「震度５弱以上未入電」）もここへ 45 として入る。**
     * 読めないからと `-1`（不明）に落とすと、行動チェックリストが発火せず、読み上げの
     * 「最大」も消え、カードの見出しが「?」になる。
     *
     * 未入電かどうかは**フィールドで持たず** `points` から導く（`isMaxScaleUnreceived`）。
     * 理由はその関数のコメント。
     */
    maxScale: IntensityScale
    domesticTsunami: DomesticTsunami
  }
  points: EarthquakePoint[]
  /**
   * 同一地震を貫いて変わらない内部キー。統合・選択・通知の同一性判定はすべてこれで行う。
   * `mergeQuakeInto` が統合のたびに既存カードの値を引き継ぐため、続報で `id` が変わっても不変。
   * DMDATA 経路は電文が共有する eventId、P2PQuake 経路は eventId が配信されないため
   * 最初に受信した報から生成する（生成規則は `utils/quakeMerge.ts` の `quakeEventKey`）。
   * 統合前の生電文には存在しないため optional。
   */
  eventKey?: string
  /**
   * 気象庁の付加文（津波に関する固定付加文）の原文。DMDATA 経路でのみ得られる。
   * 遠地地震は付加文コードが 021x 系だけでは表現しきれない（022x/023x 系を併用する）ため、
   * domesticTsunami への丸め込みで意味が落ちる。原文を読み上げに使う用途で保持する。
   * P2PQuake 経路は付加文を配信しないため undefined。
   */
  forecastText?: string
  /**
   * 気象庁の自由付加文（`Comments/FreeFormComment`）の原文。DMDATA 経路でのみ得られる。
   *
   * 固定付加文（`forecastText`）が津波区分ごとの定型文であるのに対し、こちらは電文ごとに
   * 書き起こされる本文で、**続報で実際に更新されるのはこちら側**であることが多い（観測された
   * 津波の高さ・潮位変化の有無・次報の発表予定時刻など）。固定付加文は区分が変わらない限り
   * 動かないため、これを持たないと「続報を受けたのに何も変わらない」状態になる。
   *
   * 全角スペースで整形された表が入ることがあるため、**改行と空白をそのまま保持する**
   * （前後の空行だけ落とす）。表示側も `whitespace-pre-wrap` で受けること。
   *
   * P2PQuake 経路は配信しないため undefined。
   */
  freeText?: string
}

export type TsunamiGrade = 'MajorWarning' | 'Warning' | 'Watch' | 'Forecast' | 'Unknown'

export interface TsunamiStation {
  name: string
  code: string
  highTideDateTime?: string
  arrivalTime?: string
  arrivalCondition?: string
}

/**
 * 沖合で観測された津波から導いた、沿岸への推定（電文の `Estimation`）。
 *
 * **観測値でも気象庁の発表値でもない。** 沖合の観測点で捉えた波から沿岸の予報区への
 * 到達と高さを推定したもので、VTSE52（沖合の津波観測に関する情報）でのみ届く。
 * 発表中の予想波高（`TsunamiArea.maxHeight`）と混ぜないこと。
 */
/**
 * 沿岸への推定の状態（`Estimation` 配下の `MaxHeight/Condition`）。
 *
 * 観測点側（{@link TsunamiObservationCondition}）と語彙が違う —— 推定値なので「観測中」ではなく
 * **「推定中」**。同じ表に混ぜると、電文が言っていない語を引き当てる。
 */
export interface TsunamiEstimationCondition {
  /**
   * 予想される高さに比べ十分小さく、数値を発表していない（`MaxHeight/Condition` = 推定中）。
   *
   * このとき `DateTime` と `jmx_eb:TsunamiHeight` は**出現しない**（電文解説資料 Ⅱ.13 1-2-2-3）
   * ので、`maxHeight` が作れない。値の無い理由がこのフラグにしか残らない。
   */
  estimating?: boolean
  /**
   * 推定される高さが大津波警報・津波警報の基準を超え、追加または更新された
   * （`MaxHeight/Condition` = 重要）。定性的表現から数値表現へ変わった場合も含む。
   *
   * **観測点側の「重要」とは基準が違う。** 沿岸の観測（VTSE51）は大津波警報のみが基準で、
   * こちらと沖合の観測（VTSE52）は大津波警報・津波警報の両方。語を分ける理由は
   * `tsunami.ts` の {@link import('../utils/tsunami').importantBadgeText}。
   */
  important?: boolean
}

export interface TsunamiEstimation {
  /** 津波予報区名。 */
  name: string
  code?: string
  /** 到達予想時刻（推定）。 */
  arrivalTime?: string
  /**
   * 到達についての説明（「早いところでは既に津波到達と推定」）。
   *
   * **`arrivalTime` と併存する。** 電文解説資料 Ⅱ.13 1-2-2-2 は「子要素 Condition に
   * "早いところでは既に津波到達と推定" と記載する。当該沿岸地域に属する潮位観測点のうち、
   * １観測点以上で津波の第１波の時刻を明瞭に観測した場合は、子要素 ArrivalTime に……
   * 記載する」と定めており、事例１は両方を持つ。**「時刻を出せないときの代わり」ではない**
   * ので、時刻があるときに隠さないこと（隠すと、時刻を出せる沿岸ほど注意喚起が落ちる）。
   */
  arrivalCondition?: string
  /** 予想高さ（推定）。数値にならない表記もあるため `description` を正とする。 */
  maxHeight?: {
    description: string
    value?: number
  }
  /** 電文が伝える推定の状態。数値が無い理由（「推定中」）はここにしか残らない。 */
  condition?: TsunamiEstimationCondition
}

export interface TsunamiSourceEarthquake {
  hypocenterName: string
  magnitude?: number
  /**
   * 規模が数値で求まらないときに気象庁が添える説明（`jmx_eb:Magnitude@description`）。
   *
   * **「規模不明」と「Ｍ８を超える巨大地震」は別物。** 後者は M8 を超えて速報できない
   * ことを表し、同じ電文で予想波高が「巨大」「高い」になる。`magnitude` が無いことだけを
   * 見て「不明」と出すと、**最大級の地震ほど情報が薄く見える**。
   */
  magnitudeCondition?: string
  originTime?: string
  /**
   * 震央補助表現（`NameFromMark`。「御前崎の北東４０ｋｍ付近」）。
   *
   * 日本近海で発生し津波警報・注意報を発表した地震にだけ付く（電文解説資料 Ⅱ.13 2-3-1-4）。
   * **震央地名より具体的に場所が分かる** —— 「駿河湾」だけでは自分との位置関係が掴めない。
   */
  nameFromMark?: string
  /**
   * 震源を決定した機関の略称（`Source`。「ＰＴＷＣ」「ＵＳＧＳ」等）。
   *
   * 国外で発生した地震で、気象庁以外の機関が決めた震源要素を採用したときだけ入る
   * （電文解説資料 Ⅱ.13 2-3-2）。**誰が決めた値かは、値そのものと同じくらい重要**。
   *
   * **`JMATsunami.issue.source`（発表元。「気象庁」等）とは別物。** 名前が同じなので、
   * どちらを指しているかは階層で見分けること。
   */
  source?: string
}

export interface TsunamiArea {
  grade: TsunamiGrade
  /**
   * 前回この区域に発表されていた等級（気象庁電文の `LastKind`）。
   *
   * **区域単位の切替・引き上げはこれでしか分からない。** 気象庁は一部解除でも区域を電文から
   * 消さず、「津波注意報 → 津波予報」のような等級の降格として載せる。全体の最上位等級だけを
   * 見ていると、他の区域に注意報が残っている限り「変化なし」に見える
   * （→ docs/spec/tsunami-spec.md §10「区域単位で等級が動いた報」）。
   *
   * DMDATA 経路のみ。P2PQuake は相当する項目を配信しないため常に undefined。
   */
  lastGrade?: TsunamiGrade
  immediate: boolean
  name: string
  code?: string
  firstHeight?: {
    arrivalTime?: string
    condition: string
  }
  maxHeight?: {
    description: string
    // 数値表現[m]。「巨大」「高い」のように数値化されない予想波高では欠落する
    // （P2PQuake の仕様どおりの挙動。表示・読み上げはいずれも description しか見ない）。
    value?: number
  }
  /**
   * 予想波高が大津波警報の区域で初めて数値になった、または上方修正された
   * （`Forecast/Item/MaxHeight/Condition` = 重要）。
   *
   * **観測・推定の「重要」とは意味が違う。** あちらは実際に高い津波を観測・推定した合図だが、
   * こちらは**予想の書き換え**を指す（電文解説資料 Ⅱ.11 1-1-2-4「大津波警報の津波予報区に
   * 対して、予想される津波の高さが最初に数値で発表された場合や、大津波警報の中で予想される
   * 津波の高さが上方修正された場合」）。同じ語で出すと取り違える。
   *
   * DMDATA 経路のみ。P2PQuake は相当する項目を配信しないため常に undefined。
   */
  forecastHeightImportant?: boolean
  stations?: TsunamiStation[]
}

/**
 * 潮位観測点の観測状態（気象庁電文の `Condition`）。
 *
 * **排他ではない。** 気象庁は `MaxHeight/Condition` に複数の内容を全角スペースで併記する
 * （電文解説資料 Ⅱ.12 に「重要 欠測」「微弱 欠測」「観測中 欠測」の事例がある）ため、
 * どれか 1 つを選ぶ形では表せない。読み取りは `parseTsunamiObservationCondition` に集約する。
 */
export interface TsunamiObservationCondition {
  /** 第1波の到達時刻が不明瞭で観測できなかった（`FirstHeight/Condition` = 第１波識別不能）。 */
  firstWaveUnidentifiable?: boolean
  /** 第1波が欠測（`FirstHeight/Condition` = 欠測）。到達したかどうかが判っていない。 */
  firstHeightMissing?: boolean
  /**
   * 最大波が欠測（`MaxHeight/Condition` = 欠測）。
   *
   * **`height` と同時に立ちうる。** そのときの数値は「これまでの最大波の高さ」＝欠測になる前に
   * 観測できた値で、以後は観測できていない（電文解説資料 Ⅱ.12 事例 6）。
   */
  maxHeightMissing?: boolean
  /** 津波注意報の区域で、これまでの最大波が非常に小さい（`MaxHeight/Condition` = 微弱）。 */
  weak?: boolean
  /** 予想される高さに比べ十分小さく、数値を発表していない（`MaxHeight/Condition` = 観測中）。 */
  observing?: boolean
  /** これまでの最大波が大津波警報の基準を超えた（`MaxHeight/Condition` = 重要）。 */
  important?: boolean
  /**
   * 水位が上昇中（`jmx_eb:TsunamiHeight@condition` = 上昇中）。
   *
   * 上の 6 つと出所が違う（波高の要素の属性で、`MaxHeight/Condition` ではない）が、
   * 観測状態としては同じ枠なのでここへ入れる。
   */
  rising?: boolean
}

export interface TsunamiObservation {
  name: string
  height?: {
    value: number
    description: string
    over?: boolean
  }
  /**
   * 電文が伝える観測状態。**欠測・微弱・観測中の判定はここだけを見る**
   * （`height` の有無では「まだ観測できていない」と「もう観測できない」を見分けられない）。
   */
  condition?: TsunamiObservationCondition
  arrivalTime?: string
  initial?: string  // 引き波 | 押し波
  /**
   * 沖合の潮位観測点（VTSE52「沖合の津波観測に関する情報」）か。沿岸（VTSE51）は false/undefined。
   *
   * **「重要」の基準が沿岸と違う**ため必要になる —— 沿岸は大津波警報のみ、沖合は
   * 大津波警報・津波警報の両方（電文解説資料 Ⅱ.12 1-2-2-2 と Ⅱ.13 1-1-2-2-2）。
   *
   * **`districtCode` の有無で代用しないこと。** 沖合の観測点が津波予報区に属さないため
   * 結果的に一致するが、それは電文が区域名を空にしている副作用にすぎない。判定は
   * 電文種別（`headType`）から立てる。
   */
  offshore?: boolean
  /**
   * 特殊観測機器の名称（`Station/Sensor`）。「ＧＮＳＳ波浪計」「水圧計」（電文解説資料 Ⅱ.13 1-1-2-2）。
   *
   * 沖合の観測点だけが持つ。**電文の語をそのまま出す**（言い換えると、どちらの計器が測った値かが
   * 分からなくなる）。
   */
  sensor?: string
  /**
   * 最大波の続報での位置づけ（`MaxHeight/Revise`）。「追加」＝新たに出現、「更新」＝既出の内容が
   * 変わった。
   *
   * **これは値の変化を表す印ではなく、気象庁が明示的に置いた信号として読む。**
   * 沖合の観測点で `Condition` が「観測中」のまま `Revise` が「更新」になるのは、
   * **津波警報に相当する津波を観測している**ことを示す（電文解説資料 Ⅱ.13 1-1-2-2-2）。
   * 「観測中」の中身は変わりようがない（`DateTime` も高さも出ない）ので、この組み合わせは
   * 気象庁が意図して書いたものにしかならない。判定は `isWarningLevelWhileObserving`。
   *
   * **新規／更新の言い分け（読み上げ）には使わないこと。** あちらの境界は「前に声にした波高が
   * あるか」で、`Revise` が言っているのは「気象庁が何を発表したか」。別の軸なので混ぜると、
   * 読み上げが割り込みで鳴らなかった観測点を「更新」として扱う。
   */
  maxHeightRevise?: string
  // 観測点が属する津波予報区（districtCode）。forecasts[].code と一致させて area 行に紐づける。
  // VTSE52（沖合観測単独電文）は区域を持たないため undefined になる。
  districtCode?: string
  districtName?: string
}

export interface JMATsunami {
  kind: 'tsunami'
  id: string
  eventId?: string
  time: string
  cancelled: boolean
  // cancelled=true のときの解除理由。'lifted'=気象庁の正式解除（区域が電文から消える）、
  // 'retracted'=誤って発表した電文の取消（InfoType=取消）、'expired'=ValidDateTime満了によりアプリが自動検出。
  cancelReason?: 'lifted' | 'retracted' | 'expired'
  /**
   * 取消しの概要（`Body/Text`）。取消電文（`InfoType` = 取消）でのみ入る。
   *
   * **アプリの定型文（`CANCEL_REASON_LABEL`）とは別物。** あちらは解除・取消・失効の区別を
   * 説明する文で、こちらは**気象庁がその報に書いた理由**。なぜ取り消したのかはここにしか無い。
   */
  cancelText?: string
  cancelledAt?: Date
  headline?: string
  // 付加文（固定文）。避難行動の呼びかけなど JMA 公式の定型文。長文の解説（FreeFormComment）は含まない。
  warningComment?: string
  // この津波を引き起こした地震（Earthquake 要素）。震源名・マグニチュード・発生時刻。
  /**
   * この津波を引き起こした地震。**電文は複数持ちうる**（`Earthquake` 要素が繰り返す）。
   *
   * 短い間に複数の地震が起き、まとめて 1 つの津波情報として発表される場合がある。1 件目だけを
   * 読むと、残りの震源が画面から消える。表示は 1 件目を主に扱い、残りを併記する。
   */
  sourceEarthquakes?: TsunamiSourceEarthquake[]
  // 若干の海面変動など予報のみの場合、JMAは明示的なキャンセル電文を送らず
  // ValidDateTime の経過でのみ有効期限が示される。
  validDateTime?: string
  issue: {
    source: string
    time: string
    type: 'Focus'
  }
  areas: TsunamiArea[]
  observations?: TsunamiObservation[]
  /**
   * 沖合の観測から導いた沿岸への推定（VTSE52 のみ）。
   *
   * 沖合の観測点は沿岸より先に津波を捉えるため、ここに**まだ到達していない沿岸**の
   * 到達予想と高さが入る。観測値の下に並べて、推定であることが分かる形で出す。
   */
  estimations?: TsunamiEstimation[]
}

export interface EEWRegion {
  pref: string
  name: string
  /** 予想震度の下限。震度未確定は -1（`EarthquakePoint.scale` と同じセンチネル） */
  scaleFrom: IntensityScale
  /** 予想震度の上限。地域別の最大予想震度として `eewMaxScale()` が参照する */
  scaleTo: IntensityScale
  /**
   * 予想震度の上限が定まっていない（`scaleTo` は「〜以上」の下限）ことを表す。
   * DMDATA の `to: "over"`・P2PQuake の `scaleTo: 99` がこれに当たる。どちらも
   * `scaleTo` には下限側の値（= `scaleFrom`）を入れ、「以上」はこのフラグで持つ。
   * 詳細は docs/spec/data-sources-spec.md §8「上限を定めない予想震度」。
   */
  scaleToOrAbove?: boolean
  kindCode: string
  arrivalTime: string | null
  lgIntTo?: LpgmClass  // 地域別予想長周期地震動階級。電文に含まれない場合は undefined
  /**
   * 上限を定めない予測（電文の `To="over"`）だったか。意味と扱いは `scaleToOrAbove` と同じで、
   * **語だけが違う** —— 気象庁の表現は「階級3程度以上」（→ `getLpgmClassLabelWithApproxAbove`）。
   */
  lgIntToOver?: boolean
}

export interface EEWAlert {
  /**
   * 取消しの概要（`Body/Text`）。取消電文でのみ入る。
   *
   * **地震情報・津波情報と同じ構造。** 取消電文は `Body` に `Text` しか持たないので、
   * 3 つの電文で扱いを揃える（片方だけ拾うと、同じ事象なのに種別によって理由が出たり出なかったりする）。
   */
  cancelText?: string
  kind: 'eew'
  id: string
  time: string
  test: boolean
  earthquake: {
    originTime: string
    arrivalTime: string
    condition: string
    hypocenter: Hypocenter
  }
  severity: 'Unknown' | 'Forecast' | 'Warning'
  cancelled: boolean
  expired?: boolean
  isFinal?: boolean
  cancelledAt?: Date
  // issue.serial = 情報番号（第N報）
  issue?: {
    eventId?: string
    serial?: string
    time?: string
  }
  // DMDSS パーサーは `areas` を使う。旧形式との互換のため `regions` も保持する。
  // 参照時は utils/eew.ts の eewAreas() で吸収する。
  areas?: EEWRegion[]
  regions?: EEWRegion[]
  // Yahoo 強震モニタ由来の calcintensity から変換した最大予想震度。
  // areas が空の場合のフォールバックとして eewMaxScale() が使用する。
  forecastMaxScale?: IntensityScale
  // `forecastMaxScale` の上限が定まっていない（「〜以上」）ことを表す。
  // 意味と扱いは `EEWRegion.scaleToOrAbove` と同じ。
  forecastMaxScaleOrAbove?: boolean
  // DMDATA EEW 電文 body.intensity.forecastMaxLpgmInt から取得した推定最大長周期地震動階級（1〜4）。
  forecastMaxLpgmClass?: LpgmClass
  /** 上限を定めない予測（電文の `To="over"`）だったか。→ `EEWRegion.lgIntToOver` */
  forecastMaxLpgmClassOver?: boolean
  /**
   * 気象庁の固定付加文（`Comments/WarningComment/Text`）。避難行動の呼びかけなどの定型文。
   *
   * 津波の同名フィールドと同じ扱いで、**画面にだけ出す**（読み上げには載せない）。EEW の
   * 読み上げは秒を争うため、定型文を挟むと肝心の震度・地域が遅れる。
   */
  warningComment?: string
}

export interface LpgmPoint {
  code: string      // 観測点コード（例: "0122401"）
  name: string      // 観測点名（例: "新千歳空港"）
  pref: string      // 都道府県名（電文の Pref/Name から補う）
  lgInt: number     // 長周期地震動階級 1〜4
}

export interface LpgmRegion {
  code: string      // 一次細分区域コード（例: "102"）
  name: string      // 一次細分区域名（例: "石狩地方南部"）
  maxLgInt: number  // 区域内最大長周期地震動階級 1〜4
}

export interface JMALpgm {
  id: string
  eventId: string     // VXSE51/52/53/62 が共有する 14 桁タイムスタンプ。lpgmByEventId の Map キー
  time: string
  originTime: string  // TTS 読み上げテキスト用
  maxClass: number    // 1〜4
  cancelled: boolean
  points?: LpgmPoint[]    // 観測点別階級（取消電文では undefined）
  regions?: LpgmRegion[]  // 一次細分区域別最大階級
  /**
   * 長周期地震動に関する観測情報の種類（`LgCategory`。値は "1"〜"4"。電文解説資料 Ⅱ.37 2-1-4）。
   *
   * 階級と震度の組み合わせの分類。**2 と 4 は「階級を観測した地域のうち、最大震度が4以下の
   * 地域がある」ことを表す** —— 揺れそのものは強くないのに高層階が大きく揺れた地域がある、
   * という状況。数字そのものは利用者に出さない（分類番号を見せても伝わらない）。
   *
   * 値ごとの定義表（全国の最大階級と、数える地域の階級の下限が値で違う）と、画面に出す一文の
   * 決め方は `docs/spec/quake-spec.md` §8「長周期地震動の「観測情報の種類」は意味を出す」。
   */
  category?: number
}

export type AppEvent = JMAQuake | JMATsunami | EEWAlert

// 南海トラフ地震臨時情報 (VYSE50)
// 段階（調査中 → 巨大地震注意／巨大地震警戒 → 調査終了）はすべてこの 1 種別で配信される。
// 段階の判別は電文の Head/Title（情報名）に入る括弧内キーワードで行う。Head/InfoKind は
// 段階に関わらず「南海トラフ地震に関連する情報」で固定されており判別に使えない
// （実電文 14 通で確認。詳細は docs/spec/data-sources-spec.md）。
export interface JMANankai {
  id: string
  time: string
  eventId: string
  /**
   * 気象庁の地震関連情報番号コード（電文の `Body/EarthquakeInfo/InfoSerial/Code`）。
   *
   * `111`/`112`/`113`=調査中（発表の契機が違う。順に「監視領域内の M6.8 以上の地震」
   * 「ひずみ計の有意な変化」「その他の現象」）／`120`=巨大地震警戒／`130`=巨大地震注意／
   * `190`=調査終了。
   *
   * **空文字になることがある。** `InfoSerial` は電文仕様上は省略可で、読めなかった報は
   * `Head/Title` から段階を拾う（そのときコードは持てない）。**判定には `kindName` を使うこと。**
   */
  kindCode: string
  kindName: string   // '調査中' | '巨大地震注意' | '巨大地震警戒' | '調査終了'
  headline: string
  body: string
  /**
   * 帯を引っ込めるか。調査終了（`kindName === '調査終了'`）と取消の両方で立つ。
   *
   * **取消と調査終了を、これ 1 つで見分けてはいけない**（→ `retracted`）。どちらも状況の表示を
   * 終える点は同じだが、**意味は正反対**——調査終了は「調べた結果、可能性は通常の範囲内だった」
   * という気象庁の判断で、取消は「その電文を撤回する」だけ。可能性については何も言っていない。
   */
  cancelled: boolean
  /**
   * 取消電文（`Head/InfoType` が「取消」）か。
   *
   * 気象庁の定めでは、取消は**「独立した情報単位」全体を取り消す**という意味しか持たない
   * （電文解説資料 Ⅰ.別紙ウ）。段階の判断を含まないので、`kindName` に「調査終了」を詰めて
   * 済ませてはならない —— 発表していない安心情報をアプリが作ることになる。
   */
  retracted?: boolean
  reportDateTime: string
}

// 南海トラフ地震関連解説情報 (VYSE51=臨時解説 / VYSE52=定例解説)
// 臨時情報（JMANankai）とは別物で、段階を持たない。想定震源域の地震活動・地殻変動の状況を
// 解説する電文で、臨時情報の発表期間中は VYSE51 が毎日、平常時は VYSE52 が毎月届く。
// 臨時情報と同じスロットに入れると段階の表示を上書きしてしまうため、型ごと分けている。
export interface JMANankaiCommentary {
  id: string
  time: string
  eventId: string
  /**
   * 気象庁の地震関連情報番号コード（`Body/EarthquakeInfo/InfoSerial/Code`）。
   * `200`=定例解説／`210`=臨時解説（次回も臨時）／`219`=臨時解説（次回は定例）。
   * 名称（`serialName`）はどちらの臨時解説も「臨時解説」で、次回の予定だけがコードで分かれる。
   */
  serialCode: string
  serialName: string // '臨時解説' | '定例解説'
  headline: string   // Head/Title 例: '南海トラフ地震関連解説情報（第１号）'
  summary: string    // Head/Headline/Text の一文要約。バナーの見出しに使う
  body: string       // Body/EarthquakeInfo/Text の本文（1000 字を超えることがある）
  // 取消電文（InfoType=取消）。解説情報に「解除」の概念は無く実電文でも未発表だが、
  // 来たときに帯を消せるようにしておく（取消を無視すると古い帯を出し続けることになる）
  cancelled: boolean
  reportDateTime: string
  expireAt: string   // reportDateTime + 7日。定例解説は月 1 回来て自然に消えないため期限で畳む
}

// 北海道・三陸沖後発地震注意情報 (VYSE60)
export interface JMAKohatsu {
  id: string
  time: string
  eventId: string
  headline: string
  body: string
  cancelled: boolean
  /** 取消電文か（意味は `JMANankai.retracted` に同じ）。 */
  retracted?: boolean
  reportDateTime: string
  expireAt: string  // reportDateTime + 7日
}

/**
 * データ受信の状態。
 *
 * `replay` は「テスト時刻設定（強震モニタ）で過去を再生しているため、ライブ受信を意図的に止めている」
 * 状態。`disconnected`（＝繋がるべきなのに繋がっていない）と区別する必要がある——混ぜると地図に
 * 切断警告が出てしまうし、逆に更新しないままにすると直前の値（多くは `connected`）が残って
 * 「受信していないのに接続中」と表示され続ける。
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'replay'

export interface TelegramLogEntry {
  id: string
  receivedAt: Date
  source: 'dmdss' | 'p2pquake'
  headType: string
  isTest: boolean
  status: 'parsed' | 'filtered' | 'error'
  kind?: 'eew' | 'quake' | 'tsunami' | 'lpgm' | 'nankai' | 'nankaiCommentary' | 'kohatsu'
  rawHead?: unknown
  rawBody: unknown
  errorMessage?: string
}
