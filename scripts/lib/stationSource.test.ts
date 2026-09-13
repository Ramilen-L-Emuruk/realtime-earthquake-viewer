import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { collectUnlistedStations, MIN_READABLE_REVISIONS, STATION_SOURCE_URL, stationKeyOf } from './stationSource.mjs'

// 上流のリビジョン履歴を辿る処理（`collectUnlistedStations`）を、合成したリビジョン列で検証する。
//
// **実データでは固定できない性質をここで押さえる。** 生成スクリプト側の検査
// （`build-station-coords.mjs` の `REQUIRED_UNLISTED`）は実電文に出てくる観測点を名指しする形で、
// 「廃止された観測点を拾う」ことは担保できるが、**「固定リビジョンより後に一覧へ加わった観測点を
// 拾う」ほうは担保できない** —— 取得元を最新へ保つ運用にしたので、その実例が現時点で存在しない。
// 走査を片方向（過去だけ）に絞る変更が入っても実データでは落ちないため、合成データで直接見る。

const { pathname } = new URL(STATION_SOURCE_URL)
const [, GIST_USER, GIST_ID, , PINNED_REVISION, GIST_FILE] = pathname.split('/')

interface Station {
  name?: string
  furigana?: string
  pref?: { name?: string }
}

interface Revision {
  id: string
  /** 文字列を渡すとそのまま本文になる（JSON として壊れた版を作るため）。 */
  body: unknown
}

const station = (pref: string, name: string): Station => ({ name, furigana: 'てすと', pref: { name: pref } })

/** どの版にも居る観測点。これが「現行の一覧」になる。 */
const BASE: Station[] = [station('東京都', '基準点いち'), station('東京都', '基準点に')]
const LISTED = new Set(BASE.map(s => stationKeyOf(s) as string))

const response = (body: string, ok = true): Response =>
  ({ ok, status: ok ? 200 : 404, text: async () => body }) as unknown as Response

function stubUpstream(revisions: Revision[]): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('https://api.github.com/gists/')) {
      const page = Number(new URL(url).searchParams.get('page') ?? '1')
      return response(JSON.stringify(page === 1 ? revisions.map(r => ({ version: r.id })) : []))
    }
    const hit = revisions.find(r => url === `https://gist.githubusercontent.com/${GIST_USER}/${GIST_ID}/raw/${r.id}/${GIST_FILE}`)
    if (!hit) return response('', false)
    return response(typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body))
  }))
}

/**
 * `total` 件のうち `broken` 件が都道府県を持たない版の中身を作る（捨てられる割合を作るため）。
 * 名前は版ごとに重ならないよう連番にし、拾える側が `unlisted` へ入っても害が無いようにする。
 */
function partiallyBroken(total: number, broken: number): Station[] {
  return Array.from({ length: total }, (_, i) => (
    i < broken
      ? { name: `県が無い点${i}`, furigana: 'てすと' }
      : station('北海道', `拾える点${i}`)
  ))
}

/**
 * 新しい順のリビジョン列を作る。先頭が固定リビジョンより新しい版、2 番目が固定リビジョン。
 * 残りは古い版で、いちばん古い版にだけ `retired` を混ぜる。
 */
