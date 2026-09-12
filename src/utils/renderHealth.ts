// 地図の描画物が「描けているか・掴めているか」を集める。
//
// **なぜ要るか**: 地図のカスタムレイヤーが描けなくなっても、画面には何も出ない。
// たとえば震源カタログは、絞り込んだ件数を JS 側だけで数えて表示するため、
// **「275,554 件」と出したまま地図が真っ白**になりうる。利用者からは絞り込みの結果と
// 見分けがつかず、手掛かりは `console` にしか残らない。
//
// 取得の失敗（`fetchJson.ts` の取得状況）と同じ作りにしてある。あちらは「データが来たか」、
// こちらは「来たデータを描けたか」を見る。表示は `components/MapRenderStatus.tsx`。

/** 何ができていないか。 */
export type RenderFailureKind =
  /** 描けていない（レイヤーが 1 つも描画物を出せない）。 */
  | 'draw'
  /** 掴めない（クリック・ホバーの判定が働かない）。描画自体は出ている。 */
  | 'interact'

export interface RenderHealth {
  /** 描けていない描画物の表示名。登録順。 */
  broken: readonly string[]
  /** 掴めない描画物の表示名。登録順。 */
  uninteractive: readonly string[]
}

const EMPTY: RenderHealth = { broken: [], uninteractive: [] }

/**
 * 報告されている不調。キーはレイヤー ID と種別の組。
 *
 * **ID で畳むのは、同じレイヤーが繰り返し報告しても 1 件にするため。** 描画ループから
 * 毎フレーム呼ばれる経路があり、件数で持つと際限なく増える。
 *
 * **種別まで鍵に含めるのは、1 つのレイヤーが両方を報告しうるから。** 同じレイヤーが
 * 「描けない」と「掴めない」を別々に抱えることがあり、ID だけで持つと後から来た方が
 * 前を消す。しかも描けない側は毎フレーム報告するので、必ず掴めない側が消える。
 */
const failures = new Map<string, { label: string; kind: RenderFailureKind }>()

/**
 * 記録の鍵。ID だけだと 2 種類を同時に持てないので種別を足す。
 *
 * **種別を先に置く。** 種別は 2 語しか無く区切り文字を含まないため、ID に何が入っても
 * 別の組み合わせと衝突しない（後ろに置くと `a:b` と `draw` の組が別の ID と重なりうる）。
 */
function keyOf(id: string, kind: RenderFailureKind): string {
  return `${kind}:${id}`
}

const listeners = new Set<() => void>()
let snapshot: RenderHealth = EMPTY

/**
 * スナップショットを作り直す。**中身が変わらないなら前の参照をそのまま残す。**
 * `useSyncExternalStore` は参照で変化を見るため、毎回作ると描画のたびに再描画が走る。
 */
function publish(): void {
  const broken: string[] = []
  const uninteractive: string[] = []
  for (const { label, kind } of failures.values()) {
    const target = kind === 'draw' ? broken : uninteractive
    // **同じ名前は 1 度だけ。** 1 つの描画物が別々の理由で 2 件報告することがある
    //（レイヤー自身が気づいた不調と、`gl/guardRender.ts` が受け止めた例外は鍵を分けてある）。
    // 利用者に同じ名前を 2 つ並べても伝わる情報は増えない。
    if (!target.includes(label)) target.push(label)
  }
  const same =
    snapshot.broken.length === broken.length &&
    snapshot.uninteractive.length === uninteractive.length &&
    snapshot.broken.every((s, i) => s === broken[i]) &&
    snapshot.uninteractive.every((s, i) => s === uninteractive[i])
  if (same) return
  snapshot = broken.length === 0 && uninteractive.length === 0 ? EMPTY : { broken, uninteractive }
  for (const fn of listeners) fn()
}

/**
 * 描画物の不調を記録する。同じ ID で繰り返し呼んでよい（1 件に畳む）。
 *
 * @param id レイヤー ID。解除（{@link clearRenderFailure}）と対で使う。種別ごとに別の記録になる
 * @param label 利用者に見せる名前。**呼ぶ側が持つ**——ここに対応表を置くと、
 *   レイヤーを増やしたときに更新を忘れて ID がそのまま画面に出る
 * @param kind 描けていないのか、掴めないのか
 */
export function reportRenderFailure(id: string, label: string, kind: RenderFailureKind): void {
  const key = keyOf(id, kind)
  const prev = failures.get(key)
  if (prev && prev.label === label) return
  failures.set(key, { label, kind })
  publish()
}

/**
 * 不調の記録を消す。**直った場合と、そのレイヤーが画面から外れた場合の両方で呼ぶ。**
 * 外れたときに消さないと、二度と出てこない描画物の名前が居座る。
 *
 * **そのレイヤーに付けられた記録をまとめて消す。** `Map/gl/guardRender.ts` は受け止めた例外を
 * `<id>:uncaught` という別の鍵で記録する（レイヤー自身の申告と取り消し合わないようにするため）。
 * 鍵が違うぶん、**レイヤーを外すときに本人が消せない**——`render()` はもう呼ばれないので、
 * ガードの側にも消す機会が無い。ここでまとめて消すことで、レイヤーは自分の ID だけ知っていれば
 * 後始末を終えられる。
 */
export function clearRenderFailure(id: string, kind: RenderFailureKind): void {
  const self = keyOf(id, kind)
  // 区切りまで含めて見る。`hypocenter-depth` の後始末で `hypocenter-depth-2` を巻き込まない。
  const prefix = `${self}:`
  let changed = false
  for (const key of [...failures.keys()]) {
    if (key !== self && !key.startsWith(prefix)) continue
    failures.delete(key)
    changed = true
  }
  if (!changed) return
  publish()
}

export function subscribeRenderHealth(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function getRenderHealth(): RenderHealth {
  return snapshot
}

/** テスト用。記録を空に戻す。 */
export function resetRenderHealthForTest(): void {
  failures.clear()
  snapshot = EMPTY
  listeners.clear()
}
