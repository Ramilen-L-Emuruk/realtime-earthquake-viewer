import { useEffect, useRef, useState } from 'react'
import type { SiteCoords } from '../services/kyoshin'
import { haversineKm } from '../utils/geo'

export interface DetectedPoint {
  lat: number
  lng: number
  index: number
}

export interface KyoshinDetection {
  detected: boolean
  maxIndex: number
  /** 急上昇した観測点（震度インデックス降順） */
  points: DetectedPoint[]
}

// ---- 定数 ---------------------------------------------------------------

/** 1秒で index が 2 以上増加した観測点を「変化あり」とみなす（約1.0 計測震度相当の上昇） */
const DELTA_THRESHOLD = 2
/** 検知対象とする最低インデックス（震度0相当: 計測震度 0.0 以上 = index 6） */
export const MIN_DETECTION_INDEX = 6
/** このインデックス以上は delta チェックをスキップする（震度3以上: 計測震度 2.5 以上 = index 11）。
 *  急上昇がなくても震度3を2秒維持すれば確定できるようにする。 */
const BYPASS_DELTA_INDEX = 11
/** 空間クラスタリングの距離閾値 (km) */
const PROXIMITY_KM = 60
/** クラスタ成立に必要な最低観測点数（2点は隣接センサー誤作動と区別不可のため3点以上） */
const MIN_CLUSTER_SIZE = 3
/** 候補クラスタの有効期限 (ms)：この時間内に再検出されなければ廃棄 */
const PENDING_TIMEOUT_MS = 3_000
/** 既存候補との同一クラスタ判定距離 (km) */
const PENDING_MATCH_KM = 120
/** 候補どまりの誤検知をこの回数繰り返した観測点をノイズとみなす */
const NOISE_THRESHOLD = 3
/** ノイズ判定された観測点を除外する時間 (ms) */
const NOISE_BLACKLIST_MS = 300_000
/** 検知後の表示維持時間 (ms) */
const DETECTION_DURATION_MS = 10_000
/** 時系列バッファのサイズ（フレーム数） */
const N_HISTORY = 3

// ---- 内部型 --------------------------------------------------------------

interface Cluster {
  /** クラスタ重心 */
  centroid: { lat: number; lng: number }
  /** クラスタ構成観測点インデックス */
  siteIndices: number[]
  maxIndex: number
}

interface PendingCluster {
  centroid: { lat: number; lng: number }
  siteIndices: number[]
  maxIndex: number
  detectedAt: number
}

// ---- ユーティリティ ------------------------------------------------------

/**
 * Union-Find を使い、PROXIMITY_KM 以内の観測点を連結してクラスタ列を返す。
 * 重心は構成点の算術平均とする。
 */
function buildClusters(
  changedItems: Array<{ siteIdx: number; index: number }>,
  sites: SiteCoords,
): Cluster[] {
  const n = changedItems.length
  const parent = Array.from({ length: n }, (_, i) => i)

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }

  for (let a = 0; a < n; a++) {
    const siteA = sites[changedItems[a].siteIdx]
    if (!siteA) continue
    for (let b = a + 1; b < n; b++) {
      const siteB = sites[changedItems[b].siteIdx]
      if (!siteB) continue
      if (haversineKm(siteA[0], siteA[1], siteB[0], siteB[1]) <= PROXIMITY_KM) {
        const ra = find(a), rb = find(b)
        if (ra !== rb) parent[ra] = rb
      }
    }
  }

  const groups = new Map<number, typeof changedItems>()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    const g = groups.get(root) ?? []
    g.push(changedItems[i])
    groups.set(root, g)
  }

  const clusters: Cluster[] = []
  for (const members of groups.values()) {
    if (members.length < MIN_CLUSTER_SIZE) continue
    let latSum = 0, lngSum = 0, maxIndex = 0
    const siteIndices: number[] = []
    for (const m of members) {
      const site = sites[m.siteIdx]
      if (!site) continue
      latSum += site[0]
      lngSum += site[1]
      if (m.index > maxIndex) maxIndex = m.index
      siteIndices.push(m.siteIdx)
    }
    const count = siteIndices.length
    if (count === 0) continue
    clusters.push({
      centroid: { lat: latSum / count, lng: lngSum / count },
      siteIndices,
      maxIndex,
    })
  }
  return clusters
}

