// 要約を作る別スレッドの中身。親（`waveSummaryWorkerRunner.ts`）から 1 件ずつ受け取って作り、結果を返す。
//
// **ここには処理を書かない。** 中身は `buildSummaryFile`（テストの届く場所）にあり、ここは受け渡しだけ ——
// 別スレッドの中はテストから直には動かせない。

import { parentPort } from 'node:worker_threads'

import { buildSummaryFile, type SummaryJob } from './waveSummaryFiles'

parentPort?.on('message', (msg: { readonly id: number; readonly job: SummaryJob }) => {
  void buildSummaryFile(msg.job).then((result) => parentPort?.postMessage({ id: msg.id, result }))
})
