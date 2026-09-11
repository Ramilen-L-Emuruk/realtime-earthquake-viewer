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
  /**
   * マグニチュードの種別（`jmx_eb:Magnitude@type`）。→ {@link TsunamiSourceEarthquake.magnitudeType}
   *
   * P2PQuake 経路は相当する項目を配信しないため常に undefined。
   */
  magnitudeType?: string
  /**
   * 震央地名コード（`Area/Code`）と詳細震央地名コード（`Area/DetailedCode`）。
   *
   * **画面には出さない。** 震央地名は名前で出しており、コードは同名の震央地名を
   * 見分けるためのもの。長周期・津波は既に読んでいたので扱いを揃える
   * （→ {@link HypocenterAreaDetail.code}）。
   */
  code?: string
  detailedCode?: string
  /**
   * 震央補助表現（`Area/NameFromMark`）とその材料。意味は
   * {@link HypocenterAreaDetail.nameFromMark} と同じで、**読み手も同じ**
   * （`readHypocenterAreaLabels`）。長周期・津波は既に読んでいたので扱いを揃える。
   *
   * **読んで持つだけで、いまはどこからも使っていない。** 震央地名より具体的に場所を伝えられる
   * ので出す価値はあるが、震央地名を置き換えるのか併記するのかは表示側の判断が要る。
   */
  nameFromMark?: string
  markCode?: string
  direction?: string
  distanceKm?: number
  /**
   * 震源決定機関（`Hypocenter/Source`）。気象庁以外が決めた震源に入る（遠地地震など）。
   * 津波側の {@link TsunamiSourceEarthquake.source} と同じもの。
   *
   * **読んで持つだけで、いまはどこからも使っていない。**
   */
  source?: string
}

/**
 * 電文の運用種別（`Control/Status`。電文解説資料 Ⅰ.3）。
 *
 * **`EEWAlert.test` とは別物。** あちらは「画面・音・地図へ流さない」ための抑制フラグで、
 * 検証用に受信した試験報はあえて `test: false` にして流している（`services/dmdata.ts`）。
 * こちらは**電文が自分で名乗っている種別**で、表示に印を付けるためだけに持つ。
 *
 * 「通常」は持たせない（既定の状態に欄を割く意味がない）。
 */
export type TelegramOperationStatus = '訓練' | '試験'

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
  /**
   * 続報でこの点がどう変わったか（電文の `Revise`）。値は `'追加'` / `'上方修正'` / `'下方修正'`。
   *
   * **気象庁が「初出か」「震度が動いたか」を電文で直接伝えている。** 解説資料 Ⅱ.33 の
   * 2-1-3-2（都道府県）と 2-1-3-3-2（地域）—— 続報で新規に追加された場合は「追加」、
   * 最大震度が更新された場合は「上方修正」「下方修正」を記載する、と定められている。
   *
   * **読んで持つだけで、いまはどこからも使っていない。** 読み上げは前報との突き合わせで
   * 同じ判定を自前で出しており（`ttsText.ts` の差分ロジック。→ `CLAUDE.md`「続報は差分だけ
   * 読む」）、そちらを電文の値へ置き換えるかは別の判断が要る。読み上げの差分判定は
   * 単一情報源が何行も費やしている繊細な場所で、電文の網羅性点検の範囲を超えるため。
   *
   * **津波の `Revise`（`TsunamiObservation.firstHeightRevise` ほか）とは別物。**
   * あちらは波高の更新で、こちらは震度。名前が同じなので取り違えないこと。
   */
  revise?: string
  /**
   * 気象庁以外が運用する観測点（電文では名前の末尾に `＊`）。この印についての単一情報源。
   *
   * 電文の固定付加文が「＊印は気象庁以外の震度観測点についての情報です。」と断っている
   * （解説資料 Ⅱ.33 4-2、コード `0262`。長周期は Ⅱ.37 4-2 の `0263`）。**自治体だけではない**
   * ので「自治体の観測点」と言い換えないこと。
   *
   * **どれだけの数が当てはまるかは書かない。** 割合は電文ごとに変わり、手元の標本から
   * 出した数字はその標本の性質（どの地震か・どこまで揺れたか）を映しているだけで、
   * 読む人が確かめる術がない。「少数の例外」として扱わないことだけ守れば足りる。
   *
   * 印そのものは名前から外す（座標表の鍵に入っていないため引き当てが外れる）。
   * **外すだけで事実を捨てないよう**、ここへ移して画面ではバッジで出す。
   */
  nonJma?: boolean
  /**
   * 観測点コード（`IntensityStation/Code`）。区域・都道府県の点では持たない。
   *
   * **引き当ては名前で行っている**（座標表の鍵が名前のため）。読んで持つのは、名前が
   * 読めなかったときの記録の手がかりと、将来の引き当ての材料。画面には出さない。
   */
  code?: string
  /**
   * その観測点が属する市町村（電文の `City/Name`）。観測点の点にだけ入る。
   *
   * **座標表からは引けない。** `station-coords.json` が観測点について持つのは
   * 緯度・経度・所属区域だけで、市町村は入っていない。電文は観測点を市町村の下に置いて
   * いるので、**読み取りの時点で拾わないと後から復元できない**。
   *
   * DMDATA の XML 経路でのみ入る。P2PQuake は観測点を市町村でまとめずに配信するため空。
   */
  city?: string
  /**
   * その観測点が属する一次細分区域（電文の `Area/Name`）。観測点の点にだけ入る。
   *
   * **`isArea` と混同しないこと。** `isArea` は「この点が区域そのものを表す」という印で、
   * こちらは「この観測点がどの区域の下に置かれていたか」。両方が立つ点は存在しない。
   *
   * 持つ理由は 3 つある。いずれも**区域が分からないと救えない**。
   *
   * 1. **同名の市町村を取り違えない。** 市町村名は全国で一意ではない（府中市＝東京都・広島県、
   *    伊達市＝北海道・福島県）。名前だけで観測点を市町村へ結ぶと、1 通に両方が載った電文で
   *    観測点が混ざる。区域名と組にすれば一意になる（区域は 1 つの県にしか属さない）。
   * 2. **市町村の震度が読めなかったときに観測点まで道連れにしない。** 市町村の行は電文の
   *    `City` から作るので、そこが読めないと配下の観測点の置き場所が無くなる。区域が分かって
   *    いれば区域の直下へ落とせる。
   * 3. **座標表に頼らずに区域へ置ける。** 逆引き（`lookupStationRegion`）は座標表が要り、
   *    読み込み前・取得失敗・新設観測点では引けない。電文が言っている区域はそれより確実。
   *
   * DMDATA の XML 経路でのみ入る。P2PQuake は区域と観測点を別の電文で配信するため空で、
   * そちらは従来どおり座標表からの逆引きに頼る。
   */
  area?: string
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

