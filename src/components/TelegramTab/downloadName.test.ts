// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement as h } from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { TelegramTab } from './index'
import type { TelegramLogEntry } from '../../types/earthquake'
import { withTz } from '../../test-utils/withTz'

// 電文ログのダウンロード名の時刻。UTC で作ると JST の端末では 9 時間ずれた名前が並び、
// 画面に出ている受信時刻と突き合わせられない（診断ログ側と同じ穴）。
//
// JSX を使わず createElement で組むのは、vitest の include が `src/**/*.test.ts` に限られており
// `.tsx` を拾わないため（CameraFollowsGL.test.ts と同じ方針）。

/** ダウンロードを走らせず、`a.download` と Blob だけ捕まえる。 */
function captureDownloads(): { names: string[]; blobs: Blob[]; restore: () => void } {
  const names: string[] = []
  const blobs: Blob[] = []
  const origClick = HTMLAnchorElement.prototype.click
  const origCreate = URL.createObjectURL
  const origRevoke = URL.revokeObjectURL
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (this.download) { names.push(this.download); return }
    return origClick.apply(this)
  }
  URL.createObjectURL = (b: Blob | MediaSource) => { blobs.push(b as Blob); return 'blob:dummy' }
  URL.revokeObjectURL = () => {}
  return {
    names,
    blobs,
    restore: () => {
      HTMLAnchorElement.prototype.click = origClick
      URL.createObjectURL = origCreate
      URL.revokeObjectURL = origRevoke
    },
  }
}

function entry(receivedAt: Date, headType = 'VXSE53'): TelegramLogEntry {
  return {
    id: `id-${receivedAt.getTime()}`,
    receivedAt,
    source: 'dmdss',
    headType,
    isTest: false,
    status: 'parsed',
    kind: 'quake',
    rawHead: { type: headType },
    rawBody: { ok: true },
  }
}

function click(container: HTMLElement, text: string): void {
  const btn = Array.from(container.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === text,
  )
  if (!btn) throw new Error(`ボタンが見つからない: ${text}`)
  act(() => { btn.click() })
}

/** 電文の行を押して本文を開く（ダウンロード・コピーは開かないと出ない）。 */
function expandRow(container: HTMLElement, headType: string): void {
  const row = Array.from(container.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').includes(headType),
  )
  if (!row) throw new Error(`電文の行が見つからない: ${headType}`)
  act(() => { row.click() })
}

describe('電文ログのダウンロード名', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  // ローカルで 2026-08-23 15:04:05（JST）になる受信時刻。UTC 基準だと 060405 になる
  const RECEIVED = () => new Date(2026, 7, 23, 15, 4, 5)
  const NOW = () => new Date(2026, 7, 24, 9, 30, 0).getTime()

  it('個別ダウンロードは受信時刻を端末のローカル時刻で出す', () => {
    withTz('Asia/Tokyo', () => {
      const cap = captureDownloads()
      try {
        const { container } = render(h(TelegramTab, { telegramLog: [entry(RECEIVED())], onClear: () => {} }))
        expandRow(container, 'VXSE53')
        click(container, 'ダウンロード')
        expect(cap.names).toEqual(['20260823_150405+0900_DMDSS_VXSE53.json'])
      } finally {
        cap.restore()
      }
    })
  })

  it('選択ダウンロード（JSON）は書き出した時刻で出す', () => {
    withTz('Asia/Tokyo', () => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW())
      const cap = captureDownloads()
      try {
        const { container } = render(h(TelegramTab, { telegramLog: [entry(RECEIVED())], onClear: () => {} }))
        const box = container.querySelector('input[type=checkbox]')
        if (!box) throw new Error('選択のチェックボックスが無い')
        fireEvent.click(box)
        click(container, 'JSON')
        expect(cap.names).toEqual(['20260824_093000+0900_telegrams_1件.json'])
      } finally {
        cap.restore()
      }
    })
  })

  it('JSON の中身の受信時刻は ISO のまま（ファイル名だけをローカル時刻にする）', async () => {
    // ファイル名は人が読んで突き合わせるもの、中身は機械が読み直すもの。役割が違うので基準を分ける。
    // 「名前と揃えよう」と本文までローカル時刻にすると、他のツールでの再解析が壊れる
    const cap = captureDownloads()
    try {
      // 期待値もこの中で作る。`RECEIVED()` は壁時計から Date を組むので、外で呼ぶと実行環境の
      // 時間帯で解釈される。UTC で走る CI では中身（JST 解釈）と 9 時間ずれて落ちる
      const expectedIso = withTz('Asia/Tokyo', () => {
        const { container } = render(h(TelegramTab, { telegramLog: [entry(RECEIVED())], onClear: () => {} }))
        const box = container.querySelector('input[type=checkbox]')
        if (!box) throw new Error('選択のチェックボックスが無い')
        fireEvent.click(box)
        click(container, 'JSON')
        return RECEIVED().toISOString()
      })
      const payload = JSON.parse(await cap.blobs[0].text()) as { receivedAt: string }[]
      expect(payload[0].receivedAt).toBe(expectedIso)
      expect(payload[0].receivedAt).toMatch(/Z$/)
    } finally {
      cap.restore()
    }
  })

  it('ZIP は外側を書き出した時刻・中身を受信時刻で出す', async () => {
    const cap = captureDownloads()
    try {
      withTz('Asia/Tokyo', () => {
        vi.spyOn(Date, 'now').mockReturnValue(NOW())
        const { container } = render(h(TelegramTab, { telegramLog: [entry(RECEIVED())], onClear: () => {} }))
        const box = container.querySelector('input[type=checkbox]')
        if (!box) throw new Error('選択のチェックボックスが無い')
        fireEvent.click(box)
        click(container, 'ZIP')
      })
      expect(cap.names).toEqual(['20260824_093000+0900_telegrams_1件.zip'])
      // zip はローカルファイルヘッダに名前を非圧縮で持つので、生バイトから読める
      const bytes = new Uint8Array(await cap.blobs[0].arrayBuffer())
      const text = new TextDecoder('utf-8').decode(bytes)
      expect(text).toContain('20260823_150405+0900_DMDSS_VXSE53.json')
    } finally {
      cap.restore()
    }
  })
})
