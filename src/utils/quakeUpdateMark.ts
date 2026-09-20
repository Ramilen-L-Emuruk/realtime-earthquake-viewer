import type { JMAQuake, JMAQuakeCity, EarthquakePoint, IssueType } from '../types/earthquake'
import { cityKey } from './quakePoints'
import { UPDATE_MARK_TTL_MS, statusOf, type SnapshotValue, type UpdateStatus } from './updateMark'

/**
 * 地震カードで「この報で動いた」と示せる欄。
 *
 * **どれも実配信では稀にしか動かない**（控え 60 日・続報 534 通での実測。震央地名 0.0% /
 * 津波区分 1.0% / 規模 4.0% / 深さ 4.5% / 座標 4.7% / 最大震度 9.6%）。稀だからこそ印が
 * 「そこが動いた」を本当に意味する。
 *
 * **震央地名は 1 度も動かなかったが、入れておく。** 気象庁は訂正報と震源要素更新
 * （VXSE61）で震源名を書き換えうるので、動かないのは標本の性質であって規約ではない。
 */
export type QuakeUpdateField =
  | 'hypocenterName'
  | 'coordinate'
  | 'magnitude'
  | 'depth'
  | 'domesticTsunami'
  | 'maxScale'

/** 震源要素・最大震度のスナップショット。 */
export type QuakeFactSnapshot = ReadonlyMap<QuakeUpdateField, SnapshotValue>

/** 震度一覧・長周期一覧の行のスナップショット。鍵は {@link rowMarkKey}。 */
export type RowSnapshot = ReadonlyMap<string, SnapshotValue>

/**
 * 津波区分の重さ。**「調査中」「不明」はここに載せない** —— あれは値ではなく
 * 「まだ決まっていない」なので、そこから確定しても上がった／下がったとは言えない。
 *
 * **載っていない値は「値が無い」として扱う**（{@link quakeFactSnapshot} が番兵へ倒す）。
 * 調査中から確定した報に印を付けないのは、震源が未確定から確定した報に付けないのと同じ理由 ——
 * 文言そのものが「調査中」から区分の名前へ変わるので、印が無くても目に入る。
 */
const DOMESTIC_TSUNAMI_RANK: Record<string, number> = {
  'なし': 0,
  '若干の海面変動': 1,
  '海面変動の可能性': 2,
  '注意報': 3,
  '警報等': 4,
}

/**
 * 行を指す鍵。**段の種別を前置きする** —— 区域名と県名は一致しうる（実データの「奈良県」）。
 * カードの開閉キー（`expandKey`）が同じ理由で同じ形を採っている。
 *
 * **名前だけで鍵にする段がある**（県・区域・観測点）。市町村だけは名前が全国で一意にならない
 * ので（府中市＝東京都・広島県）区域との組にする —— 既存の {@link cityKey} をそのまま使い、
 * 区切り文字を書き写さない。
 *
 * 観測点名も全国で一意とは限らないが、**取り違えても起きるのは「隣の行に印が付く」ことだけ**で、
 * 座標や震度が入れ替わるわけではない。津波カードの観測点も名前で引いており、そちらと揃える。
 */
export const rowMarkKey = {
  pref: (name: string) => `pref:${name}`,
  area: (name: string) => `area:${name}`,
  city: (area: string, name: string) => `city:${cityKey(area, name)}`,
  station: (name: string) => `st:${name}`,
} as const

/** {@link rowMarkKey} が作る鍵の種別。`diffQuakeRows` が「その段が初めて現れた報」を見分けるのに使う。 */
const ROW_KINDS = ['pref:', 'area:', 'city:', 'st:'] as const
const kindOf = (key: string): string => ROW_KINDS.find(k => key.startsWith(k)) ?? ''

/** 値が無い欄を表す番兵。**空文字を「比べない」の意味に使わない** —— 下記の理由を参照。 */
const UNKNOWN = ''

