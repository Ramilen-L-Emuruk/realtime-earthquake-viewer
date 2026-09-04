import type { JMAQuake, IssueType } from '../types/earthquake'
import { isAreaPoint, type AreaPrefIndex } from './quakePoints'
import { log } from './logger'

// 地震情報の種別優先度（高いほど詳しい）。
//
// **`mergeQuakeInto` の据え置き判定のうち、incoming が震度データを持たない電文（震源情報等）の
// ときにだけ使う。** incoming が震度速報・各地の震度のように実震度を持つ電文なら、この表ではなく
// 発表時刻（time）で判定する（理由は据え置き判定のコメント）。
//
// この表だけで全種別の据え置きを判定していた旧実装には穴があった。震度速報を複数回発表する
// ケース（能登 2024/1/1 16:06〜16:08 の実データで確認）で、間に震度を持たない震源情報が挟まると、
// 既存カードの issue.type が「震源情報」に変わる。そこへ震度速報の続報（実震度を持つ）が来ても
// 優先度だけで判定すると「優先度が低い」という理由で無視され、新しく増えた区域（新潟県佐渡等）が
// 地図・カードに反映されなくなっていた。
// IssueType でキー付けする（string ではなく）ことで、将来 IssueType に種別が増えたときに
// この表への追加漏れをコンパイルエラーで検出できる。漏れたまま実行時 `?? 0` に頼ると、
// 新種別が無警告で最低優先度（'その他' 相当）として扱われてしまう。
export const QUAKE_ISSUE_PRIORITY: Record<IssueType, number> = {
  '顕著な地震の震源要素更新のお知らせ': 5,
  '各地の震度情報': 4,
  '震源・震度情報': 3,
  '震源情報': 2,
  '震度速報': 1,
  '遠地地震': 0,
  'その他': 0,
}

const AMENDMENT_TYPE = '顕著な地震の震源要素更新のお知らせ'

// 電文 ID 文字列から eventId（14桁タイムスタンプ）を抽出する。
// VXSE51/52/53/61 はすべて同じ eventId を共有するため、同一地震の同定に使用できる。
// 電文 ID の書式: `dmdata-quake-YYYYMMDDhhmmss-<serial>`。
// `xml-` を挟む旧形式（`dmdata-xml-quake-…`）も読む ―― 経路を XML へ一本化する前の REST 履歴が
// この形で、リプレイの記録や動作中のセッションに残りうる。作る側はもう付けない。
export function extractQuakeEventIdFromId(id: string | undefined | null): string | null {
  return id?.match(/^dmdata-(?:xml-)?quake-(\d{14})-/)?.[1] ?? null
}

// 地震カード (JMAQuake) の id フィールドから eventId を抽出するラッパ。
export function extractQuakeEventId(q: JMAQuake): string | null {
  return extractQuakeEventIdFromId(q.id)
}

// 地震カードの安定キー。統合・選択・通知の同一性判定はすべてこの値で行う。
// 統合済みカードは mergeQuakeInto が付けた eventKey を持ち、続報で id が変わっても不変。
// 統合前の生電文にはまだ無いため、その場で新規キーを導出する。
export function quakeEventKey(q: JMAQuake): string {
  return q.eventKey ?? initialQuakeKey(q)
}

// 生電文からイベントキーを新規に作る。DMDATA は全報が共有する eventId をそのまま使う。
// P2PQuake は eventId を配信せず、レコード id も報ごとに変わるため、
// 「発生時刻＋その報の id」で一意化する。このキーが作られるのはイベントの初報だけで、
// 以降の続報は mergeQuakeInto が初報のキーを引き継ぐ（＝キーは事後的に安定する）。
function initialQuakeKey(q: JMAQuake): string {
  return extractQuakeEventId(q) ?? `p2p:${q.earthquake.time}#${q.id}`
}

// 同一イベントのまま震源名が変わりうる電文か。
// - 訂正報（infoType=訂正／P2PQuake の `correct`）: 震源そのものを訂正する
// - 顕著な地震の震源要素更新（VXSE61 / P2PQuake の DestinationAmended）: 震源要素を差し替える
//   電文で、`issue.correct` は「なし」のまま来る。mergeQuakeInto の分岐 A が hypocenter を
//   丸ごと置き換える設計と対になる条件なので、ここから外すと震源名が変わった更新報が
//   別カードに分裂する（P2PQuake 経路は eventId が無く震源名で判定するため）。
function allowsHypocenterChange(q: JMAQuake): boolean {
  return q.issue.correct !== 'なし' || q.issue.type === AMENDMENT_TYPE
}

// 震源名が「両方とも判明していて食い違う」なら別イベントとみなせる。
// 震度速報は震源が未確定で名前が空のため判定に使わない（震源を伴う続報と合流させる）。
//
// 副作用: 条件が対称なので、片方が震源名の変更を許す電文（訂正報・震源要素更新）であれば
// 常に「食い違いなし」になる。震源要素更新のカードが残っている間は、同じ分に起きた別の
// 地震の報まで吸収しうる（`docs/spec/quake-spec.md` §6.1 の限界の 3 つ目）。
function hasConflictingHypocenter(a: JMAQuake, b: JMAQuake): boolean {
  const na = a.earthquake.hypocenter.name
  const nb = b.earthquake.hypocenter.name
  if (!na || !nb || na === nb) return false
  return !allowsHypocenterChange(a) && !allowsHypocenterChange(b)
}

