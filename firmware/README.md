# センサーノードのファームウェア

**読者はこのセンサーを自分で組み立てて動かす人。** ここにあるのはマイコンへ
書き込むプログラムで、**このアプリ本体のビルドには含まれない**。

自作地震計のセンサー側。加速度センサーの生波形を LAN 内へ流し続けるだけのもので、
震度の計算はしない。値の意味と全体の設計は
[`docs/implementation-plan.md`](../docs/implementation-plan.md) の項目 93 を参照。

- `seismo-node/seismo-node.ino` — ESP32 + MPU6050 用。**なぜそう書いたかはコード中のコメントに書いてある**（冒頭だけでなく各所にある）
- `seismo-node/wifi_config.example.h` — 接続先の雛形

## 用意するもの

| | |
|---|---|
| マイコン | ESP32（WROOM-32 系） |
| センサー | MPU6050（GY-521 等のブレイクアウト） |
| ビルド | [arduino-cli](https://arduino.github.io/arduino-cli/) と `esp32:esp32` コア |

## 配線

4 本だけ。他のピンは使わない。

| センサー側 | ESP32 側 |
|---|---|
| VCC | **3V3** |
| GND | GND |
| SDA | **GPIO21** |
| SCL | **GPIO22** |

**`22` の隣が `21` とは限らない。** 基板によっては `TX0`・`RX0` が
あいだに入る。ピンを数えず、基板の印字を読んで挿すこと。ここを 1 つずらすと
センサーは応答しないが、USB シリアルは平然と動き続けるので気づきにくい。

**VCC は `5V` ではなく `3V3` へ。** ブレイクアウトの多くは基板上に
レギュレータを持つが、省いた個体があり、それに 5V を入れると I2C の線に 5V が
乗って ESP32 側を壊す。

配線するのは上の 4 本だけで、**残りのピンは未接続のままでよい**。AD0 も繋がない
（I2C アドレスが `0x68` になる。1 枚に 1 個なら衝突しない）。

## 接続先を書く

```bash
cp seismo-node/wifi_config.example.h seismo-node/wifi_config.h
```

複製した側に SSID・パスワード・送り先を書く。**`wifi_config.h` は
`.gitignore` で除外してある**ので、このリポジトリには入らない。

## ノードの名前

名前は **MAC アドレスから引く**。対応表は `wifi_config.h` の `NODE_NAMES` で、
表に無い基板は MAC の下 3 バイトを使って `seismo-xxxxxx` と名乗る。

**1 つのバイナリを全台へ焼けるので、焼き間違いという事故が起こりえない。**
ビルド時に名前を切り替える形を避けた理由は `seismo-node.ino` の
`resolveNodeName` の直前に書いてある。

基板を足すときは、起動時のシリアル出力（**115200 bps**）か状態ページに出る
MAC を対応表へ書き足す。

## 書き込む

```bash
arduino-cli compile --fqbn esp32:esp32:esp32 firmware/seismo-node
arduino-cli upload -p <ポート> --fqbn esp32:esp32:esp32 firmware/seismo-node
```

2 台目以降は OTA で更新できる。

```bash
arduino-cli upload -p seismo-1.local --protocol network --fqbn esp32:esp32:esp32 firmware/seismo-node --upload-field password=
```

**OTA は受信側の PC へ内向きの TCP 接続を張り返す。** ファイアウォールが
それを止めていると「No response from device」で失敗するので、書き込みツールへ
受信を許可する規則を足すこと。

## 動いているか見る

`http://seismo-1.local/` が JSON を返す。項目はこれで全部。

```json
{"node":"seismo-1","mac":"aa:bb:cc:dd:ee:ff","sensor":"MPU6050",
 "sensor_ok":true,"who_am_i":"0x68","uptime_s":54,"rssi":-65,
 "ip":"192.0.2.42","time_synced":true,"unix":1790174493,
 "sample_hz":100,"ug_per_lsb":61.0352,"seq":4620,"packets":154,
 "overflow":0,"last":[-7294,4726,-13472]}
```

- `sensor_ok` が false・`who_am_i` が `0x68` 以外 — センサーに届いていない。配線を見る
- `overflow` — センサー内のバッファがあふれてサンプルを落とした累積回数。
  受け手はこの値の変化で不連続を知る
- `time_synced` — 時刻を取れているか。取れていないとサンプルの絶対時刻が決まらない
- `rssi` — Wi-Fi の受信強度（dBm）。弱いと送信が滞り、あふれの原因になる
- `last` — 最後に読んだ生の 3 軸。静止しているなら長さが 1 g 相当（約 16400）に
  なるので、**センサーが値を返しているのに配線が緩んでいる**といった形も見分けられる
- `uptime_s` と `seq` — 割れば実際のサンプリング周波数が出る。`sample_hz` は設定値

**USB のポート番号で基板を呼ばないこと。** シリアル番号を持たない個体があり、
挿す口を変えるたびに番号が動く。名前（`seismo-1.local`）か MAC で指すこと。