/**
 * 市町村ごとの震度（電文の `Pref/Area/City`。電文解説資料 Ⅱ.33 2-1-3-3-3）。
 *
 * **`points` へ混ぜない。** `points` は「都道府県ロールアップ点／区域／観測点」の 3 種を
 * `pref` の有無と `isArea` の組み合わせで見分けており、4 種目を足すとカード・地図・読み上げの
 * 見分けが一斉に狂う。市町村は表示の粒度を 1 段細かくするためだけのものなので、別に持つ。
 */
export interface JMAQuakeCity {
  /** 市町村名（`City/Name`）。 */
  name: string
  /** 所属する一次細分区域名（`Area/Name`）。カードでこの区域の下にぶら下げる。 */
  area: string
  /** 所属する都道府県名（`Pref/Name`）。 */
  pref: string
  scale: IntensityScale
  /**
   * **この市町村の震度そのものが未入電**（`MaxInt` が無く `Condition` だけがある形）。
   * `scale` は下限の 45（5弱）が入る。表示は「5弱以上」。
   *
   * 都道府県・区域の行と同じ意味（→ {@link EarthquakePoint.unreceived}）。
   */
  unreceived?: boolean
  /**
   * **配下に未入電の観測点がある**（`MaxInt` と `Condition` が併存する形）。
   * `scale` はこの市町村が実際に観測した最大震度。表示は「未入電あり」。
   *
   * **`unreceived` と混ぜないこと。** 解説資料 Ⅱ.33 2-1-3-3-3 は `Condition` が出る条件を
   * 「配下に基準以上と考えられるが値を入手していない観測点があり、**かつ市町村の最大震度が
   * 基準未満（又は入電なし）**」と定めている。前者だけを見て 1 つのフラグへ畳むと、
   * 「震度4を観測したが未入電もある」市町村が「4以上」と表示され、観測できた値を
   * 下限のように見せてしまう。
   */
  hasUnreceived?: boolean
  /** 市町村コード（`City/Code`）。扱いは {@link EarthquakePoint.code} に同じ。 */
  code?: string
  /**
   * 続報でこの市町村がどう変わったか（電文の `Revise`）。→ {@link EarthquakePoint.revise}
   * （意味も扱いも同じ。**読んで持つだけで、いまはどこからも使っていない**）
   *
   * 解説資料 Ⅱ.33 は `Revise` を都道府県（2-1-3-2）・地域（2-1-3-3-2）・**市町村
   * （2-1-3-3-3-2）**の 3 階層に定めている。点検の集計は要素名でまとめるため
   * 「VXSE53 Revise」の 1 行にしか見えず、**市町村だけ読み落としても一覧からは分からない**
   * （→ `scripts/telegram-audit/where-defined.mjs`）。
   */
  revise?: string
}

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
  /**
   * 電文の運用種別（`Control/Status`）。訓練・試験のときだけ入る。→ {@link TelegramOperationStatus}
   */
  operationStatus?: TelegramOperationStatus
  points: EarthquakePoint[]
  /**
   * 市町村ごとの震度（`Pref/Area/City`）。DMDATA の XML 経路でのみ入る。
   *
   * 区域（一次細分区域）と観測点の**あいだの粒度**。気象庁の発表単位のひとつで、
   * カードの詳細表示で区域の下にぶら下げる。P2PQuake 経路は配信しないため undefined。
   */
  cities?: JMAQuakeCity[]
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
   * 固定付加文（その他）（`VarComment/Text`）の原文。DMDATA 経路でのみ得られる。
   *
   * 長周期地震動の同じ枠（{@link JMALpgm.varCommentText}）と揃えた。観測点名の `＊` を
   * 説明する定型文はここへ入らない（アプリは印をバッジに置き換えている。
   * → `readVarCommentTextForDisplay`）。
   */
  varCommentText?: string
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
  /**
   * 見出し文（`Head/Headline/Text`）。気象庁が電文へ添えた一文の要約。
   *
   * **読んで持つが、画面には出していない。** 本文や既読の要素に無い事実は含まない
   * （実電文で確かめた）。→ `dmdataParser.ts` の `readHeadlineText`
   */
  headline?: string
}

export type TsunamiGrade = 'MajorWarning' | 'Warning' | 'Watch' | 'Forecast' | 'Unknown'

export interface TsunamiStation {
  name: string
  code: string
  highTideDateTime?: string
  arrivalTime?: string
  arrivalCondition?: string
  /**
   * 続報での位置づけ（`FirstHeight/Revise`）。「追加」または「更新」。
   * 意味と扱いは {@link TsunamiObservation.firstHeightRevise} に同じ。
   */
  revise?: string
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
  /**
   * 最大波を推定した時刻（`MaxHeight/DateTime`）。「推定中」では出現しない。
   * 意味は観測点側の {@link TsunamiObservation.maxHeightDateTime} と同じ。
   *
   * **読んで持つが、画面には出していない。** 推定の行が出しているのは到達予想時刻と
   * 説明で、そこへ 3 つ目の時刻を並べると何の時刻か読み取れなくなる。観測点の行に
   * 出しているのは、あちらが実測値でいつの観測かが値の意味を変えるため。
   */
  maxHeightDateTime?: string
  /**
   * 続報での位置づけ（`FirstHeight/Revise` / `MaxHeight/Revise`）。「追加」または「更新」。
   * **読んで持つが、画面には出していない**（観測点側の同名フィールドと同じ扱い）。
   */
  firstHeightRevise?: string
  maxHeightRevise?: string
}

