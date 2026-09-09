import { fetchJsonWithTimeout } from './fetchJson'
import { log } from './logger'

/**
 * 生成された読み上げ辞書（震度観測点名の読み・震央地名の句割り）の共通のローダー。
 *
 * どちらも「気象庁のふりがなから作った生成物を、手で書いた句区切り辞書と合わせて使う」という
 * 同じ形をしているので、取得・検分・キャッシュはここへ寄せる。個々の入口は
 * `ttsStationReadings.ts` / `ttsEpicenterAccents.ts`。
 */

/**
 * 生成辞書のタイムアウト（ミリ秒）。句区切り辞書（`DICT_FETCH_TIMEOUT_MS`）と同じ値にする。
 *
 * 読み上げ本体がこれらの取得を並行して待つため、片方だけ長くしても意味がない。取れなくても
 * 読み上げ自体は成立する（誤読や抑揚が直らないだけ）なので、短く見切る。
 */
export const GENERATED_DICT_FETCH_TIMEOUT_MS = 5_000

export type GeneratedDictLoader = {
  /** 取得する（初回のみ fetch し、以降はキャッシュを返す）。 */
  load: () => Promise<Record<string, string>>
  /** 読み込み済みのキャッシュを返す（未読み込みなら null）。 */
  getCache: () => Record<string, string> | null
}

/**
 * 生成辞書のローダーを作る。
 *
 * @param fileName `public/data/` 配下のファイル名
 * @param statusName 取得状況の記録に使う名前
 * @param label ログに出す日本語の呼び名（「観測点の読み」等）
 */
export function createGeneratedDictLoader(
  fileName: string,
  statusName: string,
  label: string,
): GeneratedDictLoader {
  const url = `${import.meta.env.BASE_URL}data/${fileName}`
  let cache: Record<string, string> | null = null
  let inflight: Promise<Record<string, string>> | null = null

  const load = (): Promise<Record<string, string>> => {
    if (cache) return Promise.resolve(cache)
    if (!inflight) {
      inflight = fetchJsonWithTimeout<Record<string, string>>(
        url,
        statusName,
        // 取れなくても読み上げの読み・抑揚が効かないだけで地図は変わらないため、
        // 地図に重ねる取得状況表示には数えない（句区切り辞書と同じ扱い）。
        {
          timeoutMs: GENERATED_DICT_FETCH_TIMEOUT_MS,
          trackStatus: false,
          // 200 でも中身が空・別物なら失敗として扱う。取得の中で検分しないと、
          // 「取れた」ことになってから気づく形になり、記録に残らない。
          validate: (data) => {
            if (data == null || typeof data !== 'object' || Array.isArray(data)) {
              throw new Error(`${label}が JSON オブジェクトではありません`)
            }
            const entries = Object.entries(data as Record<string, unknown>)
              .filter(([key]) => !key.startsWith('_'))
            if (entries.length === 0) throw new Error(`${label}が 1 件も入っていません`)
            const bad = entries.find(([, value]) => typeof value !== 'string' || value === '')
            if (bad) throw new Error(`${label}の値が文字列ではありません: ${bad[0]}`)
            // 空のキーは弾く。`findPhraseBreakMatch` の `text.indexOf('')` は常に 0 を返すので、
            // 混ざるとどのチャンクにも先頭で一致し、読み上げの頭に無関係な読みが差し込まれる。
            if (entries.some(([key]) => key === '')) {
              throw new Error(`${label}に空のキーがあります`)
            }
          },
        },
      )
        .then((data) => {
          // `_comment` のような注記のキーは辞書から外す（キーは地名だけ）。
          const dict: Record<string, string> = {}
          for (const [key, value] of Object.entries(data)) {
            if (!key.startsWith('_')) dict[key] = value
          }
          cache = dict
          log.debug(`[tts] ${label}を ${Object.keys(dict).length} 件読み込んだ`)
          return cache
        })
        .catch((err) => {
          inflight = null
          throw err
        })
    }
    return inflight
  }

  return { load, getCache: () => cache }
}

/**
 * 手で書いた句区切り辞書と、生成された辞書を 1 つへ合わせる。どれも無ければ null。
 *
 * **キーが完全に一致したときは句区切り辞書（`base`）が勝つ。** あちらは人がアクセント核と句区切りの
 * 位置まで指定したもので、生成物は機械的に決めた形（観測点名は末尾に核、震央地名は前部／後部の境界で
 * 割って各句末に核）。聞いて直したくなったら句区切り辞書へ同じキーを足せば勝てる、という関係にする。
 *
 * **ここで決まるのは完全一致のときだけ。** 合成した後は 1 つの辞書として扱われ、読み上げ文の中では
 * `findPhraseBreakMatch` が「最初に現れる位置のもの・同じ位置なら長い方」で選ぶ。だから
 * `西表島`（手書き）と `西表島付近`（生成物）のように**片方が他方の一部になっている組では、
 * 辞書の別を問わず長い側が勝つ**。これは意図した挙動 —— 短い側だけを当てると名前の残りが別に
 * 読まれてしまう（`久米島町山城` に `久米島` を当てると「町山城」が離れる）。人が短いキーの読みを
 * 優先させたいなら、長い側と同じキーを句区切り辞書へ書くこと。
 *
 * 生成辞書どうしはキーが衝突しない（観測点名と震央地名は別の名前空間）。**万一衝突したら後ろの
 * 辞書が勝つ**が、それを当てにした運用はしないこと。
 */
export function mergeSpeechDicts(
  base: Record<string, string> | null,
  ...generated: readonly (Record<string, string> | null)[]
): Record<string, string> | null {
  const present = generated.filter((d): d is Record<string, string> => d != null)
  if (present.length === 0) return base
  if (!base && present.length === 1) return present[0]
  return Object.assign({}, ...present, base ?? {})
}
