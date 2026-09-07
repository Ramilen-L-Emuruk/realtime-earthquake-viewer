// @vitest-environment jsdom
//
// 特別情報の帯に出す運用種別（電文の `Control/Status`）の印。
//
// **この状態はブラウザで作れない。** アプリは試験報・訓練報を既定で捨て、リプレイ経路
// （`dmdataReplay.ts`）は設定に関わらず落とす。だが実電文を数えると、帯に出る 2 種別は
// これまでに配信されたものの多くが訓練報だった（後発地震注意情報は訓練 5 / 通常 2、
// 南海トラフ臨時情報は訓練 4 / 通常 4）。印が無いと、訓練の「巨大地震注意」が本物と
// 同じ顔で出る。描いて確かめるしかない。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { SpecialInfoBanner } from './index'
import type { JMAKohatsu, JMANankai, JMANankaiCommentary, TelegramOperationStatus } from '../../types/earthquake'

afterEach(cleanup)

const nankai = (operationStatus?: TelegramOperationStatus): JMANankai => ({
  id: 'n1', time: '2026-01-01T12:00:00+09:00', eventId: 'e1',
  kindCode: '120', kindName: '巨大地震警戒',
  headline: '南海トラフ地震臨時情報（巨大地震警戒）を発表しました。',
  body: '本文', cancelled: false, reportDateTime: '2026-01-01T12:00:00+09:00',
  ...(operationStatus && { operationStatus }),
})

const commentary = (operationStatus?: TelegramOperationStatus): JMANankaiCommentary => ({
  id: 'c1', time: '2026-01-01T12:00:00+09:00', eventId: 'e2',
  serialCode: '200', serialName: '定例解説',
  headline: '南海トラフ地震関連解説情報（定例）', summary: '', body: '本文',
  cancelled: false, reportDateTime: '2026-01-01T12:00:00+09:00',
  expireAt: '2026-01-08T12:00:00+09:00',
  ...(operationStatus && { operationStatus }),
})

const kohatsu = (operationStatus?: TelegramOperationStatus): JMAKohatsu => ({
  id: 'k1', time: '2026-01-01T12:00:00+09:00', eventId: 'e3',
  headline: '北海道・三陸沖後発地震注意情報を発表しました。', body: '本文',
  cancelled: false, reportDateTime: '2026-01-01T12:00:00+09:00',
  expireAt: '2026-01-08T12:00:00+09:00',
  ...(operationStatus && { operationStatus }),
})

describe('特別情報の帯の運用種別', () => {
  // 正: 3 つの帯すべてに印が出る。**帯ごとに書くと片方だけ落ちる**ので、まとめて見る。
  it('訓練報はどの帯にも印が出る', () => {
    render(<SpecialInfoBanner nankai={nankai('訓練')} nankaiCommentary={commentary('訓練')} kohatsu={kohatsu('訓練')} />)
    expect(screen.getAllByText('訓練報')).toHaveLength(3)
  })

  it('試験報も同じ', () => {
    render(<SpecialInfoBanner nankai={nankai('試験')} nankaiCommentary={commentary('試験')} kohatsu={kohatsu('試験')} />)
    expect(screen.getAllByText('試験報')).toHaveLength(3)
  })

  // 対照: 通常の報では印を出さない。**平常時に余計な印が出ないこと**を押さえる。
  it('通常の報では印を出さない', () => {
    render(<SpecialInfoBanner nankai={nankai()} nankaiCommentary={commentary()} kohatsu={kohatsu()} />)
    expect(screen.queryByText('訓練報')).toBeNull()
    expect(screen.queryByText('試験報')).toBeNull()
    // 帯そのものは出ている（印だけが出ない）
    expect(screen.getByText('巨大地震警戒')).toBeTruthy()
    expect(screen.getByText('後発地震注意')).toBeTruthy()
  })
})