export interface TsunamiSourceEarthquake extends HypocenterAreaDetail {
  hypocenterName: string
  magnitude?: number
  /**
   * マグニチュードの種別（`jmx_eb:Magnitude@type`）。`Mj` は気象庁マグニチュード、
   * `M` は気象庁以外の機関が決めた値（`source` と対で現れる）。
   *
   * **画面には出さない。** 気象庁自身も本文では「Ｍ７．６」としか書かないため、種別を
   * 添えると発表より詳しい顔になる。電文が述べている事実として持つだけ。
   */
  magnitudeType?: string
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
   * 地震発現時刻（`Earthquake/ArrivalTime`）。観測点が地震を検知した時刻で、国外の地震で
   * 発現時刻が不明なときは発生時刻の値が入る（電文解説資料 Ⅱ.11 2-2）。
   *
   * **`originTime` と入れ替えないこと。** 地震情報側（`parseEarthquakeFromXml`）は
   * こちらを優先して地震の時刻に充てているが、津波の `originTime` は
   * `isTsunamiContinuation`（`utils/tsunami.ts`）が**識別子を持たない電文の同一性判定**に
   * 使っている。中身を差し替えると、続報が別の津波として立つ。
   */
  arrivalTime?: string
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
    /** 続報での位置づけ（`FirstHeight/Revise`）。「追加」または「更新」。 */
    revise?: string
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
   * 潮位観測点コード（`Station/Code`）。**予想区域の観測点（{@link TsunamiStation.code}）は
   * 読んでいたのに、観測情報側は記録にしか使っていなかった。** 扱いを揃える。
   * 引き当ては名前で行っているので画面には出さない。
   */
  code?: string
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
  /**
   * 第1波の続報での位置づけ（`FirstHeight/Revise`）。値と扱いは {@link maxHeightRevise} と
   * 同じ軸で、そちらが最大波、こちらが第1波。
   *
   * **新規／更新の言い分け（読み上げ）には使わないこと。** 理由も同上。
   */
  firstHeightRevise?: string
  /**
   * 最大波を観測した時刻（`MaxHeight/DateTime`）。
   *
   * **波高の数値だけでは、それがいつの観測値かが分からない。** 続報で値が変わらないとき、
   * 観測し直して同じだったのか前の値が据え置かれているのかを読み取れる唯一の手がかり。
   * 「観測中」「微弱」ではこの要素ごと出現しない（電文解説資料 Ⅱ.12 1-2-2-2）。
   */
  maxHeightDateTime?: string
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
  /**
   * 電文の運用種別（`Control/Status`）。訓練・試験のときだけ入る。→ {@link TelegramOperationStatus}
   */
  operationStatus?: TelegramOperationStatus
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
  /**
   * 気象庁が電文に添えた本文（`Body/Text`）。**発表報でのみ入る。**
   *
   * 津波予報（若干の海面変動）では区域に波高も到達時刻も付かないため、
   * **いつ来ていつまで続くかはこの文にしか無い**：
   *
   *     若干の海面変動が予想される時刻は、早い沿岸で０２日１０時３０分頃です。
   *     　これらの沿岸では今後１日程度は若干の海面変動が継続する可能性が高いと考えられます。
   *
   * **`cancelText` と同じ要素だが別の中身。** 電文解説資料は「自由文形式で追加的に情報を
   * 記載する。**例えば**情報形態が"取消"の場合に取消しの概要等を記載する」と定めており、
   * 取消はあくまで例。かつては取消のときだけ拾っており、**例を定義として読んでいた**。
   *
   * 付加文 2 種（`warningComment` / `freeText`）とも別物で、同じ電文に 4 つとも入りうる。
   */
  bodyText?: string
  /**
   * 気象庁の自由付加文（`Comments/FreeFormComment`）の原文。DMDATA 経路でのみ得られる。
   *
   * 上の `warningComment` が等級ごとの定型文なのに対し、こちらは電文ごとに書き起こされる
   * 本文（「［予想される津波の高さの解説］……」等）。**地震情報・長周期地震動観測情報では
   * 読んで画面に出していたのに、津波だけ落ちていた。**
   *
   * 全角スペースで整形された表が入ることがあるため、**改行と空白をそのまま保持する**
   * （前後の空行だけ落とす）。表示側も `whitespace-pre-wrap` で受けること。
   */
  freeText?: string
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
  /**
   * 電文が名乗る情報名（`Head/Title`）。**その報が何を出しているか**を気象庁の言葉で表す。
   *
   * 実電文では VTSE41 が「大津波警報・津波警報・津波注意報」のように発表中の等級を並べ、
   * VTSE51 は「津波観測に関する情報」と「各地の満潮時刻・津波到達予想時刻に関する情報」を
   * 名乗り分ける。**種別コードだけでは、いま画面に出ているのがどちらか分からない。**
   *
   * **`Control/Title`（種別の固定名。津波では末尾に記号が付く「津波情報a」）とは別物。**
   * 読み取りは `readInfoName`（`services/dmdataParser.ts`）に集約している。
   */
  infoName?: string
  areas: TsunamiArea[]
  observations?: TsunamiObservation[]
  /**
   * **観測状況を確定した時刻**（`Head/TargetDateTime`）。津波観測情報（VTSE51）と
   * 沖合の津波観測に関する情報（VTSE52）でのみ入る。
   *
   * この要素は種別で意味が変わり（電文解説資料 Ⅰ.（ⅱ）3）、観測情報では「いつ時点の
   * 観測状況か」を表す。**発表時刻とは別物**で、実電文 135 通では VTSE52 で 60〜360 秒、
   * VTSE51 で 0〜120 秒さかのぼる。最大 6 分前の値を「いまの高さ」として見せると
   * 誤解を招くため、観測欄に時点を添えて出す。
   *
   * 津波警報・注意報・予報（VTSE41）では読まない —— そちらは観測情報ではなく、
   * 実電文でも `ReportDateTime` と一致していた（差 0 秒・8 通）。
   *
   * **個々の観測点が持つ時刻（`TsunamiObservation.arrivalTime`）とは別物。**
   * あちらは第 1 波の到達時刻で、こちらは電文全体の基点。
   */
  observationDateTime?: string
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
  /**
   * 主要動の到達予測時刻（`Area/ArrivalTime`）。**到達済みの区域では出ない** ——
   * その場合は代わりに `arrived` が立つ（次項）。
   */
  arrivalTime: string | null
  /**
   * 区域の `Condition`（「既に主要動到達と推測」）を読んだ結果。
   *
   * **`arrivalTime` と排他。** 気象庁は到達予測時刻を過ぎた区域について、時刻を落として
   * こちらを出す（電文解説資料 Ⅱ.21 2-1-5-3-6・2-1-5-3-7）。
   *
   * **判定にこのフィールドを直接使わないこと。`isEewAreaArrived`（`utils/eew.ts`）を通す。**
   * 同じ事実を電文は 2 通りで伝えており、`Condition` を配信するのは DMDATA だけ。P2PQuake は
   * 種別コード（01/11）の側でしか伝えてこないので、ここだけを見ると standard 版で到達済みの
   * 区域が「時刻も印も持たない区域」に落ちて画面から消える。
   */
  arrived?: boolean
  lgIntTo?: LpgmClass  // 地域別予想長周期地震動階級。電文に含まれない場合は undefined
  /**
   * 上限を定めない予測（電文の `To="over"`）だったか。意味と扱いは `scaleToOrAbove` と同じで、
   * **語だけが違う** —— 気象庁の表現は「階級3程度以上」（→ `getLpgmClassLabelWithApproxAbove`）。
   */
  lgIntToOver?: boolean
}

