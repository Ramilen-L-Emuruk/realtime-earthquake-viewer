// 助走（`kyoshinWarmup.ts`）と、助走を待つ間に溜めたフレームを検知エンジンへ食わせる処理。
//
// **React から切り離してある。** この処理は可変の状態を 4 つ（検知エンジンの状態・最後に
// 食わせた時刻・待たせているフレーム・待っているかどうか）同時に動かすため、フックの
// エフェクトの中に置くと、境界の条件（時刻の巻き戻り・観測点集合の版違い・`step()` の例外）を
// 目視でしか確認できない。純関数にすれば `renderHook` を介さずに確かめられる。
//
// ここが受け持つのは「どのフレームを、どの順で食わせるか」だけ。どこまで遡るかの規則は
// `kyoshinWarmup.ts`、取得は供給元（`services/kyoshinSource`）、結果の記録と画面への
// 反映は呼び出し側（`hooks/useKyoshinDetectorV2`）が持つ。

import { MISSING_INDEX_THRESHOLD, type SiteCoords } from '../services/kyoshin'
import { step, type DetectorState, type StationMeta } from './kyoshinDetector'

/** 助走が届くまで待たせているフレーム。 */
export interface PendingFrame {
  dataTimeMs: number
  indices: number[]
  /**
   * このフレームが属する観測点集合の識別子。
   *
   * 待っている間に観測点リストの版が替わりうるので、食わせる直前に今の座標と照合する
   * （長さの検証だけでは、点数がたまたま一致したときに通ってしまう）。
   */
  sitesKey: string
}

/** 助走として渡されたフレーム（`services/kyoshinSource` の `KyoshinFrame` の必要な部分）。 */
export interface WarmupFrame {
  dataTime: string
  indices: number[]
  sitesKey: string
}

/**
 * 消化のあいだに起きた、記録すべきこと。
 *
 * **文言はここで作らない。** 呼び出し側がログへ出す（同じ事実を 2 通りの言葉で書かないため）。
 */
export type WarmupNotice =
  /** 助走が届かないまま上限に達したので、助走なしで始めた。 */
  | { kind: 'gave-up'; waitedFrames: number }
  /** 助走は届いたのに 1 件も使えなかった（版違い・巻き戻り・例外の内訳つき）。 */
  | { kind: 'all-unusable'; total: number; versionMismatch: number }
  /** フレームを 1 件食わせる途中で投げた（件数と、最初に落ちたフレーム）。 */
  | { kind: 'feed-failed'; count: number; frameTimeMs: number | null; error: unknown }
  /**
   * 1 件の消化の外で投げたので、その段を途中で打ち切った。
   *
   * `feed-failed` と分けるのは、**残りを食わせたかどうかが違う**ため。あちらは 1 件だけ
   * 落として先へ進むが、こちらは列の反復そのものが壊れているので、その段は途中で止まる。
   */
  | { kind: 'aborted'; phase: 'warmup' | 'pending'; error: unknown }

export interface ConsumeWarmupInput {
  state: DetectorState
  /** 最後に `step()` へ渡したデータ時刻。まだ無ければ `-Infinity`。 */
  lastSteppedMs: number
  /**
   * 待たせているフレーム（時刻の昇順）。
   *
   * **末尾は「いまのフレーム」として扱い、ここでは食わせない。** 呼び出し側が通常の経路で
   * 処理して画面へ出す（ここで食わせると、その 1 周期ぶんの検知結果が画面に出ない）。
   */
  pending: readonly PendingFrame[]
  /** 届いた助走。`null` なら未達。 */
  warmupFrames: readonly WarmupFrame[] | null
  sites: SiteCoords
  /** いまの座標が属する観測点集合の識別子。 */
  sitesSiteConfigId: string
  meta: StationMeta
  eewActive: boolean
}

export interface ConsumeWarmupResult {
  state: DetectorState
  lastSteppedMs: number
  notices: WarmupNotice[]
}

/**
 * 助走と待機分を順に食わせる。画面へ出す値は作らない（呼び出し側が通常の経路で作る）。
 *
 * **助走 → 待機分（末尾を除く）の順で食わせる。** 逆にすると、助走が「時刻の巻き戻り」として
 * 落とされて丸ごと効かなくなる。
 *
 * @param input 消化に要るものすべて（可変の状態は呼び出し側が持つ）
 * @returns 進めた状態と、記録すべきこと
 */
