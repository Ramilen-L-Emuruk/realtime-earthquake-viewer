// 震度観測点一覧の取得元と、そこから「現行の一覧に無い観測点」を集める処理。
//
// **座標を作る側（`build-station-coords.mjs`）と読みを作る側（`build-station-readings.ts`）の
// 両方が同じ列挙元を要る。** 座標側は「廃止された観測点も地図に出す」ために、読み側は
// 「その観測点名も声になるので誤読を判定する」ために。別々に持つと、片方だけが古い版を
// 見ている状態に誰も気づけない。
//
// 実装を .ts へ移していないのは、`build-station-coords.mjs` が素の node で動かす規定
// （`node scripts/build-station-coords.mjs`）で、そちらから import できる形を保つため。
// TypeScript から呼ぶための宣言は `stationSource.d.mts` にある。

/**
 * 震度観測点一覧の取得元。**リビジョンを固定している**（生成のたびに中身が変わらないように）。
 *
 * 上流が更新されたらここを上げる。上げると次が動く:
 *   - 現行の観測点が増減し、`unlisted` 側がその分だけ入れ替わる
 *   - 一次細分区域の重心（`areas`）の値が動く。**キー順は動かなくても値は動く**ので、
 *     突き合わせるときは生成物どうしを比べること（キー数・キー順だけ見ても分からない）
 *   - `docs/spec/data-sources-spec.md` §6 の件数・取りこぼし率がずれる
 *
 * データ出典: 気象庁 震度観測点一覧表（iku55 氏が JSON 化したものを利用）
 *   https://gist.github.com/iku55/79005d1896631ad6117bbe327b8162c1
 */
export const STATION_SOURCE_URL =
  'https://gist.githubusercontent.com/iku55/79005d1896631ad6117bbe327b8162c1/raw/c3f798c09d0be79feeea3f8e554f8072d049ce95/stations.json'

/**
 * 現行の観測点として受け入れる件数の幅。2026-09 時点で 4360 点。
 * この幅を外れたらスキーマか取得元が変わったと見て止める（黙って少ない表を作らない）。
 */
export const LISTED_COUNT_RANGE = { min: 4000, max: 5000 }

/**
 * 中身を読めたリビジョンの下限。2026-09 時点で 24 版中 23 版が読める（1 版は上流の保存が
 * 途中で切れている）。
 *
 * **件数ではなくこちらが本体の歯止め。** 取得元が一時的に応答しなくなった・形が変わったと
 * いった形で一部の版が落ちても、拾えた観測点の数だけを見ていると気づけない。
 * 上流はリビジョンを足す一方なので、この下限を割ったら中身ではなく取得の側を疑う。
 */
export const MIN_READABLE_REVISIONS = 20

/**
 * 1 つのリビジョンで捨ててよい観測点の割合。これを超えたリビジョンは
 * **「読めた」と数えない**（{@link MIN_READABLE_REVISIONS} の判定から外す）。
 *
 * **`JSON.parse` が通ることは、中身が読めたことを意味しない。** 上流が `pref` のキー名を
 * 変えるような形でスキーマを変えると、配列としては読めるのに観測点が軒並み捨てられる。
 * その形は「読めなかったリビジョン」として数えられないので、件数の幅（`UNLISTED_RANGE`）
 * だけが最後の歯止めになり、数十点規模の劣化はすり抜ける。
 *
 * 2026-09 時点の実績では、捨てるのは全リビジョンを通して 1 点だけ（`伊豆大島町岡田`。
 * 都道府県を持たない）なので、実データに対しては十分に緩い。
 */
const MAX_DROP_RATIO = 0.5

// 上流のリビジョン一覧と、各リビジョンの中身。**取得元は STATION_SOURCE_URL から導く** ——
// gist の識別子とファイル名を別のリテラルで持つと、取得元を差し替えたときに片方だけ古くなる。
const {
  user: GIST_USER,
  id: GIST_ID,
  revision: PINNED_REVISION,
  file: GIST_FILE,
} = parseGistUrl(STATION_SOURCE_URL)
const GIST_COMMITS_API = `https://api.github.com/gists/${GIST_ID}/commits`

/** gist の raw URL から利用者名・識別子・リビジョン・ファイル名を取り出す。 */
function parseGistUrl(url) {
  const [, user, id, raw, revision, file] = new URL(url).pathname.split('/')
  if (!user || !id || raw !== 'raw' || !revision || !file) {
    throw new Error(`取得元 URL の形が想定と違います（.../<user>/<id>/raw/<revision>/<file> を期待）: ${url}`)
  }
  return { user, id, revision, file }
}

