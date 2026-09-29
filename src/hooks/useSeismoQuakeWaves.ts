// 有感の地震について、その区間の自作地震計の合成波形を集める。
//
// **初動は読み返し、その先は押し出しを繋ぐ。** ホストへ取りに行くのは地震 1 件につき
// 1 回だけで（`GET /waves`）、そこから先はアプリが常時受けている波形を同じ列の幅へ
// 畳んで右へ足していく（2026-09-30 のユーザー指摘「繋げればいいじゃん」）。
//
// **繋ぐのはここ（App の層）。描く側ではない。** 描画側へ置くと、**カードを開いている
// 間・タブが見えている間しか繋がらない**（`requestAnimationFrame` はタブが隠れると
// 止まる）—— 後で開いたときに初動と現在の間が大穴になる。
//
// **判定はすべて `serverNow()` 基準。** 壁時計を使うと、再生中（テスト時刻設定）に
// 自作地震計を読むようになったとき、打ち切りの比較が常に真になって静かに止まる。
//
// **観測点の一覧も自分で引く。** 押し出しの `stations` を借りると繋いでいる間しか
// 動かないものになる —— ライブでも再生中でも経路は 1 本。

import { useEffect, useMemo, useRef, useState } from 'react'

import { fetchSeismoWaveHistory, buildWaveHistoryRange } from '../services/seismoWaveHistory'
import { fetchSeismoStatus, isValidSeismoHostUrl } from '../services/seismoStream'
import { quakeScaleForScope, type NearbyScope } from '../utils/actionChecklistTrigger'
import { serverNow } from '../utils/clock'
import { log } from '../utils/logger'
import { quakeEventKey } from '../utils/quakeMerge'
import { appendWaveWindow, isSettled, type TimedColumns } from '../utils/seismoWaveColumns'
import { WAVE_TRIGGER_MIN_SCALE } from '../utils/seismoWaveTrigger'
import type { SeismoWaveWindow } from '../utils/seismoWaveBuffer'
import type { JMAQuake } from '../types/earthquake'

/**
 * ホストへ要求する列の数。
 *
 * **画面の幅より多めに取り、描く側でさらに畳む。** 列は上下の端なので、隣り合う列を
 * まとめるのは「下端の最小・上端の最大」を取るだけで正しく縮む —— 逆に足りない列を
 * 増やすことはできない。**実測（2026-09-29・hostpc）**: 3.5 分ぶん 600 列で 138 ms。
 */
const WAVE_HISTORY_COLUMNS = 1200

/**
 * 継ぎ足しを見に行く間隔（ms）。
 *
 * **押し出しの周期に合わせる**（まとまりは 0.3 秒ごと）。`readWave()` は呼ぶたびに
 * 96 KB を確保するので、それより細かく回しても同じ列を作り直すだけ。
 *
 * **`requestAnimationFrame` は使わない。** あれはタブが隠れると止まる —— 地震が起きたら
 * 地図や別のタブを見るので、**いちばん繋ぎたい時間に止まる**ことになる。
 */
const APPEND_INTERVAL_MS = 300

/**
 * 「収まった」と見なす静穏の長さ（ms）。**60 秒。**
 *
 * **地図の下の絵の余韻と同じ長さ**（`useSeismoWaveVisibility`）。あちらが「揺れが
 * 収まってからも 60 秒は絵を残す」としているので、伸ばすのをやめる線も揃える。
 */
const SETTLE_WINDOW_MS = 60_000

/**
 * 静穏と見なす振幅（gal）。
 *
 * **実機の静穏時の最大は 1.61 gal**（2026-09-29・12 秒 1203 サンプルの実測。→
 * `SeismoWaveChart` の `MIN_SCALE_GAL`）。**その倍弱**に取って、ノイズで「まだ揺れて
 * いる」と誤判定しないようにする。
 */
const QUIET_GAL = 3

/**
 * 「収まった」の判定を始めるまでの猶予（ms）。**発生から 90 秒。**
 *
 * **弱い地震は、振幅では「揺れているか」を判定できない。** 震度1 はおよそ 0.8〜2.5 gal・
 * 震度2 は 2.5〜8 gal で、**静穏時のノイズ（最大 1.61 gal）と同じ桁**にいる。
 * {@link QUIET_GAL} を下げてもノイズと区別が付かないだけなので、**揺れの強さに関わらず
 * この時間までは繋ぎ足す**（弱い地震は数十秒で終わるのでこれで足りる）。
 */