// 震源が未確定の電文か（＝震度速報。震源名が空であることで見分ける）。
//
// **この電文の EventID は同一性の根拠にできない。** 気象庁は震源決定前を検知時刻で採番し、
// 震源が決まると震源時刻で採り直すため、同じ地震でも ID が変わることがある。
// 実例: 2026-08-24 04:05 の地震（熊本県天草・芦北地方）で、震度速報が 20260824040519、
// 震源情報以降が 20260824040526。震度速報は気象庁本庁、震源情報は大阪管区気象台の発表で、
// 官署の引き継ぎに伴って採り直された。
function isHypocenterPending(q: JMAQuake): boolean {
  // **取消電文を除くこと。** 取消はパーサが種別を問わず震源名を空で作るため、
  // 除かないと「震源未確定」として内容照合へ落ちる。取消は eventId でのみ照合する。
  return !q.cancelled && !q.earthquake.hypocenter.name
}

// 一次細分区域の名前の集合。震度速報も、震度を伴う続報も同じ粒度で持つ。
//
// **都道府県のロールアップ点を除くこと。** DMDSS 経路（DMDATA）は県別の最大震度を
// `{ pref: 名前, addr: 名前, isArea: true }` として足すため、`isArea` だけで絞ると県名が混ざる。
// 県は区域より粗いので、同じ県の別々の区域で起きた 2 つの地震が「重なる」ことになってしまう。
// 除き方は読み上げ側と揃える（判定は `quakePoints.ts` の `isAreaPoint` に集約）。
//
// **索引は引数で受ける。** このモジュールは座標テーブルを import できない（node 側スクリプトの
// 型検査対象に入るため。capture-test-scenario → dmdataReplay → ここ）ので、ブラウザ側の
// 呼び出し元が `getAreaPrefIndexCache()` から渡す。null のときは名前だけの判定へ落ち、
// 区域名が県名と同じ奈良県を取りこぼす——区域集合が小さくなる方向なので、判定は
// 「引き離せない」へ倒れる（別の地震を同一視することはあっても、同じ地震を割ることはない）。
function areaNames(q: JMAQuake, areaPrefIndex: AreaPrefIndex): Set<string> {
  return new Set(q.points.filter(p => isAreaPoint(p, areaPrefIndex)).map(p => p.addr))
}

// 両方が区域別震度を持ち、少なくとも 1 つを共有するか。
function hasSharedArea(a: JMAQuake, b: JMAQuake, areaPrefIndex: AreaPrefIndex): boolean {
  const sa = areaNames(a, areaPrefIndex)
  if (sa.size === 0) return false
  const sb = areaNames(b, areaPrefIndex)
  if (sb.size === 0) return false
  for (const name of sa) if (sb.has(name)) return true
  return false
}

// 「両方が区域別震度を持つのに 1 つも重ならない」なら、別の地震とみなせる。
// 片方でも区域を持たなければ判断材料が無いので false（＝引き離せない）を返す。
function hasDisjointAreas(a: JMAQuake, b: JMAQuake, areaPrefIndex: AreaPrefIndex): boolean {
  return areaNames(a, areaPrefIndex).size > 0 && areaNames(b, areaPrefIndex).size > 0
    && !hasSharedArea(a, b, areaPrefIndex)
}

