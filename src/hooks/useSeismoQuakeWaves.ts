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
import { computeWaveArrival, type WaveArrival } from '../utils/seismoWaveArrival'
import {
  appendWaveWindow,
  isSettled,
  trimAfter,
  type TimedColumns,
} from '../utils/seismoWaveColumns'
import { WAVE_TRIGGER_MIN_SCALE } from '../utils/seismoWaveTrigger'
import type { SeismoWaveWindow } from '../utils/seismoWaveBuffer'
import type { Hypocenter, JMAQuake } from '../types/earthquake'

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
 * **弱い地震は、振幅では「揺れているか」を判定できない。** この観測点の静穏時の最大は
 * **1.61 gal**（2026-09-29・12 秒 1203 サンプルの実測）で、弱い揺れの加速度はその同じ桁に
 * 入ってくる。{@link QUIET_GAL} を下げてもノイズと区別が付かないだけなので、**揺れの
 * 強さに関わらずこの時間までは繋ぎ足す**（弱い地震は数十秒で終わるのでこれで足りる）。
 *
 * **震度の階級から加速度の範囲を引くことはしない。** 計測震度は加速度だけで決まらない
 * （周期と継続時間も効く）ので、階級を加速度の帯として書くと出どころの無い数字になる。
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
 * 読み返しに失敗したときに取り直すまでの間隔（ms）。**30 秒。**
 *
 * **1 度の失敗で諦めない。** ホストが重くなるのは地震の直後 ——いちばん取りたい
 * 瞬間で、そこで外すとそのカードは永久に波形を持たない（しかも画面上は「記録が
 * 無かった」と見分けが付かない）。
 *
 * **取り直すのは発生から {@link GROW_SAFETY_MS} までの地震だけ。** ホストが落ちて
 * いる間、7 日ぶんのカードを延々と叩き続けないため。
 */
const RETRY_INTERVAL_MS = 30_000

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
  /**
   * その観測点へ P 波・S 波が届いた時刻。**求まらなければ `null`**（→ `seismoWaveArrival`）。
   *
   * **続報で震源が動けば引き直す。** 実測で 15 地震のうち 11 件・1〜6 秒動いた
   * （→ `docs/spec/settings-pwa-spec.md` §7）ので、初報の値で固定すると線だけがずれる。
   */
  readonly arrival: WaveArrival | null
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
  /** 到達時刻を解くための震源（判らない値はセンチネルのまま。弾くのは計算側）。 */
  readonly hypocenter: Hypocenter
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
  const found: { eventKey: string; originMs: number; hypocenter: Hypocenter }[] = []
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
    found.push({ eventKey, originMs, hypocenter: q.earthquake.hypocenter })
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

/**
 * 出す内容が前回と同じか。**参照を使い回してよいかの判定。**
 *
 * **列は参照で、到達は値で比べる。** 列は繋ぎ足しが新しい配列を作るときだけ変わるが、
 * 到達は出すたびに引き直すので毎回別のオブジェクトになる。
 */
function sameWaves(
  prev: readonly SeismoQuakeWave[] | undefined,
  next: readonly SeismoQuakeWave[],
): prev is readonly SeismoQuakeWave[] {
  if (prev === undefined || prev.length !== next.length) return false
  for (let i = 0; i < next.length; i += 1) {
    const a = prev[i]
    const b = next[i]
    if (a.stationId !== b.stationId) return false
    if (a.displayName !== b.displayName) return false
    if (a.columns !== b.columns) return false
    if (a.arrival === null || b.arrival === null) {
      if (a.arrival !== b.arrival) return false
      continue
    }
    if (a.arrival.pMs !== b.arrival.pMs || a.arrival.sMs !== b.arrival.sMs) return false
  }
  return true
}

