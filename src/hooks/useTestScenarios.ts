import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { TestScenarioFile, TestScenarioIndex } from '../types/testScenario'
import type { ReplayEntry } from '../services/dmdataReplay'
import { instantiateScenario } from '../utils/testScenarioReplay'
import { serverDate } from '../utils/clock'
import { log } from '../utils/logger'
import { validateScenarioIndex, validateScenarioFile } from '../utils/testScenarioSchema'
import { fetchJsonWithTimeout } from '../utils/fetchJson'

const INDEX_URL = `${import.meta.env.BASE_URL}data/test-scenarios/index.json`
const scenarioUrl = (id: string): string => `${import.meta.env.BASE_URL}data/test-scenarios/${id}.json`

// シナリオ再生後、同じボタンを再度押せるようにするまでの安全マージン。
// EEW自動解除・津波解除タイマー等の後始末がシナリオ末尾から数分かかりうるため、
// durationMs だけでなくバッファを足す（詳細は testScenario.ts の durationMs の定義を参照）。
const REPLAY_REENABLE_BUFFER_MS = 5 * 60_000

export type ScenarioLoadState = 'loading' | 'loaded' | 'error'

export interface UseTestScenariosResult {
  loadState: ScenarioLoadState
  scenarios: TestScenarioIndex
  playingIds: ReadonlySet<string>
  errorIds: ReadonlySet<string>
  play: (id: string) => void
}

// 実地震テストのシナリオ一覧・再生を管理する。standard版・DMDSS版どちらでも同じ挙動。
export function useTestScenarios(
  loadReplayEvents: (entries: ReplayEntry[]) => void,
): UseTestScenariosResult {
  const [loadState, setLoadState] = useState<ScenarioLoadState>('loading')
  const [scenarios, setScenarios] = useState<TestScenarioIndex>([])
  const [playingIds, setPlayingIds] = useState<ReadonlySet<string>>(new Set())
  const [errorIds, setErrorIds] = useState<ReadonlySet<string>>(new Set())
  const scenarioCacheRef = useRef(new Map<string, TestScenarioFile>())
  const reenableTimersRef = useRef(new Map<string, number>())
  // fetch中の多重呼び出しガード。playingIds はfetch完了後(runScenario内)にしかセットされないため、
  // 未キャッシュのシナリオを連打した際にfetchが複数走るのを防ぐ。
  const fetchingIdsRef = useRef(new Set<string>())

  useEffect(() => {
    let cancelled = false
    // 実地震テストは設定タブの機能で、失敗しても地図は変わらない（一覧側に専用の表示がある）。
    // 地図に重ねる取得状況表示には数えない。
    fetchJsonWithTimeout<unknown>(INDEX_URL, 'test-scenarios index', { trackStatus: false })
      .then(raw => {
        if (cancelled) return
        // 破損 JSON でも UI をクラッシュさせないため配列全体を捨てず、要素単位で通ったものだけ採用する。
        // malformed=true は「トップレベルが配列ですらない」深刻な破損。UI 上は「シナリオがありません」
        // という空リスト表示になり正常な空リストと区別できないため、少なくともコンソールには
        // 「破損」と明示的にログ出しして開発者・QA が原因を特定できるようにする。
        const { valid, skipped, malformed } = validateScenarioIndex(raw)
        if (malformed) log.error('[testScenarios] index.json のトップレベルが配列ではない（配信破損）')
        else if (skipped > 0) log.warn(`[testScenarios] index.json の破損エントリ ${skipped} 件をスキップ`)
        setScenarios(valid)
        setLoadState(malformed ? 'error' : 'loaded')
      })
      .catch(err => {
        if (cancelled) return
        log.error('[testScenarios] シナリオ一覧の取得に失敗', err)
        setLoadState('error')
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const timers = reenableTimersRef.current
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer)
    }
  }, [])

  const play = useCallback((id: string) => {
    if (fetchingIdsRef.current.has(id)) return

    const runScenario = (scenario: TestScenarioFile) => {
      loadReplayEvents(instantiateScenario(scenario, serverDate()))
      setPlayingIds(prev => new Set(prev).add(id))
      const prevTimer = reenableTimersRef.current.get(id)
      if (prevTimer !== undefined) window.clearTimeout(prevTimer)
      const timer = window.setTimeout(() => {
        reenableTimersRef.current.delete(id)
        setPlayingIds(prev => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }, scenario.durationMs + REPLAY_REENABLE_BUFFER_MS)
      reenableTimersRef.current.set(id, timer)
    }

    const cached = scenarioCacheRef.current.get(id)
    if (cached) { runScenario(cached); return }

    fetchingIdsRef.current.add(id)
    // 再生失敗は再生ボタン側（errorIds）に出るため、地図に重ねる取得状況表示には数えない。
    fetchJsonWithTimeout<unknown>(scenarioUrl(id), `scenario:${id}`, { trackStatus: false })
      .then(raw => {
        // 破損 JSON をそのまま instantiateScenario に渡すと実行時に落ちるため、
        // ここで型検証して壊れているならエラー扱いにする（instantiateScenario は valid 前提）。
        const scenario = validateScenarioFile(raw)
        if (!scenario) {
          log.error(`[testScenarios] シナリオファイルの型検証失敗 id=${id}`)
          setErrorIds(prev => new Set(prev).add(id))
          return
        }
        scenarioCacheRef.current.set(id, scenario)
        setErrorIds(prev => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        runScenario(scenario)
      })
      .catch(err => {
        log.error(`[testScenarios] シナリオ取得に失敗 id=${id}`, err)
        setErrorIds(prev => new Set(prev).add(id))
      })
      .finally(() => { fetchingIdsRef.current.delete(id) })
  }, [loadReplayEvents])

  // 戻り値をメモ化する。呼び出し元（SettingsTab）が React.memo でラップされており、
  // 毎レンダー新オブジェクトを返すと props の shallow compare で常に不一致となり
  // memo が破られるため、内部で参照する各値が変わったときだけ新オブジェクトを返す。
  return useMemo(
    () => ({ loadState, scenarios, playingIds, errorIds, play }),
    [loadState, scenarios, playingIds, errorIds, play],
  )
}