/**
 * 震源要素・最大震度の、いま画面に出ている値を写し取る。
 *
 * **渡すのは併合後のカードで、届いた電文そのものではない。** 続報の持ち越し規則
 * （`docs/spec/quake-spec.md` §6.4 —— 震度速報は震源を持たないので前報から補う、
 * 種別に付く定型文の津波区分は採らない、等）は併合が既に適用している。電文の側で差分を
 * 取ると、その規則をもう 1 か所に書き写すことになり、必ず食い違う。
 *
 * **値が無い欄も番兵で写す。捨てない。** 捨てると「値が消えた」が差分に現れなくなる。
 * 気象庁が取り下げた値は画面からも消えるので（§6.4「値が消えた・下がったのはそのまま従う」）、
 * そこは印が要る変化。
 */
export function quakeFactSnapshot(q: JMAQuake): Map<QuakeUpdateField, SnapshotValue> {
  const h = q.earthquake.hypocenter
  const snap = new Map<QuakeUpdateField, SnapshotValue>()
  // 震央地名と座標には大小が無いので `rank` を付けない（動いたことしか言えない）。
  snap.set('hypocenterName', { key: h.name || UNKNOWN })
  // 位置不明のセンチネルは -200（パーサーが埋める）。`Number.isFinite` だけでは素通りする。
  const hasPos = Number.isFinite(h.latitude) && Number.isFinite(h.longitude) && h.latitude !== -200 && h.longitude !== -200
  snap.set('coordinate', { key: hasPos ? `${h.latitude},${h.longitude}` : UNKNOWN })
  // 規模は**数値と説明の両方**を鍵に含める。「Ｍ８を超える巨大地震」は本文が NaN で
  // `description` だけが値を持つので、数値だけで比べるとその変化が消える
  // （→ `docs/spec/quake-spec.md` §8）。**大小を比べられるのは数値があるときだけ。**
  const hasMag = Number.isFinite(h.magnitude) && h.magnitude >= 0
  const magKey = `${hasMag ? h.magnitude.toFixed(1) : ''}|${h.magnitudeCondition ?? ''}`
  snap.set('magnitude', magKey === '|'
    ? { key: UNKNOWN }
    : { key: magKey, ...(hasMag ? { rank: h.magnitude } : {}) })
  // 深さの 0 は「ごく浅い」という有効値で、-1 が「読めなかった」の目印。
  // **浅いほど危険なので、順序は深さの符号を反転させる** —— 「上がった（赤）」が
  // 「より深刻になった」を指す約束を、どの欄でも守る。
  snap.set('depth', h.depth >= 0 ? { key: String(h.depth), rank: -h.depth } : { key: UNKNOWN })
  // 「調査中」「不明」は値ではなく「まだ決まっていない」ので、値が無いのと同じに扱う
  // （→ `DOMESTIC_TSUNAMI_RANK`）。**逆向き（確定していた区分が調査中へ戻る）は印を付ける** ——
  // 気象庁が取り下げた事実なので、こちらは伝える。
  const tsunami = q.earthquake.domesticTsunami
  const tsunamiRank = tsunami ? DOMESTIC_TSUNAMI_RANK[tsunami] : undefined
  snap.set('domesticTsunami', tsunamiRank === undefined
    ? { key: UNKNOWN }
    : { key: tsunami, rank: tsunamiRank })
  snap.set('maxScale', q.earthquake.maxScale >= 0
    ? { key: String(q.earthquake.maxScale), rank: q.earthquake.maxScale }
    : { key: UNKNOWN })
  return snap
}

/**
 * 前report から動いた欄を、欄ごとの印にする。
 *
 * **前が無ければ何も返さない。** そのカードで最初に見た報は全欄が「初出」になり、
 * 印が画面を埋めるだけで何も指さない。
 *
 * **値が無い状態から値が付いた欄には印を付けない。** 震源要素の欄は顔ぶれが決まっていて
 * 常に見えている（値が無ければ「震源調査中」や空欄として出ている）ので、値が付いたこと自体を
 * その欄が語っている —— 印は何も足さない。震度速報のあとに震源情報が届く形がこれで、
 * 付けると**震源が確定した報で欄が一斉に光る**。
 *
 * **一覧の行はこれと違う**（→ {@link diffQuakeRows}）。数百行のなかに 1 行増えても、それ自体では
 * 気づけないので初出の印が要る。
 *
 * 値どうしが入れ替わったら、大小を比べられるなら向き（上がった／下がった）、比べられないなら
 * 「向きの無い変化」。**値が消えたのは「向きの無い変化」** —— 小さくなったのではなく気象庁が
 * 取り下げたので、大小の話にしない。
 */