const MIN_GROW_MS = 90_000

/**
 * 継ぎ足しの安全弁（ms）。**発生から 30 分。**
 *
 * **これで打ち切ることを想定していない。** 通常は「収まった」か「次の有感地震」で
 * 止まる —— ここまで伸びるのは判定が壊れているときなので、**長さに意味は無く、
 * 際限なく増えないことだけが役目**。
 */
const GROW_SAFETY_MS = 30 * 60 * 1000

/**
 * 1 件の地震に確保する窓の最小の長さ（ms）。
 *
 * **次の地震の発生時刻で右端を切る**（重なる区間が 2 枚のカードに出るのを防ぐ）が、
 * **同じ分に別の地震が起きることは実際にある**（→ `docs/spec/quake-spec.md` §6.1）。
 * そのまま切ると窓が潰れて初動が 1 列も入らないので、ここだけは重なりを許す ——
 * **同時刻に起きた 2 つの地震の揺れは、そもそも切り分けられない。**
 */
const MIN_WINDOW_MS = 30_000

/** 読み返した初動 ＋ 繋いだ続き。 */
export interface SeismoQuakeWave {
  readonly stationId: string
  readonly displayName: string
  /** **描く側はこれを描くだけ。** 繋ぐのはこのフックの仕事。 */
  readonly columns: TimedColumns
}

/** 読み返す対象。**テストから直に確かめられるよう外へ出してある。** */
export interface SeismoWaveTarget {
  readonly eventKey: string
  readonly originMs: number
  /**
   * 右端の打ち切り（**次に新しい有感地震の発生時刻**。無ければ `Infinity`）。
   *
   * **別の地震の波形が同じ絵に入るのを防ぐ。** 止めないと、前の地震のカードの末尾へ
   * 次の地震の頭が入り、同じ揺れが 2 枚のカードに出る。
   */
  readonly cutoffMs: number
}

/**
 * 対象の地震を選ぶ。**新しい順・件数の上限は置かない。**
 *
 * **上限を置かない**（2026-09-30 のユーザー判断）—— 有感の地震は 7 日でせいぜい数件で、
 * 取得は LAN 内の自前のホストへ 1 件 140 ms・直列。歯止めを置くほどの量にならない。
 *
 * **時刻として読めないものは外す**（窓を作れないので取りに行きようがない）。
 *
 * **並べ直す。** 呼び出し側の並びに依存すると、並びを変えた日に打ち切りの順序が
 * 静かに狂う（`cutoffMs` は「1 つ新しい地震」から取る）。
 */
export function pickTargets(quakes: readonly JMAQuake[], scope: NearbyScope): SeismoWaveTarget[] {
  const found: { eventKey: string; originMs: number }[] = []
  const seen = new Set<string>()
  for (const q of quakes) {
    if (quakeScaleForScope(q, scope, WAVE_TRIGGER_MIN_SCALE) === null) continue
    // **タイムゾーンを明示しない値はローカル時刻として解釈される**（P2PQuake 経路が
    // そう。DMDATA は電文の `ArrivalTime` をそのまま持つのでオフセット付き）。自作
    // 地震計は自宅に置くもので、見る端末も同じ生活圏にあるという前提で許容する。
    const originMs = new Date(q.earthquake.time).getTime()
    if (!Number.isFinite(originMs)) continue
    const eventKey = quakeEventKey(q)
    if (seen.has(eventKey)) continue
    seen.add(eventKey)
    found.push({ eventKey, originMs })
  }
  found.sort((a, b) => b.originMs - a.originMs)
  return found.map((t, i) => ({
    ...t,
    // 1 つ新しい地震の発生時刻まで。**同分の別地震で窓が潰れないよう下限を置く。**
    cutoffMs: i === 0 ? Infinity : Math.max(found[i - 1].originMs, t.originMs + MIN_WINDOW_MS),
  }))
}

/** その対象の窓（読み返す範囲）。**打ち切りが手前にあればそこで切る。** */
function rangeFor(target: SeismoWaveTarget): { fromMs: number; toMs: number } | null {
  const full = buildWaveHistoryRange(target.originMs)
  if (full === null) return null
  return { fromMs: full.fromMs, toMs: Math.min(full.toMs, target.cutoffMs) }
}

interface Entry {
  readonly stationId: string
  readonly displayName: string
  columns: TimedColumns
}

