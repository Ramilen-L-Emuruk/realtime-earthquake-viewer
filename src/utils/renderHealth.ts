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
 *
 * **レイヤー ID に `:` を入れないこと。** `Map/gl/guardRender.ts` が派生鍵を
 * `<ID>:uncaught` の形で作るため、{@link clearRenderFailuresFor} は `<ID>:` で始まる鍵を
 * 「その描画物の派生」として消す。ID 自体に `:` があると、`a` の後始末が別レイヤー `a:b` の
 * 記録まで巻き込む。現在の ID はすべて英小文字とハイフンだけで付けてある。
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
 * 自分が置いた不調の記録を取り下げる。**その ID・その種別の 1 件だけ。**
 *
 * 直ったとき・隠したときはこちらを使う。**`Map/gl/guardRender.ts` が別の鍵
 * （`<id>:uncaught`）で記録した例外は消さない。** あちらは「自分が報告したか」を
 * クロージャの中だけで覚えているので、外から消すと消されたことに気づけず、
 * **例外が続いていても二度と報告しなくなる**（画面は「描けている」と言い続ける）。
 *
 * 画面から外すときは {@link clearRenderFailuresFor} を使うこと。
 */
export function clearRenderFailure(id: string, kind: RenderFailureKind): void {
  if (!failures.delete(keyOf(id, kind))) return
  publish()
}

/**
 * その描画物に付いた記録を、種別も派生鍵もまとめて消す。**画面から外すときだけ使う。**
 *
 * `Map/gl/guardRender.ts` は受け止めた例外を `<id>:uncaught` という別の鍵で記録する
 * （レイヤー自身の申告と取り消し合わないようにするため）。鍵が違うぶん、**レイヤーを外すときに
 * 本人が消せない**——`render()` はもう呼ばれないので、ガードの側にも消す機会が無い。ここで
 * まとめて消すことで、レイヤーは自分の ID だけ知っていれば後始末を終えられる。
 *
 * **逆に、外していないのにこれを呼ぶと `guardRender` の未解決の報告まで消える。** 直った・
 * 隠した、という理由で取り下げるときは {@link clearRenderFailure} を使うこと。
 */
export function clearRenderFailuresFor(id: string): void {
  let changed = false
  for (const key of [...failures.keys()]) {
    // 鍵は `<種別>:<ID>`。種別に `:` は入らないので、最初の区切りで ID 側を切り出せる。
    const idPart = key.slice(key.indexOf(':') + 1)
    // 区切りまで含めて見る。`hypocenter-depth` の後始末で `hypocenter-depth-2` を巻き込まない。
    if (idPart !== id && !idPart.startsWith(`${id}:`)) continue
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