interface Entry {
  readonly stationId: string
  readonly displayName: string
  /** 観測点の座標（ホストの設定に無ければ `null`）。**到達時刻を解くのに要る。** */
  readonly lat: number | null
  readonly lon: number | null
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
  // 直前に出した内容。**変わっていない地震は同じ配列の参照を使い回す**ための控え。
  const publishedRef = useRef<ReadonlyMap<string, readonly SeismoQuakeWave[]>>(new Map())
  const publishRef = useRef<() => void>(() => {})
  publishRef.current = () => {
    // **到達時刻はここで引き直す。** 読み返したときの値を持ち回すと、続報で震源が
    // 動いても線だけが初報のまま残る（実測で 15 地震のうち 11 件・1〜6 秒動いた）。
    // 引くのは表引き 2 回ぶんなので、出すたびに解いてよい。
    const byKey = new Map(targetsRef.current.map((t) => [t.eventKey, t]))
    const out = new Map<string, readonly SeismoQuakeWave[]>()
    for (const [key, list] of bookRef.current) {
      const target = byKey.get(key)
      const next = list.map((e) => ({
        stationId: e.stationId,
        displayName: e.displayName,
        columns: e.columns,
        arrival:
          target === undefined
            ? null
            : computeWaveArrival({
                originMs: target.originMs,
                hypocenter: target.hypocenter,
                stationLat: e.lat,
                stationLon: e.lon,
              }),
      }))
      // **中身が同じなら前の配列を使い回す。** 伸びているのは 1 件だけでも、毎回
      // 全部を作り直すと**関わりのない地震のカードまで描き直される**（この出し直しは
      // 0.3 秒ごとに走り、カードは 7 日ぶん残る）。
      const prev = publishedRef.current.get(key)
      out.set(key, sameWaves(prev, next) ? prev : next)
    }
    publishedRef.current = out
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

  // 読み返し（地震 × 観測点について 1 回ずつ。**失敗したら取り直す**）。
  useEffect(() => {
    if (!canFetch || targets.length === 0) return
    const ctrl = new AbortController()
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    /** **取り直す値打ちのある対象**（＝発生から {@link GROW_SAFETY_MS} 以内）があるか。 */
    const hasFreshTarget = (): boolean =>
      targets.some((t) => serverNow() <= t.originMs + GROW_SAFETY_MS)

    /** 一巡する。**取り直す値打ちのある失敗が残ったか**を返す。 */
    const sweep = async (): Promise<boolean> => {
      const status = await fetchSeismoStatus(baseUrl)
      if (ctrl.signal.aborted) return false
      // 理由は `fetchSeismoStatus` が記録へ残している。**取り直すのは新しい地震が
      // あるときだけ** —— 状態の口が一時的に返らないだけなら取り直す値打ちがあるが、
      // ホストが落ちている間、古いカードのために延々と叩き続ける理由は無い。
      if (status.kind !== 'ok') return hasFreshTarget()
      const stationList = status.stations.map((s) => ({
        stationId: s.stationId,
        displayName: s.displayName,
        lat: s.lat,
        lon: s.lon,
      }))
      // **観測点が 0 件でも取り直す。** 通信は成功しているので `kind` は `'ok'` だが、
      // **ホストの起動直後は必ずこの形を通る** ——`seismo-host` の `sensorHealth.ts` は
      // 実際にパケットを受けたセンサーしか載せないので、まだ 1 枚も基板が繋ぎ直して
      // いない間は空で返る。
      //
      // **ここで諦めると、次に `targetKey` が変わるまでその地震の波形を取りに行かない**
      // （この効果の依存は `[canFetch, baseUrl, targetKey]` だけ）。その地震が最後の
      // 1 件だったら二度と来ない —— **停電はホストの再起動と地震の両方の原因になりうる**
      // ので、いちばん見たい地震でこれを踏む。
      //
      // **記録も残す。** 同じファイルの他の失敗分岐はすべて理由を記録に残しているのに、
      // ここだけ沈黙していた（2026-09-30 のレビューで見つかった）。
      if (stationList.length === 0) {
        log.warn('[seismo] /status は応答したが観測点が 0 件（まだ繋がっていない可能性）')
        return hasFreshTarget()
      }

      // **取り直す値打ちのある失敗**（＝古すぎない地震で、一時的な理由で取れなかったもの）。
      let retryable = false
      for (const target of targets) {
        const range = rangeFor(target)
        if (range === null) continue
        // **古い地震は取り直さない。** 継ぎ足しの安全弁と同じ線（発生 + 30 分）で切る ——
        // ホストが落ちている間、7 日ぶんのカードを何十分も叩き続けることになる。
        // **初回は取りに行く**（過去のカードを開いたときも波形は見たい）。
        const fresh = serverNow() <= target.originMs + GROW_SAFETY_MS
        for (const station of stationList) {
          if (ctrl.signal.aborted) return false
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
          if (ctrl.signal.aborted) return false
          // **一時的な失敗も数えない。** 相手に届かなかった・5xx・応答が読めなかった、の
          // いずれも**次の機会には取れる**（ホストが重いのは地震の直後ほど起きやすい）。
          // 数えてしまうと、いちばん混む瞬間に 1 度外しただけでそのカードは永久に
          // 波形を持たず、**画面上は「記録が無かった」と見分けが付かない**。
          //
          // **`bad-request` だけは数える。** こちらが組み立てた窓が通らなかったという
          // ことなので、同じ窓で投げ直しても結果は変わらない。
          //
          // **古い地震はここで諦める**（＝「取った」に数える）。取り直さないものを
          // 帳面へ入れずにおくと、**新しい地震が失敗を繰り返している間ずっと、
          // 一巡のたびに古いカードのぶんまで叩き直す**ことになる。
          if (result.kind !== 'ok' && result.kind !== 'bad-request' && fresh) {
            retryable = true
            continue
          }
          doneRef.current.add(key)
          if (result.kind !== 'ok') continue
          // **ホストが記録の欠けを申告していたら残す。** 絵は出るので画面からは
          // 分からない ——ホスト側のディスクや保存の不調を追える唯一の手掛かり。
          const { filesMissing, filesFailed, skippedBytes, truncated } = result.history
          if (filesMissing > 0 || filesFailed > 0 || skippedBytes > 0 || truncated) {
            log.warn(
              `[seismo] 読み返した波形に欠けがある（${station.stationId}）: ` +
                `無かったファイル ${filesMissing}・読めなかったファイル ${filesFailed}・` +
                `読み飛ばし ${skippedBytes} バイト・打ち切り ${truncated ? 'あり' : 'なし'}`,
            )
          }
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
              lat: station.lat,
              lon: station.lon,
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
      return retryable
    }

    const run = async (): Promise<void> => {
      const retryable = await sweep()
      if (ctrl.signal.aborted || !retryable) return
      retryTimer = setTimeout(() => void run(), RETRY_INTERVAL_MS)
    }
    void run()

    return () => {
      ctrl.abort()
      if (retryTimer !== undefined) clearTimeout(retryTimer)
    }
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

  // **震源が動いたら到達の線を引き直す。**
  //
  // **取得の鍵（`targetKey`）と分ける。** あちらに震源を混ぜると、続報が届くたびに
  // 読み返しの effect が張り直されて、取りかけの取得が中断される（`doneRef` が
  // 取り直しはするが、中断を増やす理由が無い）。
  const arrivalKey = targets
    .map((t) => {
      const h = t.hypocenter
      return `${t.eventKey}@${t.originMs}@${h.latitude},${h.longitude},${h.depth}`
    })
    .join(',')
  useEffect(() => {
    // 何も持っていなければ出し直す意味が無い（空の Map を作り替えるだけになる）。
    if (bookRef.current.size === 0) return
    publishRef.current()
  }, [arrivalKey])

  // 対象から外れた地震の分を捨て、**打ち切りが縮んだ分を切り戻す。**
  useEffect(() => {
    const alive = new Map(targetsRef.current.map((t) => [t.eventKey, t]))
    let changed = false
    for (const [key, entries] of [...bookRef.current]) {
      const target = alive.get(key)
      // 取消・表示する震度の設定変更で対象から外れたもの。
      if (target === undefined) {
        bookRef.current.delete(key)
        changed = true
        continue
      }
      // **次の有感地震が現れたら、その手前まで切り戻す。** 繋いでいる最中はその地震が
      // いちばん新しいので右端の打ち切りが無く、**次の地震の電文が届くまでの間に
      // その揺れを取り込んでいる**（実測で発生から 90 秒ほど遅れて届く）。
      for (const entry of entries) {
        const next = trimAfter(entry.columns, target.cutoffMs)
        if (next === entry.columns) continue
        entry.columns = next
        changed = true
      }
    }
    if (changed) publishRef.current()
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
