// @vitest-environment jsdom
//
// 「検知が判らなくなって消えた」あとの復帰で、同じ地震の警報を鳴らし直さないことのテスト。
//
// 検知エンジンは結果を出せないフレームが続くと結果を空にする（凍結したメンバーを現在の震度に
// 当てて描き続けないため）。このとき confirmed が false へ落ちるので、復帰時に素朴なエッジ検出だと
// 「揺れ検知開始」がもう一度発火し、同じ地震で音とブラウザ通知が鳴り直す。
//
// **判定に経過時間を使わない**ことが要点。時計を持ち込むと、起点のずれ・リプレイでの時計の飛び・
// 窓の閉じ忘れで「鳴るべきときに鳴らない」側へ倒れる。代わりに「結果が戻った最初のフレームで検知が
// 立っているか」と「その場所が途絶前と揃っているか」の 2 つで判断する。場所を見ないと、短い途絶では
// 検知エンジンが状態を組み直さないため、復帰フレームで確定した**別の地震**を続きと誤認する。
//
// ここで固定するのは 5 つ。
//   1. 正: 「判らなくなった」直後の復帰では鳴らさない
//   2. 正: 鳴らさない場合でも画面は戻す
//   3. 対照: 揺れが収まって消えたあとの再検知では鳴らす（別の地震かもしれない）
//   4. 安全弁: 復帰した検知が別の場所なら鳴らす（1 つでも離れた地点が混じれば鳴らす）
//   5. 安全弁: 検知が戻らないまま結果だけ復帰したら印を下ろす（後から来た別の地震で鳴る）
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useKyoshinAlerts, type KyoshinAlertsDeps } from './useKyoshinAlerts'
import { playAlertSound } from '../utils/alertSound'
import { showBrowserNotification } from '../utils/notifications'
import type { AppSettings } from './useSettings'
import type { AlertTitleApi } from './useAlertTitle'
import type { EEWAlert } from '../types/earthquake'
import type { TabId } from '../components/IconNav'

vi.mock('../utils/alertSound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/alertSound')>()
  return { ...actual, playAlertSound: vi.fn(), playKyoshinUpdateSound: vi.fn() }
})
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

const NOTO = { lat: 37.5, lng: 137.0, index: 20, peak: { lat: 37.45, lng: 137.15 } }
// 能登から約 700km。イベント重心を 1 地震とみなす MERGE_EVENT_KM(100km) より十分遠い。
const FUKUOKA = { lat: 33.6, lng: 130.4, index: 20, peak: { lat: 33.58, lng: 130.35 } }

function makeDeps(over: Partial<KyoshinAlertsDeps> = {}): KyoshinAlertsDeps {
  return {
    confirmed: false,
    candidate: false,
    candidateMaxIndex: 0,
    confirmedShocks: [],
    dataTime: '',
    stalled: false,
    // 通知も対象にするため notifyMinScale は 0（通知する）。
    settings: { soundEnabled: true, notifyMinScale: 0, notifyDetection: true } as unknown as AppSettings,
    title: { setTitle: vi.fn(), applyPriority: vi.fn() } as unknown as AlertTitleApi,
    activeEEWsRef: { current: new Map<string, EEWAlert>() },
    defaultTabRef: { current: 'earthquake' as TabId },
    setActiveTab: vi.fn(),
    revertToDefaultTab: vi.fn(),
    onShakeFocus: vi.fn(),
    ...over,
  }
}

/** 検知中の状態。 */
const DETECTING = { confirmed: true, confirmedShocks: [NOTO] }
/** 検知が消えた状態（消えた理由は stalled で指定する）。 */
const lost = (stalled: boolean) => ({ confirmed: false, confirmedShocks: [], stalled })

describe('useKyoshinAlerts: 判らなくなったあとの復帰で鳴らし直さない', () => {
  beforeEach(() => {
    vi.mocked(playAlertSound).mockClear()
    vi.mocked(showBrowserNotification).mockClear()
  })

  /** 検知中から始めて、渡したコマを順に流す。初検知ぶんの発報は数えない。 */
  function drive(...frames: Partial<KyoshinAlertsDeps>[]) {
    const { rerender } = renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), {
      initialProps: makeDeps(DETECTING),
    })
    vi.mocked(playAlertSound).mockClear()
    vi.mocked(showBrowserNotification).mockClear()
    for (const f of frames) rerender(makeDeps(f))
  }

  it('[正] 検知が止まって消えた直後の復帰では、音もブラウザ通知も出さない', () => {
    drive(lost(true), DETECTING)
    expect(playAlertSound).not.toHaveBeenCalled()
    expect(showBrowserNotification).not.toHaveBeenCalled()
  })

  it('[正] 鳴らさない場合でも画面は戻す（タブとタイトル）', () => {
    const setActiveTab = vi.fn()
    const title = { setTitle: vi.fn(), applyPriority: vi.fn() } as unknown as AlertTitleApi
    const { rerender } = renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), {
      initialProps: makeDeps({ ...DETECTING, setActiveTab, title }),
    })
    vi.mocked(setActiveTab).mockClear()
    vi.mocked(title.setTitle).mockClear()

    rerender(makeDeps({ ...lost(true), setActiveTab, title }))
    rerender(makeDeps({ ...DETECTING, setActiveTab, title }))

    expect(setActiveTab).toHaveBeenCalledWith('realtime')
    expect(title.setTitle).toHaveBeenCalledWith('揺れ検知')
  })

  it('[対照] 揺れが収まって消えたあとの再検知では鳴らす（別の地震かもしれない）', () => {
    drive(lost(false), DETECTING)
    expect(playAlertSound).toHaveBeenCalledTimes(1)
    expect(showBrowserNotification).toHaveBeenCalledTimes(1)
  })

  it('[安全弁] 判らなくなった直後の復帰でも、別の場所の地震なら鳴らす', () => {
    // 途絶が MAX_DT_GAP_MS 以内だと検知エンジンは状態を組み直さず通常の経路を通るため、復帰した
    // フレームで**まったく別の地震**が確定しうる（EEW 発表中や高震度は 1 フレームで確定する設計）。
    // 中間フレームを経ずに直接遷移するので、印が立っているかだけでは見分けられない——ここで
    // 場所を照合しないと、無関係な地震の警報を無音で握り潰す。
    drive(lost(true), { confirmed: true, confirmedShocks: [FUKUOKA] })
    expect(playAlertSound).toHaveBeenCalledTimes(1)
    expect(showBrowserNotification).toHaveBeenCalledTimes(1)
  })

  it('[安全弁] 復帰後に元の場所と離れた地点が混じっていたら鳴らす', () => {
    // 元の揺れが続いていても、別の地震が重なったなら知らせる必要がある。
    drive(lost(true), { confirmed: true, confirmedShocks: [NOTO, FUKUOKA] })
    expect(playAlertSound).toHaveBeenCalledTimes(1)
  })

  it('[安全弁] 検知が戻らないまま結果だけ復帰したら、次の検知では鳴らす', () => {
    // 途絶が長ければ検知エンジンは状態を組み直し、そのフレームの検知を空で返す。ここで印を
    // 下ろさないと、後から来た**無関係な地震**の音と通知が無音で消える。
    drive(
      lost(true), // 判らなくなって消えた
      lost(false), // 結果は戻ったが検知は無い（＝続きではなかった）
      DETECTING, // 別の地震
    )
    expect(playAlertSound).toHaveBeenCalledTimes(1)
    expect(showBrowserNotification).toHaveBeenCalledTimes(1)
  })
})
