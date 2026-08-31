import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attributionLine,
  DEFAULT_SHARE_CARD_FORMAT,
  shareCardMapHeight,
  shareOrDownloadImage,
  standardAppUrl,
} from './shareCard'

// 地図に割ける高さは「カード全体 − 見出し帯 − 出典帯」で決まり、撮影側（useShareCard）と
// 合成側（composeShareCard）の両方が同じ計算を通す。ここが崩れると、撮った地図が貼るときに
// 引き伸ばされて縮尺が狂う——型では捕まらないので値で固定する。

describe('shareCardMapHeight', () => {
  const format = DEFAULT_SHARE_CARD_FORMAT

  it('出典が増えるほど地図は縮む', () => {
    const h0 = shareCardMapHeight(format, 0)
    const h1 = shareCardMapHeight(format, 1)
    const h2 = shareCardMapHeight(format, 2)
    expect(h0).toBeGreaterThan(h1)
    expect(h1).toBeGreaterThan(h2)
  })

  it('どの行数でも地図の高さは正で、カード全体に収まる', () => {
    for (const count of [0, 1, 2, 3, 4]) {
      const h = shareCardMapHeight(format, count)
      expect(h).toBeGreaterThan(0)
      expect(h).toBeLessThan(format.height)
    }
  })

  // 出典が 1 行も無ければ帯ごと出さない。そのぶん 1 行目の減り幅だけが、2 行目以降
  // （行送りのみ）より大きくなる。
  it('出典が 0 行のときは帯ごと出ない', () => {
    const firstLineCost = shareCardMapHeight(format, 0) - shareCardMapHeight(format, 1)
    const secondLineCost = shareCardMapHeight(format, 1) - shareCardMapHeight(format, 2)
    expect(firstLineCost).toBeGreaterThan(secondLineCost)
  })

  it('既定の寸法は X のタイムラインに合わせた 16:9', () => {
    expect(format.width / format.height).toBeCloseTo(16 / 9, 4)
  })
})

describe('attributionLine', () => {
  // 境界線や活断層は元データを変換して使う（加工にあたる）が、海底地形は配信されるタイルを
  // そのまま描いている。まとめて括ると、加工していないものまで加工したと述べることになる。
  it('加工したものだけを「を加工して作成」で括る', () => {
    const line = attributionLine({ derived: ['気象庁'], asIs: ['GEBCO'] })
    expect(line).toBe('出典: GEBCO／気象庁 を加工して作成')
  })

  it('加工していないものが無ければ、加工の句だけを出す', () => {
    expect(attributionLine({ derived: ['気象庁'], asIs: [] })).toBe('出典: 気象庁 を加工して作成')
  })

  it('加工したものが無ければ、加工の句を出さない', () => {
    const line = attributionLine({ derived: [], asIs: ['GEBCO'] })
    expect(line).toBe('出典: GEBCO')
    expect(line).not.toContain('加工')
  })
})

// 本文の末尾に載せる URL。DMDSS 版は DMDATA.JP の API キーが要るため、そのパスを渡すと
// 受け取った人が設定画面に突き当たる。共有には誰でも開ける standard 版を載せる。
describe('standardAppUrl', () => {
  it('standard 版の配信パスはそのまま使う', () => {
    expect(standardAppUrl('https://example.test', '/realtime-earthquake-viewer/')).toBe(
      'https://example.test/realtime-earthquake-viewer/',
    )
  })

  it('DMDSS 版から共有しても standard 版の URL にする', () => {
    expect(standardAppUrl('https://example.test', '/realtime-earthquake-viewer/dmdss/')).toBe(
      'https://example.test/realtime-earthquake-viewer/',
    )
  })

  it('ルート配信でも成り立つ', () => {
    expect(standardAppUrl('https://example.test', '/')).toBe('https://example.test/')
  })

  // 対照。パスの途中に dmdss を含むだけの配信先を削ってしまわないこと。落とすのは末尾だけ。
  it('末尾以外の dmdss は落とさない', () => {
    expect(standardAppUrl('https://example.test', '/dmdss-viewer/')).toBe('https://example.test/dmdss-viewer/')
  })

  // 安全弁。配信パスの書き方を決めているのは vite.config.ts の一存で、末尾スラッシュを落とす
  // 変更が入りうる。そのとき本文の URL が黙って DMDSS 版へ戻らないこと。
  it('末尾スラッシュが無い配信パスでも落とす', () => {
    expect(standardAppUrl('https://example.test', '/realtime-earthquake-viewer/dmdss')).toBe(
      'https://example.test/realtime-earthquake-viewer/',
    )
  })
})

