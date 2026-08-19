# 音声・TTS 仕様書

> 本書は**現在の実装が通知音・読み上げ・ウィンドウタイトルをどう扱うか**をまとめた仕様書。
> 実コードと食い違う場合は実コードを正とする。

## 1. 概要

情報受信時にユーザーへ通知する 3 系統の副作用を扱う:

- **通知音**（`alertSound`）: Web Audio API で合成した種別別のアラート音
- **VOICEVOX 読み上げ**（`voicevox`）: ローカル VOICEVOX HTTP API 経由の音声合成（任意）
- **ウィンドウタイトル**（`useAlertTitle`）: ブラウザタブ / ウィンドウのタイトル書き換え（AutoHotKey 等の外部監視向け）

さらに以下も関連する:
- ブラウザ通知（`Notification` API）
- 自動タブ切替
- 自動カメラフィット

すべての発火は `src/hooks/useLiveEventHandler.ts` で一元的にディスパッチする。

## 2. 通知音（`alertSound`）

`src/utils/alertSound.ts`。Web Audio API の `OscillatorNode` + `GainNode` + `BiquadFilterNode` で
種別ごとの音を合成する。事前録音ファイルは持たない。

### 音の種類

| 種別 | 用途 | 概要 |
|---|---|---|
| `eewSpecial` | EEW 特別警報 | 低音スイープ + 9 連打アラーム + ドローン（約 1.7s） |
| `eew` | EEW 警報 | 連打アラーム（短め） |
| `eewForecast` | EEW 予報 | 控えめなピンポン |
| `eewUpdate` | EEW 続報 | 短いピッチアップ |
| `eewFinal` | EEW 最終報（自動解除の直前は使わず、真の最終報用） | ダークピアノ F4→C4 の穏やかな 2 音 |
| `eewCancel` | EEW 誤報取消 | 下降スイープ |
| `tsunamiMajor` | 大津波警報 | 5 回のダブルスイープ（約 3.85s） |
| `tsunami` | 津波警報 | 連続スイープ |
| `tsunamiWatch` | 津波注意報 | 短めのスイープ |
| `tsunamiForecast` | 津波予報（若干の海面変動） | 単音のチャイム |
| `tsunamiUpdate` | 津波観測情報の更新 | 小音量のティン音 |
| `tsunamiCancel` | 津波の解除・取消・期限切れ（cancelReason の 3 種は音では区別せず単一音で伝える） | 降下 3 音（700Hz→520Hz→380Hz） |
| `earthquake` | 地震情報（震源・震度 / 各地の震度） | ピアノ上昇 4 音 E4→G#4→B4→E5 |
| `earthquakePrompt` | 地震情報（震度速報） | ピアノ上昇 3 音 G#4→B4→E5 |
| `earthquakeInfo` | 地震情報（震源情報・遠地地震・その他） | ピアノ 2 音 G4→B4（控えめ） |
| `kyoshin` | 揺れ検知（confirmed） | 打撃 2 音 + シマー高周波 |
| `kyoshinCandidate` | 揺れの候補（faint / likely） | 控えめな単発チャイム |
| `specialInfo` | 南海トラフ臨時情報・後発地震注意情報 | ピアノ A4×2 連打 → D5 |

### 発火 API

```ts
playAlertSound(type: AlertSoundType)
```

内部で `AudioContext` の取得・resume を行う。`getCtx()` はシングルトンで、モジュール変数
`_reverb`（`ConvolverNode`）と一緒に使い回される。

### 音量制御

- `globalVolume`（0.0〜1.0）を `setGlobalVolume(v)` で更新
- 各種別内の相対バランスは `PLAYERS[type]` 内でハードコード

### マスターチェーンとリミッター