// 2つの地震カードが同一イベントかどうか。
// 判定の優先順は「安定キー → eventId → 発生時刻＋震源名＋区域の重なり」。
//
// DMDATA は震度速報が targetDateTime、以降が arrivalTime を earthquake.time に使い、
// 同じ地震なら同じ値になる（震源時刻 originTime とは 1 分ずれることがあるため採らない）。
// P2PQuake は eventId が無いため発生時刻で比較するが、同時刻は分単位でしか一致しない
// （P2PQuake の発生時刻は秒が常に 00）ので、震源名まで見て「同じ分に起きた別の地震」を分離する。
//
// **eventId が食い違っても、それだけで別イベントとはしない。** 震源未確定の電文（震度速報）の
// EventID は暫定値で採り直されうるため、その場合だけ内容での照合へ落とす。震源が判明している
// 電文どうしは従来どおり eventId だけで分離する（同じ分の別々の地震を取り違えないため）。
//
// **採り直しの照合には「区域が重なる」という積極的な証拠を要求する。** 時刻の一致だけで
// 合流させると、同じ分に起きた別の地震の震源情報（VXSE52 は区域を持たない）が震度速報の
// カードを乗っ取り、揺れていない地域の震度が別の震源に貼り付く。eventId が無い経路
// （P2PQuake）は従来どおり「1 つも重ならなければ別」の緩い基準を使う —— そちらは
// eventId による分離が最初から無く、厳しくすると通常の続報まで分かれてしまうため。
//
// 第1分岐（双方が eventKey を持つ）は、実運用では incoming 側が統合前の生電文なので通らない。
// 統合済みカードどうしを比較する将来の呼び出し・テストのための分岐。
//
// 限界（`docs/spec/quake-spec.md` §6.1）:
// - eventId が完全に一致すれば、発生時刻も区域も見ずに同一と判断する
// - 暫定 ID のカードは、区域を持たない電文（震源情報）とはその場では合流しない
// - P2PQuake 経路では、同じ分に起きた別々の地震を常には分離できない（震源名が同じ場合など）
export function sameQuakeEntry(a: JMAQuake, b: JMAQuake, areaPrefIndex: AreaPrefIndex): boolean {
  if (a.eventKey && b.eventKey) return a.eventKey === b.eventKey
  const ea = extractQuakeEventId(a)
  const eb = extractQuakeEventId(b)
  // eventId が食い違う＝暫定 ID の採り直しの疑い。証拠を厳しく要求する側へ倒す。
  const requiresSharedArea = Boolean(ea && eb && ea !== eb)
  if (ea && eb) {
    if (ea === eb) return true
    // 暫定 ID の採り直しは「震源未確定の電文 × 震源が判明した電文」の組でしか起きない。
    // 同じ地震の震度速報どうしは同じ ID を共有する（2026-08-23 22:45 の 2 通で確認）ため、
    // **両方が震源未確定なら別々の地震**。片方でも震源が判明していなければ救済しない。
    if (isHypocenterPending(a) === isHypocenterPending(b)) return false
  }
  // 発生時刻が空の電文（取消）は内容照合の材料を持たない。空どうしを「一致」と
  // 数えないよう、値があることまで要求する。
  if (!a.earthquake.time || a.earthquake.time !== b.earthquake.time) return false
  if (hasConflictingHypocenter(a, b)) return false
  return requiresSharedArea ? hasSharedArea(a, b, areaPrefIndex) : !hasDisjointAreas(a, b, areaPrefIndex)
}

// カードが実際の震度データ（最大震度 or 各地の震度）を持つか。
// VXSE61 単独カードや震度欠落の速報段階では false になる。
export function hasIntensity(q: JMAQuake): boolean {
  return q.earthquake.maxScale >= 0 || q.points.length > 0
}

// 表示順（earthquake.time 降順＝新しい地震が先頭）。
export function sortQuakes(arr: JMAQuake[]): JMAQuake[] {
  return [...arr].sort((a, b) =>
    new Date(b.earthquake.time).getTime() - new Date(a.earthquake.time).getTime()
  )
}