// 共有シートへ渡すか、保存して本文をクリップボードへ置くか。分岐そのものと、そこで起きうる
// 失敗の扱いを固定する。ブラウザの API はテスト環境に無いので、必要なものだけ差し替える。
describe('shareOrDownloadImage', () => {
  const TEXT = '最大震度 4　日向灘\nhttps://example.test/'

  /** 共有・保存・クリップボードの呼ばれ方を記録する土台を敷く。 */
  function setup(over: {
    canShare?: boolean
    share?: () => Promise<void>
    writeText?: (t: string) => Promise<void>
    noClipboard?: boolean
  }) {
    const shared: unknown[] = []
    const saved: string[] = []
    const copied: string[] = []
    const anchor = { href: '', download: '', click: () => saved.push(anchor.download), remove: () => {} }
    vi.stubGlobal('document', { createElement: () => anchor, body: { appendChild: () => {} } })
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => (cb(0), 0))
    vi.stubGlobal('navigator', {
      canShare: () => over.canShare ?? true,
      share: async (d: unknown) => {
        shared.push(d)
        if (over.share) await over.share()
      },
      // **API が無い環境は `clipboard` ごと存在しない。** 空のオブジェクトを置くと、防御が
      // 無い実装でも呼び出しが例外になって拾われてしまい、テストが穴を見逃す。
      clipboard: over.noClipboard
        ? undefined
        : {
            writeText: async (t: string) => {
              if (over.writeText) return over.writeText(t)
              copied.push(t)
            },
          },
    })
    return { shared, saved, copied }
  }

  afterEach(() => vi.unstubAllGlobals())

  function blob() {
    return new Blob(['x'], { type: 'image/png' })
  }

  it('共有シートが使えるなら画像と本文を一緒に渡す', async () => {
    const { shared, saved, copied } = setup({ canShare: true })
    const outcome = await shareOrDownloadImage(blob(), 'quake_x.png', TEXT)
    expect(outcome).toEqual({ result: 'shared', textCopied: false })
    expect((shared[0] as { text: string }).text).toBe(TEXT)
    expect((shared[0] as { files: File[] }).files[0].name).toBe('quake_x.png')
    // 共有シートが本文ごと受け取っているので、保存もクリップボードも使わない。
    expect(saved).toEqual([])
    expect(copied).toEqual([])
  })

  // 対照。共有シートを持たない環境では本文の渡し先が無いので、クリップボードへ置く。
  it('共有シートが無ければ保存し、本文をクリップボードへ置く', async () => {
    const { shared, saved, copied } = setup({ canShare: false })
    const outcome = await shareOrDownloadImage(blob(), 'quake_x.png', TEXT)
    expect(outcome).toEqual({ result: 'downloaded', textCopied: true })
    expect(shared).toEqual([])
    expect(saved).toEqual(['quake_x.png'])
    expect(copied).toEqual([TEXT])
  })

  // 安全弁。クリップボードへ置けなくても画像の保存までは終える。置けなかったことは
  // 呼び出し元へ伝える（伝えないと「コピーしました」と見せてしまう）。
  it('クリップボードへ置けなくても保存は済ませ、置けなかったことを返す', async () => {
    const { saved } = setup({
      canShare: false,
      writeText: () => Promise.reject(new Error('拒否されました')),
    })
    const outcome = await shareOrDownloadImage(blob(), 'quake_x.png', TEXT)
    expect(outcome).toEqual({ result: 'downloaded', textCopied: false })
    expect(saved).toEqual(['quake_x.png'])
  })

  // 安全弁。クリップボードの API 自体が無い環境（安全な文脈でない配信）でも同じ扱いにする。
  // `navigator.clipboard?.writeText(text)` と書くと undefined を await して成功と誤認するため、
  // 実装は呼ぶ前に有無を確かめている。ここはその防御が外れたことを捕まえる。
  it('クリップボードの API が無い環境でも保存は済ませる', async () => {
    const { saved } = setup({ canShare: false, noClipboard: true })
    const outcome = await shareOrDownloadImage(blob(), 'quake_x.png', TEXT)
    expect(outcome).toEqual({ result: 'downloaded', textCopied: false })
    expect(saved).toEqual(['quake_x.png'])
  })

  // 安全弁。共有シートを閉じただけの取り消しは失敗ではない。保存へ落とさないのはもちろん、
  // **クリップボードも書き換えない**——共有をやめた利用者の手元を勝手に上書きしないため。
  it('共有シートを閉じただけなら保存もクリップボードも触らない', async () => {
    const { saved, copied } = setup({
      canShare: true,
      share: () => Promise.reject(new DOMException('中止', 'AbortError')),
    })
    const outcome = await shareOrDownloadImage(blob(), 'quake_x.png', TEXT)
    expect(outcome).toEqual({ result: 'canceled', textCopied: false })
    expect(saved).toEqual([])
    expect(copied).toEqual([])
  })

  // 取り消し以外の失敗（共有シートが本文つきを扱えない等）では保存へ切り替える。
  it('共有に失敗したら保存へ切り替える', async () => {
    const { saved, copied } = setup({
      canShare: true,
      share: () => Promise.reject(new Error('渡せませんでした')),
    })
    const outcome = await shareOrDownloadImage(blob(), 'quake_x.png', TEXT)
    expect(outcome).toEqual({ result: 'downloaded', textCopied: true })
    expect(saved).toEqual(['quake_x.png'])
    expect(copied).toEqual([TEXT])
  })
})
