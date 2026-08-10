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
| `quake` | 地震情報 | 単音 |
| `quakeUpdate` | 地震続報 | 短い上昇 |
| `foreshock` | 揺れの候補（faint/likely） | 微小音 |
| `detected` | 揺れ検知（confirmed） | 通知音 |

### 発火 API

```ts
playAlertSound(type: AlertSoundType)
```

内部で `AudioContext` の取得・resume を行う。`getCtx()` はシングルトンで、モジュール変数
`_reverb`（`ConvolverNode`）と一緒に使い回される。

### 音量制御

- `globalVolume`（0.0〜1.0）を `setGlobalVolume(v)` で更新
- 各種別内の相対バランスは `PLAYERS[type]` 内でハードコード

### 既知の課題

- 優先度制御・キュー・重複再生防止が皆無。EEW と津波の同時発報で音が加算合成される
  （現状はドメイン特性上、同時発生は稀）
- `AudioContext.resume()` の Promise を await せずに `currentTime + 0.02` をスケジュール（iOS Safari で初回音がドロップしうる）
- `eewSpecial` の内部ゲイン合計が 1.0 を超え、単独でもクリップしうる

## 3. VOICEVOX 読み上げ（`voicevox`）

`src/utils/voicevox.ts`。VOICEVOX ローカル HTTP API（デフォルト `http://localhost:50021`）を呼び出して
音声合成する。任意機能で、有効化はユーザー設定 `voicevoxEnabled` による。

### API 呼び出し

- `POST /audio_query` — テキストからアクセント句を生成
- `POST /synthesis` — アクセント句から WAV を合成

合成 WAV は `AudioContext.decodeAudioData` でデコードして `AudioBufferSourceNode` で再生する。

### セッション管理

- モジュール変数 `activeSources: Set<AudioBufferSourceNode>` と `currentSessionId: number`
- `speakWithVoicevox(text)` を呼ぶたびに既存の再生を全 stop() し、`currentSessionId++` で新セッションに切替
- **単一グローバルセッション**なので、EEW / 地震 / 津波 / LPGM の全読み上げがこの単一セッションを共有する

### 辞書（読み仮名の補正）

`src/utils/ttsPhraseBreakDict.ts` + `public/data/tts-phrase-break-dict.json` に地名・専門用語の
読み仮名エントリを持ち、`findPhraseBreakMatch` で該当箇所のアクセント句をキャッシュ済みのものと差し替える。

### 話速

現状 `synthesizeChunk` 内で `query.speedScale = 1.2` を無条件に上書き（ユーザー設定なし）。

### 既知の課題

- 中断時に進行中の fetch がキャンセルされない（AbortController 未使用）
- 全種別が単一セッションを共有するため、無関係な津波観測更新が EEW 警報読み上げを打ち切りうる
- 通常チャンクの音声合成に一切キャッシュがない（定型句「緊急地震速報。」等も毎回合成）
- 失敗パスに一切ログがなく原因追跡ができない

## 4. 読み上げテキスト生成（`ttsText`）

`src/utils/ttsText.ts`。イベント種別に応じた読み上げ文を生成する。

### 主要関数

- `eewAlertToText(eew)` — EEW 全体の読み上げ（新規発報用）
- `eewIntensityToText(eew)` — 震度・区域だけを短く読み上げ
- `quakeToText(quake)` — 地震情報
- `tsunamiToText(tsunami)` / `tsunamiCancelToText(tsunami)` — 津波
- `lpgmToText(...)` — 長周期地震動
- `nankaiToText(...)` / `kohatsuToText(...)` — 南海トラフ・後発地震

### 特殊な扱い

- **仮定震源要素**: `condition === '仮定震源要素'` の場合は M・深さを読み上げない（EEW-spec 参照）
- **震源深さ不明**: `depth <= 0` で「ごく浅い場所」と読み上げる（`-1` は不明センチネル・現状「ごく浅い」に落ちる HIGH 課題）
- **マグニチュード不明**: 現状 NaN ガードなしで `M${NaN.toFixed(1)}` を生成しうる

## 5. ウィンドウタイトル（`useAlertTitle`）

`src/hooks/useAlertTitle.ts`。情報更新時にブラウザタブ / ウィンドウのタイトルを書き換える。
AutoHotKey 等の外部監視ツールから状態を検知できる。

### タイトル表

| 状態 | タイトル |
|---|---|
| 平常時 | `リアルタイム地震ビューアー` |
| 地震情報受信 | `🔴 地震情報 <震源> 最大震度<N>` |
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

- `settings.soundEnabled` — 音の ON/OFF
- `settings.voicevoxEnabled` — 読み上げの ON/OFF
- `settings.notificationEnabled` — ブラウザ通知の ON/OFF
- `settings.notifyMinScale` — 通知の最低震度
- `settings.autoReturnSec` — 自動タブ復帰までの時間

### 既知の課題

- `soundEnabled` と `voicevoxEnabled` の依存関係が箇所によって逆転（EEW 本編は AND、取消系は voicevoxEnabled 単独）
- 津波の解除/取消/期限切れで通知音が鳴らない（他の取消系は音があるのに津波だけ非対称）
- 5 箇所の setTimeout が未追跡・キャンセル不能で時系列逆転が起きうる
- 続報時のタブ切替に優先度なし。EEW 誤報取消の 10 秒オーバーレイ中に無関係な地震情報でタブが即消える

## 7. ブラウザ通知（`notifications`）

`src/utils/notifications.ts`。`Notification` API のラッパー。

- 初回発火時に権限リクエスト
- `tag` で通知を種別ごとに識別（同一 tag は上書き）
- EEW の tag は `eew-${key}`、津波の tag は `'tsunami'` 固定
- `requireInteraction: true` でユーザーが閉じるまで残す

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