// 同一イベントの2電文を統合する唯一の真実。リアルタイム(WS)経路の逐次統合の意味を保存する。
// 取消電文（cancelled=true）は呼び出し側（live の取消専用分岐・履歴の mergeQuakeHistory）で
// 先に捌かれる前提のため、ここでは通常電文として扱わない。
//
// - incoming が VXSE61（顕著地震の震源要素更新）: 既存カードの震度（maxScale/points）を保持したまま、
//   震源・M・種別・発表時刻・（判明していれば）国内津波を更新する。既存が無ければ震度なし単独カードを返す。
// - incoming が通常電文: 既存が「実震度を持つ・未取消・より高優先度」なら据え置き（戻り値 === existing）。
//   そうでなければ incoming で置換する。置換時、
//     * incoming が震度を持たない（震源のみの後続電文）なら既存の震度を補完し、
//     * incoming が震源を持たない（震度速報）なら既存の震源要素を補完し（津波区分・付加文は
//       震度速報が自前で持つため補完しない）、
//     * 既存がより新しい VXSE61 なら、その更新後の震源・種別を保持したまま incoming の震度を採る。
//
// 補完するのは**その電文種別が構造的に持たないフィールド**だけ。同じ種別の中で値が消えた場合は
// 補完してはいけない（`docs/spec/quake-spec.md` §6.4）。この関数の中では、続報の震度が前報より
// 下がったときに高い方へ書き戻さないことがそれに当たる。
//
// 戻り値が existing と同一参照なら「変化なし」を意味する（呼び出し側は状態を更新しない）。
//
// 統合結果には必ず eventKey を持たせる。既存カードがあればそのキーを引き継ぐため、
// P2PQuake のように続報で id が変わる経路でも、カードのキーは初報のまま不変になる。
export function mergeQuakeInto(existing: JMAQuake | undefined, incoming: JMAQuake): JMAQuake {
  const eventKey = existing?.eventKey ?? quakeEventKey(incoming)

  // --- A. incoming が VXSE61（顕著地震の震源要素更新） ---
  if (incoming.issue.type === AMENDMENT_TYPE) {
    if (!existing) return { ...incoming, eventKey }
    return {
      ...existing,
      eventKey,
      time: incoming.time,
      issue: incoming.issue,
      earthquake: {
        ...existing.earthquake,
        hypocenter: incoming.earthquake.hypocenter,
        domesticTsunami: incoming.earthquake.domesticTsunami !== '不明'
          ? incoming.earthquake.domesticTsunami
          : existing.earthquake.domesticTsunami,
      },
      // VXSE61 は自由付加文を必ず持ち、定型文だけのこともあれば**精査後のモーメント
      // マグニチュード**が添えられることもある。`...existing` を土台にしているため、
      // 明示的に採らないとその報だけが持つ情報が捨てられ、更新前の付加文が残り続ける。
      // 固定付加文（`forecastText`）は実電文では VXSE61 に付かないため触らない
      // （コードで保証しているわけではない。付くようになったら同じ扱いが要る）。
      freeText: incoming.freeText ?? existing.freeText,
    }
  }

  // --- B. incoming が通常電文 ---
  if (!existing) return { ...incoming, eventKey }

  // 据え置き判定: 既存が実震度を持ち・未取消のとき、incoming を無視するかどうかを判定する。
  // hasIntensity を条件に含めることで、VXSE61 単独カードや震度欠落カードは
  // 実震度を持つ電文で必ず上書きできる。
  //
  // **既存が VXSE61 とマージ済みの完成カードなら、時刻を問わず絶対的に据え置く。**
  // VXSE61 は「震源要素が確定した」という強い意味を持つ電文で、その後に届く通常電文
  // （震度速報の再送等）で覆されるべきではない。
  //
  // **それ以外は、incoming が震度データを持つかどうかで判定軸を変える。**
  //
  // - **incoming が実震度を持つ（震度速報・震源・震度情報・各地の震度）**: 発表時刻（time）で
  //   判定する。issue.type の優先度は見ない。旧実装は種別優先度だけで判定しており、震度速報を
  //   複数回発表するケース（能登 2024/1/1 16:06〜16:08 の実データで確認）で、間に震度を持たない
  //   震源情報が挟まって既存カードの issue.type が「震源情報」（震度速報より高優先度）に変わると、
  //   時系列的には後から届いた正しい震度速報の続報が「優先度が低い」という理由だけで無視され、
  //   新しく増えた区域（新潟県佐渡等）が地図・カードに反映されなくなっていた。
  //   **同じ発表時刻（time）の続報は常に受け入れる。** `time`（気象庁電文の ReportDateTime）は
  //   分単位までしか精度が無く、同じ分に複数報が発表されることが普通にある（上の実データでも
  //   震源情報と震度速報の続報が同じ分に発表されていた）。`mergeQuakeInto` が時系列順に逐次
  //   呼ばれる前提（ライブ経路は受信順、`mergeQuakeHistory` は time でソート済み）に乗り、
  //   後から呼ばれた incoming を信じる。
  // - **incoming が震度データを持たない（震源情報等。この分岐に来た時点で existing は
  //   上の if 条件により必ず実震度を持つ）**: issue.type の優先度で判定する。震度を持たない
  //   電文では time の精度（分単位）で新旧を確定できないうえ、時刻だけで判定すると、詳しい
  //   情報（例: 震源・震度情報）を持つ既存カードが、粗い情報（震源情報）で種別ラベルだけ
  //   後退してしまう（`coalesceByEventId` が暫定 ID のカードを畳むときに起きる）。
  //
  // **time が欠けている電文は「古い」とみなして据え置く。** 空文字列どうしの比較は
  // 常に false（`'' < ''` は false）になり据え置かれないため、明示的に弾く必要がある。
  // 気象庁電文はパーサーが time を必ず埋める前提だが、欠けたまま届いた場合に無警告で
  // 上書きを許すより、安全側（据え置き）に倒して記録を残す。
  //
  // **time の比較は文字列の辞書順（`Date` を経由しない）。** これが時系列順と一致するのは
  // existing/incoming が同じ書式・同じタイムゾーンオフセットで揃っているときだけ。DMDATA
  // 経路（dmdataParser.ts）は ISO 8601 + 固定オフセット（例: `+09:00`）、P2PQuake 経路
  // （p2pquake.ts）はスラッシュ区切りでオフセット無し（例: `2026/01/02 15:04:05`）と書式が
  // 異なる。今のところ実害が無いのは、standard 版は P2PQuake のみ・DMDSS 版は DMDATA のみと
  // ビルドバリアントごとにデータソースが単一だから（`CLAUDE.md`）。両方を1つの mergeQuakeInto
  // 呼び出し系列に混ぜる変更をするなら、先に time を `Date` ベースの比較に置き換えること。
  if (!existing.cancelledAt && hasIntensity(existing)) {
    if (existing.issue.type === AMENDMENT_TYPE) return existing
    if (!incoming.time) {
      log.warn('[quake] 発表時刻が空の電文を受信（据え置く）', { incomingId: incoming.id, incomingType: incoming.issue.type })
      return existing
    }
    if (hasIntensity(incoming)) {
      if (incoming.time < existing.time) return existing
      // **時刻では受け入れるが、種別優先度としては据え置き相当（既存の方が詳しい）だった場合は
      // 記録を残す。** sameQuakeEntry は eventId が無い経路（P2PQuake）や暫定 ID の再採番で
      // 別の地震を同一と誤認識しうる（同関数の限界の節を参照）。誤認識が起きると、無関係な
      // 電文がここを通って正しいカードを無警告で上書きする。ログが無いと「地震カードの内容が
      // 急に後退した」ときに原因を辿れない。
      if ((QUAKE_ISSUE_PRIORITY[existing.issue.type] ?? 0) > (QUAKE_ISSUE_PRIORITY[incoming.issue.type] ?? 0)) {
        log.info('[quake] 種別優先度は据え置き相当だが、発表時刻が新しいため受け入れた', {
          eventKey, existingType: existing.issue.type, incomingType: incoming.issue.type,
          existingTime: existing.time, incomingTime: incoming.time,
        })
      }
    } else if ((QUAKE_ISSUE_PRIORITY[existing.issue.type] ?? 0) > (QUAKE_ISSUE_PRIORITY[incoming.issue.type] ?? 0)) {
      return existing
    }
  }

  let result: JMAQuake = { ...incoming, eventKey }

  // 震度欠落の後続電文（震源のみ等）は既存の震度で補完する。
  if (!hasIntensity(incoming) && hasIntensity(existing)) {
    result = {
      ...result,
      earthquake: { ...result.earthquake, maxScale: existing.earthquake.maxScale },
      points: existing.points,
      // 自由付加文も同じ考え方で補う。震度を引き継ぐ経路で本文だけ落とすと、
      // 「津波注意報を発表中です」のような状況説明が後続の震源情報で静かに消える。
      freeText: result.freeText ?? existing.freeText,
    }
  }

  // 震源が未確定の電文（震度速報）は既存カードの震源で補完する。上の震度補完と対の処理。
  //
  // 震度速報は電文に Earthquake 要素を持たない種別で、パーサーは震源名を空・座標を -200・
  // 深さを -1 のセンチネルで埋める。**これは「震源が未確定に戻った」という意味ではない。**
  // 気象庁が確定した震源を取り下げるなら訂正報（`issue.correct`）か VXSE61 が出る。
  // 補わないと、震源情報（VXSE52）が確定させた震源名・座標・深さ・マグニチュードが、
  // あとから届く震度速報の続報で丸ごと消える。座標が -200 に戻ると地図の震源マーカーと
  // カードの位置表示（`EarthquakeCard` の `hasLocation`）が落ちる。
  // 実例: 能登 2024/1/1 の前震。震度速報 → 震源情報 → 震度速報の続報の順に届き、**後の 2 通は
  // `time` が同じ 16:08**（分精度）になるため、据え置き判定は続報を受け入れる。
  //
  // **判定は `isHypocenterPending` を使い、震源名の空判定を書き写さない。** 同じ事実を別の
  // 言葉で表すと、片方だけが変わったときに範囲がずれる。
  //
  // 逆に「同じ種別・同じフィールドの中で値が消えた」場合は補ってはいけない
  // （`docs/spec/quake-spec.md` §6.4）。気象庁が予想を取り下げた事実を隠すことになる。
  //
  // **取消表示中（`cancelledAt`）のカードからは引き継がない。** 取消は「その報の内容が誤りだった」
  // という意味なので、取り下げられた震源を新しいカードへ持ち込むと、気象庁が消した位置を地図に
  // 出し直すことになる。据え置き判定（上の `!existing.cancelledAt && hasIntensity(existing)`）が
  // 取消表示中のカードを守らない設計と同じ向きに揃えている。
  // **同じ危険は上の震度補完ブロックにも残っている**（あちらはこの判定を持たず、取消済みカードの
  // 震度・自由付加文を引き継ぐ）。根は「取消表示中のカードが `existing` として選ばれ、置換で
  // `cancelledAt` ごと消える」ことで、`findExistingQuakeCard` と purge 予約まで見て直す必要がある。
  //
  // **ここで補うのは震源要素だけ。** 津波区分と固定付加文は別の理由で扱うので下のブロックへ。
  if (isHypocenterPending(incoming) && !isHypocenterPending(existing) && !existing.cancelledAt) {
    result = {
      ...result,
      earthquake: { ...result.earthquake, hypocenter: existing.earthquake.hypocenter },
    }
  }

  // 震度速報の津波区分・固定付加文は採らず、既存カードの判断を残す。
  //
  // 震度速報はこれらを自前で持っているが、**その報の判断を表していない**。種別に付く定型文で、
  // 実データではこうなっていた（能登 2024/1/1 の前震）:
  //   16:08:32 震源情報 …… `なし`「この地震による津波の心配はありません。」
  //   16:08:42 震度速報 …… `調査中`「今後の情報に注意してください。」
  // 気象庁が「なし」と判断した 10 秒後の報が `調査中` のまま届く。判断が更新されていないのでは
  // なく、震度速報の付加文コード（0217）が種別に紐づいて動かないだけ。採ると、確定した安全表示が
  // 続報のたびに `調査中` へ戻る（`formatDomesticTsunami` は `なし` を緑・`調査中` を灰で出す）。
  // 津波警報の発表中に震度速報の続報が届けば、同じ経路で `警報等` を `調査中` へ格下げしうる。
  //
  // **読み上げ側は既に同じ扱いをしている**（`ttsText.ts` の「震度速報では呼ばないこと」）。
  // 画面表示側にだけ無かったので揃える。
  //
  // 既存が `不明`（判断がまだ無い）のときは震度速報の値を使う。イベントの初報が震度速報のときは
  // そもそも既存カードが無いため、この分岐に入らず `調査中` がそのまま出る。
  //
  // **判定は `issue.type` で行う。** `isHypocenterPending`（震源名の空判定）を流用しないこと。
  // 別の事実を同じ述語で表すと、片方の意味が変わったときに範囲がずれる。
  if (incoming.issue.type === '震度速報' && !existing.cancelledAt) {
    result = {
      ...result,
      earthquake: {
        ...result.earthquake,
        domesticTsunami: existing.earthquake.domesticTsunami !== '不明'
          ? existing.earthquake.domesticTsunami
          : result.earthquake.domesticTsunami,
      },
      forecastText: existing.forecastText ?? result.forecastText,
    }
  }

  // 既存がより新しい VXSE61 の場合、その更新後の震源・種別・発表時刻を保持しつつ
  // incoming（震度電文）の震度を採用する。
  if (existing.issue.type === AMENDMENT_TYPE && existing.time >= incoming.time) {
    result = {
      ...result,
      time: existing.time,
      issue: existing.issue,
      earthquake: { ...result.earthquake, hypocenter: existing.earthquake.hypocenter },
      // 自由付加文も新しい側（＝ここでは VXSE61）を残す。土台が incoming なので、
      // 明示しないと VXSE61 が伝える精査後の Mw が**震度が確定した瞬間に消える**。
      // VXSE61 が先に立ったカードへ後から震度電文が届く経路は実運用で起きる（§8 QUAKE-4）。
      freeText: existing.freeText ?? result.freeText,
    }
  }

  return result
}

