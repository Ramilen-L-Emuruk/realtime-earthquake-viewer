// 読み上げに関わる 2 つの上限の関係。
//
// **「合成側 < チェーン側」を機械的に固定する。** 片方だけを動かすと、どちらもテストは通るのに
// 判断が静かに崩れる —— 合成が返ってこない発話は、チェーン側が待ちを打ち切るより先に
// 自分で諦めて完了するべきで、そうでないと待ち上限に達した側が「打ち切った」と記録し、
// 既読を「鳴った」へ倒す（`useLiveEventHandler` の `chainEEWSpeech`）。1 音も出ていないのに
// 既読が進む形になる。
//
// **「上限まで返ってこない＝鳴っている最中」という推論には、もう頼っていない。** 待ちは
// `isAudioPlaying`（再生中の音源があるか）で直接判定する —— 合成待ちでも真を返す
// `isSpeaking` を使うと、ハングしたときにこそ待ちが延びる。ここで固定しているのは
// 「異常系では合成側が先に片を付ける」という、その手前の関係。
//
// 定数は別々のファイルにあり、型検査では関係を保てない。ここで突き合わせる。
import { describe, it, expect } from 'vitest'
import { CHUNK_SYNTH_TIMEOUT_MS, SPEECH_SYNTH_BUDGET_MS } from './voicevox'
import { EEW_SPEECH_CHAIN_MAX_WAIT_MS, MUTUAL_YIELD_SPEECH_MAX_WAIT_MS, SPEECH_WAIT_HARD_CAP_MS } from '../hooks/useLiveEventHandler'
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

  // **延長の上限は、待ちの上限のどれよりも後に来ること。** 音が出ている間は待ちの上限を
  // 計時しないので、実際に待ちを明けさせるのは延長の上限のほう。これが逆転すると、
  // 「相互譲りは 180 秒まで待つ」と決めた値が届く前に打ち切られ、**定数が意味を失う**
  // （いちばん長いのは相互譲りなので、そこだけ見れば足りる）。
  it('延長の上限は、待ちの上限のいちばん長いものより後に来る', () => {
    expect(SPEECH_WAIT_HARD_CAP_MS).toBeGreaterThan(MUTUAL_YIELD_SPEECH_MAX_WAIT_MS)
  })
})