async function fetchText(url, what) {
  const res = await fetch(url, { headers: { 'User-Agent': 'build-station-coords' } })
  if (!res.ok) throw new Error(`${what}を取得できません（HTTP ${res.status}）: ${url}`)
  return await res.text()
}

async function fetchJson(url, what) {
  return JSON.parse(await fetchText(url, what))
}

/**
 * 観測点の鍵（"都道府県|観測点名"）を返す。名前か都道府県が無ければ null。
 *
 * 都道府県を含めるのは、引く側の鍵がその形だから。県が無い観測点は索引にも座標にも
 * 載せられないので落とす（上流の古いリビジョンに実在する。例: 伊豆大島町岡田）。
 *
 * **「現行の一覧」の範囲は、呼ぶ側で違ってよい。** `collectUnlistedStations` へ渡す集合を、
 * 座標側は「名前＋都道府県＋**有効な座標**」で作り、読み仮名側はこの関数のまま
 * （名前＋都道府県）で作る。**揃えると片方が壊れる**ので、意図して非対称にしてある。
 *
 * - 座標側が座標まで要求するのは、**座標が壊れている現行の観測点を履歴の値で救うため**。
 *   揃えて名前だけにすると、その観測点は「現行だから」と履歴の走査から外れ、座標を
 *   どこからも引けなくなる
 * - 読み仮名側が座標を見ないのは、読みに座標が要らないから。ここへ座標の条件を持ち込むと、
 *   座標が壊れている現行の観測点だけ履歴側のふりがなが採られる（現行の値と違えば生成が
 *   止まるが、一致していても「現行を見ていない」状態になる）
 *
 * どちらも同じ観測点を扱えるので実害は無く、2026-09 時点の上流に座標が壊れた現行の観測点は
 * 1 件も無い。
 */
export function stationKeyOf(station) {
  if (!station?.name || !station?.pref?.name) return null
  return `${station.pref.name}|${station.name}`
}

/** 固定リビジョンの観測点一覧を取る。件数が想定の幅を外れたら止める。 */
export async function fetchListedStations() {
  console.log(`Fetching ${STATION_SOURCE_URL} ...`)
  const stations = await fetchJson(STATION_SOURCE_URL, '観測点一覧')
  if (!Array.isArray(stations)) throw new Error('取得したデータが配列ではありません')
  if (stations.length < LISTED_COUNT_RANGE.min || stations.length > LISTED_COUNT_RANGE.max) {
    throw new Error(
      `震度観測点の件数が想定の幅（${LISTED_COUNT_RANGE.min}〜${LISTED_COUNT_RANGE.max}）を`
      + `外れています: ${stations.length} 件。取得元か形式が変わっていないか確かめてください。`,
    )
  }
  console.log(`Loaded ${stations.length} stations`)
  return stations
}

/**
 * 上流のリビジョン（新しい順）を全ページ辿って返す。
 *
 * **GitHub API を叩くのはここだけ。** 各リビジョンの中身は raw の CDN から取るので、
 * 未認証の 60 回/時という制限にかかるのは 1 リクエストだけで済む。
 */
async function fetchRevisions() {
  const versions = []
  for (let page = 1; page <= 20; page++) {
    const items = await fetchJson(`${GIST_COMMITS_API}?per_page=100&page=${page}`, '上流のリビジョン一覧')
    if (!Array.isArray(items)) throw new Error('上流のリビジョン一覧が配列ではありません')
    for (const it of items) {
      if (typeof it?.version !== 'string') throw new Error('リビジョン一覧に version を持たない項目があります')
      versions.push(it.version)
    }
    if (items.length < 100) return versions
  }
  throw new Error('上流のリビジョンが多すぎます（20 ページを超えました）')
}

/**
 * 現行の一覧に無い観測点を、上流のリビジョン履歴から集める。
 *
 * **廃止された観測点だけとは限らない。** 固定リビジョンより後に一覧へ加わった観測点も
 * ここへ入る（どちらも「現行の一覧＝固定リビジョン に無い」という点では同じで、座標を
 * 引く側から見れば区別する理由が無い）。名前を `unlisted` にしているのはそのため。
 *
 * 固定リビジョンを最新に保っているあいだは後者が該当しないが、**上流が更新されれば再び
 * 生じる**。「廃止された観測点だけ」と読み替えないこと。
 *
 * @param listed 固定リビジョンの観測点キー（"都道府県|観測点名"）の集合
 * @returns キー -> 上流の観測点オブジェクト（座標・ふりがな・区域名をそのまま持つ）
 */