/**
 * 取り下げの記録。取消電文の発表時刻・種別と、対象を照合するための電文・カード。
 *
 * `entry` に何を入れるかで照合の精度が変わる。**取消を受けたカードがあればそれを入れる**
 * （震源名・発生時刻・区域が揃っているため `sameQuakeEntry` の全経路が使える）。当たるカードが
 * 無かった場合は取消電文そのものを入れるが、そちらは発生時刻・震源名とも空なので eventId でしか
 * 照合できない（§6.2）。eventId を持たない P2PQuake 経路では後者は当たらない。
 *
 * `issueType` は**取消電文の**種別。`entry` から読まずに別に持つのは、`entry` がカードのときに
 * その `issue.type` が取消電文と一致しているのは「取消のマッチング条件がそうだから」という
 * 間接的な理由にすぎず、マッチングの条件が変わると静かにずれるため。
 */
export interface QuakeRetraction {
  /** 取消電文の発表時刻（`ReportDateTime`）。 */
  reportTime: string
  /** 取消電文の種別。 */
  issueType: IssueType
  /** 照合に使う電文・カード。 */
  entry: JMAQuake
}

/**
 * 取消電文から取り下げの記録を作る。
 *
 * `matched` には、その取消が当たったカードを渡す（照合の材料が揃うため。理由は
 * `QuakeRetraction`）。当たらなかった場合は省略する。
 */