`alertSound` の全音源と `voicevox` の TTS 発話は、個々の `.connect(ctx.destination)` ではなく
`getMasterInput(ctx)`（`alertSound.ts` から export）を経由し、
`GainNode → DynamicsCompressorNode → ctx.destination` の順で流れる。特別警報級 EEW
（`eewSpecial`）と大津波警報（`tsunamiMajor`）が同時発火した場合、または TTS 継続中に
警報音が重なった場合、素の加算合成では波形がクリップして警報音がノイズに埋もれるため、
compressor で合成音圧の暴走をリミッター的に抑える。単独再生時は threshold 以下なので
音色に実質影響しない。パラメータは threshold=-6dB / knee=6 / ratio=4 / attack=3ms /
release=250ms（音楽制作のリミッター標準的な値）。

### 既知の課題

- 優先度キュー（低優先度の音を高優先度中に抑制するシリアライズ）と重複再生の抑止（dedup）は
  未実装。マスターチェーンの compressor で合成音圧の暴走は防いでいるが、UX として「特別警報中は
  他の音を鳴らさない」「同一種別の呼び出しを短時間ガードする」等の能動的な制御は行っていない。
  dedup を種別単位で入れると、群発地震で連続する別イベントの警報音を誤って抑止してしまう
  リスクがあるため、実装するなら eventId 単位のキーで慎重に設計する必要がある
- `AudioContext.resume()` の Promise を await せずに `currentTime + 0.02` をスケジュール（iOS Safari で初回音がドロップしうる）
- `eewSpecial` の内部ゲイン合計が 1.0 を超え、単独でもクリップしうる（compressor で緩和される）

## 3. VOICEVOX 読み上げ（`voicevox`）