export function changedQuakeFacts(
  cur: QuakeFactSnapshot,
  prev: QuakeFactSnapshot | undefined,
): Map<QuakeUpdateField, UpdateStatus> {
  const out = new Map<QuakeUpdateField, UpdateStatus>()
  if (!prev) return out
  for (const [field, value] of cur) {
    const before = prev.get(field)
    if (before === undefined) continue
    // 値が無いところへ値が付いただけなら印を付けない（上の注記）。
    if (before.key === UNKNOWN) continue
    const status = statusOf(before, value)
    if (status) out.set(field, status)
  }
  return out
}

/**
 * 震度一覧の行の、いま画面に出ている階級を写し取る。
 *
 * **併合後のカードの点を渡すこと**（理由は {@link quakeFactSnapshot} と同じ）。
 *
 * **電文の `Revise`（「追加」「上方修正」「下方修正」）は使わない。** あれは**直前の電文**からの
 * 差分で、カードが見せている状態からの差分ではない。カードは種別の違う報を併合した積み上げ
 * なので、既に見えている行が別の報の都合で「追加」と名乗ることがある。加えて P2PQuake 経路は
 * この値を配信しないため、使うと DMDSS 版でしか印が出ない非対称になる。
 * （読み上げ側が同じ理由でこれを使っていない —— `docs/spec/audio-tts-spec.md` §4）
 */
export function quakeRowSnapshot(
  points: readonly EarthquakePoint[],
  cities: readonly JMAQuakeCity[],
): Map<string, SnapshotValue> {
  const snap = new Map<string, SnapshotValue>()
  for (const p of points) {
    // 未入電は下限の 45 が入っているので、階級だけで比べると観測値が届いた瞬間を
    // 取りこぼす（45 のまま）。**鍵には含め、順序には含めない** —— 階級が同じまま
    // 未入電が解けたのは「上がった」でも「下がった」でもないため。
    const value: SnapshotValue = { key: `${p.scale}${p.unreceived ? '!' : ''}`, rank: p.scale }
    // **振り分けは `buildIntensityRows` と同じ規則にする。** 行を組む側と写す側で違えると、
    // 画面に無い行を記憶したり、ある行を記憶し損ねたりする。
    //
    // とくに**都道府県ロールアップ点**（`Pref/MaxInt` 由来。`isArea` が真で `pref` を持つ）は
    // **どの行にもならず、県の最大にしか効かない**。`isAreaPoint` で振り分けると観測点の側へ
    // 落ちるので（あの述語は `addr === pref` のとき区域の索引を引き、索引に無ければ偽を返す）、
    // 震度速報の段階で `st:` の記憶ができてしまい、**「観測点の段が初めて現れた報では印を
    // 付けない」歯止めが効かなくなる** —— 各地の震度で観測点が数千行いっぺんに光る。
    if (p.pref) {
      // 県の行は配下の最大。**点を上書きせず、大きい方を残す。**
      const key = rowMarkKey.pref(p.pref)
      const cur = snap.get(key)
      if (cur === undefined || p.scale > (cur.rank ?? -1)) snap.set(key, { key: String(p.scale), rank: p.scale })
    }
    if (!p.pref && p.isArea) snap.set(rowMarkKey.area(p.addr), value)
    if (!p.isArea) snap.set(rowMarkKey.station(p.addr), value)
  }
  for (const c of cities) {
    if (!c.area || !c.name) continue
    snap.set(rowMarkKey.city(c.area, c.name), { key: `${c.scale}${c.unreceived ? '!' : ''}`, rank: c.scale })
  }
  return snap
}