export function quakeRetractionOf(cancel: JMAQuake, matched?: JMAQuake): QuakeRetraction {
  return { reportTime: cancel.time, issueType: cancel.issue.type, entry: matched ?? cancel }
}

/**
 * 取消の後に届いた報が「取り下げ済みの内容」かどうか。
 *
 * **正常な運用では取消の後に同じ地震の続報は来ない。** 取消は「その情報を取り下げる」意味で、
 * 取り下げた地震について続報は出ない。それでも届いたなら異常が 2 通りある。
 *
 * - **到着順の入れ替わり**: 取消より前に発表された報が遅れて届いた。当日ぶんの REST 経路や
 *   リプレイでは順序が入れ替わりうる（同じ分のタイは呼び出し側の入力順に委ねているため）。
 *   これは取り下げ済みの内容なので**捨てる**。この関数が `true` を返すのはこの場合
 * - **同一性の誤認識**: 別の地震の報が `sameQuakeEntry` で同一と判定された（§6.1 の限界。
 *   P2PQuake 経路・暫定 EventID の採り直しで起こりうる）。こちらは取消より後に発表された報に
 *   なるため `false` を返し、`findExistingQuakeCard` が取消済みカードを避けることで**別カードと
 *   して立つ**。飲み込むと本物の地震が画面に出ない
 *
 * **同じ発表時刻なら取り下げ側へ倒す。** `time` は分精度なので、同じ分の取消と報のどちらが先か
 * は時刻から決められない。取消を尊重する方が安全。
 *
 * **発表時刻が空の報も取り下げ側へ倒す。** 空文字列どうしの比較は常に false になるため明示的に
 * 弾く必要がある（据え置き判定が空の `time` を扱うのと同じ理由）。
 *
 * **種別（`issue.type`）まで一致を要求する。** 取消は情報単位で、`useEarthquakes` の取消の
 * マッチングも種別まで見て絞っている（遠地地震の取消報が「震源・震度情報」のカードを巻き込まない
 * ようにするため。遠地地震は VXSE53 を共有し `Head/Title` だけが異なる）。**適用側が絞ったものを
 * 参照側で広げてはいけない。** 報を落とす判定は結果が画面に出ないぶん見つけにくいので、
 * 適用側と対称に保つ。
 */
