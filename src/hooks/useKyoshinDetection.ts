import { useEffect, useRef, useState } from 'react'
import type { SiteCoords } from '../services/kyoshin'
import { haversineKm } from '../utils/geo'
import { log } from '../utils/logger'

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
  /** 未確定の主候補クラスタの構成観測点（Layer 2 成立・Layer 4 未確定）。主候補が無ければ空配列。 */
  candidatePoints: DetectedPoint[]
  /** 主候補クラスタの識別子（登録時刻 detectedAt をそのまま流用）。主候補が無ければ null。
   *  同じ候補が pendingRef に留まる限り値は変わらないため、UI 側の再フィット判定に使える。 */
  candidateId: number | null
}

// ---- 定数 ---------------------------------------------------------------

/** 1秒で index が 2 以上増加した観測点を「変化あり」とみなす（約1.0 計測震度相当の上昇） */
const DELTA_THRESHOLD = 2
/** 全観測点表示・外部UIサマリ用の最低インデックス（震度-1相当: 計測震度 -0.5 以上 = index 5）。
 *  検知エンジン内部のクラスタ形成・アンカー判定には使わない（→ ACTIVE_MIN_INDEX）。App.tsx・RealtimeTab 参照。 */
export const MIN_DETECTION_INDEX = 5
/** このインデックス以上は delta チェックをスキップする（震度3以上: 計測震度 2.5 以上 = index 11）。
 *  急上昇がなくても震度3を2秒維持すれば確定できるようにする。 */
const BYPASS_DELTA_INDEX = 11
/** 検知エンジンが「アクティブ」とみなす最低インデックス（震度1相当: 計測震度 0.5 以上 = index 7）。
 *  新規クラスタ形成（Layer1 changed 判定・Layer2 クラスタリング・MIN_CLUSTER_SIZE カウント）と、
 *  近傍確定（isNear）のアンカー資格は全てこの閾値で判定する。
 *  震度0以下（index 6 以下）はアクティブ判定に一切加わらず、新規検知のトリガーにも周辺点の起爆剤にもならない。 */
const ACTIVE_MIN_INDEX = 7
/** 震度0のインデックス値（計測震度 0.0 以上 0.5 未満 = index 6）。
 *  アクティブな確定点（ACTIVE_MIN_INDEX 以上）の近傍にある間だけ「表示専用の確定点」として追跡する。
 *  クラスタ形成にもアンカーにもならず、検知タイマーも延長しない（→ shindo0DisplaySitesRef）。 */
const SHINDO0_INDEX = 6
/** 空間クラスタリングの距離閾値 (km) */
const PROXIMITY_KM = 60
/** クラスタ成立に必要な最低観測点数（2点は隣接センサー誤作動と区別不可のため3点以上） */
const MIN_CLUSTER_SIZE = 3
/** 候補クラスタの有効期限 (ms)：この時間内に再検出されなければ廃棄。
 *  ポーリング間隔は POLL_MS=1000 だが fetch のレイテンシ等で実際のフレーム間隔にはジッターが乗る。
 *  3フレーム分ちょうど（3000ms）だと正当な3フレーム目の再検出さえ僅かな遅延で期限切れになり得るため、
 *  1フレーム分の余裕を持たせている。 */
const PENDING_TIMEOUT_MS = 4_000
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

/**
 * pendingRef の中から「主候補」1件を選ぶ（maxIndex 最大、同点なら detectedAt が新しい方）。
 * 複数の無関係な候補が同時に存在しても bounds が無意味に拡大しないよう、常に1件だけを対象にする。
 */
function pickPrimaryCandidate(
  alive: PendingCluster[],
  curr: number[],
  sites: SiteCoords,
): { points: DetectedPoint[]; id: number | null } {
  const primary = alive.reduce<PendingCluster | null>((best, p) =>
    !best || p.maxIndex > best.maxIndex || (p.maxIndex === best.maxIndex && p.detectedAt > best.detectedAt)
      ? p : best, null)
  if (!primary) return { points: [], id: null }
  const points: DetectedPoint[] = primary.siteIndices
    .map((si) => {
      const site = sites[si]
      const idx = curr[si]
      if (!site || idx === undefined) return null
      return { lat: site[0], lng: site[1], index: idx }
    })
    .filter((p): p is DetectedPoint => p !== null)
    .sort((a, b) => b.index - a.index)
  return { points, id: primary.detectedAt }
}

// ---- Hook ----------------------------------------------------------------

/** confirmed 状態のみ（candidatePoints/candidateId は別 state として保持し、hook の返り値で合成する） */
type ConfirmedState = Pick<KyoshinDetection, 'detected' | 'maxIndex' | 'points'>
const EMPTY: ConfirmedState = { detected: false, maxIndex: 0, points: [] }

