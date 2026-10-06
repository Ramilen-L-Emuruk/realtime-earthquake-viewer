// @vitest-environment jsdom
//
// 観測点タブのうち、**運用者に考えさせない・打たせない**ための振る舞いを固定する。
// `stationId` は登録後に変えられず、`PUT` は upsert なので、既存と同じ値を勧めると
// 稼働中の観測点が警告なく消える。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initStationsView, nextStationId } from './viewStations'
import type { StationInfo } from '../receiver/stationConfigTypes'

describe('nextStationId', () => {
  it('1 件も無ければ station-1', () => {
    expect(nextStationId([])).toBe('station-1')
  })

  it('連番の途中が空いていれば、いちばん小さい空きを使う', () => {
    expect(nextStationId(['station-1', 'station-3'])).toBe('station-2')
  })

  it('連番が詰まっていれば次の番号', () => {
    expect(nextStationId(['station-1', 'station-2'])).toBe('station-3')
  })

  // 運用者が自分で付けた ID（`home`・`study` 等）は連番と重ならない。
  it('連番でない ID は邪魔をしない', () => {
    expect(nextStationId(['home', 'study'])).toBe('station-1')
  })
})

const STATIONS: readonly StationInfo[] = [
  { stationId: 'station-1', displayName: '書斎', lat: 35.6, lon: 139.7 },
]

/**
 * `/api/stations` の応答を固定値で返す。
 *
 * `listFailsAfter` は「N 回目の GET から失敗させる」指定。**保存は成功したが直後の
 * 一覧再取得だけ失敗する**という並びを作るために要る（敵対的レビューで検出した穴）。
 */
function stubApiFetch(
  options: { readonly listFails?: boolean; readonly listFailsAfter?: number } = {},
): void {
  let gets = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: unknown, init?: { readonly method?: string }) => {
      if (path === '/api/stations') {
        gets += 1
        const fails =
          options.listFails === true ||
          (options.listFailsAfter !== undefined && gets >= options.listFailsAfter)
        if (fails) return { ok: false, status: 503, json: async () => ({}) }
        return { ok: true, status: 200, json: async () => ({ stations: STATIONS }) }
      }
      if (typeof path === 'string' && path.startsWith('/api/stations/') && init?.method === 'PUT') {
        return { ok: true, status: 204, json: async () => ({}) }
      }
      throw new Error(`unexpected fetch path: ${String(path)}`)
    }),
  )
}

async function mount(): Promise<HTMLElement> {
  const container = document.createElement('div')
  await initStationsView(container, new AbortController().signal)
  return container
}

const stationIdValue = (c: HTMLElement): string =>
  c.querySelector<HTMLInputElement>('[name=stationId]')?.value ?? ''

describe('観測点 ID の自動生成', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('初回に開いた時点で、空いている ID が入っている', async () => {
    stubApiFetch()
    expect(stationIdValue(await mount())).toBe('station-2')
  })

  it('既存を編集するときは、その ID のまま（提案で上書きしない）', async () => {
    stubApiFetch()
    const container = await mount()
    container.querySelector<HTMLButtonElement>('.edit-station')?.click()
    expect(stationIdValue(container)).toBe('station-1')
  })

  it('「新規登録へ」で戻すと、また空いている ID が入る', async () => {
    stubApiFetch()
    const container = await mount()
    container.querySelector<HTMLButtonElement>('.edit-station')?.click()
    container.querySelector<HTMLButtonElement>('.reset-form')?.click()
    expect(stationIdValue(container)).toBe('station-2')
  })

  // **知らない既存を上書きしうる提案はしない。** 一覧が取れていないのに連番を出すと、
  // 稼働中の観測点と同じ ID を勧めることになる（`PUT` は upsert）。
  it('一覧を取れなかったときは提案しない（空欄のまま）', async () => {
    stubApiFetch({ listFails: true })
    const container = await mount()
    expect(stationIdValue(container)).toBe('')
  })

  // **保存は通ったが直後の再取得だけ失敗した場合。** `current` は保存前のままなので、
  // 印を立てたままにすると**いま保存した ID をもう一度勧める**。運用者が続けて別の
  // 内容で保存すると、さっき作った観測点が確認なく上書きされる（敵対的レビューで検出）。
  it('保存後に一覧を取り直せなかったら、次の ID を提案しない', async () => {
    // 1 回目（初回マウント）は成功・2 回目（保存後の再取得）から失敗。
    stubApiFetch({ listFailsAfter: 2 })
    const container = await mount()
    expect(stationIdValue(container)).toBe('station-2')

    const name = container.querySelector<HTMLInputElement>('[name=displayName]')
    const lat = container.querySelector<HTMLInputElement>('[name=lat]')
    const lon = container.querySelector<HTMLInputElement>('[name=lon]')
    if (name === null || lat === null || lon === null) throw new Error('入力欄が無い')
    name.value = '玄関'
    lat.value = '35'
    lon.value = '139'
    container.querySelector<HTMLFormElement>('.station-form')?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(stationIdValue(container)).toBe('')
    expect(container.querySelector('.stations-error')?.textContent).toContain('再取得に失敗')
  })
})