export function consumeWarmup(input: ConsumeWarmupInput): ConsumeWarmupResult {
  const { sites, sitesSiteConfigId, meta, eewActive } = input
  let state = input.state
  let lastSteppedMs = input.lastSteppedMs
  const notices: WarmupNotice[] = []
  const failure = { count: 0, first: null as { frameTimeMs: number; err: unknown } | null }

  /**
   * 1 フレームだけ進める。落とす条件は通常の経路と同じ。
   *
   * **例外はここで握る。囲うのは本体の全体で、`step()` の呼び出しだけではない。**
   * 呼び出し元はフックのエフェクトで、投げるとエフェクトごと未捕捉例外で抜け、**根のエラー
   * 境界まで飛んで画面全体が落ちる**（地図も地震カードも設定も消える）。`step()` 以外にも
   * 投げうる箇所はある —— 型の上では `number[]` でも、供給元が渡すのは外部データ由来の
   * 値なので、`values` が配列でなければ長さの検証そのものが投げる。
   * 1 件の失敗で残りの消化を止めず、件数だけ数えて先へ進む。
   */
  const feed = (frameTimeMs: number, values: number[]): boolean => {
    try {
      if (!Number.isFinite(frameTimeMs) || frameTimeMs <= lastSteppedMs) return false
      if (values.length !== sites.length) return false
      state = step(
        state,
        {
          dataTimeMs: frameTimeMs,
          sites: sites as [number, number][],
          values,
          missing: values.map((idx) => idx < MISSING_INDEX_THRESHOLD),
          eewActive,
        },
        meta,
      ).state
    } catch (err) {
      failure.count++
      failure.first ??= { frameTimeMs, err }
      return false
    }
    lastSteppedMs = frameTimeMs
    return true
  }

  if (input.warmupFrames === null) {
    notices.push({ kind: 'gave-up', waitedFrames: input.pending.length })
  } else {
    // **列の反復そのものが壊れる場合に備えて包む。** `feed` の中の握りは 1 件ぶんしか
    // 守らないので、要素の取り出しや `for...of` が投げるとここを素通りして画面全体が落ちる。
    // 途中で止めても、そこまでに食わせた分は無駄にならない（`state` は進んだところまで残る）。
    try {
      let used = 0
      let versionMismatch = 0
      for (const f of input.warmupFrames) {
        // 観測点リストの版が違う助走は使えない（座標と震度の対応が取れない）。
        if (f.sitesKey !== sitesSiteConfigId) { versionMismatch++; continue }
        if (feed(new Date(f.dataTime).getTime(), f.indices)) used++
      }
      // **届いたのに 1 件も使えなかったことは記録する。** 画面からは「助走が無かった」のと
      // 見分けが付かず、立ち上がりの検知が遅れた原因を後から追えない。
      if (input.warmupFrames.length > 0 && used === 0) {
        notices.push({ kind: 'all-unusable', total: input.warmupFrames.length, versionMismatch })
      }
    } catch (error) {
      notices.push({ kind: 'aborted', phase: 'warmup', error })
    }
  }

  // 待たせていた分。**末尾はいまのフレーム**なので、呼び出し側の通常処理へ渡す。
  //
  // 助走の段が打ち切られてもここは通す。待機分は別の経路で溜めたもので、助走が壊れて
  // いることは待機分が使えないことを意味しない。
  try {
    for (let i = 0; i < input.pending.length - 1; i++) {
      const p = input.pending[i]
      if (p.sitesKey !== sitesSiteConfigId) continue
      feed(p.dataTimeMs, p.indices)
    }
  } catch (error) {
    notices.push({ kind: 'aborted', phase: 'pending', error })
  }

  if (failure.count > 0) {
    notices.push({
      kind: 'feed-failed',
      count: failure.count,
      frameTimeMs: failure.first?.frameTimeMs ?? null,
      error: failure.first?.err,
    })
  }
  return { state, lastSteppedMs, notices }
}

/**
 * 待たせるフレームを 1 件積む（同じデータ時刻は 2 度積まない）。
 *
 * **助走は通常フレームと別の経路で届く**ので、データ時刻が変わらないまま助走だけが変わる
 * レンダーが必ず起きる（通常フレームの取得 1 件は、助走の一括取得よりずっと速い）。
 * 二重に積むと、`consumeWarmup` が「末尾以外」として食わせてしまい、**待たせていた
 * フレームの検知結果が画面へ出ない**（次のフレームまで音も自動タブ切替も動かない）。
 *
 * @returns 積んだ後の配列（同じ時刻なら元の配列をそのまま返す）
 */
export function pushPendingFrame(pending: PendingFrame[], frame: PendingFrame): PendingFrame[] {
  const last = pending[pending.length - 1]
  if (last && last.dataTimeMs === frame.dataTimeMs) return pending
  pending.push(frame)
  return pending
}