export function isRetractedQuakeReport(
  retractions: readonly QuakeRetraction[],
  incoming: JMAQuake,
  areaPrefIndex: AreaPrefIndex,
): boolean {
  return retractions.some(r =>
    r.issueType === incoming.issue.type
    && sameQuakeEntry(r.entry, incoming, areaPrefIndex)
    && (!incoming.time || incoming.time <= r.reportTime)
  )
}

/**
 * 受信した電文に対応する既存カードを選ぶ。
 *
 * 通常、一致するカードは 1 枚しかない。ただし暫定 EventID で分かれていたカードが確定 ID の
 * 電文で合流するときだけ、**2 枚が同時に一致する**（暫定 ID のカードは区域の重なりで、
 * 確定 ID のカードは eventId で）。ここで後から立った方を選ぶと、統合後のカードの `eventKey`
 * が入れ替わる。`eventKey` はブラウザ通知の重複抑止・カード選択・読み上げの主題キーに使う値
 * なので、入れ替わると**同じ地震の通知が二度出る**。
 *
 * **先に立ったカード（発表時刻が古い方）を選んでキーを据え置く。**
 *
 * **取消表示中のカードは選ばない。** 選ぶと `mergeQuakeInto` が置換して `cancelledAt` が落ち、
 * さらに `id` も入れ替わるため 10 秒後の purge 予約（`id` で対象を引く）が空振りし、取り消した
 * はずの地震が居座る。取消の後に届いた報の扱いは `isRetractedQuakeReport` を参照。
 */
export function findExistingQuakeCard(cards: JMAQuake[], incoming: JMAQuake, areaPrefIndex: AreaPrefIndex): JMAQuake | undefined {
  let found: JMAQuake | undefined
  for (const card of cards) {
    if (card.cancelledAt) continue
    if (!sameQuakeEntry(card, incoming, areaPrefIndex)) continue
    // 発表時刻が同値なら id で決める。配列順（＝到着順）に委ねると、同じ入力でも
    // ライブと履歴で選ばれる側が変わる。
    if (!found || card.time < found.time || (card.time === found.time && card.id < found.id)) found = card
  }
  return found
}

/**
 * 同じ eventId を指すことになったカードどうしを 1 枚に畳む。
 *
 * 震度速報は暫定 EventID でカードを作る（§6.1）。そのカードがあとから確定 ID の電文を
 * 区域の重なりで引き当てて取り込むと、**同じ確定 ID を持つ別のカードが既に居る**ことがある。
 * 実例は 2026-08-24 04:05 で、震度速報（VXSE51・暫定 519）→ 震源情報（VXSE52・確定 526・
 * 区域を持たないため合流しない）→ 震源・震度情報（VXSE53・確定 526・区域が重なるので
 * 震度速報のカードへ入る）と届き、震度を持つカードと「震源情報だけ」のカードが並ぶ。
 *
 * **eventKey では気づけない。** 続報で不変にするため既存カードから引き継ぐ値なので、
 * 2 枚は最後まで別のキーを持ち続ける。ここでは eventId だけを見て畳む。
 *
 * eventId を持たない電文（P2PQuake 経路）は対象外 —— そちらの同一性は `sameQuakeEntry` が見る。
 */
export function coalesceByEventId(cards: JMAQuake[]): JMAQuake[] {
  const result: JMAQuake[] = []
  for (const card of cards) {
    const eventId = extractQuakeEventId(card)
    // **取消表示中のカードは畳まない。** `mergeQuakeInto` は置換時に `cancelledAt` を引き継がず
    // `id` も入れ替わるため、畳むと 10 秒後の purge 予約（`id` で対象を引く）が空振りし、
    // 取り消したはずのカードが居座る。
    const index = eventId && !card.cancelledAt
      ? result.findIndex(e => extractQuakeEventId(e) === eventId && !e.cancelledAt)
      : -1
    if (index < 0) {
      result.push(card)
      continue
    }
    // 先に居る方を既存として扱う。据え置き判定（震度を持つ・高優先度）が働くため、
    // 完成したカードが震源情報だけのカードに上書きされることはない。
    const kept = mergeQuakeInto(result[index], card)
    // 畳んだことは記録に残す。無音だと「畳まれたのか、そもそも重複していないのか」を
    // 実運用で区別できない（取消の不一致を `useEarthquakes` が warn するのと同じ理由）。
    log.info('[quake] 同じ eventId のカードを畳んだ', {
      eventId, keptId: kept.id, droppedId: card.id, keptEventKey: kept.eventKey,
    })
    result[index] = kept
  }
  return result
}