/**
 * 行のスナップショットどうしを突き合わせて、行ごとの印を出す。
 *
 * **「値が動いたか」と「行が初めて出たか」で、比べる相手を分ける。**
 *
 * 値が動いたかは**直前の報**と比べる。気象庁が震度を引き上げた事実は、報の種別が変わっても
 * 伝える価値があるため。
 *
 * 行が初めて出たかは**同じ情報種別で前に見た報**と比べる。気象庁は同じ地震について載せる範囲の
 * 違う電文を発表する —— 震度速報は震度3以上の区域しか載せず、震源・震度情報は震度1以上の全区域を
 * 載せる。種別をまたいで比べると区域と県が一斉に増え、それが「初出」として光る（能登本震の実電文で
 * 33 県 75 区域 → 44 県 118 区域。11 県・43 区域が該当）。**それは新しく揺れが観測されたのでは
 * なく、報の粒度が変わっただけ。**
 *
 * **初出の判定に「直前の報の種別」を使ってはいけない。** 気象庁は種別を前後させる ——
 * 2024-01-01 16:06 の前震では震度速報（16:07）→ 震源情報 → 震度速報（16:08）の順で届く。
 * 「直前と種別が違えば初出を出さない」という形にすると、**震度速報どうしの続報が種別の変わり目と
 * して扱われ**、その報で本当に増えた区域（新潟県佐渡）の印まで消える。種別ごとに写しを持つのは
 * このため（→ {@link QuakeMarkMemory}）。
 *
 * **その種別を初めて見た報では初出を出さない**（`prevSameType` が無い）。比べる相手が無いので、
 * 増えた行はすべて初出に見える。
 *
 * **段が初めて現れた報でも印を付けない。** 「震度速報 → 各地の震度」では観測点の行がいっぺんに
 * 全部現れる（控え 60 日の実測で中央値 26 行・最大 2,825 行）。種別ごとに比べるようになって
 * 重なる場面が増えたが、**同じ種別のまま段が増える経路も残る**ので置いたままにする —— 市町村に
 * 紐づかない観測点しか持たない報のあとに市町村付きの報が来る形（`points` の振り分けは電文の
 * 入れ子で決まる）がそれにあたる。
 *
 * 2 通目以降は素直に差分を出す。実測では観測点の行のうち印が付くのは中央値 3.2% だった。
 */
export function diffQuakeRows(
  cur: RowSnapshot,
  /** 直前の報の写し（種別を問わない）。**値が動いたか**はこれと比べる。 */
  prev: RowSnapshot | undefined,
  /** 同じ情報種別で前に見た写し。**行が初めて出たか**はこれと比べる。 */
  prevSameType: RowSnapshot | undefined,
): Map<string, UpdateStatus> {
  const out = new Map<string, UpdateStatus>()
  // 段の既出は**同じ種別の写し**で見る。種別をまたぐと段の顔ぶれが変わるため。
  const seenKinds = new Set<string>()
  for (const key of prevSameType?.keys() ?? []) seenKinds.add(kindOf(key))
  for (const [key, value] of cur) {
    const before = prev?.get(key)
    if (before !== undefined) {
      const status = statusOf(before, value)
      if (status) out.set(key, status)
      continue
    }
    // 直前の報に無い行。**初出と言えるのは、同じ種別の写しにも無いときだけ。**
    if (!prevSameType) continue
    if (prevSameType.has(key)) continue
    if (!seenKinds.has(kindOf(key))) continue
    out.set(key, 'new')
  }
  return out
}

/**
 * 長周期地震動の一覧の行を写し取る（県 → 区域 → 観測点の 3 段）。
 *
 * **震度一覧と同じ鍵・同じ差分関数を通す。** 段の数が違うだけで、行の意味は同じ。
 *
 * **控えの 60 日では長周期の続報が 1 通も無かった**（24 件すべて単発）。ただしこれは
 * 「見つからなかった」であって「来ない」ではない —— 電文の仕様は訂正・続報を禁じておらず、
 * アプリ自身も初報と続報を見分けている（`seenLpgmEventIdsRef`）。震度一覧に印を付ける以上、
 * 同じ構造のこちらだけ印が出ない形にはしない。
 *
 * 階級と震度の両方を鍵に含める。カードは 2 つを並べて出しているので、震度だけが動いた報で
 * 印が出ないと画面と食い違う。
 */