/**
 * 震源要素の精度（電文の `Hypocenter/Accuracy`。電文解説資料 Ⅱ.21 1-4-2）。
 *
 * 値は電文の属性そのまま。**アプリ側で意味へ畳まない** —— ランクの意味は気象庁が改定しうるし、
 * 部内システム専用と断られている値もある（`epicenterRank2` の 1・9 以外、`magnitudePoints`）。
 * 表示に使う語は `utils/eew.ts` の対応表が単一情報源。
 *
 * 実電文 405 通（2026-06〜09）ではすべての報に出現する。
 */
export interface EEWAccuracy {
  /** 震央位置の精度ランク（0〜8）。**1 は「P波／S波レベル超え、IPF 法（1 点）、または仮定震源要素」**。 */
  epicenterRank?: number
  /** 震央位置の精度ランク 2（0〜4・9）。**9 は「推定震源とマグニチュードはこれ以降変化しない」**。 */
  epicenterRank2?: number
  /** 深さの精度ランク（0〜8）。値の意味は `epicenterRank` と同じ表。 */
  depthRank?: number
  /** マグニチュードの精度ランク（0・2〜6・8）。8 は「P波／S波レベル超え、または仮定震源要素」。 */
  magnitudeRank?: number
  /** マグニチュード計算に使った観測点数（0〜5。**5 は「5 点以上」**、1 は「1 点、P波／S波レベル超え、または仮定震源要素」）。 */
  magnitudePoints?: number
}

/**
 * 最大予測値の変化（電文の `Body/Intensity/Forecast/Appendix`。電文解説資料 Ⅱ.21 2-1-4）。
 *
 * **気象庁が「変わったか」と「なぜ変わったか」を直接言っている。** アプリは続報どうしを
 * 比べて変化を推定しているが、それは代理指標で、電文はこちらを正としている。
 *
 * 震度予測・長周期階級予測をどちらも行っていない報では要素ごと出現しない（実電文 405 通中 318 通）。
 */
export interface EEWForecastChange {
  /** 最大予測震度の変化。0＝ほとんど変化なし／1＝1.0 以上大きくなった／2＝1.0 以上小さくなった。 */
  maxInt?: 0 | 1 | 2
  /** 最大予測長周期地震動階級の変化。値の意味は `maxInt` と同じ。 */
  maxLgInt?: 0 | 1 | 2
  /**
   * 変化の理由。0＝変化なし／1＝主としてＭが変化（1.0 以上）／2＝主として震央位置が変化（10.0km 以上）／
   * 3＝Ｍと震央位置の複合／4＝震源の深さが変化（30.0km 以上）／**9＝PLUM 法による予測により変化**。
   */
  reason?: 0 | 1 | 2 | 3 | 4 | 9
}

export interface EEWAlert {
  /**
   * 見出し文（`Head/Headline/Text`）。→ {@link JMAQuake.headline}（扱いも同じ）
   */
  headline?: string
  /**
   * 電文が名乗る情報名（`Head/Title`）。→ {@link JMATsunami.infoName}（読み取りも扱いも同じ）
   *
   * **読んで持つだけで画面には出さない。** アプリが受信する VXSE45 では実電文 8 通すべてが
   * 「緊急地震速報（地震動予報）」の 1 種類で、報ごとに変わらない。しかも画面の見出しは
   * 電文の区分（`severity`）から「地震動予報」「緊急地震速報（警報）」を組み立てており
   * （`docs/spec/eew-spec.md` §3）、並べると同じ語が二重に出る。
   *
   * **区分の判定にも使わない** —— そちらは電文のコードで読む。
   */
  infoName?: string
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
  /**
   * 電文の運用種別（`Control/Status`）。訓練・試験のときだけ入る。→ {@link TelegramOperationStatus}
   *
   * **`test` と混同しないこと。** `test` は流すかどうかの抑制で、こちらは画面に印を出すため。
   */
  operationStatus?: TelegramOperationStatus
  /** 震源要素の精度（`Hypocenter/Accuracy`）。DMDATA の XML 経路でのみ入る。 */
  accuracy?: EEWAccuracy
  /** 震央が内陸か海域か（`Hypocenter/Area/LandOrSea`）。値は電文どおり。 */
  landOrSea?: '内陸' | '海域'
  /**
   * 短縮用震央地名（`Hypocenter/Area/ReduceName`）。例: 「青森県東方沖」に対して「青森東方沖」。
   *
   * **通常の震央地名（`hypocenter.name`）を置き換えるものではない。** 幅が足りない場所で
   * 代わりに出すための短い呼び方で、気象庁が電文に載せている。
   */
  reduceName?: string
  /**
   * 短縮用震央地名コード（`Area/ReduceCode`）。上の `reduceName` と対。
   * **画面には出さない**（名前の側を出している）。
   */
  reduceCode?: string
  /** 最大予測値の変化（`Intensity/Forecast/Appendix`）。 */
  forecastChange?: EEWForecastChange
}

/**
 * 周期帯ごとの長周期地震動階級と絶対速度応答スペクトル（電文解説資料 Ⅱ.37 2-1-6・2-1-7）。
 *
 * **長周期地震動は「周期帯ごとに効き方が違う」ことが本体。** 電文は 1〜7 の 7 帯
 * （1.5〜2.5 秒台 … 7.5〜8.5 秒台）を持ち、帯が長いほど高い建物が大きく揺れる。
 * 全体の階級（{@link LpgmPoint.lgInt}）だけでは、その揺れが低層寄りか高層寄りかが出せない。
 */
