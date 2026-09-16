// 読み上げに関わる 2 つの上限の関係。
//
// **「合成側 < チェーン側」を機械的に固定する。** 片方だけを動かすと、どちらもテストは通るのに
// 判断が静かに崩れる —— 発話チェーンは「上限まで返ってこないのは鳴っている最中」とみなして
// 既読を進めるが（`useLiveEventHandler` の `chainEEWSpeech`）、その前提は**合成側が先に
// 諦めること**で成り立っている。合成側が長い（または無い）と、VOICEVOX が応答しないまま
// ハングした発話が「鳴っている最中」に化け、1 音も出ていないのに既読が進む。
//
// 定数は別々のファイルにあり、型検査では関係を保てない。ここで突き合わせる。
import { describe, it, expect } from 'vitest'
import { CHUNK_SYNTH_TIMEOUT_MS, SPEECH_SYNTH_BUDGET_MS } from './voicevox'
import { EEW_SPEECH_CHAIN_MAX_WAIT_MS } from '../hooks/useLiveEventHandler'
import { DICT_FETCH_TIMEOUT_MS } from './ttsPhraseBreakDict'

describe('読み上げの上限', () => {
  // **見るのは合計の予算。** チャンクごとの上限だけでは足りない —— 合成待ちは直列に積み上がる
  // ので、チャンクが増えれば合計はいくらでも伸びる。
  it('発話 1 回の合成待ちの予算は、発話チェーンの待ち上限より短い', () => {
    expect(SPEECH_SYNTH_BUDGET_MS).toBeLessThan(EEW_SPEECH_CHAIN_MAX_WAIT_MS)
  })

  // 1 チャンクの上限が予算を越えていると、予算の意味が無くなる（1 チャンクで使い切る）
  it('合成 1 チャンクの上限は、合計の予算を越えない', () => {
    expect(CHUNK_SYNTH_TIMEOUT_MS).toBeLessThanOrEqual(SPEECH_SYNTH_BUDGET_MS)
  })

  // **予算の起点は発話の開始で、辞書の取得待ちも含む。** 含めないと、辞書が遅い日に
  // 「辞書 5 秒 ＋ 合成 6 秒 = 11 秒」となってチェーン上限（8 秒）を越え、まだ 1 音も
  // 鳴っていないのに「鳴っている最中」と誤認される。
  //
  // ここで確かめるのは**予算が辞書の上限を飲み込める大きさか**。予算のほうが小さいと、
  // 辞書を待つだけで予算が尽き、合成に 1ms も充てられない読み上げができてしまう。
  it('合成待ちの予算は、辞書の取得待ちの上限より大きい', () => {
    expect(SPEECH_SYNTH_BUDGET_MS).toBeGreaterThan(DICT_FETCH_TIMEOUT_MS)
  })
})