export function lpgmRowSnapshot(
  regions: readonly { name: string; maxLgInt: number; maxInt?: number }[],
  points: readonly { name: string; lgInt: number; int?: number }[],
  prefs: readonly { name: string; maxLgInt: number; maxInt?: number }[],
): Map<string, SnapshotValue> {
  const snap = new Map<string, SnapshotValue>()
  // 順序は**階級を主、震度を従**にする（カードもその並びで出している）。震度は階級表の
  // 最大が 70 なので、階級 1 段の差が震度のどの差よりも大きくなる桁を取る。
  const value = (lgInt: number, int?: number): SnapshotValue =>
    ({ key: `${lgInt}/${int ?? ''}`, rank: lgInt * 1000 + (int ?? 0) })
  for (const p of prefs) snap.set(rowMarkKey.pref(p.name), value(p.maxLgInt, p.maxInt))
  for (const r of regions) snap.set(rowMarkKey.area(r.name), value(r.maxLgInt, r.maxInt))
  for (const s of points) snap.set(rowMarkKey.station(s.name), value(s.lgInt, s.int))
  return snap
}

/**
 * 長周期地震動の印を指す鍵。
 *
 * **地震の印と同じ入れ物に入れるが、鍵の名前空間を分ける。** 長周期の一覧はカードの中で
 * 震度一覧と切り替えて出るので、行の鍵（`area:` / `st:`）が同じ名前で衝突しうる。
 * 入れ物を分けないのは、寿命の掃除を 1 つで済ませるため。
 */
export const lpgmMarkKey = (eventId: string) => `lpgm:${eventId}`

/**
 * 写しを持ち回るカードの数の上限（→ {@link advanceQuakeMarks}）。
 *
 * 印の寿命は 1 分なので、**それより長く遡って写しを持つ意味はほとんど無い**。
 * 群発でも 1 分のあいだに続報が届くカードがこの数を超えることは考えにくく、
 * 超えたとしても落ちるのはいちばん長く触っていないものになる。
 */
const MARK_MEMORY_MAX_ENTRIES = 24

/** カードに出す印。欄ごとと行ごとの 2 系統を持つ。 */
export interface QuakeCardMarks {
  facts: ReadonlyMap<QuakeUpdateField, UpdateStatus>
  rows: ReadonlyMap<string, UpdateStatus>
  /** 印を付けた時刻。{@link UPDATE_MARK_TTL_MS} を過ぎたら消す。 */
  markedAt: number
}

/** 1 通ぶんの写し（`advanceQuakeMarks` へ渡す入力）。 */
export interface QuakeMarkSnapshot {
  facts: QuakeFactSnapshot
  rows: RowSnapshot
  /**
   * その報の情報種別。**行の写しをこの単位で持つ**（→ {@link QuakeMarkMemory}）。
   *
   * **`headType` ではなく `issue.type` を見る。** 知りたいのは「載せる範囲が同じか」で、
   * 種別の名前が同じなら範囲も同じ。`resolveIssueType` が未知の `headType` を
   * `'震源・震度情報'` へ落とす点は、ここでは「未知の種別どうしを同じ範囲とみなす」に留まる。
   */
  reportType: MarkReportType
}