function revisionsWith(options: { newer?: Station[]; retired?: Station[]; olderCount?: number } = {}): Revision[] {
  const olderCount = options.olderCount ?? MIN_READABLE_REVISIONS
  const list: Revision[] = [
    { id: 'f'.repeat(40), body: [...BASE, ...(options.newer ?? [])] },
    { id: PINNED_REVISION, body: BASE },
  ]
  for (let i = 0; i < olderCount; i++) {
    const isOldest = i === olderCount - 1
    list.push({
      id: String(i).padStart(40, 'a'),
      body: [...BASE, ...(isOldest ? (options.retired ?? []) : [])],
    })
  }
  return list
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('collectUnlistedStations', () => {
  it('固定リビジョンより後に一覧へ加わった観測点を拾う', async () => {
    // **この経路は実データでは検証できない**（取得元を最新に保っているため実例が無い）。
    // 走査を「固定リビジョンより古い版だけ」に絞る変更が入ると、ここが落ちる。
    stubUpstream(revisionsWith({ newer: [station('大阪府', '後から加わった点')] }))

    const unlisted = await collectUnlistedStations(LISTED)

    expect([...unlisted.keys()]).toContain('大阪府|後から加わった点')
  })

  it('廃止された観測点（古い版にだけ居る）を拾う', async () => {
    stubUpstream(revisionsWith({ retired: [station('宮崎県', '廃止された点')] }))

    const unlisted = await collectUnlistedStations(LISTED)

    expect([...unlisted.keys()]).toContain('宮崎県|廃止された点')
  })

  it('現行の一覧にある観測点は入れない', async () => {
    stubUpstream(revisionsWith())

    const unlisted = await collectUnlistedStations(LISTED)

    expect([...unlisted.keys()]).toEqual([])
  })

  it('名前か都道府県を持たない観測点は落とす（鍵を作れないため）', async () => {
    stubUpstream(revisionsWith({
      retired: [{ furigana: 'なまえなし' }, { name: '県が無い点', furigana: 'けんがない' }],
    }))

    const unlisted = await collectUnlistedStations(LISTED)

    expect([...unlisted.keys()]).toEqual([])
  })

  it('固定リビジョンが上流の一覧に無ければ止める', async () => {
    // 固定先が消えた・URL を書き間違えた形。素通しすると「現行の一覧」と「履歴」が
    // 別物を指したまま生成が通る。
    stubUpstream(revisionsWith().filter(r => r.id !== PINNED_REVISION))

    await expect(collectUnlistedStations(LISTED)).rejects.toThrow(/リビジョン一覧にありません/)
  })

  it('JSON として読めない版が多いと止める', async () => {
    const revisions = revisionsWith()
    for (let i = 2; i < 5; i++) revisions[i].body = '{壊れた本文'
    stubUpstream(revisions)

    await expect(collectUnlistedStations(LISTED)).rejects.toThrow(/中身を読めたリビジョンが/)
  })

  it('読めても中身の大半を捨てた版は「読めた」と数えない', async () => {
    // **`JSON.parse` が通ることは中身が読めたことを意味しない。** 上流が `pref` のキー名を
    // 変えるような形でスキーマを変えると、配列としては読めるのに観測点が軒並み捨てられる。
    // 件数の幅だけを歯止めにしていると、この形の劣化はすり抜ける。
    const revisions = revisionsWith()
    for (let i = 2; i < 5; i++) revisions[i].body = partiallyBroken(10, 10)
    stubUpstream(revisions)

    await expect(collectUnlistedStations(LISTED)).rejects.toThrow(/大半を捨てた 3 件/)
  })

  // 閾値の境界を固定する。**ここを押さえないと `MAX_DROP_RATIO` の値も比較演算子も、
  // 変えたことに誰も気づけない**（上のテストは 10/10 で、どちらを動かしても落ちない）。
  it('捨てた割合がちょうど半分の版は「読めた」と数える', async () => {
    const revisions = revisionsWith()
    for (let i = 2; i < 5; i++) revisions[i].body = partiallyBroken(10, 5)
    stubUpstream(revisions)

    await expect(collectUnlistedStations(LISTED)).resolves.toBeInstanceOf(Map)
  })

  it('捨てた割合が半分を超えた版は「読めた」と数えない', async () => {
    const revisions = revisionsWith()
    for (let i = 2; i < 5; i++) revisions[i].body = partiallyBroken(10, 6)
    stubUpstream(revisions)

    await expect(collectUnlistedStations(LISTED)).rejects.toThrow(/大半を捨てた 3 件/)
  })

  it('中身が空の版も「読めた」と数えない', async () => {
    // 観測点を 1 件も提供していないのに下限の分母だけ満たす形。**割合の判定では捕まらない**
    // （`0 / 0` は `NaN` で、どんな比較も偽になる）ので、手前で分ける。
    const revisions = revisionsWith()
    for (let i = 2; i < 5; i++) revisions[i].body = []
    stubUpstream(revisions)

    await expect(collectUnlistedStations(LISTED)).rejects.toThrow(/空 3 件/)
  })

  it('一部の版が読めなくても、下限を割らなければ拾えた分を返す', async () => {
    // 上流には保存が途中で切れた版が実在する。1 つの壊れた保存で生成が永久に通らなくなる
    // のを避けるため、飛ばして続ける。
    const revisions = revisionsWith({
      retired: [station('宮崎県', '廃止された点')],
      olderCount: MIN_READABLE_REVISIONS + 2,
    })
    revisions[2].body = '{壊れた本文'
    stubUpstream(revisions)

    const unlisted = await collectUnlistedStations(LISTED)

    expect([...unlisted.keys()]).toContain('宮崎県|廃止された点')
  })
})