export interface LpgmPeriodBand {
  /** 電文の `PeriodicBand`（1〜7）。中心周期は 2 秒台から 8 秒台まで 1 秒刻み */
  band: number
  /** その周期帯の長周期地震動階級。0（該当なし）もそのまま持つ */
  lgInt?: number
  /** その周期帯の絶対速度応答スペクトル（cm/s） */
  sva?: number
}

export interface LpgmPoint {
  code: string      // 観測点コード（例: "0122401"）
  name: string      // 観測点名（例: "新千歳空港"）
  pref: string      // 都道府県名（電文の Pref/Name から補う）
  /**
   * その観測点が属する一次細分区域名（電文の `Area/Name` から補う）。
   *
   * **電文の入れ子からしか拾えない。** 座標表が観測点について持つのは緯度・経度と所属区域で、
   * 長周期地震動観測点はそこに載っているとは限らない（→ {@link EarthquakePoint.area} と同じ事情）。
   * ここを落とすと、カードの震度一覧に相当する「県 → 区域 → 観測点」の入れ子で観測点の
   * 行き先が決まらない。
   */
  area?: string
  lgInt: number     // 長周期地震動階級 1〜4
  /**
   * その観測点の震度（`IntensityStation/Int`）。
   *
   * **長周期の電文は震度も持っている。** 階級だけを出すと「階級4 なのに震度は 3 だった」
   * ような、高層階だけが大きく揺れた状況を伝えられない（→ {@link JMALpgm.category} が
   * 地域単位で言おうとしているのと同じことを、観測点単位で言える）。
   */
  int?: IntensityScale
  /** 絶対速度応答スペクトルの最大値（`Sva`。cm/s） */
  sva?: number
  /** 周期帯ごとの内訳。→ {@link LpgmPeriodBand} */
  periods?: LpgmPeriodBand[]
  /**
   * 気象庁以外が運用する観測点（長周期地震動観測点の側。電文では名前の末尾に `＊`）。
   * 扱いは震度観測点と同じ —— 説明は {@link EarthquakePoint.nonJma} にまとめてある。
   */
  nonJma?: boolean
}

/**
 * 長周期地震動観測情報が持つ震源の要素（`Body/Earthquake/Hypocenter`）。
 *
 * **読んで持つが、画面には出していない。** 長周期の情報は地震カードに紐づけて出しており、
 * 震源・規模はそちらが同じ地震の値を出すため重複する。**電文が持っているものを落とさない**
 * ために保持する（地震情報と突き合わせて訂正に気づく、長周期が先に届いた場合に出す、
 * といった使い道はここでは実装していない）。
 */
export interface LpgmHypocenter extends HypocenterAreaDetail {
  /**
   * 震央地名。**詳細震央地名（`Area/DetailedName`）を優先し、無ければ `Area/Name`**
   * （地震情報・津波と同じ規則）。国外の地震では `Name` が「中米」のように粗い。
   */
  name: string
  /**
   * 震源決定機関（`Hypocenter/Source`）。→ {@link TsunamiSourceEarthquake.source}
   * （意味も扱いも同じ。**読んで持つだけで、いまはどこからも使っていない**）
   */
  source?: string
}

/**
 * 震源の位置要素（`Hypocenter/Area`）のうち、電文種別をまたいで同じ意味を持つもの。
 *
 * **1 つにまとめてあるのは、種別ごとに読む項目がずれるのを防ぐため。** 同じ `Area` を
 * 地震情報・長周期地震動観測情報・津波の 3 経路が別々に読んでおり、津波だけ座標と
 * 震央補助表現の材料が落ちていた（震央補助表現の文そのものは読んでいた）。
 * 読み取りは `readHypocenterAreaDetail` の 1 箇所に集約してある。
 */
export interface HypocenterAreaDetail {
  /** 震央地名コード（`Area/Code`） */
  code?: string
  /** 詳細震央地名コード（`Area/DetailedCode`）。国外の地震で `DetailedName` と対で入る */
  detailedCode?: string
  latitude?: number
  longitude?: number
  /** 深さ（km）。読めないときは持たせない。**`0` は「ごく浅い」という有効値** */
  depth?: number
  /**
   * 震央補助表現（`Area/NameFromMark`。例:「御前崎の北東４０ｋｍ付近」）。
   *
   * 日本近海で発生し、津波警報・注意報を発表した地震にだけ付く（電文解説資料 Ⅱ.13 2-3-1-4）。
   * **震央地名より具体的に場所が分かる** ——「駿河湾」だけでは自分との位置関係が掴めない。
   */
  nameFromMark?: string
  /**
   * 震央補助表現の構成要素（`MarkCode` / `Direction` / `Distance`）。上の文の材料で、
   * 目印のコード・目印から見た震央の 16 方位・目印から震央までの距離（km。電文は 10km 刻み）。
   */
  markCode?: string
  direction?: string
  distanceKm?: number
}

/**
 * 都道府県ごとの最大値（電文の `Pref/MaxInt`・`Pref/MaxLgInt`）。
 *
 * **区域の値から計算し直さない。** 気象庁が都道府県単位の最大値を電文に書いているので、
 * それを使う。区域から積み上げると、区域を 1 つでも読み落としたときに静かにずれる
 * （電文が直接述べている事実を代理値で置き換える形になる）。
 */
export interface LpgmPref {
  code: string
  name: string
  maxLgInt: number
  maxInt?: IntensityScale
  /**
   * 続報でこの都道府県がどう変わったか（電文の `Revise`）。→ {@link EarthquakePoint.revise}
   * （意味も扱いも同じ。**読んで持つだけで、いまはどこからも使っていない**）
   */
  revise?: string
}

export interface LpgmRegion {
  code: string      // 一次細分区域コード（例: "102"）
  name: string      // 一次細分区域名（例: "石狩地方南部"）
  maxLgInt: number  // 区域内最大長周期地震動階級 1〜4
  /** その区域が属する都道府県名（電文の `Pref/Name` から補う） */
  pref?: string
  /** 区域内の最大震度（`Area/MaxInt`）。階級と並べると、揺れの高さと長さの差が出る */
  maxInt?: IntensityScale
  /**
   * 続報でこの区域がどう変わったか（電文の `Revise`）。→ {@link EarthquakePoint.revise}
   * （意味も扱いも同じ。**読んで持つだけで、いまはどこからも使っていない**）
   */
  revise?: string
}

