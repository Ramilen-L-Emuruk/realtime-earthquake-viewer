import { useEffect, useRef } from 'react'
import type { ReplayPayload } from '../types/replay'
import { prefetchSpeechTexts, abortSpeechPrefetch, isValidVoicevoxUrl } from '../utils/voicevox'
import { speculativeSpeechTextsSafe } from '../utils/speechPrefetch'
import type { TtsSpeechOptions } from '../utils/ttsText'
import { log } from '../utils/logger'

/**
 * 何秒先までの電文を焼くか。
 *
 * **リプレイが持っている未来はもっと長い**（窓 1 時間ぶん・終端の 10 分前に次を先読み）が、
 * 全部を焼く意味は無い —— 群発の最中は 1 時間に数百通が並び、控えの上限を超えて
 * **先に焼いたものから追い出される**（LRU）。60 秒あれば、いま読んでいる長文の次に来る電文は
 * 確実に覆える。
 */
export const PREFETCH_HORIZON_MS = 60_000

/**
 * 覗きに行く間隔。
 *
 * 短くしても投機自体は `isSpeaking()` で自制するので害は小さいが、覗くたびにキューを走査する。
 * 地平線が 60 秒あるので、この間隔で取りこぼすことはない。
 */
const PREFETCH_TICK_MS = 2000

/**
 * リプレイ中、**これから届く電文の読み上げを先に合成しておく**。
 *
 * 録画中は PC の負荷で合成が再生に追いつかなくなり、読み上げが遅れる・後半のチャンクが
 * 落ちるということが起きていた。リプレイは未来の電文を先に持っているので、**空いている間に
 * 焼いておける**（→ `utils/speechPrefetch.ts` に、なぜ投機で足りるのかを書いてある）。
 *
 * **録画モードには限らない。** 投機は本番の読み上げを邪魔しない作り
 * （`prefetchSpeechTexts` が読み上げ中は投げず、始まれば打ち切る）なので、リプレイ全般で
 * 効かせてよい。限ると「録画のときだけ挙動が違う」経路がもう 1 つ増える。
 *
 * @param enabled リプレイ中で、かつ読み上げが有効か
 * @param peekUpcoming 近く発火する電文を覗く（`useEarthquakes` の `peekUpcomingPayloads`）
 * @param baseUrl VOICEVOX の接続先。**入力が落ち着くのを待った値を渡すこと**
 *   （設定の変化で通信する経路の決まり。→ `docs/spec/audio-tts-spec.md` §3「接続先の確認」）
 */
export function useSpeechPrefetch({
  enabled,
  replayKey,
  peekUpcoming,
  baseUrl,
  speakerId,
  opts,
}: {
  enabled: boolean
  /**
   * いまの再生を指す値（再生時刻のオフセット）。**変われば投機をやり直す。**
   *
   * **`enabled` だけを依存にすると、再生中に別の時刻へ開始し直したときに effect が張り直らない**
   * （`enabled` は真のまま変わらない）。そのとき、もう無関係になった前の区間のバッチが
   * `prefetchRunning` を占有し続け、新しい再生位置の電文が投機されない。録画は区間ごとに
   * 再生を開始し直すので、これは**いちばん効いてほしい区間の立ち上がり**で起こる。
   */
  replayKey: number | null
  peekUpcoming: (horizonMs: number) => ReplayPayload[]
  baseUrl: string
  speakerId: number
  opts: TtsSpeechOptions
}): void {
  // 毎レンダー変わりうる値は ref 経由で読む。依存に入れると、設定を触るたびに
  // interval を張り直すことになる（投機の周期が乱れる）。
  const latest = useRef({ peekUpcoming, baseUrl, speakerId, opts })
  latest.current = { peekUpcoming, baseUrl, speakerId, opts }

  useEffect(() => {
    if (!enabled) return

    const tick = () => {
      const { peekUpcoming, baseUrl, speakerId, opts } = latest.current
      // 通信前の検分。**黙って戻らない**（設定タブは同じ条件を画面に出すが、ここは画面を
      // 持たないので、記録が無いと「投機が一度も効かない」原因を追えない）。値が変わらない
      // 限り毎周期この判定を通るため、記録は `debug` に留める。
      if (!isValidVoicevoxUrl(baseUrl)) {
        log.debug('[VoiceVox] 投機の先行合成をスキップ (接続先の URL が不正)')
        return
      }
      const payloads = peekUpcoming(PREFETCH_HORIZON_MS)
      if (payloads.length === 0) return
      const texts = payloads.flatMap(p => speculativeSpeechTextsSafe(p, opts))
      if (texts.length === 0) return
      prefetchSpeechTexts(baseUrl, texts, speakerId)
    }

    // **最初の 1 回はすぐ走らせる。** 間隔を待つと、再生開始の直後に届く電文を焼き逃す。
    tick()
    const id = setInterval(tick, PREFETCH_TICK_MS)
    return () => {
      clearInterval(id)
      // **進行中の投機も止める。** 間隔を止めるだけでは、既に走っているループが
      // `prefetchRunning` を真のまま保持し続ける —— そのフラグは投機の唯一の再入防止なので、
      // **次の区間の最初のティックが黙ってスキップされる**（記録も残らない）。止めた投機は
      // 次のティックで積み直されるので、取りこぼしにはならない。
      abortSpeechPrefetch()
    }
  }, [enabled, replayKey])
}