**VOICEVOX** は無料で配布されている音声合成ソフトウェア（[voicevox.hiroshiba.jp](https://voicevox.hiroshiba.jp/)）。
ユーザーが自分の PC 上で起動しておくと、その HTTP API に対してテキスト → 音声合成をリクエストできる。
本アプリは任意機能として組み込んでおり、VOICEVOX を起動していない場合は無音で失敗する。

`src/utils/voicevox.ts`。VOICEVOX ローカル HTTP API（デフォルト `http://localhost:50021`）を呼び出して
音声合成する。任意機能で、有効化はユーザー設定 `voicevoxEnabled` による。

### API 呼び出し

- `POST /audio_query` — テキストからアクセント句を生成
- `POST /synthesis` — アクセント句から WAV を合成
- `POST /accent_phrases` — 句区切り辞書のカナ表記からアクセント句を作る（下記「辞書」節で使う）

合成 WAV は `AudioContext.decodeAudioData` でデコードして `AudioBufferSourceNode` で再生する。

### セッション管理

- モジュール変数 `activeSources: AudioBufferSourceNode[]` と `currentSessionId: number`
- `speakWithVoicevox(text)` を呼ぶたびに既存の再生を全 stop() し、`currentSessionId++` で新セッションに切替
- 同時に旧セッションの `AbortController` を abort し、進行中の合成リクエスト
  （`/audio_query`・`/synthesis`・`/accent_phrases`）も打ち切る。セッション ID だけでは
  in-flight のリクエストが完走して VOICEVOX の処理を占有し、新しい発話が待たされるため
- **単一グローバルセッション**なので、EEW / 地震 / 津波 / LPGM の全読み上げがこの単一セッションを共有する

### 辞書（読み仮名の補正）

`src/utils/ttsPhraseBreakDict.ts` + `public/data/tts-phrase-break-dict.json` に地名・専門用語の
読み仮名エントリを持ち、`findPhraseBreakMatch` で該当箇所のアクセント句をキャッシュ済みのものと差し替える。

辞書はアプリ起動時に先読みする。読み上げ開始時にまだ取得できていなければ待つが、その待ちは
**5 秒**で打ち切る。生成データ共通の取得タイムアウト（[`data-sources-spec.md`](data-sources-spec.md) §6）
より大幅に短くしているのは、ここでの待ち時間がそのまま緊急地震速報の読み上げの遅れになるため。
辞書が無くても句区切りが効かないだけで読み上げ自体は成立する。

### 話速

現状 `synthesizeChunk` 内で `query.speedScale = 1.2` を無条件に上書き（ユーザー設定なし）。

### 既知の課題

- 全種別が単一セッションを共有するため、無関係な津波観測更新が EEW 警報読み上げを打ち切りうる
- 通常チャンクの音声合成に一切キャッシュがない（定型句「緊急地震速報。」等も毎回合成）
- 音声合成そのものの失敗パス（`synthesizeChunk` の `catch`）にログがなく原因追跡ができない
  （辞書取得の失敗は `log.debug` に残る）

## 4. 読み上げテキスト生成（`ttsText`）

`src/utils/ttsText.ts`。イベント種別に応じた読み上げ文を生成する。

### 主要関数

- `eewAlertToText(eew)` — EEW 全体の読み上げ（新規発報用）
- `eewIntensityToText(eew)` — 震度・区域だけを短く読み上げ
- `earthquakeToText(quake, opts, isNew)` — 地震情報（`isNew:false` で更新報の言い回しになる）
- `tsunamiToText(tsunami)` / `tsunamiCancelToText(cancelReason)` — 津波
- `lpgmToText(...)` — 長周期地震動
- `nankaiToText(...)` / `kohatsuToText(...)` — 南海トラフ・後発地震

### 特殊な扱い

- **仮定震源要素**: EEW の予想震度を「単独点処理のため、予想震度なし。」と読み、長周期階級は句ごと
  省く。単独点処理では地域別予想が発表されないため、`eewMaxScale` / `eewMaxLpgmClass` がともに 0 を
  返すことによる。この言い回しが付くのは `eewIntensityToText`（第2フェーズ）のみで、`eewToText` は
  震度句を省くだけ。なお M・深さを隠すのはカード表示・地図マーカー側の扱いで、EEW の読み上げは
  元から M・深さに触れない（[eew-spec.md](eew-spec.md) §5）
- **震源深さ不明**: 深さ不明（負値）では**深さ句ごと省く**。`0` のみ「ごく浅い場所」と読む
- **マグニチュード不明**: 規模不明（`NaN`＝DMDATA 経路／負値＝P2PQuake 経路）ではマグニチュード句ごと省く
- 深さ・マグニチュードの判定は `formatters.ts` の共有関数 `hasDepth` / `hasMagnitude` で行う。カード表示
  （`formatDepth` / `formatMagnitude`）・色付け（`getDepthColor` / `getMagnitudeColor`）も同じ関数を使うため、
  カードが「不明」と出すものを読み上げが「ごく浅い」「M0.0」と言うような食い違いは起きない
- **地域列挙の助詞**: 階級ごとに地域を並べるとき、場所の助詞「で」は文末（述語の直前）にのみ置く。
  句ごとに付けると一文字の助詞が読点に挟まれ、読み上げが途切れて聞こえる（震度・長周期地震動階級で共通）
- **遠地地震**: 「遠地地震に関する情報。」と名乗り、**日付から読み上げる**（発表が発生の数十分後になり日付をまたぐため）。
  津波の一文は電文の付加文原文（`JMAQuake.forecastText`）を優先し、無い経路では津波区分から起こす
  （付加文コードの詳細は [quake-spec.md](quake-spec.md) §3）

### 地域列挙の範囲

どの階級まで・各階級で何地域まで読むかは、設定タブの 4 項目で決まる
（項目名と既定値は [settings-pwa-spec.md](settings-pwa-spec.md) §2「主な項目の補足」）。
実装では `ttsText.ts` の `TtsRegionOptions`（`intensityLevels` / `alwaysReadScale` /
`maxRegions` / `regionTolerance`）としてこの 4 項目を受け取る。

- 読む階級は「階数の範囲内」**または**「必ず読み上げる震度以上」を満たすもの
- 階数は**最大震度に加えて何階級下まで読むか**。`0` なら最大震度のみ、既定の `2` なら最大を含めて計 3 階級
- 階数で数えるのは**観測がある階級だけ**。観測 0 地域の階級は飛ばして次を数える
  （例: 階数 1 で 5 強・5 弱の観測が無ければ、6 弱 の次に読むのは 震度 4）。長周期地震動階級も同じ数え方
- 1 階級あたりの地域名は上限まで読む。ただし上限をわずかに超えるだけなら（許容超過の範囲内）省略せず
  全地域を読む。超えた場合は上限ちょうどで切り「ほか N 地域」と件数で伝える
- 上位の階級で読んだ地域名は、下位の階級では繰り返さない
- 「必ず読み上げる震度」は震度にのみ効く。長周期地震動階級（1〜4）は震度と別軸のため対象外

## 5. ウィンドウタイトル（`useAlertTitle`）

`src/hooks/useAlertTitle.ts`。情報更新時にブラウザタブ / ウィンドウのタイトルを書き換える。
AutoHotKey 等の外部監視ツールから状態を検知できる。

### タイトル表

| 状態 | タイトル |
|---|---|
| 平常時 | `リアルタイム地震ビューアー` |
| 地震情報受信 | `🔴 地震情報 <震源> 最大震度<N>` |
| 遠地地震受信 | `🔴 遠地地震 <震源> M<規模>`（国内震度がないため震度は出さない。規模不明なら省略） |
| EEW 発報 | `🚨 緊急地震速報 <震源> 最大震度<N>予想` |
| 津波情報発表 | `🌊 津波情報 発表中` |
| 揺れの候補（未確定） | `🔍 揺れの可能性` |
| 揺れ検知 | `📈 揺れ検知` |

### タイマー管理

- `earthquake` / `eew` / `tsunami` / `specialInfo` の 4 種類のタイマーを `timersRef` に保持
- デフォルトタブへ復帰する時刻に平常時タイトルへ戻す
- 「自動復帰までの時間」を無効化していれば次の情報更新までタイトルは維持される
- 津波タイトルは既定で「発表が解除されるまで表示」（設定で「一定時間に制限」も可）

## 6. ライブイベント連動（`useLiveEventHandler`）

`src/hooks/useLiveEventHandler.ts`。イベント種別ごとに音・通知・読み上げ・タブ切替・タイトルの発火を
一元的に扱う（約 500 行以上の巨大フック）。

### 発火順序（概念）

各イベントで以下が並行 or 逐次に発火する:

1. 音（`playAlertSound(type)`）
2. ブラウザ通知（`showBrowserNotification(...)`）
3. VOICEVOX 読み上げ（`setTimeout` で遅延投入、種別ごとに 500〜4200ms）
4. 自動タブ切替（`setActiveTabNonRealtime(tab)` or `setActiveTabRealtimeOnUpdate()`）
5. ウィンドウタイトル変更（`useAlertTitle`）
6. カメラ自動フィット（`FitTo*GL` 経由）

### 設定連動

- `settings.soundEnabled` — アラート音の ON/OFF
- `settings.voicevoxEnabled` — 読み上げの ON/OFF（`soundEnabled` と独立）
- **ブラウザ通知は種別ごとに 3 つの独立トグル**:
  - `settings.notifyEEW` — 緊急地震速報の発報・昇格時のブラウザ通知 ON/OFF
  - `settings.notifyTsunami` — 津波注意報以上のブラウザ通知 ON/OFF
  - `settings.notifyDetection` — 強震モニタ揺れ検知時のブラウザ通知 ON/OFF
- `settings.notifyMinScale` — 通知の最低震度
- `settings.idleRevertSec` — **操作なし経過後**にデフォルトタブへ戻るまでの秒数（`0` で無効。「情報受信後の N 秒」ではなく「ユーザー操作が止まってからの N 秒」で判定）

### 既知の課題

- 5 箇所の setTimeout が未追跡・キャンセル不能で時系列逆転が起きうる
- 続報時のタブ切替に優先度なし。EEW 誤報取消の 10 秒オーバーレイ中に無関係な地震情報でタブが即消える

### 解消済み

- **AUD-2**: EEW キャンセル電文が P2PQuake WS と Yahoo の両方から届いた場合の二重鳴り防止。`hadKey=true`（このセッションで表示中の EEW）のみで音・通知・読み上げを発火（`useLiveEventHandler.ts`）
- **AUD-4**: 新しい読み上げの開始時に旧セッションの合成リクエストを `AbortController` で打ち切るようにした。セッション ID の更新だけでは in-flight のリクエストが完走して VOICEVOX を占有し、新規発話が待たされていた
- **AUD-6**: 津波の解除/取消/期限切れの通知音を追加（`playAlertSound('tsunamiCancel')`。ding 高→中→低の降下 3 音）
- **AUD-7**: 読み上げは常に `voicevoxEnabled` 単独で判定するように統一。`soundEnabled` はアラート音のみに影響し、`voicevoxEnabled` の可否とは独立に動く

## 7. ブラウザ通知（`notifications`）

`src/utils/notifications.ts`。`Notification` API のラッパー。

- 初回発火時に権限リクエスト
- `tag` で通知を種別ごとに識別（同一 tag は上書き）
- EEW の tag は `eew-${key}`、津波の tag は `'tsunami'` 固定
- **`requireInteraction: true` は EEW 発報（`useLiveEventHandler.ts` の新規・レベルアップ経路）と津波警報のみに渡す**。誤報取消・強震モニタ揺れ検知は `requireInteraction: false` で自然消滅させる

## 8. 関連実装ファイル

- `src/utils/alertSound.ts` — 通知音生成
- `src/utils/voicevox.ts` — VOICEVOX 連携
- `src/utils/ttsText.ts` — 読み上げテキスト生成
- `src/utils/ttsPhraseBreakDict.ts` — 読み仮名辞書
- `public/data/tts-phrase-break-dict.json` — 辞書データ
- `src/hooks/useAlertTitle.ts` — ウィンドウタイトル管理
- `src/hooks/useLiveEventHandler.ts` — 音・通知・読み上げ・タブ切替の一元ディスパッチ
- `src/utils/notifications.ts` — ブラウザ通知

## 9. AutoHotKey 連携の例

```autohotkey
SetTimer, CheckTitle, 1000
return

CheckTitle:
    if WinExist("🚨 緊急地震速報")
    {
        ; ここに発火したい処理を書く
    }
return
```

ブラウザのタブタイトルがウィンドウタイトルに反映されるよう、対象タブを開いた状態
（またはキオスク／アプリモード）で使用する。

## 10. 改訂履歴

- 2026-08-10: 仕様書構造の再編にあわせて新規作成
- 2026-08-15: 遠地地震の読み上げを独立させ、深さ不明の誤読（既知の HIGH 課題）と規模不明の誤表示を解消
- 2026-08-17: 地域を列挙する読み上げ（震度速報・各地の震度・長周期地震動階級）で、階級ごとの句末に付いていた助詞「で」を文末のみに変更し、一文字の助詞が読点に挟まれて読み上げが途切れる問題を解消
- 2026-08-18: 読み上げ範囲の決まり方を §4 に明文化（従来どこにも記述がなかった）。あわせて「必ず読み上げる震度」と
  「地域数の許容超過」を新設し、階数の設定で打ち切られて低い震度の地域が読まれない問題と、上限をわずかに超えただけで
  「ほか N 地域」に丸められる問題を解消した。階級を数える対象も観測がある階級だけに変更（観測 0 地域の階級が枠を空費していた）
- 2026-08-18: 上記の記述を「特殊な扱い」から独立させ §4「地域列挙の範囲」にした。設定連動の中核であり
  例外処理の一項目に埋もれていたため。階数の数え方（最大に加えて何階級下までか）も明示した
