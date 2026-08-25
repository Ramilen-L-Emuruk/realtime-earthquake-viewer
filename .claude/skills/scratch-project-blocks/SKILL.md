---
name: scratch-project-blocks
description: Scratch で作られたプロジェクトの中身（ブロック定義＝アルゴリズム）を読むときに使う。公開プロジェクトの URL または ID から project.json を取得し、スプライト・Stage ごとのスクリプトを疑似コードへ展開する手順。他実装の調査・仕様の突き合わせに使う。
---

# Scratch プロジェクトのブロック群を読む

Scratch 3.0 のプロジェクトは、**全ブロック定義が `project.json` という単一ファイルに入っている**。
公開プロジェクトなら URL から辿って読める。

このリポジトリと同種のもの（Scratch 上に作られた地震ビューアー等）を調べる用途を想定している。

## 使うとき

- 他実装がある挙動をどう処理しているかを確かめたいとき
- Scratch 製プロジェクトの構成・データの持ち方を把握したいとき

## 前提

- **Node.js を使う。** この環境の `bash` に `jq` は無く、PowerShell 5.1 の `ConvertFrom-Json` は
  キーの大文字小文字を区別せず `DuplicateKeysInJsonString` で落ちる。Scratch のブロック ID は
  `bRa` と `bRA` のような組が併存するため、大きなプロジェクトではまず確実に踏む
  （下記「実測例」のプロジェクトでは 9,679 組）
- **取得物はスクラップパッドへ置く。** 規模の大きいプロジェクトの `project.json` は数 MB になる
  （同 5.2 MB）。リポジトリ内に置かない
- **ターゲット（target）＝スプライトと Stage。** Scratch の内部では両者が同じ構造で並び、
  それぞれが自分のブロック・変数・リストを持つ

## 手順

同ディレクトリの [`scratch-blocks.mjs`](scratch-blocks.mjs) に一連の操作を入れてある。
リポジトリのトップレベルから、出力先をスクラップパッドに指定して呼ぶ。

```bash
S=.claude/skills/scratch-project-blocks/scratch-blocks.mjs
node $S fetch 636244032 "$SCRATCHPAD/project.json"   # ID → トークン → project.json
node $S meta  636244032                              # 作者の説明文（project.json には入らない）
node $S targets "$SCRATCHPAD/project.json"           # ターゲット一覧（当たりを付ける）
node $S names   "$SCRATCHPAD/project.json" '震度'    # 変数名・リスト名・コメントを検索
node $S grep    "$SCRATCHPAD/project.json" '震度速報' # ブロック 1 個単位で検索
node $S dump    "$SCRATCHPAD/project.json" '受信と検出' --filter 'listcontainsitem'
```

`fetch` と `meta` にはプロジェクトページの URL をそのまま渡してもよい（末尾の数字を ID として読む）。

`$SCRATCHPAD` はセッションのスクラップパッドのパスに読み替える（環境変数として用意されてはいない）。
**`cd` はコマンドの先頭に含めること** —— この環境の `bash` は呼び出しごとに作業ディレクトリが
リポジトリのトップレベルへ戻るため、ワークツリー内で使うなら毎回 `cd` から書く。

### 取得の中身（手動で辿る場合）

1. **プロジェクト ID** — ページ URL の末尾の数字（`https://scratch.mit.edu/projects/636244032` → `636244032`）
2. **トークン** — `https://api.scratch.mit.edu/projects/<ID>` の `project_token`
3. **本体** — `https://projects.scratch.mit.edu/<ID>?token=<project_token>`

**トークンは発行から数分で失効する。** 2 と 3 は続けて実行する（`fetch` は 1 回の呼び出しで両方やる）。
`project_token` が返らない場合は非公開・削除済み・ID 誤りのいずれか。

手順 2 のレスポンスには `title` / `instructions` / `history.modified` も入っている（`project.json` の
方には入らない）。**`instructions` は作者が書く説明文で、機能一覧・データの取得元・バージョン履歴が
載っていることが多い。** ブロックを読む前に `meta` で読むと、どのスプライトを見るべきかの見当が付く。

## 読み進め方

**全ブロックを順に読むのは非現実的。** 下記「実測例」のプロジェクトは全体 23,933 ブロック・
1 スプライト最大 8,755 ブロックだった。

1. `targets` でブロック数を見る。処理の本体は数の多いスプライトにある
2. `names` で変数名・リスト名・**コメント**を当たる。Scratch のコメントはブロックとは別に
   `targets[].comments` に入っていて、作者が節の見出しとして使っていることが多い
3. `grep` で目的の処理を含むブロックを特定する
4. `dump ... --filter` でそのブロックを含むスクリプトだけを展開する

### ブロックの構造（`dump` が何を出しているか）

- 各行の頭にある `data_setvariableto` のような識別子が **`opcode`（ブロックの種類）**。
  接頭辞でおおよその分類が付く（`data_` リスト・変数／`control_` 制御／`operator_` 演算／`looks_` 見た目）
- スクリプトは `topLevel: true` のブロックを起点に `next` で数珠つなぎ
- 引数は `inputs`（他ブロックを差せる穴）と `fields`（選択肢・変数名）
- `SUBSTACK` / `SUBSTACK2` が `if` や `repeat` の中身。`dump` は `SUBSTACK:` の見出し行を挟み、
  その下をさらに 1 段字下げして出す
- カスタムブロックは opcode が `procedures_call` / `procedures_definition` で共通のため、
  **名前は `mutation.proccode`** に入っている。`dump` は呼び出しを
  `call 読み上げ "震度速報" 追加 ""`、定義を `define 読み上げ %s 追加 %s` の形に組み直す
- 式の中で変数・リストを参照している箇所は **`var:名前` / `list:名前`** と出る
  （Scratch は変数・リストをブロックとして持たず、引数の中へ直接埋め込むため）
- リストの読み出しは `data_itemoflist LIST="..." INDEX=...`。**Scratch には配列としてリストしか
  無いため、1 件 N 要素の固定長で詰める使い方がよくある**（`INDEX=(カウント×N+1)` のような式が目印）
- `topLevel` には「どこにも繋がっていない浮いたブロック」も含まれる。`dump` はそれも 1 件として出す
- `<欠落 id>` / `<循環検出 id>` / `<深すぎ opcode>` は、参照先が無い・ブロックが輪になっている・
  入れ子が異常に深い、のいずれかで出る**異常時の目印**。正常な project.json では出ない

## 実測例

`636244032`（「リアルタイム地震ビューアー」・Scratch 版・DMDATA.JP から受信）:

| ターゲット | ブロック数 | 役割（コメントより） |
|---|---|---|
| 受信と検出 | 8,755 | 受信・揺れ検知・EEW・地震情報・読み上げ制御 |
| UI | 7,846 | パネル描画 |
| 地図 | 5,610 | 背景地図・観測点・EEW 円のスタンプ |
| 効果音&読み上げ | 1,594 | 音と TTS |
| Stage | 110 | 変数 59・リスト 148（データの置き場） |
| オーバーレイ | 18 | 最前面の描画 |

**このプロジェクトは DMDATA を直接叩いておらず、外部サーバが整形した結果をクラウド変数で受け取る。**
そのため電文の解釈そのものはブロックからは読めない（Scratch 側にあるのは受け取った後の処理）。
他実装の「電文の扱い」を調べる目的では、この境界を踏まえること。