/**
 * 有感の地震カードへ出す波形を集める。
 *
 * 返すのは `eventKey` から観測点ごとの波形への対応。**取れなかった地震は載らない** ——
 * 呼び出し側は「載っていなければ描かない」だけでよい（2026-09-29 のユーザー判断で、
 * 記録が無いことを画面へ出さないと決めた。理由の記録は取得層が残す）。
 */
export function useSeismoQuakeWaves(params: {
  /** 自作地震計の機能そのものが有効か（設定）。 */
  enabled: boolean
  baseUrl: string
  quakes: readonly JMAQuake[]
  scope: NearbyScope
  /** 押し出しで抱えている窓を読む（→ `useSeismoStation`）。 */
  readWave: (stationId: string) => SeismoWaveWindow | null
  /**
   * 再生の時刻オフセット（`null` ならライブ）。
   *
   * **変わったら持っている列を捨てる。** 時間軸が変わるので、前の軸の列へ次の軸の
   * 波形を繋いではいけない —— **再生を止めた直後がまさにこれ**（再生していた時刻が
   * 最近だと同じ地震がライブの一覧にもいるので、鍵が一致してしまう）。
   */
  replayOffsetMs: number | null
}): ReadonlyMap<string, readonly SeismoQuakeWave[]> {
  const { enabled, baseUrl, quakes, scope, readWave, replayOffsetMs } = params
  const [waves, setWaves] = useState<ReadonlyMap<string, readonly SeismoQuakeWave[]>>(new Map())

  const canFetch = enabled && isValidSeismoHostUrl(baseUrl)
  const targets = useMemo(
    () => (canFetch ? pickTargets(quakes, scope) : []),
    [canFetch, quakes, scope],
  )
  // **依存は鍵の並びで持つ。** `targets` は毎レンダー新しい配列になるので、そのまま
  // 依存に置くと電文が 1 通届くたびに取り直しへ入る。
  const targetKey = targets.map((t) => `${t.eventKey}@${t.originMs}@${t.cutoffMs}`).join(',')

  // 取り終えた組。**もう取りに行かないための帳面。**
  const doneRef = useRef(new Set<string>())
  // いま取りに行っている組。**中断されたらここから外して、次の機会に取り直す。**
  const inFlightRef = useRef(new Set<string>())
  const bookRef = useRef<Map<string, Entry[]>>(new Map())
  const targetsRef = useRef(targets)
  targetsRef.current = targets
  const readWaveRef = useRef(readWave)
  readWaveRef.current = readWave
  const publishRef = useRef<() => void>(() => {})
  publishRef.current = () => {
    const out = new Map<string, readonly SeismoQuakeWave[]>()
    for (const [key, list] of bookRef.current) {
      out.set(
        key,
        list.map((e) => ({ stationId: e.stationId, displayName: e.displayName, columns: e.columns })),
      )
    }
    setWaves(out)
  }

  // **接続先か時間軸が変わったら、持っているものを全部捨てる。**
  //
  // **`setWaves` も呼ぶ。** ref だけ消すと、次に 1 件成功するまで画面には前の相手
  // （または前の時間軸）のものが出たままになる。
  const resetKey = `${baseUrl}|${replayOffsetMs ?? 'live'}`
  const resetKeyRef = useRef(resetKey)
  useEffect(() => {
    if (resetKeyRef.current === resetKey) return
    resetKeyRef.current = resetKey
    doneRef.current = new Set()
    inFlightRef.current = new Set()
    bookRef.current = new Map()
    setWaves(new Map())
  }, [resetKey])

  // 読み返し（地震 × 観測点について 1 回ずつ）。
  useEffect(() => {
    if (!canFetch || targets.length === 0) return
    const ctrl = new AbortController()

    // **直列に取る。** 同時に投げても速くはならない（相手は 1 台）うえ、
    // 取り消しの効きが読みにくくなる。
    void (async () => {
      const status = await fetchSeismoStatus(baseUrl)
      if (ctrl.signal.aborted) return
      // 理由は `fetchSeismoStatus` が記録へ残している。
      if (status.kind !== 'ok') return
      const stationList = status.stations.map((s) => ({
        stationId: s.stationId,
        displayName: s.displayName,
      }))
      if (stationList.length === 0) return

      for (const target of targets) {
        const range = rangeFor(target)
        if (range === null) continue
        for (const station of stationList) {
          if (ctrl.signal.aborted) return
          // **地震ごとに数える。** 窓を鍵にすると、同じ分に起きた別の地震で 2 件目が
          // 「取得済み」と見なされ、片方のカードにだけ波形が出ない。
          const key = `${target.eventKey}|${station.stationId}`
          if (doneRef.current.has(key) || inFlightRef.current.has(key)) continue
          inFlightRef.current.add(key)

          const result = await fetchSeismoWaveHistory({
            baseUrl,
            stationId: station.stationId,
            range,
            columns: WAVE_HISTORY_COLUMNS,
            signal: ctrl.signal,
          })
          inFlightRef.current.delete(key)
          // **中断は「取った」に数えない。** 数えると、対象が入れ替わった拍子に取りかけて
          // いた観測点が二度と取りに行かれなくなる（群発・余震ほど起きやすい）。
          if (ctrl.signal.aborted) return
          doneRef.current.add(key)
          if (result.kind !== 'ok') continue
          // **記録が 1 件も無いものは載せない**（2026-09-29 のユーザー判断）。
          if (!result.history.hasAnyValue) continue
          // **観測点を知らないと言われたら載せない。** 取り違えなので、静かな波形として
          // 描くと嘘になる。**記録には残す** —— 画面へ出さないと決めた以上ここだけが手掛かり。
          if (!result.history.stationKnown) {
            log.warn(`[seismo] ホストが知らない観測点の波形を読み返した: ${station.stationId}`)
            continue
          }

          const prev = bookRef.current.get(target.eventKey) ?? []
          bookRef.current.set(target.eventKey, [
            ...prev,
            {
              stationId: station.stationId,
              displayName: station.displayName,
              columns: {
                fromMs: result.history.fromMs,
                columnSpanMs: result.history.columnSpanMs,
                columns: result.history.columns,
              },
            },
          ])
          // **1 件ごとに画面へ出す。** まとめて出すと、観測点が増えたとき最後の 1 本を
          // 待って全部が遅れる。
          publishRef.current()
        }
      }
    })()

    return () => ctrl.abort()
    // `targets` は `targetKey` が同じなら中身も同じ。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canFetch, baseUrl, targetKey])

  // 継ぎ足し（**いちばん新しい対象だけ**）。
  useEffect(() => {
    if (!canFetch) return
    const timer = setInterval(() => {
      const target = targetsRef.current[0]
      if (target === undefined) return
      const entries = bookRef.current.get(target.eventKey)
      if (entries === undefined || entries.length === 0) return

      const atMs = serverNow()
      // 止める条件は 2 つ＋安全弁（2026-09-30 のユーザー判断）。
      //
      //   1. **揺れが収まった** —— 時間で切ると、長く揺れる大地震でいちばん見たい
      //      後半が入らない。**ただし発生から `MIN_GROW_MS` は判定しない**（弱い地震は
      //      ノイズと同じ桁なので、揺れている最中に「収まった」と出てしまう）
      //   2. 次の有感地震が来た —— そのときこの対象は先頭でなくなるので、ここが触らなく
      //      なる（窓も `cutoffMs` で切れている）
      //   3. 安全弁（1・2 が揃って壊れたときだけ効く）
      if (atMs > target.originMs + GROW_SAFETY_MS) return

      let changed = false
      for (const entry of entries) {
        if (
          atMs > target.originMs + MIN_GROW_MS &&
          isSettled(entry.columns, SETTLE_WINDOW_MS, QUIET_GAL)
        ) {
          continue
        }
        const next = appendWaveWindow({
          base: entry.columns,
          window: readWaveRef.current(entry.stationId),
          // **次の地震の手前まで。** 外すと、前の地震のカードへ次の地震の頭が入る。
          limitMs: Math.min(target.originMs + GROW_SAFETY_MS, target.cutoffMs),
        })
        if (next !== entry.columns) {
          entry.columns = next
          changed = true
        }
      }
      if (changed) publishRef.current()
    }, APPEND_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [canFetch])

  // 対象から外れた地震（取消・表示する震度の設定変更）の分を捨てる。
  useEffect(() => {
    const alive = new Set(targetsRef.current.map((t) => t.eventKey))
    let dropped = false
    for (const key of [...bookRef.current.keys()]) {
      if (alive.has(key)) continue
      bookRef.current.delete(key)
      dropped = true
    }
    if (dropped) publishRef.current()
  }, [targetKey])

  // 機能を切ったら画面からも消す。
  useEffect(() => {
    if (canFetch) return
    doneRef.current = new Set()
    inFlightRef.current = new Set()
    bookRef.current = new Map()
    setWaves(new Map())
  }, [canFetch])

  return waves
}
