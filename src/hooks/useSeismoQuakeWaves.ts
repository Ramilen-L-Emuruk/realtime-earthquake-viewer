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

import { fetchSeismoQuakeIntensity, type QuakeIntensity } from '../services/seismoQuakeIntensity'
import { fetchSeismoWaveHistory, buildWaveHistoryRange } from '../services/seismoWaveHistory'
import { fetchSeismoStatus, isValidSeismoHostUrl, type SeismoStationWaveRevised } from '../services/seismoStream'
import { RangeCoalescer } from '../services/seismoWaveRefill'
import { quakeScaleForScope, type NearbyScope } from '../utils/actionChecklistTrigger'
import { serverNow } from '../utils/clock'
import { log } from '../utils/logger'
import { quakeEventKey } from '../utils/quakeMerge'
import { parseJstTimeMs, type OriginSeconds } from '../utils/quakeOriginSeconds'
import {
  columnsSpan,
  computeReachBand,
  MINUTE_MS,
  selectQuakeWindow,
  type ReachBand,
  type WaveAxisZero,
} from '../utils/seismoQuakeWindow'
import { computeHypocentralDistanceKm, computeWaveArrival, type WaveArrival } from '../utils/seismoWaveArrival'
import {
  appendWaveWindow,
  isSettled,
  revisedColumnSpan,
  spliceRevisedColumns,
  trimAfter,
  type TimedColumns,
} from '../utils/seismoWaveColumns'
import { judgeSilence } from '../utils/seismoSilence'
import { WAVE_TRIGGER_MIN_SCALE } from '../utils/seismoWaveTrigger'
import { WAVE_STALE_MS } from './useSeismoStation'
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
  /**
   * 時間軸の 0。**秒まで取れれば発生時刻、取れなければ地震情報の時刻の分の頭**
   * （→ `utils/seismoQuakeWindow.ts` の `WaveAxisZero`）。目盛りの起点と、描く範囲の左端になる。
   */
  readonly axisZero: WaveAxisZero
  /**
   * この地震の揺れが届きうる時間帯。**走時が出せなければ `null`**（描く側は範囲を切らない）。
   *
   * **秒が取れない地震でも出す。** 線は引かないが、分の頭から解いた走時に 60 秒の幅を
   * 持たせれば、描く範囲を決める材料にはなる。
   */
  readonly reach: ReachBand | null
  /**
   * **繋ぎ足しが途切れている。** まだ伸ばす番なのに、{@link WAVE_STALE_MS} を超えて
   * 1 列も伸びていない状態（→ `utils/seismoSilence.ts`）。
   *
   * **描く側は濃さを落とすのに使う**（`paintWaveColumns` の `stale`）。列は時間で
   * 薄れないので、これを見ないと**止まった絵が「いま静かに揺れている」ように
   * 見え続ける。**
   *
   * **`useSeismoStation` の `waveStale` を素通しで代わりにはできない。** あちらは
   * 「いまのライブ接続の生死」なので、**過去に正常に完結した 7 日ぶんのカードまで
   * 薄くなる**（#406 のメタレビューが副作用として確認した）。ここが立つのは
   * 「伸ばす番のカード」だけ。
   */
  readonly interrupted: boolean
  /**
   * **もう伸ばさない。** 先頭の対象でない・再生中・収まった・安全弁を過ぎた、のいずれか。
   *
   * 震度（{@link intensity}）を訊くのはこれが立ってから —— 伸びている途中の区間で
   * 計測震度を出すと、揺れの後半が入らない値になる（計測震度は揺れ全体に 1 回出す量）。
   */
  readonly complete: boolean
  /**
   * この区間の震度（最大リアルタイム震度・計測震度）。**訊く前・訊けなかったときは `null`。**
   *
   * **持っている値の区間（`fromMs`〜`toMs`）が描く区間と一致するときだけ出すこと。**
   * 次の地震で末尾が切り戻されると描く区間が変わり、訊き直すまでの間は古い区間の値が残る。
   */
  readonly intensity: QuakeIntensity | null
  /**
   * 震源から観測点までの距離（km）。**震源の位置・深さか観測点の座標が判らなければ `null`。**
   * 詳細の窓に出す。観測から読み取った S−P 時間ではない（P 波はノイズに埋もれることが多く、
   * 自動で読むと誤った秒数をもっともらしく出してしまう。2026-10-05 のユーザー判断）。
   */
  readonly distanceKm: number | null
  /**
   * 波形を読み返した接続先。**詳細の窓が、拡大した範囲を同じホストへ取り直すのに使う。**
   * 接続先が変わると帳面ごと捨てるので、ここに載っている値と取った列は必ず対になる。
   */
  readonly baseUrl: string
}