/** 基板タブと同じ未保存確認（敵対的レビューが両タブの非対称として指摘）。 */
describe('観測点タブの未保存確認', () => {
  beforeEach(() => {
    stubApiFetch()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('入力中に別の観測点の編集を押すと確認を求める', async () => {
    const container = await mount()
    const name = container.querySelector<HTMLInputElement>('[name=displayName]')
    if (name === null) throw new Error('表示名の入力欄が無い')
    name.value = '入力途中'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    container.querySelector<HTMLButtonElement>('.edit-station')?.click()

    expect(confirmSpy).toHaveBeenCalledOnce()
    expect(container.querySelector<HTMLInputElement>('[name=displayName]')?.value).toBe('入力途中')
  })

  it('未編集なら確認を求めない', async () => {
    const container = await mount()
    const confirmSpy = vi.spyOn(window, 'confirm')

    container.querySelector<HTMLButtonElement>('.edit-station')?.click()

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(stationIdValue(container)).toBe('station-1')
  })
})

describe('現在地から座標を入れる', () => {
  beforeEach(() => {
    stubApiFetch()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** `window.isSecureContext` と `navigator.geolocation` を差し替える。 */
  function stubGeolocation(secure: boolean, geolocation: unknown): void {
    Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true })
    Object.defineProperty(window.navigator, 'geolocation', { value: geolocation, configurable: true })
  }

  it('取得できたら緯度・経度を埋め、誤差を添える', async () => {
    stubGeolocation(true, {
      getCurrentPosition: (ok: (p: unknown) => void) =>
        // 公開前の検査が座標として拾わないよう、日本の外（赤道付近の海上）の値にしてある。
        ok({ coords: { latitude: 1.234567891, longitude: 2.345678912, accuracy: 32.4 } }),
    })
    const container = await mount()
    container.querySelector<HTMLButtonElement>('.use-current-location')?.click()

    expect(container.querySelector<HTMLInputElement>('[name=lat]')?.value).toBe('1.234568')
    expect(container.querySelector<HTMLInputElement>('[name=lon]')?.value).toBe('2.345679')
    expect(container.querySelector('.location-note')?.textContent).toContain('±32 m')
  })

  it('拒否されたら理由を出す（座標は書き換えない）', async () => {
    stubGeolocation(true, {
      getCurrentPosition: (_ok: unknown, ng: (e: { code: number }) => void) => ng({ code: 1 }),
    })
    const container = await mount()
    container.querySelector<HTMLButtonElement>('.use-current-location')?.click()

    expect(container.querySelector('.location-note')?.textContent).toContain('許可されていない')
    expect(container.querySelector<HTMLInputElement>('[name=lat]')?.value).toBe('')
  })

  // **押しても何も起きない画面にしない。** このホストはまだ HTTPS で配信して
  // いないので（REQUIREMENTS.md §13）、tailnet の IP で開くとここへ来る。
  it('素の HTTP ではボタンを押せなくし、URL が原因だと書く', async () => {
    stubGeolocation(false, { getCurrentPosition: () => undefined })
    const container = await mount()

    expect(container.querySelector<HTMLButtonElement>('.use-current-location')?.disabled).toBe(true)
    expect(container.querySelector('.location-note')?.textContent).toContain('HTTPS か localhost')
  })
})
