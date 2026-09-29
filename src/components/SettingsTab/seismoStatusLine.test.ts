import { describe, it, expect } from 'vitest'
import { seismoStatusLine, SEISMO_STATUS_TONE_CLASS } from './seismoStatusLine'

describe('seismoStatusLine', () => {
  it('正: 繋がったら観測点とセンサーの本数を出す', () => {
    // **「繋がった」だけでは足りない。** 観測点が 0 件なら、ホストは動いているが
    // 設定がまだ、と分かる。
    const line = seismoStatusLine({
      kind: 'ok',
      stations: [{ stationId: 'home', displayName: '自宅', lat: 35, lon: 139 }],
      sensorCount: 9,
    })
    expect(line.tone).toBe('ok')
    expect(line.text).toContain('観測点 1')
    expect(line.text).toContain('センサー 9')
  })

  it('対照: 繋がらない 4 つの理由を別の文で出す', () => {
    // **これがトグルを持つ形にした代償の手当て。** 1 つの「繋がりません」へ潰すと、
    // 利用者は何を直せばよいか分からない。
    const texts = (['disabled', 'no-url', 'invalid'] as const).map(
      (kind) => seismoStatusLine({ kind }).text,
    )
    texts.push(seismoStatusLine({ kind: 'unreachable', detail: 'Failed to fetch' }).text)
    expect(new Set(texts).size).toBe(4)
  })

  it('対照: 通信する手前で決まる状態は赤で騒がない', () => {
    // トグルが切れている・URL が空は「まだ設定していない」だけで、異常ではない。
    expect(seismoStatusLine({ kind: 'disabled' }).tone).toBe('muted')
    expect(seismoStatusLine({ kind: 'no-url' }).tone).toBe('muted')
    expect(seismoStatusLine({ kind: 'checking' }).tone).toBe('muted')
    // URL の形が違うのは直せる誤りなので赤で出す。
    expect(seismoStatusLine({ kind: 'invalid' }).tone).toBe('problem')
  })

  it('正: 観測点が 0 件のときは別の文にする', () => {
    // **「接続できました（観測点 0・センサー 0）」では成功か異常か判らない。**
    // ホストは動いているが設定がまだ、という状態なので次にすることを書く。
    const line = seismoStatusLine({ kind: 'ok', stations: [], sensorCount: 0 })
    expect(line.tone).toBe('ok')
    expect(line.text).toContain('まだ設定されていません')
    expect(line.text).not.toContain('観測点 0')
  })

  it('安全弁: 到達できないときは何を確かめるかを書く', () => {
    const line = seismoStatusLine({ kind: 'unreachable', detail: 'Failed to fetch' })
    expect(line.text).toContain('起動')
    expect(line.tone).toBe('problem')
  })

  it('対照: 括弧の中へ確認事項を 2 つ詰めない', () => {
    // ホーム画面から開く前提は、この行の上にある常時表示の但し書きが受け持つ。
    // 両方に書くと狭いパネルで折り返して何本出ているか読めなくなる
    // （`settings-pwa-spec.md` §5.5「通知の文の形」）。
    const line = seismoStatusLine({ kind: 'unreachable', detail: 'Failed to fetch' })
    expect(line.text).not.toContain('ホーム画面')
    // 括弧は 1 組だけ。
    expect(line.text.match(/（/g)).toHaveLength(1)
  })

  it('安全弁: 失敗の詳細を画面へ出さない', () => {
    // `fetch` が返す文面（`Failed to fetch` 等）は利用者の行動に繋がらない。
    // 詳細は記録へ出る（`seismoStream.ts`）。
    const line = seismoStatusLine({ kind: 'unreachable', detail: 'Failed to fetch' })
    expect(line.text).not.toContain('Failed to fetch')
    const unreadable = seismoStatusLine({ kind: 'unreadable', detail: 'sensors が無い' })
    expect(unreadable.text).not.toContain('sensors')
  })

  it('安全弁: HTTP の状態コードだけは内訳として出す', () => {
    // あちらはこちらの言葉ではなく相手が名乗った番号で、調べる手掛かりになる。
    expect(seismoStatusLine({ kind: 'http-error', status: 503 }).text).toContain('503')
  })

  it('安全弁: 色調の表は 3 種すべてを持つ', () => {
    expect(Object.keys(SEISMO_STATUS_TONE_CLASS).sort()).toEqual(['muted', 'ok', 'problem'])
  })
})