export async function collectUnlistedStations(listed) {
  const revisions = await fetchRevisions()
  console.log(`Found ${revisions.length} revisions`)

  // **固定リビジョンが一覧に含まれることを確かめる。** 固定先が消えた・書き間違えたを
  // ここで捕まえる。含まれていなければ「現行の一覧」と「履歴」が別物を指しているので、
  // unlisted の中身が何を意味するのか誰にも言えなくなる。
  if (!revisions.includes(PINNED_REVISION)) {
    throw new Error(
      `固定リビジョン（${PINNED_REVISION.slice(0, 8)}）が上流のリビジョン一覧にありません。`
      + 'URL の書き間違いか、上流で履歴が作り直されています',
    )
  }

  const unlisted = new Map()
  const unreadable = []
  const empty = []
  const degraded = []
  const noPref = new Set()
  let noName = 0
  for (const revision of revisions) {
    const url = `https://gist.githubusercontent.com/${GIST_USER}/${GIST_ID}/raw/${revision}/${GIST_FILE}`
    // **取得そのものの失敗は止める。** 一時的な障害を黙って飲み込むと、欠けたことが
    // 生成物から分からないまま「拾えたつもり」の表ができあがる。
    const text = await fetchText(url, `リビジョン ${revision.slice(0, 8)} の観測点一覧`)
    // **中身が読めないリビジョンは飛ばす。** 上流には保存が途中で切れたリビジョンが実在し
    // （2021-12-18 の版が 651,917 バイトで途切れている）、これを失敗にすると生成が
    // 永久に通らない。**飛ばした数は下の {@link MIN_READABLE_REVISIONS} が見る**ので、
    // 一部の版がまとめて読めなくなればそこで止まる。
    let stations
    try {
      stations = JSON.parse(text)
    } catch {
      stations = null
    }
    if (!Array.isArray(stations)) {
      unreadable.push(revision.slice(0, 8))
      continue
    }
    // **空の版も「読めた」と数えない。** 観測点を 1 件も提供していないのに下限の分母だけ
    // 満たすため、上流が一時的に空を返す形が起きると歯止めをすり抜ける。
    // 下の割合の判定では捕まらない —— `0 / 0` は `NaN` で、どんな比較も偽になる。
    if (stations.length === 0) {
      empty.push(revision.slice(0, 8))
      continue
    }
    let dropped = 0
    for (const s of stations) {
      if (!s?.name) { noName++; dropped++; continue }
      if (!s?.pref?.name) { noPref.add(s.name); dropped++; continue }
      const key = stationKeyOf(s)
      if (listed.has(key) || unlisted.has(key)) continue
      unlisted.set(key, s)
    }
    // **中身の大半を捨てたリビジョンは「読めた」と数えない**（→ {@link MAX_DROP_RATIO}）。
    // 拾えた観測点は捨てずに使う —— 数えるのは歯止めのためで、部分的に読めたものを
    // 無かったことにする理由は無い。
    //
    // **割合がちょうど閾値のときは通す**（厳密不等号）。半分までの欠落は正常の範囲として
    // 許す設計で、境界は `stationSource.test.ts` が固定している。
    if (dropped / stations.length > MAX_DROP_RATIO) {
      degraded.push(`${revision.slice(0, 8)}（${dropped}/${stations.length}）`)
    }
  }
  if (unreadable.length > 0) {
    console.warn(`Skipped ${unreadable.length} unreadable revision(s): ${unreadable.join(' ')}`)
  }
  if (empty.length > 0) {
    console.warn(`Empty revision(s): ${empty.join(' ')}`)
  }
  if (degraded.length > 0) {
    console.warn(`Mostly-dropped revision(s): ${degraded.join(' ')}`)
  }
  if (noPref.size > 0) {
    console.warn(`Skipped ${noPref.size} station(s) without a prefecture: ${[...noPref].slice(0, 5).join(' ')}`)
  }
  if (noName > 0) {
    console.warn(`Skipped ${noName} entr(ies) without a name`)
  }
  const readable = revisions.length - unreadable.length - empty.length - degraded.length
  if (readable < MIN_READABLE_REVISIONS) {
    throw new Error(
      `中身を読めたリビジョンが ${readable} 件しかありません（全 ${revisions.length} 件・`
      + `形式が読めない ${unreadable.length} 件・空 ${empty.length} 件・`
      + `大半を捨てた ${degraded.length} 件・下限 ${MIN_READABLE_REVISIONS}）。`
      + '取得元の形が変わったか、取得が一部失敗しています',
    )
  }
  return unlisted
}