/** 次の報と突き合わせるための、いまカードが見せている値の写し。 */
export interface QuakeMarkMemory {
  /**
   * 震源要素・最大震度。**種別で分けない** —— 欄の顔ぶれはどの種別でも同じで、
   * 震源要素更新（VXSE61）のように必ず種別が変わる報でも値の変化を伝えたいため。
   */
  facts: QuakeFactSnapshot
  /** 直前の報の行。**値が動いたか**はこれと比べる（種別を問わない）。 */
  rows: RowSnapshot
  /**
   * **情報種別ごとの行の写し。行が初めて出たかはこれと比べる。** 種別をまたいで比べると、
   * 報の粒度の違い（震度速報は震度3以上の区域まで・震源・震度情報は震度1以上の観測点まで）が
   * 「初出」として光る。
   *
   * **「直前の報の種別」を覚える形では足りない。** 気象庁は種別を前後させるので
   * （震度速報 → 震源情報 → 震度速報）、直前と比べると**震度速報どうしの続報が種別の
   * 変わり目に見え**、その報で本当に増えた区域の印まで消える（2024-01-01 16:06 の前震で実際に
   * そうなった）。種別ごとに持てば、いつでも「同じ範囲を載せる報どうし」を比べられる。
   *
   * **種別数に上限を置かない。** 鍵の値域は {@link MarkReportType} が定める 8 値で、
   * 型として有限なので溜まりようがない。**上限は「持ち物が膨らむこと」の代理値**で、
   * 実際に効くのはカードの枚数（`liveKeys` に無い地震の記憶は捨てる）。上限を置いていた頃は
   * 「震度速報 → 震源情報 → 震源・震度情報 → 各地の震度情報」というありふれた遷移で
   * 最初の種別が追い出され、**その種別が再び届いたとき初出の印が出なかった**。
   *
   * **どの種別の写しも大きくなりうる。** 写す先は電文ではなく**併合後のカード**なので、
   * その報自体が観測点を運ばない種別（震源情報・顕著な地震の震源要素更新）でも、先行する報が
   * 積んだ点をそのまま引き継いだ状態が写る（→ §6.4 の持ち越し規則）。空になるのは、その種別が
   * そのカードで最初の報だったときだけ。
   *
   * それでも溜まらないのは、**種別の数が型で有限**（高々 8）で、**カードの数にも上限がある**から
   * （{@link MARK_MEMORY_MAX_ENTRIES}）。能登本震の各地の震度情報で 2,829 行という大きさは、
   * この 2 つの上限の内側に収まる。
   */
  rowsByType: ReadonlyMap<MarkReportType, RowSnapshot>
}

/**
 * 写しを作った報の種別。地震カードは情報種別をそのまま使い、長周期地震動は
 * 1 種類しか無いので専用の値を置く。
 *
 * **長周期を `IssueType` のどれかで代用しない。** 地震カードと長周期は同じ入れ物
 * （`quakeMarkMemory`）に鍵を分けて同居するので、代用すると「種別が変わった」の意味が
 * 2 つの一覧で違ってしまう。
 */
export type MarkReportType = IssueType | 'lpgm'

/**
 * 1 通ぶん、記憶を進めて印を出す。**純関数** —— 状態の更新関数の中から呼ぶので、
 * ref への書き込みのような副作用を持たせない（React が更新関数を 2 度走らせても同じ結果になる）。
 *
 * **記憶は受信のたびに進める。読み上げ用の記憶を流用しない。** 上位の読み上げに待たされて
 * 声にならなかった報でも、画面にはその内容が届いている。声にした分だけ進む記憶で画面の差分を
 * 取ると、読まれなかった報の変化が次の報の印に混ざる（津波カードが同じ理由で 2 つに分けている）。
 *
 * **カードが消えた地震の記憶は捨てる。** 一覧の上限で落ちたカードの記憶を持ち続けると、
 * 群発のあいだ観測点の写し（大きいものは数千件）が積み上がる。
 */