// ---- Hook ----------------------------------------------------------------

const EMPTY: KyoshinDetection = { detected: false, maxIndex: 0, points: [] }

/**
 * Layer 0〜5 の6層構成による地震検知フック（Layer 3 は現在無効化中）。
 *
 * Layer 0: 直近3フレームの時系列バッファ管理
 * Layer 1: 観測点レベルフィルタ（急上昇・震度3以上持続・ノイズブラックリスト）
 * Layer 2: 空間クラスタリング（Union-Find、最低3点）
 * Layer 3: グローバルサニティ（全体の15%以上が変化 → データ異常として棄却）※現在無効化中
 * Layer 4: テンポラル確定（2フレーム連続検出で確定、複数クラスタ独立管理）
 * Layer 5: 観測点ノイズトラッキング（繰り返し誤検知観測点を5分除外）
 */
export function useKyoshinDetection(
  sites: SiteCoords,
  indices: number[],
): KyoshinDetection {
  // Layer 0: フレームバッファ（[oldest, ..., newest]）
  const frameBufferRef = useRef<number[][]>([])
  // Layer 4: 候補クラスタリスト
  const pendingRef = useRef<PendingCluster[]>([])
  // Layer 4: 確定済み観測点セット（Layer 1 の delta チェックをバイパスして毎フレーム追跡）
  const confirmedSitesRef = useRef<Set<number>>(new Set())
  // Layer 5: ノイズ観測点 Map<siteIdx, {count, until}>
  const noisyRef = useRef<Map<number, { count: number; until: number }>>(new Map())

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [detection, setDetection] = useState<KyoshinDetection>(EMPTY)

  useEffect(() => {
    if (sites.length === 0 || indices.length === 0) return

    // --- Layer 0: バッファ更新 ---
    const buf = frameBufferRef.current
    buf.push(indices.slice())
    if (buf.length > N_HISTORY) buf.shift()
    if (buf.length < 2) return  // 最低2フレーム必要

    const curr = buf[buf.length - 1]
    const prev = buf[buf.length - 2]
    const older = buf.length >= 3 ? buf[buf.length - 3] : null

    if (prev.length !== curr.length) return

    const now = Date.now()

    // Layer 5: 期限切れノイズエントリを清掃
    for (const [k, v] of noisyRef.current) {
      if (now >= v.until) noisyRef.current.delete(k)
    }

    // --- Layer 1: 観測点フィルタ ---
    // delta は t-2 フレーム基準で計算する。
    // これにより「7→8→9」のような1秒に1インデックスずつ緩やかに上昇する
    // 地震波も捕捉できる（t-2基準のdelta=2となり閾値を満たす）。
    // t-1基準では delta=1 しか得られず、こうした地震は検知できなかった。
    // 単一フレームのスパイクは Layer 4 テンポラル確定が吸収する。
    //
    // 確定済み観測点（confirmedSites）は delta チェックをスキップし、
    // 震度が閾値以上である限り毎フレーム自動で changed に追加する。
    // 震度が閾値を下回ったら confirmedSites から除外する。
    const changed: Array<{ siteIdx: number; index: number }> = []
    for (let i = 0; i < curr.length; i++) {
      const idx = curr[i]

      // 確定済み観測点：delta チェックをスキップ
      if (confirmedSitesRef.current.has(i)) {
        if (idx >= MIN_DETECTION_INDEX) {
          changed.push({ siteIdx: i, index: idx })
        } else {
          confirmedSitesRef.current.delete(i)  // 震度が閾値を下回ったら除外
        }
        continue
      }

      // 未確定観測点：通常の delta フィルタ
      if (idx < MIN_DETECTION_INDEX) continue
      // 震度3以上（BYPASS_DELTA_INDEX）は急上昇がなくても changed に追加する
      if (idx < BYPASS_DELTA_INDEX) {
        const baseIdx = older !== null ? (older[i] ?? 0) : (prev[i] ?? 0)
        if (idx - baseIdx < DELTA_THRESHOLD) continue
      }
      if (noisyRef.current.has(i)) continue
      changed.push({ siteIdx: i, index: idx })
    }

    // --- Layer 3: グローバルサニティ ---
//    if (changed.length / curr.length > ANOMALY_RATIO) {
//      // データ異常：全候補を廃棄してこのフレームをスキップ
//      pendingRef.current = []
//      return
//    }

    // --- Layer 2: 空間クラスタリング ---
    const clusters = changed.length > 0 ? buildClusters(changed, sites) : []

    // --- Layer 4: テンポラル確定（候補との照合） ---
    // 期限切れ候補を廃棄し、廃棄された候補の観測点をノイズカウントアップ
    const alive: PendingCluster[] = []
    const expired: PendingCluster[] = []
    for (const p of pendingRef.current) {
      if (now - p.detectedAt <= PENDING_TIMEOUT_MS) {
        alive.push(p)
      } else {
        expired.push(p)
      }
    }

    // Layer 5: 廃棄候補の観測点をノイズカウント
    for (const p of expired) {
      for (const si of p.siteIndices) {
        const entry = noisyRef.current.get(si) ?? { count: 0, until: 0 }
        entry.count += 1
        if (entry.count >= NOISE_THRESHOLD) {
          entry.until = now + NOISE_BLACKLIST_MS
          entry.count = 0
        }
        noisyRef.current.set(si, entry)
      }
    }

    pendingRef.current = alive

    if (clusters.length === 0) return

    let confirmed = false
    let confirmedMaxIndex = 0
    const confirmedSiteIndices: number[] = []

    for (const cluster of clusters) {
      // 既存候補と照合
      const matchIdx = alive.findIndex(
        (p) => haversineKm(p.centroid.lat, p.centroid.lng, cluster.centroid.lat, cluster.centroid.lng) <= PENDING_MATCH_KM,
      )

      if (matchIdx >= 0) {
        // 2フレーム目：確定
        confirmed = true
        if (cluster.maxIndex > confirmedMaxIndex) confirmedMaxIndex = cluster.maxIndex
        confirmedSiteIndices.push(...cluster.siteIndices)
        // 確定した候補を候補リストから除去（連続更新は不要）
        alive.splice(matchIdx, 1)
      } else {
        // 新規候補として登録
        alive.push({
          centroid: cluster.centroid,
          siteIndices: cluster.siteIndices,
          maxIndex: cluster.maxIndex,
          detectedAt: now,
        })
      }
    }

    pendingRef.current = alive

    // Layer 4 確定時：新規確定観測点を confirmedSites に追加してタイマーをリセット
    if (confirmed) {
      for (const si of confirmedSiteIndices) {
        confirmedSitesRef.current.add(si)
        // Layer 5: 確定地震の観測点はノイズカウントをリセット
        noisyRef.current.delete(si)
      }
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        setDetection(EMPTY)
        confirmedSitesRef.current.clear()
      }, DETECTION_DURATION_MS)
    }

    // 確定済み観測点が存在するフレームで毎回 points を更新（リアルタイム反映）
    if (confirmedSitesRef.current.size > 0) {
      const points: DetectedPoint[] = changed
        .filter((c) => confirmedSitesRef.current.has(c.siteIdx))
        .map((c) => {
          const site = sites[c.siteIdx]
          if (!site) return null
          return { lat: site[0], lng: site[1], index: c.index }
        })
        .filter((p): p is DetectedPoint => p !== null)
        .sort((a, b) => b.index - a.index)
      const maxIndex = points[0]?.index ?? confirmedMaxIndex
      setDetection({ detected: true, maxIndex, points })
    }
  }, [sites, indices])

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    confirmedSitesRef.current.clear()
  }, [])

  return detection
}