/**
 * Layer 0〜5 の6層構成による地震検知フック（Layer 3 は現在無効化中）。
 *
 * Layer 0: 直近3フレームの時系列バッファ管理
 * Layer 1: 観測点レベルフィルタ（急上昇・震度3以上持続・ノイズブラックリスト）。震度0以下は対象外
 * Layer 2: 空間クラスタリング（Union-Find、最低3点、震度1以上の点のみ）
 * Layer 3: グローバルサニティ（全体の15%以上が変化 → データ異常として棄却）※現在無効化中
 * Layer 4: テンポラル確定（2フレーム連続検出で確定、複数クラスタ独立管理）
 *          + 近傍確定：確定済み観測点が PENDING_MATCH_KM 以内にある場合、震度1以上の点を全フィルタースキップで即時確定
 *          + 震度0随伴表示：近傍確定と同条件で震度0の点を「表示専用の確定点」として追跡（アンカーにはならず新規検知のトリガーにもならない）
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
  // Layer 4: 近傍確定で追加された観測点セット（閾値 ACTIVE_MIN_INDEX で管理）
  const nearConfirmedSitesRef = useRef<Set<number>>(new Set())
  // Layer 4: 震度0随伴表示の観測点セット（表示専用。アンカーにはならず新規検知のトリガーにもならない）
  const shindo0DisplaySitesRef = useRef<Set<number>>(new Set())
  // Layer 5: ノイズ観測点 Map<siteIdx, {count, until}>
  const noisyRef = useRef<Map<number, { count: number; until: number }>>(new Map())

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevDetectedRef = useRef(false)
  const [detection, setDetection] = useState<ConfirmedState>(EMPTY)
  // Layer 4: 主候補クラスタ（未確定）。地図フィット・早期タブ切替/通知音のトリガーに使う。
  const [candidatePoints, setCandidatePoints] = useState<DetectedPoint[]>([])
  const [candidateId, setCandidateId] = useState<number | null>(null)

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
    // 震度1以上（ACTIVE_MIN_INDEX）である限り毎フレーム自動で changed に追加する。
    // 震度0まで減衰したらアンカー資格を失い、表示専用の震度0随伴点（shindo0DisplaySites）へ格下げする。
    // 震度0未満まで下がったら完全に除外する。
    // 近傍確定観測点（nearConfirmedSites）も ACTIVE_MIN_INDEX を閾値として同様に扱う。
    // 震度0随伴点（shindo0DisplaySites）は changed もクラスタリングも通さず、現在値のみを追跡する
    // （震度1以上に再上昇したらアクティブな近傍確定点へ復帰する）。
    const changed: Array<{ siteIdx: number; index: number }> = []
    for (let i = 0; i < curr.length; i++) {
      const idx = curr[i]

      // 確定済み観測点：delta チェックをスキップ
      if (confirmedSitesRef.current.has(i)) {
        if (idx >= ACTIVE_MIN_INDEX) {
          changed.push({ siteIdx: i, index: idx })
        } else if (idx === SHINDO0_INDEX) {
          confirmedSitesRef.current.delete(i)
          shindo0DisplaySitesRef.current.add(i)  // 震度0まで減衰：表示専用の確定点へ格下げ
        } else {
          confirmedSitesRef.current.delete(i)  // 震度0未満まで下がったら除外
        }
        continue
      }

      // 近傍確定観測点：delta チェックをスキップ（閾値は ACTIVE_MIN_INDEX）
      if (nearConfirmedSitesRef.current.has(i)) {
        if (idx >= ACTIVE_MIN_INDEX) {
          changed.push({ siteIdx: i, index: idx })
        } else if (idx === SHINDO0_INDEX) {
          nearConfirmedSitesRef.current.delete(i)
          shindo0DisplaySitesRef.current.add(i)  // 震度0まで減衰：表示専用の確定点へ格下げ
        } else {
          nearConfirmedSitesRef.current.delete(i)  // 震度1未満になったら除外
        }
        continue
      }

      // 震度0随伴点：表示専用。delta チェックもクラスタリングも通さない
      if (shindo0DisplaySitesRef.current.has(i)) {
        if (idx >= ACTIVE_MIN_INDEX) {
          // 震度1以上に再上昇：アクティブな近傍確定点へ復帰
          shindo0DisplaySitesRef.current.delete(i)
          nearConfirmedSitesRef.current.add(i)
          changed.push({ siteIdx: i, index: idx })
        } else if (idx !== SHINDO0_INDEX) {
          shindo0DisplaySitesRef.current.delete(i)  // 震度0以外になったら除外
        }
        continue
      }

      // 未確定観測点：通常の delta フィルタ（震度0以下は新規クラスタ形成の対象外）
      if (idx < ACTIVE_MIN_INDEX) continue
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

    let confirmed = false
    let confirmedMaxIndex = 0
    const confirmedSiteIndices: number[] = []

    // --- 近傍確定：クラスタ照合より先に実行（clusters が空でも動作する） ---
    // 確定済み観測点（震度1以上のアクティブ点のみ。震度0随伴点は含まない）が PENDING_MATCH_KM 以内にある場合、
    // 震度1以上の点は全フィルタースキップで即時確定（アンカーへ昇格）、震度0の点は表示専用の随伴点として追跡する
    // （随伴点はアンカーにならず confirmed も立てないため、検知タイマーは延長しない）。
    // changed を経由せず curr 全体を走査する。
    let shindo0Attached = false
    const allConfirmedSites = new Set([...confirmedSitesRef.current, ...nearConfirmedSitesRef.current])
    if (allConfirmedSites.size > 0) {
      for (let i = 0; i < curr.length; i++) {
        if (confirmedSitesRef.current.has(i) || nearConfirmedSitesRef.current.has(i) || shindo0DisplaySitesRef.current.has(i)) continue
        const idx = curr[i]
        const isActiveCandidate = idx >= ACTIVE_MIN_INDEX
        const isShindo0Candidate = idx === SHINDO0_INDEX
        if (!isActiveCandidate && !isShindo0Candidate) continue
        const site = sites[i]
        if (!site) continue
        const isNear = [...allConfirmedSites].some((si) => {
          const cs = sites[si]
          return cs !== undefined && haversineKm(cs[0], cs[1], site[0], site[1]) <= PENDING_MATCH_KM
        })
        if (!isNear) continue
        if (isActiveCandidate) {
          nearConfirmedSitesRef.current.add(i)
          if (idx > confirmedMaxIndex) confirmedMaxIndex = idx
          confirmed = true
        } else {
          shindo0DisplaySitesRef.current.add(i)  // 表示専用：アンカーにならず confirmed も立てない
          shindo0Attached = true
        }
      }
    }

    if (clusters.length === 0) {
      // クラスタなしでも近傍確定・震度0随伴表示があれば後処理へ進む
      if (!confirmed && !shindo0Attached) {
        // 新規クラスタは無いため alive（期限切れクリーンアップ済み）がそのまま最終状態
        const primary = pickPrimaryCandidate(alive, curr, sites)
        setCandidatePoints(primary.points)
        setCandidateId(primary.id)
        return
      }
    }

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

    // 新規登録・確定除去を反映した最新の alive から主候補を選び直す
    const primary = pickPrimaryCandidate(alive, curr, sites)
    setCandidatePoints(primary.points)
    setCandidateId(primary.id)

    // Layer 4 確定時：新規確定観測点を confirmedSites に追加してタイマーをリセット
    if (confirmed) {
      for (const si of confirmedSiteIndices) {
        confirmedSitesRef.current.add(si)
        // Layer 5: 確定地震の観測点はノイズカウントをリセット
        noisyRef.current.delete(si)
      }
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        log.debug(`[kyoshin] 検知タイマー満了 → 検知終了 (DETECTION_DURATION_MS=${DETECTION_DURATION_MS}ms)`)
        prevDetectedRef.current = false
        setDetection(EMPTY)
        confirmedSitesRef.current.clear()
        nearConfirmedSitesRef.current.clear()
        shindo0DisplaySitesRef.current.clear()
      }, DETECTION_DURATION_MS)
    }

    // 確定済み観測点が存在するフレームで毎回 points を更新（リアルタイム反映）
    const allConfirmedSize = confirmedSitesRef.current.size + nearConfirmedSitesRef.current.size + shindo0DisplaySitesRef.current.size
    if (allConfirmedSize > 0) {
      const allConfirmed = new Set([...confirmedSitesRef.current, ...nearConfirmedSitesRef.current, ...shindo0DisplaySitesRef.current])
      // nearConfirmedSites・shindo0DisplaySites の点は changed を通っていないため curr から直接収集する
      const passivePoints: Array<{ siteIdx: number; index: number }> = []
      for (const si of nearConfirmedSitesRef.current) {
        if (!changed.some((c) => c.siteIdx === si)) {
          const idx = curr[si]
          if (idx !== undefined && idx >= ACTIVE_MIN_INDEX) {
            passivePoints.push({ siteIdx: si, index: idx })
          }
        }
      }
      for (const si of shindo0DisplaySitesRef.current) {
        const idx = curr[si]
        if (idx !== undefined && idx === SHINDO0_INDEX) {
          passivePoints.push({ siteIdx: si, index: idx })
        }
      }
      const allChanged = [...changed, ...passivePoints]
      const points: DetectedPoint[] = allChanged
        .filter((c) => allConfirmed.has(c.siteIdx))
        .map((c) => {
          const site = sites[c.siteIdx]
          if (!site) return null
          return { lat: site[0], lng: site[1], index: c.index }
        })
        .filter((p): p is DetectedPoint => p !== null)
        .sort((a, b) => b.index - a.index)
      const maxIndex = points[0]?.index ?? confirmedMaxIndex
      if (!prevDetectedRef.current) {
        log.debug(`[kyoshin] 検知開始 maxIndex=${maxIndex} 観測点数=${points.length} MIN_DETECTION_INDEX=${MIN_DETECTION_INDEX}`)
        prevDetectedRef.current = true
      }
      setDetection({ detected: true, maxIndex, points })
    }
  }, [sites, indices])

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    confirmedSitesRef.current.clear()
    nearConfirmedSitesRef.current.clear()
    shindo0DisplaySitesRef.current.clear()
  }, [])

  return { ...detection, candidatePoints, candidateId }
}