export interface JMALpgm {
  id: string
  eventId: string     // VXSE51/52/53/62 が共有する 14 桁タイムスタンプ。lpgmByEventId の Map キー
  time: string
  /**
   * 電文の運用種別（`Control/Status`）。訓練・試験のときだけ入る。→ {@link TelegramOperationStatus}
   *
   * **全種別に付ける。** ヘッダ部の要素なので、どの電文にも同じ形で入る。種別によって
   * 付けたり付けなかったりすると、試験報の印が電文の種類次第で出たり出なかったりする。
   */
  operationStatus?: TelegramOperationStatus
  /**
   * 電文が名乗る情報名（`Head/Title`）。読み取りは {@link JMATsunami.infoName} と同じ。
   *
   * **読んで持つだけで画面には出さない。** 実電文 8 通すべてが「長周期地震動に関する観測情報」の
   * 1 種類で、報ごとに変わらない（津波と違い名乗り分けが無い）。出しても情報が増えない。
   */
  infoName?: string
  originTime: string  // TTS 読み上げテキスト用
  maxClass: number    // 1〜4
  cancelled: boolean
  points?: LpgmPoint[]    // 観測点別階級（取消電文では undefined）
  regions?: LpgmRegion[]  // 一次細分区域別最大階級
  prefs?: LpgmPref[]      // 都道府県別最大階級・最大震度（→ {@link LpgmPref}）
  /**
   * 全国の最大震度（`Intensity/Observation/MaxInt`）。
   *
   * **読んで持つが、画面には出していない。** 同じ地震の最大震度は地震カードが出すため。
   * 区域・観測点ごとの震度（{@link LpgmRegion.maxInt} / {@link LpgmPoint.int}）は
   * 階級と並べる意味があるので出している。
   */
  maxInt?: IntensityScale
  /** 地震の規模（`jmx_eb:Magnitude`）。数値で求まらないときは持たせない。画面には出していない */
  magnitude?: number
  /**
   * 規模が数値で求まらないときに気象庁が添える説明（`jmx_eb:Magnitude@description`）。
   * 意味は {@link TsunamiSourceEarthquake.magnitudeCondition} と同じ（解説資料 Ⅱ.37 2-4）。
   */
  magnitudeCondition?: string
  /** マグニチュードの種別（`@type`）。→ {@link TsunamiSourceEarthquake.magnitudeType} */
  magnitudeType?: string
  /** 地震発現時刻（`Earthquake/ArrivalTime`）。発生時刻（{@link originTime}）と別物。画面には出していない */
  arrivalTime?: string
  /** 震源の要素。→ {@link LpgmHypocenter} */
  hypocenter?: LpgmHypocenter
  /**
   * 固定付加文（`Comments/ForecastComment/Text`）。
   * 例:「この地震について、緊急地震速報を発表しています。」
   */
  forecastText?: string
  /** 固定付加文（その他。`Comments/VarComment/Text`） */
  varCommentText?: string
  /**
   * 自由付加文（`Comments/FreeFormComment`）。階級ごとの揺れの言い換えと、
   * 詳細ページへの案内が入る。**改行と空白を保つ**（地震情報側と同じ扱い）。
   */
  freeFormText?: string
  /**
   * 気象庁の詳細ページ（`Comments/URI`）。波形とスペクトルが載る。
   *
   * **アプリが出せない情報の在りかを、電文自身が示している。** 周期帯ごとの階級までは
   * 出せても波形は出せないので、そこへ行ける導線を残す。
   */
  uri?: string
  /**
   * 見出し文（`Head/Headline/Text`）。→ {@link JMAQuake.headline}（扱いも同じ）
   */
  headline?: string
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
/**
 * 巨大地震に関する情報（南海トラフ・後発地震）が共通して持つ要素。
 *
 * **3 つの型が別々に同じ要素を持つ形にしない。** 南海トラフ臨時情報（VYSE50）・
 * 南海トラフ地震関連解説情報（VYSE51/52）・北海道・三陸沖後発地震注意情報（VYSE60）は
 * 電文の構造が同じで、実際に「解説情報だけが要約を読んでいて、臨時情報と後発地震は
 * 読んでいない」という非対称ができていた。
 */
export interface EarthquakeInfoMeta {
  /**
   * 見出し文（`Head/Headline/Text`）。本文（`body`）の要約で、気象庁が自分で書いたもの。
   *
   * **本文が長い**（1000 字を超えることがある）ため、帯では要約を先に出して本文を続ける。
   * 本文に無い事実は含まない —— 実電文で確かめた。
   */
  summary?: string
  /**
   * 次回発表予定（`Body/NextAdvisory`）。
   *
   * 「次回の情報発表は、２１時頃を予定しています。なお、新たな変化を観測した場合には
   * 随時発表します。」のような文。**次にいつ情報が出るかは、この要素にしか無い。**
   * 続報を待つべきかどうかの判断に直結するので画面に出す。
   */
  nextAdvisory?: string
  /**
   * 参考情報（`Body/EarthquakeInfo/Appendix`）。情報の種類・発表条件・背景の解説。
   *
   * **電文ごとに変わらない固定文**で、長い。初めてこの情報を受け取る人には要るが、
   * 毎報そのまま積むと本文が埋もれるため**折りたたんで出す**。
   */
  appendix?: string
  /**
   * 情報の種別（`Body/EarthquakeInfo/InfoKind`）と、その上位分類（同要素の `@type`）。
   *
   * **読んで持つが、画面には出していない。** アプリは電文種別で既に見分けており、
   * 「南海トラフ地震臨時情報」のような名称は `headline`（`Head/Title`）が伝えている。
   */
  earthquakeInfoKind?: string
  earthquakeInfoType?: string
}

export interface JMANankai extends EarthquakeInfoMeta {
  id: string
  time: string
  eventId: string
  /**
   * 電文の運用種別（`Control/Status`）。訓練・試験のときだけ入る。→ {@link TelegramOperationStatus}
   *
   * **全種別に付ける。** ヘッダ部の要素なので、どの電文にも同じ形で入る。種別によって
   * 付けたり付けなかったりすると、試験報の印が電文の種類次第で出たり出なかったりする。
   */
  operationStatus?: TelegramOperationStatus
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
export interface JMANankaiCommentary extends EarthquakeInfoMeta {
  id: string
  time: string
  eventId: string
  /**
   * 電文の運用種別（`Control/Status`）。訓練・試験のときだけ入る。→ {@link TelegramOperationStatus}
   *
   * **全種別に付ける。** ヘッダ部の要素なので、どの電文にも同じ形で入る。種別によって
   * 付けたり付けなかったりすると、試験報の印が電文の種類次第で出たり出なかったりする。
   */
  operationStatus?: TelegramOperationStatus
  /**
   * 気象庁の地震関連情報番号コード（`Body/EarthquakeInfo/InfoSerial/Code`）。
   * `200`=定例解説／`210`=臨時解説（次回も臨時）／`219`=臨時解説（次回は定例）。
   * 名称（`serialName`）はどちらの臨時解説も「臨時解説」で、次回の予定だけがコードで分かれる。
   */
  serialCode: string
  serialName: string // '臨時解説' | '定例解説'
  headline: string   // Head/Title 例: '南海トラフ地震関連解説情報（第１号）'
  body: string       // Body/EarthquakeInfo/Text の本文（1000 字を超えることがある）
  // 取消電文（InfoType=取消）。解説情報に「解除」の概念は無く実電文でも未発表だが、
  // 来たときに帯を消せるようにしておく（取消を無視すると古い帯を出し続けることになる）
  cancelled: boolean
  reportDateTime: string
  expireAt: string   // reportDateTime + 7日。定例解説は月 1 回来て自然に消えないため期限で畳む
}

// 北海道・三陸沖後発地震注意情報 (VYSE60)
export interface JMAKohatsu extends EarthquakeInfoMeta {
  id: string
  time: string
  eventId: string
  /**
   * 電文の運用種別（`Control/Status`）。訓練・試験のときだけ入る。→ {@link TelegramOperationStatus}
   *
   * **全種別に付ける。** ヘッダ部の要素なので、どの電文にも同じ形で入る。種別によって
   * 付けたり付けなかったりすると、試験報の印が電文の種類次第で出たり出なかったりする。
   */
  operationStatus?: TelegramOperationStatus
  headline: string
  body: string
  cancelled: boolean
  /** 取消電文か（意味は `JMANankai.retracted` に同じ）。 */
  retracted?: boolean
  reportDateTime: string
  expireAt: string  // reportDateTime + 7日
}

/**
 * 地震・津波に関するお知らせ（VZSE40）。
 *
 * **地震そのものの情報ではなく、観測や配信の都合を伝える運用連絡。** 実配信 13 か月 43 通の内訳は
 * 半分が「〈県〉の自治体震度データ入電停止のお知らせ」——保守や停電で、その県の自治体震度観測点が
 * 一定期間だけ気象庁に入らなくなるという予告で、**何点中何点が落ちるかまで本文に書いてある**。
 * 残りは震度観測点パラメータの変更・電文配信試験の開始と終了・訓練の実施予告など。
 *
 * **画面の見え方が変わる理由を説明する情報**なので拾う。これを読まないと、観測点が減っていても
 * 「アプリが壊れた」としか見えない。**訓練報・試験報がいつ流れるかを事前に知る唯一の経路**でもある
 * （電文自身が「配信試験の開始と終了は本電文でお知らせします」と書いている。運用種別の印は
 * → {@link TelegramOperationStatus}）。
 *
 * 構造は単純で、見出し（`Head/Headline/Text`）と自由文（`Body/Text`）だけ。段階も等級も持たない。
 */
export interface JMAQuakeNotice {
  id: string
  time: string
  eventId: string
  /**
   * 電文の運用種別（`Control/Status`）。訓練・試験のときだけ入る。→ {@link TelegramOperationStatus}
   *
   * **全種別に付ける。** ヘッダ部の要素なので、どの電文にも同じ形で入る。
   */
  operationStatus?: TelegramOperationStatus
  /** `Head/Headline/Text`。例: 「和歌山県の自治体震度データ入電停止のお知らせ」 */
  headline: string
  /** `Body/Text`。自由文。改行と全角スペースの整形を保つ（記書きの体裁が崩れる） */
  body: string
  /** 取消電文（`Head/InfoType` が「取消」）。帯を引っ込める */
  cancelled: boolean
  reportDateTime: string
  /** reportDateTime + 7 日。帯を常駐させないための表示上の都合（気象庁が定めた期限ではない） */
  expireAt: string
}

/** {@link JMAEarthquakeCount} の 1 区間。 */
export interface JMAEarthquakeCountItem {
  /**
   * 区間の種類（`Item/@type`）。実サンプルで確認できるのは「地震回数」「１時間地震回数」
   * 「累積地震回数」の 3 つ。**値を推測で増やさない** —— 読めない type はそのまま持ち、
   * 画面はコードではなく電文の語を出す。
   */
  type: string
  startTime: string
  endTime: string
  /** その区間の地震回数（有感・無感の合計） */
  number: number
  /** そのうち有感（震度1以上）の回数 */
  feltNumber: number
}

/**
 * 地震回数に関する情報（VXSE60）。
 *
 * 群発地震のように**地震が多発したとき**に、一定区間ごとの地震回数と有感回数を伝える。
 * 気象庁の一般向けページでは独立項目ではなく「その他の情報」に含まれる扱い（同じ枠に
 * 顕著な地震の震源要素更新＝VXSE61 も入る）。
 *
 * **この情報が埋める穴**: アプリが地震カードで出しているのは震度1以上を観測した地震だけ。
 * 群発では震度2以下の小さな地震が大量に起きていて、その総数はどこにも出ていない。実サンプル
 * （2008 年の伊豆半島東方沖）では 21 時間で 1704 回・うち有感 1 回。電文の自由文自身が
 * 「震度３以上の場合は震源・震度情報で、震度２以下の場合は本情報で回数をまとめて発表します」
 * と説明している。
 *
 * **実配信では観測できていない。** 電文一覧 13 か月とアーカイブ 7 日（能登本震とその余震・
 * 日向灘 2 回・トカラ群発）で 0 通。型と読み取りは**気象庁公式のサンプル電文**
 * （`jmaxml_20260723_Samples.zip` の `32-35_*_VXSE60.xml`）に拠っている。
 */
export interface JMAEarthquakeCount {
  id: string
  time: string
  /** 群発の始まりを指す識別子。個々の地震カードの `eventId` とは対応しない */
  eventId: string
  /**
   * 電文の運用種別（`Control/Status`）。訓練・試験のときだけ入る。→ {@link TelegramOperationStatus}
   */
  operationStatus?: TelegramOperationStatus
  /** `Head/Headline/Text`。例: 「地震回数に関する情報をお知らせします。」 */
  headline: string
  /** 区間ごとの回数。電文に現れた順を保つ（累積が最後に来る） */
  items: JMAEarthquakeCountItem[]
  /** `Body/NextAdvisory`。次回発表の予定を伝える文 */
  nextAdvisory?: string
  /** `Body/Comments/FreeFormComment`。どこで何が起きているかの説明が入る */
  freeText?: string
  /** 取消電文（`Head/InfoType` が「取消」） */
  cancelled: boolean
  /** 取消しの理由（`Body/Text`）。取消電文だけが持つ */
  cancelText?: string
  reportDateTime: string
  /**
   * reportDateTime + 7 日。**帯を常駐させないための表示上の都合**（気象庁が定めた期限ではない）。
   *
   * 気象庁はこの情報の終わりを宣言しない —— 群発が収まれば発表が止まるだけ。畳む契機を
   * 次報と取消だけにすると、収まったあとも帯が居座る。
   */
  expireAt: string
}

/** {@link JMAEstimatedIntensity} の凡例 1 行。電文の先頭が自分で名乗ってくる。 */
export interface JMAEstimatedIntensityGrade {
  /** 階級震度の整数部（4〜7） */
  scale: number
  /** 弱・強の別。`'none' | 'weak' | 'strong'` */
  modifier: 'none' | 'weak' | 'strong'
  /** この階級に対応する計測震度の下限（**0.1 単位の整数**。35 なら計測震度 3.5） */
  lower: number
  /** 同・上限（44 なら 4.4） */
  upper: number
}

/**
 * 推計震度分布図作図用データ（IXAC41）。
 *
 * 観測した震度と地盤増幅度から、震度計の無い場所の震度も推計した**面的な分布**。
 * 250m メッシュ（世界測地系）で、推計震度4以上の範囲を示す。最大震度5弱以上を観測した地震に
 * ついて、地震発生から概ね 15 分後に発表される。
 *
 * **アプリが自前で描いている震度の面（`QuakeIntensitySurfaceGL`）の公式版**にあたる。あちらは
 * 観測点の値を逆距離加重で補間しただけだが、こちらは地盤増幅度と緊急地震速報の震度予測技術まで
 * 織り込んだ気象庁の推計。
 *
 * **この電文だけ BUFR（二進形式）で届く。** DMDATA は他の種別と違って JSON 変換版を配らない。
 * 512KiB を超えると分割配信され、受け側で結合してから読む（→ `bufrTelegramAssembly.ts`）。
 *
 * **セルは列指向の型付き配列で持つ。** 実電文の最大は 364,993 セル（2026-04-20 の M7.5）で、
 * 1 セル 1 オブジェクトにすると桁違いに重くなる。震源カタログの点群（`map-rendering-spec.md`
 * §16）が同じ持ち方をしている。
 */
export interface JMAEstimatedIntensity {
  id: string
  /** 発表時刻（電文ヘッダの時刻・ISO） */
  time: string
  /**
   * 地震発現時刻（ISO・分まで）。**この電文は `eventId` を持たない**ので、地震カードとの
   * 結び付けはこの時刻で行う。
   *
   * **発生時刻（`OriginTime`）ではなく発現時刻（`ArrivalTime`）。** 資料の表記は
   * 「年月日（地震時刻、ＵＴＣ）」でどちらとも書かれていないが、**両者が 1 分ずれた実電文
   * 2 例（2026-04-20・2026-06-26）で照合したところ、いずれも `ArrivalTime` と一致した。**
   * これは {@link JMAQuake.earthquake}`.time` が採っているのと同じ時刻なので、
   * 地震カードとは分単位でそのまま突き合わせられる（→ `matchEstimatedIntensity`）。
   */
  arrivalTime: string
  /**
   * 震源。**緯度経度は度・深さは km の実数**（電文は 0.01 度単位の整数で持つが、
   * 読み取りの時点で度へ直してある）。
   */
  hypocenter: { lat: number; lon: number; depthKm: number }
  /** マグニチュード。読めないときは `NaN`（→ `magnitudeCondition`） */
  magnitude: number
  /**
   * 数値にならない規模の説明。電文は全ビット 0 を「Ｍ不明」、全ビット 1 を
   * 「Ｍ８を超える巨大地震」と定めている（別紙4 ※1）。**地震情報・津波の
   * `magnitudeCondition` と同じ役割**なので、表示は同じ述語（`formatters.ts`）を通す。
   */
  magnitudeCondition?: string
  /** 震央地名番号（気象庁コード表 6）。名前は持たない */
  areaCode: number
  /** 電文の種類（0=通常）。0 以外は訓練等。実配信 13 か月では 0 しか観測できていない */
  telegramKind: number
  /** 階級震度と計測震度の対応表。**電文が持っている凡例をそのまま使う**（自前の階級表を当てない） */
  grades: JMAEstimatedIntensityGrade[]
  /** セル数。下の 3 本の配列はこの長さぶんだけ有効（確保長はこれ以上になりうる） */
  count: number
  /** セル南西端の緯度 */
  lat: Float32Array
  /** セル南西端の経度 */
  lon: Float32Array
  /** そのセルの計測震度（**0.1 単位の整数**。42 なら計測震度 4.2） */
  si: Uint8Array
  /**
   * 塗りがある範囲（セルの外接矩形）。**カメラの寄り先に使う。**
   *
   * 復号のときに 1 度だけ求める —— 36 万セルを描画のたびに走査し直さないため。
   * `north`/`east` はセルの北東端まで含む（南西端の最大値にセル 1 つ分を足したもの）。
   */
  bounds: { south: number; north: number; west: number; east: number }
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
    | 'quakeNotice' | 'earthquakeCount' | 'estimatedIntensity'
  rawHead?: unknown
  rawBody: unknown
  errorMessage?: string
}
