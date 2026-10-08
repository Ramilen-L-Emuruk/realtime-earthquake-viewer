// 要約を作る別スレッドの中身。親（`waveSummaryWorkerRunner.ts`）から 1 件ずつ受け取って作り、結果を返す。
//
// **ここには処理を書かない。** 中身は `buildSummaryFile`（テストの届く場所）にあり、ここは受け渡しだけ ——
// 別スレッドの中はテストから直には動かせない。

import { parentPort } from 'node:worker_threads'

import { buildSummaryFile, type SummaryJob } from './waveSummaryFiles'

parentPort?.on('message', (msg: { readonly id: number; readonly job: SummaryJob }) => {
  // `buildSummaryFile` は投げない作りだが、**投げたら理由を付けて 1 件の失敗として返す** —— 受け止めないと
  // この別スレッドごと落ち、親の記録には「終了コード 1」しか残らない。
  void buildSummaryFile(msg.job)
    .catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }))
    .then((result) => parentPort?.postMessage({ id: msg.id, result }))
})