export function advanceQuakeMarks(args: {
  prev: { memory: ReadonlyMap<string, QuakeMarkMemory>; marks: ReadonlyMap<string, QuakeCardMarks> }
  /** 印を付ける対象の地震（`quakeEventKey`）。 */
  key: string
  /** 併合後のカードから作った写し。 */
  snapshot: QuakeMarkSnapshot
  /** いま一覧に残っているカードの鍵。これ以外の記憶と印は捨てる。 */
  liveKeys: ReadonlySet<string>
  now: number
}): { memory: Map<string, QuakeMarkMemory>; marks: Map<string, QuakeCardMarks> } {
  const { prev, key, snapshot, liveKeys, now } = args
  const before = prev.memory.get(key)
  const facts = changedQuakeFacts(snapshot.facts, before?.facts)
  // 欄（`facts`）は種別をまたいでも差分を取る。**震源要素更新（VXSE61）は必ず種別が変わる報**
  // なので、ここまで種別で止めると座標・深さが動いた印が出なくなる。
  //
  // 行は**値の変化を直前の報と、初出を同じ種別で前に見た報と**比べる（→ `diffQuakeRows`）。
  const rows = diffQuakeRows(snapshot.rows, before?.rows, before?.rowsByType.get(snapshot.reportType))

  // 種別ごとの写しを進める。**捨てない** —— 鍵の値域は有限で、溜まりようがない
  // （→ `QuakeMarkMemory.rowsByType`）。
  const rowsByType = new Map<MarkReportType, RowSnapshot>(before?.rowsByType ?? [])
  rowsByType.set(snapshot.reportType, snapshot.rows)

  const memory = new Map<string, QuakeMarkMemory>()
  for (const [k, v] of prev.memory) if (liveKeys.has(k) && k !== key) memory.set(k, v)
  memory.set(key, { facts: snapshot.facts, rows: snapshot.rows, rowsByType })
  // **持ち回る数に上限を置く。** `liveKeys` はカード一覧の件数までしか絞らず、その一覧に
  // 件数の上限が無い。観測点の写しは大きい地震で数千件になるので、群発で長く動かしていると
  // 積み上がる。`Map` は挿入順を保ち、上でいま触った鍵を末尾へ置き直しているので、
  // **前から捨てれば「いちばん長く触っていないもの」から落ちる。**
  while (memory.size > MARK_MEMORY_MAX_ENTRIES) {
    const oldest = memory.keys().next()
    if (oldest.done) break
    memory.delete(oldest.value)
  }

  const marks = new Map<string, QuakeCardMarks>()
  for (const [k, v] of prev.marks) {
    if (k !== key && liveKeys.has(k) && now - v.markedAt < UPDATE_MARK_TTL_MS) marks.set(k, v)
  }
  // **報が来たら、その報の差分で付け直す。前の印は引き継がない。**
  //
  // 続報が届いた時点でカードの表示は新しくなっているので、そこに前の報の印が残っていると
  // 「いまの報で動いた」と読めてしまう。動いたものが無い報では印が消えるのが正しい。
  // 寿命（`UPDATE_MARK_TTL_MS`）が決めるのは**次の報が来ないまま置かれたとき**の上限だけ。
  if (facts.size > 0 || rows.size > 0) marks.set(key, { facts, rows, markedAt: now })
  return { memory, marks }
}

/** 寿命の切れた印を落とす。残す必要が無ければ同じ参照を返す（無駄な再描画を避ける）。 */
export function pruneQuakeMarks(
  marks: ReadonlyMap<string, QuakeCardMarks>,
  now: number,
): ReadonlyMap<string, QuakeCardMarks> {
  const kept = new Map<string, QuakeCardMarks>()
  for (const [k, v] of marks) if (now - v.markedAt < UPDATE_MARK_TTL_MS) kept.set(k, v)
  return kept.size === marks.size ? marks : kept
}

/**
 * ある行と、その配下の行のうち 1 つでも印を持つものがあるかを見る。
 *
 * **畳んだ行にも印を出すために要る。** 一覧は既定でどの段も畳んであるので、配下だけに印を
 * 付けると「開かないと気づけない」印になる。自分自身に印があればそれを、無ければ配下の
 * 印を持ち上げる。
 */
export function rowMarkOf(
  ownKey: string,
  descendantKeys: readonly string[],
  marks: ReadonlyMap<string, UpdateStatus>,
): UpdateStatus | undefined {
  const own = marks.get(ownKey)
  if (own) return own
  // 配下の向きが混ざったら**いちばん重いものを採る**。畳んだ親が言えるのは 1 つだけなので、
  // 悪化を最優先にする（上がった > 下がった > 初出 > 向きの無い変化）。
  let best: UpdateStatus | undefined
  for (const k of descendantKeys) {
    const s = marks.get(k)
    if (!s) continue
    if (s === 'raised') return 'raised'
    if (best === undefined || DESCENDANT_PRIORITY[s] > DESCENDANT_PRIORITY[best]) best = s
  }
  return best
}

/** 配下の印を 1 つへ畳むときの重さ（→ {@link rowMarkOf}）。 */
const DESCENDANT_PRIORITY: Record<UpdateStatus, number> = {
  raised: 3,
  lowered: 2,
  new: 1,
  changed: 0,
}