/**
 * その観測点の列が**途切れている**か（#423 の形 3）。
 *
 * **判定は 1 つの述語に通す**（`utils/seismoSilence.ts`）—— 地図の左上の帯・右上の行と
 * 同じ「まだ来るはずなのに、期待した間隔を超えて何も来ていない」を見ている。
 *
 * @param growing **いま伸ばす番か。** 押し出しを繋いでいて（＝再生中ではない）・
 *   先頭の対象であり・安全弁の内であり・まだ収まっていない、の 4 つが揃うときだけ真。
 *   **ここを落とすと、正常に完結したカードが全部薄くなる** —— 伸びないのが当たり前の
 *   区間と、伸びるはずなのに伸びない区間は、列の見た目では区別が付かない。
 * @param lastGrewAt 最後に列が伸びた時刻。**`serverNow()` 基準**（`now` と揃える）。
 */
export function judgeWaveInterrupted(params: {
  readonly growing: boolean
  readonly lastGrewAt: number
  readonly now: number
}): boolean {
  const { growing, lastGrewAt, now } = params
  if (!growing) return false
  return (
    judgeSilence({ lastReceivedAt: lastGrewAt, now, staleMs: WAVE_STALE_MS }).kind === 'silent'
  )
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
  /**
   * P 波・S 波の線の起点にする発生時刻（**秒まで**）。**秒が取れなければ `null` で、線は引かない。**
   *
   * **窓の起点（`originMs`）と分ける。** `originMs` は地震情報の発生時刻で、分までしか無い
   * （秒は 00）。そのまま線の起点にすると最大 59 秒ずれる。秒の出どころと決め方は
   * `utils/quakeOriginSeconds.ts`。
   */
  readonly arrivalOriginMs: number | null
  /** {@link arrivalOriginMs} の出どころ。**秒が取れなければ `null`。** */
  readonly arrivalOriginSource: OriginSeconds['source'] | null
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
export function pickTargets(
  quakes: readonly JMAQuake[],
  scope: NearbyScope,
  originSeconds: ReadonlyMap<string, OriginSeconds>,
): SeismoWaveTarget[] {
  const found: Omit<SeismoWaveTarget, 'cutoffMs'>[] = []
  const seen = new Set<string>()
  for (const q of quakes) {
    if (quakeScaleForScope(q, scope, WAVE_TRIGGER_MIN_SCALE) === null) continue
    // **時間帯を持たない値（P2PQuake の `2026/10/03 13:26:00`）は日本時間として読む。**
    // 端末の時間帯で読むと、日本国外の端末だけ窓と時間軸の 0 がずれる（ホストの記録は
    // 絶対時刻なので、ずれた分だけ別の区間を取りに行く）。
    const originMs = parseJstTimeMs(q.earthquake.time)
    if (!Number.isFinite(originMs)) continue
    const eventKey = quakeEventKey(q)
    if (seen.has(eventKey)) continue
    seen.add(eventKey)
    const seconds = originSeconds.get(eventKey)
    found.push({
      eventKey, originMs, hypocenter: q.earthquake.hypocenter,
      arrivalOriginMs: seconds?.originMs ?? null,
      arrivalOriginSource: seconds?.source ?? null,
    })
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
    if (!sameWave(a, b)) return false
  }
  return true
}

/**
 * 観測点 1 つぶんの姿が同じか。
 *
 * **観測点ごとに比べられる形にしてある。** 1 つの地震に観測点が複数あるとき、
 * 片方だけが変わっても**もう片方の参照まで作り直すと、変わっていない絵が
 * 描き直される** —— `arrival` は出し直すたびに新しいオブジェクトになるので、
 * 描く側の依存（`QuakeSeismoWave` の `useEffect`）がそれだけで発火する。
 */
function sameWave(a: SeismoQuakeWave | undefined, b: SeismoQuakeWave): a is SeismoQuakeWave {
  if (a === undefined) return false
  if (a.stationId !== b.stationId) return false
  if (a.displayName !== b.displayName) return false
  if (a.columns !== b.columns) return false
  // **途切れも比べる。** 列が 1 つも伸びていないのがまさにこの状態なので、
  // ここを見落とすと**濃さを落とす指示が画面へ届かない**（列だけを比べていると
  // 「変わっていない」として前の姿を使い回す）。
  if (a.interrupted !== b.interrupted) return false
  // **伸ばし終えたか・震度も比べる。** どちらも列が変わらないまま変わる（収まった後に
  // 震度が届く）ので、見落とすと震度の行が画面へ出ない。震度は届くたびに新しい参照になる。
  if (a.complete !== b.complete || a.intensity !== b.intensity) return false
  if (a.distanceKm !== b.distanceKm || a.baseUrl !== b.baseUrl) return false
  // **時間軸の 0 と時間帯も比べる。** 秒が後から取れたとき（過去分の取得は非同期で返る）は
  // 列も線も変わらないまま 0 だけが動くので、ここを見ないと目盛りが分の頭のまま残る。
  if (a.axisZero.kind !== b.axisZero.kind || a.axisZero.ms !== b.axisZero.ms) return false
  if ((a.reach === null) !== (b.reach === null)) return false
  if (a.reach !== null && b.reach !== null && (a.reach.fromMs !== b.reach.fromMs || a.reach.toMs !== b.reach.toMs)) {
    return false
  }
  if (a.arrival === null || b.arrival === null) return a.arrival === b.arrival
  return a.arrival.pMs === b.arrival.pMs && a.arrival.sMs === b.arrival.sMs
}

/**
 * 時間軸の 0 を決める。**秒が取れなければ分の頭。**
 *
 * **分の頭へ切り捨てる。** 地震情報の時刻は秒が 00 のはずだが、そう書かれていない経路が
 * あっても 0 が「分の頭」を名乗れるように揃える。
 */
function axisZeroOf(target: SeismoWaveTarget): WaveAxisZero {
  if (target.arrivalOriginMs !== null && target.arrivalOriginSource !== null) {
    return { kind: 'origin', ms: target.arrivalOriginMs, source: target.arrivalOriginSource }
  }
  return { kind: 'minute', ms: Math.floor(target.originMs / MINUTE_MS) * MINUTE_MS }
}

/** 震度を訊いた記録（地震 × 観測点ごと）。**どの区間について**の結果かを持つ。 */
interface IntensityAsk {
  readonly fromMs: number
  readonly toMs: number
  /** `done` = 取れた／`failed` = 一時的な失敗で取り直す／`gave-up` = この区間では訊かない。 */
  readonly kind: 'done' | 'failed' | 'gave-up'
  readonly atMs: number
}

interface Entry {
  readonly stationId: string
  readonly displayName: string
  /** 観測点の座標（ホストの設定に無ければ `null`）。**到達時刻を解くのに要る。** */
  readonly lat: number | null
  readonly lon: number | null
  columns: TimedColumns
  /**
   * 最後に列が伸びた時刻（**`serverNow()` 基準**）。
   *
   * **列の右端では代われない。** あちらが進むのは「値が届いた」ときだけで、
   * 届かない間は何も変わらない —— 止まってから何秒経ったかを測れるのは、
   * 伸びた時刻を外から書き留めてあるときだけ。
   *
   * 読み返しで作った時点を起点にする。**押し出しが 1 度も繋がらなければ、そこから
   * {@link WAVE_STALE_MS} で途切れと見なす**（それが正しい ——「伸ばす番なのに
   * 伸びていない」に当てはまる）。
   */
  lastGrewAt: number
  /** 直前に画面へ出した「途切れているか」。**裏返った巡回を捉えるために持つ。** */
  interrupted: boolean
  /**
   * 先頭の対象として**もう伸ばさない**と決まったか（継ぎ足しの巡回が書く）。
   * **先頭でない対象は、これに関わらず伸ばし終えている**（出すときに合わせて判断する）。
   */
  grownOut: boolean
  /** 訊けた震度（→ {@link SeismoQuakeWave.intensity}）。 */
  intensity: QuakeIntensity | null
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
  /** 地震カードごとの発生時刻（秒まで。→ `hooks/useQuakeOriginSeconds.ts`）。P/S 線の起点。 */
  originSeconds: ReadonlyMap<string, OriginSeconds>
  /**
   * ホストが取り戻した区間を作り直した知らせを受け取る（→ `useSeismoStation` の `subscribeWaveRevised`・#597）。
   * **受けたら、その区間に掛かる列をホストから取り直して差し替える** —— 押し出しから作った列は、
   * 届かなかったところが穴のまま残っている。
   */
  subscribeWaveRevised: (listener: (revised: SeismoStationWaveRevised) => void) => () => void
}): ReadonlyMap<string, readonly SeismoQuakeWave[]> {
  const { enabled, baseUrl, quakes, scope, readWave, replayOffsetMs, originSeconds, subscribeWaveRevised } = params
  const [waves, setWaves] = useState<ReadonlyMap<string, readonly SeismoQuakeWave[]>>(new Map())

  const canFetch = enabled && isValidSeismoHostUrl(baseUrl)
  const targets = useMemo(
    () => (canFetch ? pickTargets(quakes, scope, originSeconds) : []),
    [canFetch, quakes, scope, originSeconds],
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
    // **先頭でない対象はもう伸ばさない**（継ぎ足しの巡回が触るのは先頭だけ）。
    const headKey = targetsRef.current[0]?.eventKey
    const out = new Map<string, readonly SeismoQuakeWave[]>()
    for (const [key, list] of bookRef.current) {
      const target = byKey.get(key)
      const prev = publishedRef.current.get(key)
      // **対象から外れた直後の 1 巡**（`targetKey` の効果が帳面から消す前）だけ `target` が無い。
      // 0 を決める材料が無いので、**その地震は前に出した姿を丸ごと使い回す。** 出したことが無ければ
      // 載せない —— この地震は次の巡回で帳面からも消える（取消・表示する震度の設定変更）。
      if (target === undefined) {
        if (prev !== undefined) out.set(key, prev)
        continue
      }
      const next = list.map((e, i) => {
        const axisZero = axisZeroOf(target)
        // **0 から解いた到達。** 秒が取れていれば線にも使う。分の頭から解いた値は線には使わず、
        // 時間帯（60 秒の幅を持たせたもの）を出すためだけに使う。
        const fromZero = computeWaveArrival({
          originMs: axisZero.ms,
          hypocenter: target.hypocenter,
          stationLat: e.lat,
          stationLon: e.lon,
        })
        const built: SeismoQuakeWave = {
          stationId: e.stationId,
          displayName: e.displayName,
          columns: e.columns,
          interrupted: e.interrupted,
          complete: key !== headKey || e.grownOut,
          intensity: e.intensity,
          // **秒が取れていない地震は線を引かない**（→ `SeismoWaveTarget.arrivalOriginMs`）。
          arrival: axisZero.kind === 'origin' ? fromZero : null,
          axisZero,
          reach: computeReachBand(axisZero, fromZero),
          distanceKm: computeHypocentralDistanceKm({
            hypocenter: target.hypocenter,
            stationLat: e.lat,
            stationLon: e.lon,
          }),
          baseUrl,
        }
        // **観測点ごとに前の姿を使い回す。** 伸びている観測点が 1 つでも、
        // **同じ地震の他の観測点まで作り直すと、変わっていない絵が描き直される**
        // （→ {@link sameWave}）。
        const before = prev?.[i]
        return sameWave(before, built) ? before : built
      })
      // **中身が同じなら前の配列も使い回す。** 伸びているのは 1 件だけでも、毎回
      // 全部を作り直すと**関わりのない地震のカードまで描き直される**（この出し直しは
      // 0.3 秒ごとに走り、カードは 7 日ぶん残る）。
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
  // **繋ぎ足しの巡回から読む。** あの効果の依存は `[canFetch]` だけなので、
  // 再生の切り替えでは張り直されない（→ `growing` の判定）。
  const replayOffsetRef = useRef(replayOffsetMs)
  replayOffsetRef.current = replayOffsetMs
  useEffect(() => {
    if (resetKeyRef.current === resetKey) return
    resetKeyRef.current = resetKey
    resetIntensityRef.current()
    // **前に出した内容も捨てる。** 残すと、震度を訊く巡回が前の接続先・時間軸の区間を読む。
    publishedRef.current = new Map()
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
              lastGrewAt: serverNow(),
              interrupted: false,
              // 伸ばすかどうかは継ぎ足しの巡回が決める（先頭でなければ出すときに伸ばし終えた扱い）。
              grownOut: false,
              intensity: null,
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
      if (atMs > target.originMs + GROW_SAFETY_MS) {
        // **過ぎた拍子に「途切れている」が立っていたら戻す。** 伸ばさないのが
        // 当たり前になった区間を薄いままにすると、完結した絵が壊れているように見える
        // （→ {@link SeismoQuakeWave.interrupted}）。
        //
        // **判定は同じ述語へ通す。** ここで `false` を直に代入すると、
        // 「伸ばす番でなければ立てない」という規則が 2 箇所に分かれて、
        // 片方だけ変えたときに静かに食い違う。
        let cleared = false
        for (const entry of entries) {
          const interrupted = judgeWaveInterrupted({
            growing: false,
            lastGrewAt: entry.lastGrewAt,
            now: atMs,
          })
          if (interrupted !== entry.interrupted) {
            entry.interrupted = interrupted
            cleared = true
          }
          // **安全弁を過ぎたら伸ばし終えた。** 震度を訊く番になる。
          if (!entry.grownOut) {
            entry.grownOut = true
            cleared = true
          }
        }
        if (cleared) publishRef.current()
        return
      }

      // **再生中は伸ばす番ではない。** `App.tsx` は再生中に押し出しの購読を切るので
      // （`useSeismoStation` の `enabled` が `replayTimeOffset === null`）、
      // **`readWave()` は必ず `null` を返す** —— 列が伸びないのは当たり前で、
      // ホストの障害ではない。
      //
      // **これが無いと、再生を始めて 5 秒で絵が全部薄くなる。** しかも
      // 「読み取りの変更はリプレイで確かめる」という検証手順のただ中で起きるので、
      // 直したはずの「途絶」が誤報として最初に目に入ることになる。
      //
      // **読み返し（`GET /waves`）は再生中も動かす。** あちらは時刻の範囲を指定して
      // 取るので「いまの値が過去の画面へ混ざる」ことが起きない（→ `App.tsx`）。
      const pushLive = replayOffsetRef.current === null

      let changed = false
      for (const entry of entries) {
        // **伸ばす番かどうかを先に決める。** ここで `continue` して次の観測点へ
        // 移ると、**伸ばさなくなった後も「途切れている」が立ったまま残る**
        // （収まった絵が薄いまま居座る）。
        const growing =
          pushLive &&
          !(
            atMs > target.originMs + MIN_GROW_MS &&
            isSettled(entry.columns, SETTLE_WINDOW_MS, QUIET_GAL)
          )
        if (growing) {
          const next = appendWaveWindow({
            base: entry.columns,
            window: readWaveRef.current(entry.stationId),
            // **次の地震の手前まで。** 外すと、前の地震のカードへ次の地震の頭が入る。
            limitMs: Math.min(target.originMs + GROW_SAFETY_MS, target.cutoffMs),
          })
          if (next !== entry.columns) {
            entry.columns = next
            entry.lastGrewAt = atMs
            changed = true
          }
        }
        // **巡回のたびに引き直す。** 途切れている間は列が 1 つも変わらないので、
        // **列の変化だけを契機に出し直す形では画面に出ない** —— #423 の 3 形が
        // どれも「何も起きないことが伝わらない」だった根はここと同じ。
        const interrupted = judgeWaveInterrupted({
          growing,
          lastGrewAt: entry.lastGrewAt,
          now: atMs,
        })
        if (interrupted !== entry.interrupted) {
          entry.interrupted = interrupted
          changed = true
        }
        // **伸ばす番かどうかと同じ判定で「伸ばし終えた」を決める。** 別の条件で書くと、
        // 伸ばしているのに震度を訊く（後半の入らない計測震度になる）か、伸ばし終えたのに
        // 訊かないままになる。
        if (entry.grownOut === growing) {
          entry.grownOut = !growing
          changed = true
        }
      }
      if (changed) publishRef.current()
    }, APPEND_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [canFetch])

  // **取り戻した区間を作り直したら、その区間に掛かる列を取り直して差し替える**（#597・2026-10-07 ユーザー承認）。
  //
  // **押し出しから作った列は、届かなかったところが穴のまま残る。** 継ぎ足し（{@link appendWaveWindow}）は
  // 値のある最後の列の次からしか足さないので、後で下部の波形の穴が埋まっても、ここへは戻ってこない。
  //
  // **ライブのときだけ。** 再生中は押し出しを繋がないので知らせ自体が来ないが、時間軸の違う列へ
  // ライブの知らせを当てないよう、ここでも見る。
  useEffect(() => {
    if (!canFetch) return
    const ctrl = new AbortController()
    /** 鍵は `地震|観測点`。差し替えたのが同じ帳面かは、取りに行った時点の `resetKey` で見分ける。 */
    const runner = new RangeCoalescer(
      async (key, range) => {
        const sep = key.lastIndexOf('|')
        const eventKey = key.slice(0, sep)
        const stationId = key.slice(sep + 1)
        const token = resetKeyRef.current
        const entryOf = () => bookRef.current.get(eventKey)?.find((e) => e.stationId === stationId)
        const before = entryOf()
        if (before === undefined) return
        const span = revisedColumnSpan(before.columns, range.fromMs, range.toMs)
        if (span === null) return
        const result = await fetchSeismoWaveHistory({
          baseUrl,
          stationId,
          range: { fromMs: span.fromMs, toMs: span.toMs },
          columns: span.count,
          signal: ctrl.signal,
        })
        // **取りに行っている間に帳面が捨てられていたら書かない**（接続先・時間軸が変わった）。
        if (result.kind !== 'ok' || ctrl.signal.aborted || resetKeyRef.current !== token) return
        // **初回の読み返しと同じく、ホストの申告は記録へ残す**（画面からは「埋まらない」としか見えない）。
        const { filesMissing, filesFailed, skippedBytes, truncated } = result.history
        if (filesMissing > 0 || filesFailed > 0 || skippedBytes > 0 || truncated) {
          log.warn(
            `[seismo] 取り直した波形に欠けがある（${stationId}）: ` +
              `無かったファイル ${filesMissing}・読めなかったファイル ${filesFailed}・` +
              `読み飛ばし ${skippedBytes} バイト・打ち切り ${truncated ? 'あり' : 'なし'}`,
          )
        }
        if (!result.history.stationKnown) {
          log.warn(`[seismo] ホストが知らない観測点の波形を取り直した: ${stationId}`)
          return
        }
        const entry = entryOf()
        if (entry === undefined) return
        const next = spliceRevisedColumns(entry.columns, result.history)
        if (next === entry.columns) {
          // **列の境目が合わなかった**（{@link spliceRevisedColumns}）か、ホストも値を持っていなかった。
          log.debug(`[seismo] 取り戻した区間の列を取り直したが、カードの列は変わらなかった（${stationId}）`)
          return
        }
        entry.columns = next
        log.info(`[seismo] 取り戻した区間で地震カードの波形を差し替えた（${stationId}・${span.count} 列）`)
        publishRef.current()
      },
      ctrl.signal,
      (key, error) => log.error(`[seismo] 地震カードの波形を差し替える途中で投げた（${key}）`, error),
    )
    const unsubscribe = subscribeWaveRevised((revised) => {
      if (replayOffsetRef.current !== null) return
      for (const [eventKey, entries] of bookRef.current) {
        for (const e of entries) {
          if (e.stationId !== revised.stationId) continue
          if (revisedColumnSpan(e.columns, revised.fromMs, revised.toMs) === null) continue
          runner.push(`${eventKey}|${e.stationId}`, revised)
        }
      }
    })
    return () => {
      unsubscribe()
      ctrl.abort()
    }
  }, [canFetch, baseUrl, subscribeWaveRevised])

  // **震源が動いたら到達の線を引き直す。**
  //
  // **取得の鍵（`targetKey`）と分ける。** あちらに震源を混ぜると、続報が届くたびに
  // 読み返しの effect が張り直されて、取りかけの取得が中断される（`doneRef` が
  // 取り直しはするが、中断を増やす理由が無い）。
  const arrivalKey = targets
    .map((t) => {
      const h = t.hypocenter
      // **秒が後から取れたときも引き直す**（過去分の取得は開いた直後に非同期で返る）。
      return `${t.eventKey}@${t.arrivalOriginMs}@${t.arrivalOriginSource}@${h.latitude},${h.longitude},${h.depth}`
    })
    .join(',')
  useEffect(() => {
    // 何も持っていなければ出し直す意味が無い（空の Map を作り替えるだけになる）。
    if (bookRef.current.size === 0) return
    publishRef.current()
  }, [arrivalKey])

  // **伸ばし終えた区間の震度を訊く**（地震 × 観測点 × 描く区間について 1 回。**1 本ずつ**）。
  //
  // **1 本ずつにするのは、ホストの受信を止めないため。** 1 件は数十 ms で済むが、7 日ぶんの
  // カードを一度に投げると、ホストのイベントループが続けて塞がる（`seismo-host` の
  // `loopStall.ts` が数える「止まった」に近づく）。
  //
  // **区間が変わったら訊き直す。** 次の地震で末尾が切り戻されると、描く区間が変わる。
  const intensityAsksRef = useRef(new Map<string, IntensityAsk>())
  const intensityUnsupportedRef = useRef(false)
  const intensityCtrlRef = useRef<AbortController | null>(null)
  const intensityRetryRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const askIntensityRef = useRef<() => void>(() => {})
  askIntensityRef.current = () => {
    if (!canFetch || intensityUnsupportedRef.current || intensityCtrlRef.current !== null) return
    const now = serverNow()
    const byKey = new Map(targetsRef.current.map((t) => [t.eventKey, t]))
    // 取り直しの待ちがいちばん早く明ける時刻。**1 本のタイマーをそこへ張り直す** ——
    // 失敗のたびに張り直すと、続けて失敗したとき前の予約が上書きされて取り直しが遅れる。
    let nextDueMs = Infinity
    for (const [eventKey, list] of publishedRef.current) {
      const target = byKey.get(eventKey)
      if (target === undefined) continue
      for (const wave of list) {
        if (!wave.complete) continue
        const span = columnsSpan(selectQuakeWindow({ base: wave.columns, zero: wave.axisZero, reach: wave.reach }).columns)
        if (span === null) continue
        if (wave.intensity !== null && wave.intensity.fromMs === span.fromMs && wave.intensity.toMs === span.toMs) continue
        const askKey = `${eventKey}|${wave.stationId}`
        const prev = intensityAsksRef.current.get(askKey)
        if (prev !== undefined && prev.fromMs === span.fromMs && prev.toMs === span.toMs) {
          // 同じ区間で取れたもの・諦めたもの・取り直しを待っているものは飛ばす
          // （待ちが明けたらタイマーが呼び直す）。
          if (prev.kind !== 'failed') continue
          if (now - prev.atMs < RETRY_INTERVAL_MS) {
            nextDueMs = Math.min(nextDueMs, prev.atMs + RETRY_INTERVAL_MS)
            continue
          }
        }
        void askOne({ eventKey, stationId: wave.stationId, span, fresh: now <= target.originMs + GROW_SAFETY_MS })
        return
      }
    }
    if (intensityRetryRef.current !== undefined) clearTimeout(intensityRetryRef.current)
    intensityRetryRef.current = Number.isFinite(nextDueMs)
      ? setTimeout(() => askIntensityRef.current(), Math.max(0, nextDueMs - now))
      : undefined
  }

  /** 1 本訊く。**終わったら次を探す**（{@link askIntensityRef}）。 */
  const askOne = async (job: {
    eventKey: string
    stationId: string
    span: { fromMs: number; toMs: number }
    fresh: boolean
  }): Promise<void> => {
    const ctrl = new AbortController()
    intensityCtrlRef.current = ctrl
    const askKey = `${job.eventKey}|${job.stationId}`
    const result = await fetchSeismoQuakeIntensity({
      baseUrl,
      stationId: job.stationId,
      fromMs: job.span.fromMs,
      toMs: job.span.toMs,
      signal: ctrl.signal,
    })
    // **取り消されたら何も書かない**（接続先・時間軸が変わった。帳面ごと作り直されている）。
    if (ctrl.signal.aborted) return
    intensityCtrlRef.current = null
    // **待っている間に対象から外れた地震は書かない**（取消・表示する震度の設定変更）。
    // 書くと、外れたときに掃除した記録が死んだ鍵のまま居座る。
    if (!targetsRef.current.some((t) => t.eventKey === job.eventKey)) {
      askIntensityRef.current()
      return
    }
    const mark = (kind: IntensityAsk['kind']): void => {
      intensityAsksRef.current.set(askKey, { ...job.span, kind, atMs: serverNow() })
    }
    switch (result.kind) {
      case 'ok': {
        mark('done') // 取れた区間は二度と訊かない（区間が変われば別の問い合わせになる）
        const entry = bookRef.current.get(job.eventKey)?.find((e) => e.stationId === job.stationId)
        if (entry !== undefined) {
          // **区間は訊いた値で持つ。** ホストは整数のミリ秒へ丸めて返すので、そのまま持つと
          // 描く側の区間（列の境目）と一致しなくなる。
          entry.intensity = { ...result.intensity, fromMs: job.span.fromMs, toMs: job.span.toMs }
          // **計測震度が出なかった理由は記録へ残す。** 画面は最大リアルタイム震度だけになるので、
          // 「途切れていた」のか「記録が届いていなかった」のかはここでしか分からない。
          // **読み込みの欠けを申告されたら残す**。震度は出ても、ディスクの不調で読めなかった分が
          // 値から抜けている。
          //
          // **「無かったファイル」だけでは書かない**（本文には載せる）。ホストは区間の 1 時間前の
          // ファイルから読みに行くので、無かったファイルはふつうに数えられる —— 条件に入れると
          // カードの枚数だけ記録が埋まる。欠けた区間は途切れ（`gap`・`not-covered`）として別に出る。
          const { filesMissing, filesFailed, skippedBytes, truncated, invalidChunkCount } = result.intensity
          if (filesFailed > 0 || skippedBytes > 0 || truncated || invalidChunkCount > 0) {
            log.warn(
              `[seismo] 地震の区間の震度に読み込みの欠けがある（${job.stationId}）: ` +
                `無かったファイル ${filesMissing}・読めなかったファイル ${filesFailed}・読み飛ばし ${skippedBytes} バイト・` +
                `打ち切り ${truncated ? 'あり' : 'なし'}・値の壊れたまとまり ${invalidChunkCount}`,
            )
          }
          if (result.intensity.measured === null) {
            log.debug(
              `[seismo] 地震の区間の計測震度を出せなかった（${job.stationId}）: ${result.intensity.measuredUnavailable}` +
                `・途切れ ${result.intensity.gapCount} か所`,
            )
          }
          publishRef.current()
        }
        break
      }
      case 'not-supported':
        // **配る前のホスト。** 接続先が変わるまで訊かない。記録は 1 回だけ。
        intensityUnsupportedRef.current = true
        log.warn('[seismo] ホストが地震の区間の震度の口（/quake-intensity）を持っていない（配る前の版）')
        return
      case 'bad-request':
        mark('gave-up') // 同じ区間で投げ直しても通らない
        break
      // `aborted` は来ない（取り消しは上の `ctrl.signal.aborted` で先に返している）。
      default:
        // **一時的な失敗は、新しい地震だけ取り直す**（読み返しと同じ線。古いカードのために
        // ホストを叩き続けない）。
        // 取り直しのタイマーは次の巡回が張る（待ちが明ける時刻のうち最も早いものへ）。
        mark(job.fresh ? 'failed' : 'gave-up')
        if (!job.fresh) {
          log.debug(`[seismo] 地震の区間の震度を訊くのを諦めた（${job.stationId}・${result.kind}）: 発生から 30 分を過ぎた地震は取り直さない`)
        }
    }
    askIntensityRef.current()
  }

  useEffect(() => {
    askIntensityRef.current()
  }, [waves])

  /** 震度を訊く帳面を捨てる（接続先・時間軸が変わった・機能を切った・画面を閉じた）。 */
  const resetIntensityRef = useRef<() => void>(() => {})
  resetIntensityRef.current = () => {
    intensityCtrlRef.current?.abort()
    intensityCtrlRef.current = null
    if (intensityRetryRef.current !== undefined) clearTimeout(intensityRetryRef.current)
    intensityRetryRef.current = undefined
    intensityAsksRef.current = new Map()
    intensityUnsupportedRef.current = false
  }
  useEffect(() => () => resetIntensityRef.current(), [])

  // 対象から外れた地震の分を捨て、**打ち切りが縮んだ分を切り戻す。**
  useEffect(() => {
    const alive = new Map(targetsRef.current.map((t) => [t.eventKey, t]))
    // **先頭以外は「伸ばす番」ではない**（継ぎ足しの巡回が触るのは先頭だけ）。
    const headKey = targetsRef.current[0]?.eventKey
    let changed = false
    for (const [key, entries] of [...bookRef.current]) {
      const target = alive.get(key)
      // 取消・表示する震度の設定変更で対象から外れたもの。
      if (target === undefined) {
        bookRef.current.delete(key)
        // 震度を訊いた記録も同じ鍵で捨てる（残すと 7 日ぶん積み上がる）。
        for (const askKey of [...intensityAsksRef.current.keys()]) {
          if (askKey.startsWith(`${key}|`)) intensityAsksRef.current.delete(askKey)
        }
        changed = true
        continue
      }
      // **先頭から降りた地震の「途切れている」は戻す。** 継ぎ足しの巡回はもう
      // この地震を触らないので、立てたまま残すと**その絵は薄いまま固定される**
      // （新しい地震が来た拍子に、完結した前の地震のカードが壊れて見える）。
      if (key !== headKey) {
        for (const entry of entries) {
          if (!entry.interrupted) continue
          entry.interrupted = false
          changed = true
        }
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
    // **先頭が入れ替わっただけでも出し直す。** 降りた地震は列も途切れも変わらないまま
    // 「伸ばし終えた」になる（→ `SeismoQuakeWave.complete`）ので、出し直さないと震度を訊かない。
    if (changed || bookRef.current.size > 0) publishRef.current()
  }, [targetKey])

  // 機能を切ったら画面からも消す。
  useEffect(() => {
    if (canFetch) return
    resetIntensityRef.current()
    publishedRef.current = new Map()
    doneRef.current = new Set()
    inFlightRef.current = new Set()
    bookRef.current = new Map()
    setWaves(new Map())
  }, [canFetch])

  return waves
}