// 電文群をイベントごとに時刻順で畳み込み、リアルタイムと同一の統合結果を得る。
// base は統合済みの既存カード群（「もっと見る」でのバッチ跨ぎ用）。
//
// 同一イベントの判定は sameQuakeEntry に一本化している（Map のキー方式では、震源名を見る
// 判定や「震度速報は震源名が空」の扱いを表現できないため）。件数は履歴数十〜数百件なので
// 線形探索で足りる。
//
// **既知の限界: 同じ分（time の精度限界）に複数種別の電文が混在する場合、newQuakes の
// 入力順序がそのまま結果に効く。** ソートは安定ソート（Array.prototype.sort、ES2019 以降で
// 仕様保証）なので、time が同値の要素は入力配列上の相対順序を保つ。mergeQuakeInto の
// 据え置き判定は「incoming が実震度を持つ電文どうし」では issue.type の優先度を見ず time
// だけで判定するため、同じ分に詳しい電文（各地の震度情報等）と粗い電文（震度速報の再送等）が
// 両方含まれる場合、**入力配列で詳しい方が先・粗い方が後だと、粗い方が詳しい方を上書きする**
// （敵対的レビューで指摘・確認済み）。呼び出し側（`fetchDmdataEarthquakes`）が
// 「速報→詳細」（VXSE51→52→53→61）の順に結合することで、通常の発表順に沿う限り
// この逆転は起きない設計にしている。呼び出し側で結合順序を変える場合はこの前提を崩さないこと。
// 索引の意味は `quakePoints.ts` の `isAreaPoint`。**省略可能にしない**——渡し忘れた呼び出し側が
// 黙って縮退する（区域名が県名と同じ奈良県だけ区域で引き当てられなくなる）ため、型検査に見張らせる。
export function mergeQuakeHistory(
  newQuakes: JMAQuake[],
  base: JMAQuake[],
  knownRetractions: readonly QuakeRetraction[],
  areaPrefIndex: AreaPrefIndex,
): JMAQuake[] {
  const merged: JMAQuake[] = [...base]

  // 電文の発表時刻昇順で適用する（＝到着順の再現）。同時刻の相対順序は呼び出し側の
  // 入力順序に委ねる（上の「既知の限界」参照）。
  const ordered = [...newQuakes].sort((a, b) =>
    new Date(a.time).getTime() - new Date(b.time).getTime()
  )
  // 取り下げの記録。履歴ではカードを消してしまうため、消した後に「取消以前に発表された報」が
  // 回ってきても照合できなくなる。**同じ分に取消と報が並ぶと入力順がそのまま効く**ので
  // （上の「既知の限界」と同じ機構）、取消を見た事実を別に残しておく。
  //
  // 呼び出し側が持つ台帳（`knownRetractions`）も足す。`base` に取消表示中のカードが含まれる
  // 呼び出し（「もっと見る」は `prev.earthquakes` を渡す）では、その取消はこのバッチの中には
  // 無いため、渡されないと照合できない。
  const retractions: QuakeRetraction[] = [...knownRetractions]

  for (const q of ordered) {
    // 取消電文（infoType=取消）: 履歴では取消された地震のカードを表示しない。
    // ライブ経路（useEarthquakes の取消専用分岐）は取消を10秒表示してから purge するが、
    // 過去情報である履歴ではその最終状態（非表示）に一致させる。
    if (q.cancelled) {
      // 取消表示中のカードも対象に含める（履歴の最終状態は非表示なので消して良い）。
      const target = merged.findIndex(e => sameQuakeEntry(e, q, areaPrefIndex))
      // 照合の精度が高い順に、当たったカード → 取消電文そのもの（理由は `QuakeRetraction`）。
      retractions.push(quakeRetractionOf(q, target >= 0 ? merged[target] : undefined))
      if (target >= 0) merged.splice(target, 1)
      continue
    }
    // 取消以前に発表された報は取り下げ済みなので採らない（`isRetractedQuakeReport`）。
    if (isRetractedQuakeReport(retractions, q, areaPrefIndex)) {
      log.warn('[quake] 取消以前に発表された報を捨てた', {
        id: q.id, issueType: q.issue.type, time: q.time,
      })
      continue
    }
    // **取消表示中のカードは置換しない**（理由は `findExistingQuakeCard`）。`base` 経由で
    // 混ざりうるため、ライブ経路と同じ守りをここにも置く。
    const index = merged.findIndex(e => !e.cancelledAt && sameQuakeEntry(e, q, areaPrefIndex))
    if (index >= 0) merged[index] = mergeQuakeInto(merged[index], q)
    else merged.push(mergeQuakeInto(undefined, q))
  }

  return sortQuakes(coalesceByEventId(merged))
}
