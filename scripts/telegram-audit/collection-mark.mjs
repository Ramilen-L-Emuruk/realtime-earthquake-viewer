// 実電文サンプルの収集が完遂したかどうかを、**ディレクトリの外へ置いた札**で伝える。
//
// **なぜ札が要るか。** 収集（`fetch-samples.mjs` / `fetch-rare-samples.mjs`）の成果物は
// `telegram-cache/` に並ぶ XML と二進のファイルそのもので、JSON ではない。**ファイルの山へは
// 印を載せられない**ので、収集が途中で失敗しても下流（計測台・`triage.mjs`・
// `testdata-shapes.mjs`・`header-survey.mjs`）には「その種別のサンプルが 0 件」としか見えない。
// これは CLAUDE.md「調査レビュー」が挙げている 2026-09-11 の事故と同じ形
// —— 走査した範囲を示せないまま「無い」と結論してしまう。
//
// **成功したときも必ず書く。** 札が無いことを「完全」と読まないための決まりで、
// 読む側（`readArtifact`）は札が無ければ「不明」として印を積む。手元に古い
// `telegram-cache/` が残っているだけの状態が、黙って「完全に集めた」に化けるのを防ぐ。
//
// **札は「1 回の収集」ごとに分ける。** 1 枚を共有すると、取りこぼした収集の直後に別の収集を
// 成功させただけで印が消える。分ける単位はスクリプトだけでなく**同じスクリプトの実行対象まで**
// —— `fetch-rare-samples.mjs` は `eew` / `ixac41` / `type:VXSE60` と対象を変えて複数回走らせる
// 設計なので、対象で分けないと最後に走らせた 1 回の成否しか残らない。
import fs from 'node:fs'
import path from 'node:path'
import { readArtifact, noteIncomplete } from '../lib/incompleteness.mjs'

/** ファイル名に使える形へ落とす（対象名には `:` や `,` が入る）。 */
function safeName(target) {
  return String(target).replace(/[^0-9A-Za-z]+/g, '-').replace(/^-|-$/g, '') || 'default'
}

const RARE_PREFIX = '_collection-rare-samples-'

/** サンプル収集（`fetch-samples.mjs`）の札。**下流は必ずこれを読む。** */
export function sampleCollectionMarkPath(cacheDir) {
  return path.join(cacheDir, '_collection-samples.json')
}

/**
 * 稀な種別の収集（`fetch-rare-samples.mjs`）の札。**名指しで足すときだけ実行する**ので任意。
 *
 * @param target 実行対象（`eew` / `ixac41` / `type:VXSE60`）。**対象ごとに別のファイルにする**
 */
export function rareSampleCollectionMarkPath(cacheDir, target) {
  return path.join(cacheDir, `${RARE_PREFIX}${safeName(target)}.json`)
}

/**
 * 札を消す。**走査を始める前に呼ぶ。**
 *
 * 置きっぱなしにすると、今回の収集が途中で落ちたとき**前回成功したときの札が「最新の
 * 完了報告」として残る**。今回の実行で `telegram-cache/` の中身は変わっているかもしれないのに、
 * 下流は古い「完全に集めた」を読むことになる。先に消しておけば、落ちたときは札が無い
 * ＝「不明」へ倒れる。
 */
export function clearCollectionMark(markPath) {
  try {
    fs.rmSync(markPath, { force: true })
  } catch (e) {
    // **消せなかったことを印として積む。** 標準エラーへ出すだけでは、この仕組みが排除したはずの
    // 「見えないところで失敗する」形へ戻る。完走すれば札は上書きされるので印もその札に載るが、
    // **消せないまま走査が落ちると、古い札が「今回も完了した」として読まれる** ——
    // 1 巡目に潰したはずの症状そのものなので、起きうることを残す。
    // Windows ではウイルス対策や同期ソフトのファイルロックで現実に起こりうる。
    noteIncomplete(
      '実電文サンプルの収集（札の初期化）',
      `${path.basename(markPath)} を消せませんでした。この走査が途中で落ちた場合、前回の札が残ります: ${e?.message ?? e}`,
    )
    console.error(`  古い札を消せませんでした（${path.basename(markPath)}）: ${e?.message ?? e}`)
  }
}

/** 置いてある「稀な種別」の札を全部返す。 */
function rareMarkPaths(cacheDir) {
  try {
    return fs.readdirSync(cacheDir)
      .filter(f => f.startsWith(RARE_PREFIX) && f.endsWith('.json'))
      .sort()
      .map(f => path.join(cacheDir, f))
  } catch (e) {
    // **「ディレクトリが無い」だけを黙って通す。** それは「まだ収集していない」で、
    // 必須の札の側が「入力がありません」として伝える。それ以外（権限・一時的な I/O 障害）は
    // **札が実在するのに読めなかった**ということなので、印を積む —— こちらは任意の入力なので、
    // 黙ると取りこぼしが何の痕跡も残さずに消える。
    if (e?.code !== 'ENOENT') {
      noteIncomplete('稀な種別の収集', `札を探せませんでした（${cacheDir}）: ${e?.message ?? e}`)
    }
    return []
  }
}

/**
 * `telegram-cache/` を入力に使う側が呼ぶ。札を読んで、収集の取りこぼしを自分の台帳へ引き継ぐ。
 *
 * **`fetch-samples.mjs` の札は必須、`fetch-rare-samples.mjs` の札は任意。** 前者は収集の本体で
 * 必ず一度は走るが、後者は「既定の収集では集まらない種別を名指しで足す」補助なので、
 * 無いことが普通の状態。任意の側まで必須にすると、正常な手順で毎回警告が出る。
 *
 * **稀な種別の札は、置いてあるものを全部読む。** どの対象を走らせたかは実行した人しか
 * 知らないので、こちらからは列挙できない。
 */
export function absorbSampleCollectionMarks(cacheDir) {
  readArtifact(sampleCollectionMarkPath(cacheDir), { source: '実電文サンプルの収集' })
  for (const p of rareMarkPaths(cacheDir)) {
    const target = path.basename(p, '.json').slice(RARE_PREFIX.length)
    readArtifact(p, { source: `稀な種別の収集（${target}）`, optional: true })
  }
}
