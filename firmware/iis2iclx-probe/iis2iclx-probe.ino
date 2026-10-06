// IIS2ICLX（2 軸傾斜計）を読み出す切り分け用のスケッチ。
//
// **素子の校正値には触らない。** 読み出しと、動作条件（測定範囲と出力頻度）の
// 設定だけを行う。
//
// **UDP では送らない。** IIS2ICLX は 2 軸で、受け手（`seismo-host`）は 3 成分を
// 要求する（`REQUIRED_AXES`）。2 軸のまま送っても震度の計算からは外れるし、
// 3 軸目を 0 で埋めれば二乗和に嘘の成分が入る。**比べたいのはノイズの大きさ**なので、
// ここでは統計を出すところまでに留める。
//
// **値の読み方は 2 つ。** シリアル（毎秒 1 行）と `GET /`（JSON）。後者があるのは、
// シリアルを読むのに基板の繋がった PC へ入り直す手間を省くため。
//
// **測定範囲は `POST /fs?g=0.5|1|2|3` で切り替えられる**（起動時は ±500mg）。焼き直さずに
// 同じ置き方のまま範囲を行き来して、範囲ごとのノイズを測り比べるため。
//
// 段を分けて、それぞれの結果を出す —— 途中で止まったとき、どこまで進んだかが
// 出力から読めるようにするため。
//   1. 2 本のバスを開く
//   2. 4 通り（2 バス × 2 アドレス）で WHO_AM_I を読み、素子を探す
//   3. 見つかったものを初期化する
//   4. **書いた設定を読み返して照合する**（黙って無視されていないか）
//   5. Wi-Fi・OTA・状態の口を開く（繋がらなくてもシリアルでは動き続ける）
//   6. 毎秒、読めた件数と統計を出す
//
// **レジスタの値はすべて ST 公式ドライバから写した。**
// https://github.com/STMicroelectronics/iis2iclx
//   iis2iclx_reg.h  … アドレス・ビット配置・列挙値
//   iis2iclx_reg.c  … 感度（mg/LSB）
// 推測で書くと、動かないときに実装と仕様のどちらを疑うか分からなくなる。
//
// 焼き方:
//   初回（USB）: arduino-cli upload --fqbn esp32:esp32:esp32 -p COM5 <このフォルダ>
//   以後（OTA）: arduino-cli upload --fqbn esp32:esp32:esp32 -p <IP> --protocol network <このフォルダ>

#include <Wire.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <ArduinoOTA.h>
#include <WebServer.h>
// **接続先はこのファイルが持つ。** リポジトリは公開されているので、値は焼く側の
// 端末にだけ置く（本体のファームと同じ置き方）。
#include "wifi_config.h"

// **本体のファーム（seismo-node.ino）と同じ値。** ずらすと、ここで通った配線が
// 本体で通らない。バス 0 は既定（GPIO21/22）のまま使う。
static const int I2C1_SDA = 16, I2C1_SCL = 17;

/**
 * この基板の名前。**観測中の 3 台と衝突させない。**
 *
 * mDNS と OTA のホスト名を兼ねる。本体は MAC から表を引いて決めるが、
 * こちらは 1 台きりの切り分け用なので固定でよい。
 */
static const char NODE_NAME[] = "iis2iclx-probe";

// ---- レジスタ（iis2iclx_reg.h より）----
static const uint8_t REG_WHO_AM_I = 0x0F;
static const uint8_t REG_CTRL1_XL = 0x10;
static const uint8_t REG_CTRL3_C  = 0x12;
static const uint8_t REG_STATUS   = 0x1E;
static const uint8_t REG_OUTX_L_A = 0x28;  // 0x28..0x2B に X, Y が並ぶ。**Z は無い**

static const uint8_t WHO_AM_I_VALUE = 0x6B;  // IIS2ICLX_ID

// **7bit のアドレス。** ドライバが書いている 0xD5 / 0xD7 は 8bit 表記なので半分にする。
// SJ1 を切っていなければ 0x6A。**WHO_AM_I の期待値 0x6B とは別物**（紛らわしい）。
static const uint8_t ADDR_CANDIDATES[] = { 0x6A, 0x6B };

// ---- CTRL3_C のビット ----
static const uint8_t CTRL3_SW_RESET = 0x01;
static const uint8_t CTRL3_IF_INC   = 0x04;  // 連続読みでアドレスが自動で進む
static const uint8_t CTRL3_BDU      = 0x40;  // 上下バイトが別の標本になるのを防ぐ

// ---- 測定範囲（fs_xl）----
// **並びが昇順ではない。** 0=±500mg / 1=±3g / 2=±1g / 3=±2g（iis2iclx_fs_xl_t）。
// 「値が大きいほど広い」と読むと 4 倍ずれる。感度は iis2iclx_from_fs*_to_mg の値。
struct FullScale {
  const char *query;  // POST /fs?g= に渡す値
  const char *label;  // 状態の口とシリアルに出す名前
  uint8_t code;       // CTRL1_XL の fs_xl
  float mgPerLsb;
};
static const FullScale FULL_SCALES[] = {
  { "0.5", "±500mg", 0, 0.015f },
  { "1",   "±1g",    2, 0.031f },
  { "2",   "±2g",    3, 0.061f },
  { "3",   "±3g",    1, 0.122f },
};
static const int FULL_SCALE_COUNT = sizeof(FULL_SCALES) / sizeof(FULL_SCALES[0]);

/**
 * いまの測定範囲（FULL_SCALES の添字）。起動時は ±500mg。
 *
 * **起動のたびに ±500mg へ戻る**（覚えておかない）。切り替えは測り比べるための
 * 一時的な操作で、電源を入れ直したら既定の状態から始まるほうが取り違えにくい。
 */
static int g_fsIndex = 0;
/** 切り替えた回数。状態の口へ出し、読む側が「切り替え後の値か」を見分ける。 */
static uint32_t g_fsGeneration = 0;

// ---- 出力頻度（odr_xl）----
// **100Hz は無い。** 1=12.5 / 2=26 / 3=52 / 4=104 / 5=208 / 6=416 / 7=833 Hz。
static const uint8_t ODR_104HZ = 4;
static const int ODR_104HZ_NOMINAL = 104;

static const uint8_t CTRL3_C_WANT  = (uint8_t)(CTRL3_BDU | CTRL3_IF_INC);

// 1 mg を gal（cm/s²）へ。標準重力 980.665 gal = 1000 mg。
static const float GAL_PER_MG = 0.980665f;

static const uint32_t REPORT_INTERVAL_MS = 1000;

/** 直近 1 周期ぶんの結果。**状態の口はこれを読む。** */
struct Stat {
  bool ready;        // 一度でも周期を締めたか
  uint32_t count;
  uint32_t readErrors;
  double meanX, meanY;
  double sdX, sdY;
  double spanX, spanY;
};

struct Sensor {
  TwoWire *bus;
  const char *busName;
  uint8_t addr;
  bool initialized;
  // 1 周期ぶんの集計。**平均を引いてから二乗和を積む**のではなく素の和を使うので、
  // 桁落ちに注意が要るが、ここは 104 件・値も小さいので問題にならない。
  uint32_t count;
  uint32_t readErrors;
  double sumX, sumY, sumXX, sumYY;
  int16_t minX, maxX, minY, maxY;
  Stat last;
  /**
   * 次の周期の結果を捨てる印。**測定範囲を切り替えた直後の周期には、切り替え前の
   * 標本が混ざる**（周期の途中で切り替えるため）。そのまま出すと、2 つの範囲の
   * 値が 1 つの σ に混ざる。
   */
  bool discardNext;
  /** 周期を締めた回数。読む側が同じ周期を 2 度数えないための通し番号。 */
  uint32_t period;
};

static Sensor sensors[4];
static int sensorCount = 0;

static WebServer http(80);
static uint32_t g_bootMs = 0;
static bool g_wifiOk = false;
/** OTA の最中は I²C を読まない。**更新を邪魔しない**ため。 */
static bool g_otaBusy = false;

/**
 * いまの測定範囲で CTRL1_XL に書く値。
 *
 * **関数は構造体の定義より後ろに置く。** arduino-cli は、ファイルで最初に現れる関数の
 * 手前へ全関数の宣言を差し込む。構造体より前に関数があると、宣言が `Sensor` を
 * 知らない位置に入って組み立てが落ちる。
 */
static uint8_t ctrl1XlFor(int fsIndex) {
  return (uint8_t)((ODR_104HZ << 4) | (FULL_SCALES[fsIndex].code << 2));
}

/** レジスタを n バイト読む。相手が応答しなければ false。 */
static bool readRegs(TwoWire &bus, uint8_t addr, uint8_t reg, uint8_t *buf, size_t n) {
  bus.beginTransmission(addr);
  bus.write(reg);
  // **false を渡して繰り返し開始にする。** 一度手放すと、間に別の通信が
  // 割り込んだときに読み出し位置がずれる。
  if (bus.endTransmission(false) != 0) return false;
  if (bus.requestFrom((int)addr, (int)n) != (int)n) return false;
  for (size_t i = 0; i < n; i++) buf[i] = (uint8_t)bus.read();
  return true;
}

static bool readReg(TwoWire &bus, uint8_t addr, uint8_t reg, uint8_t *out) {
  return readRegs(bus, addr, reg, out, 1);
}

static bool writeReg(TwoWire &bus, uint8_t addr, uint8_t reg, uint8_t val) {
  bus.beginTransmission(addr);
  bus.write(reg);
  bus.write(val);
  return bus.endTransmission() == 0;
}

static void resetStats(Sensor &s) {
  s.count = 0;
  s.readErrors = 0;
  s.sumX = s.sumY = s.sumXX = s.sumYY = 0.0;
  s.minX = s.minY = INT16_MAX;
  s.maxX = s.maxY = INT16_MIN;
}

/**
 * 1 個を初期化する。**書いた値を読み返して照合する** —— 書き込みが ACK されても
 * 素子が受け付けたとは限らず、黙って既定のまま動かれると
 * 「測定範囲を変えたのに値が変わらない」という形でしか現れない。
 */
static bool initSensor(Sensor &s) {
  Serial.printf("  初期化 %s 0x%02X:\n", s.busName, s.addr);

  if (!writeReg(*s.bus, s.addr, REG_CTRL3_C, CTRL3_SW_RESET)) {
    Serial.println("    リセットの書き込みに失敗");
    return false;
  }
  // リセットが済むと sw_reset のビットが自分で 0 へ戻る。データシートの
  // 所要時間を当てにせず、**戻るのを見てから進む**。
  bool cleared = false;
  for (int i = 0; i < 100; i++) {
    delay(1);
    uint8_t v;
    if (readReg(*s.bus, s.addr, REG_CTRL3_C, &v) && (v & CTRL3_SW_RESET) == 0) {
      cleared = true;
      Serial.printf("    リセット完了（%d ms）\n", i + 1);
      break;
    }
  }
  if (!cleared) {
    Serial.println("    リセットが終わらない");
    return false;
  }

  if (!writeReg(*s.bus, s.addr, REG_CTRL3_C, CTRL3_C_WANT)) {
    Serial.println("    CTRL3_C の書き込みに失敗");
    return false;
  }
  const uint8_t want1 = ctrl1XlFor(g_fsIndex);
  if (!writeReg(*s.bus, s.addr, REG_CTRL1_XL, want1)) {
    Serial.println("    CTRL1_XL の書き込みに失敗");
    return false;
  }

  uint8_t c1 = 0, c3 = 0;
  if (!readReg(*s.bus, s.addr, REG_CTRL1_XL, &c1) || !readReg(*s.bus, s.addr, REG_CTRL3_C, &c3)) {
    Serial.println("    設定の読み返しに失敗");
    return false;
  }
  Serial.printf("    CTRL1_XL = 0x%02X（期待 0x%02X）%s\n",
                c1, want1, c1 == want1 ? "" : "  ← 食い違い");
  Serial.printf("    CTRL3_C  = 0x%02X（期待 0x%02X）%s\n",
                c3, CTRL3_C_WANT, c3 == CTRL3_C_WANT ? "" : "  ← 食い違い");
  if (c1 != want1 || c3 != CTRL3_C_WANT) return false;

  Serial.printf("    測定範囲 %s（%.3f mg/LSB）・出力頻度 %d Hz\n",
                FULL_SCALES[g_fsIndex].label, FULL_SCALES[g_fsIndex].mgPerLsb, ODR_104HZ_NOMINAL);
  resetStats(s);
  return true;
}

/**
 * 測定範囲だけを書き換える（リセットはしない）。**書いた値を読み返して照合する。**
 *
 * 失敗したら `initialized` を下ろす —— 範囲が分からないまま値を出すと、
 * 感度を取り違えた σ が正しい顔をして出てしまう。
 */
static bool applyFullScale(Sensor &s) {
  if (!s.initialized) return false;
  const uint8_t want1 = ctrl1XlFor(g_fsIndex);
  uint8_t c1 = 0;
  // **3 回までやり直す。** 一度の I²C の乱れで initialized を下ろすと、再起動するまで
  // そのセンサーを取り戻す道が無い（initSensor は起動時にしか呼ばない）
  bool ok = false;
  for (int attempt = 0; attempt < 3 && !ok; attempt++) {
    ok = writeReg(*s.bus, s.addr, REG_CTRL1_XL, want1) && readReg(*s.bus, s.addr, REG_CTRL1_XL, &c1)
         && c1 == want1;
  }
  if (!ok) {
    Serial.printf("[%s 0x%02X] 測定範囲の切り替えに失敗（読み返し 0x%02X・期待 0x%02X）\n",
                  s.busName, s.addr, c1, want1);
    s.initialized = false;
    s.last.ready = false;
    return false;
  }
  // 切り替え前の標本を捨て、続く 1 周期も捨てる（途中で切り替えたので混ざる）
  resetStats(s);
  s.discardNext = true;
  s.last.ready = false;
  return true;
}

/** 1 本のバスを探る。見つけた数を返す。 */
static int probeBus(TwoWire &bus, const char *busName) {
  int found = 0;
  for (uint8_t addr : ADDR_CANDIDATES) {
    uint8_t who = 0;
    if (!readReg(bus, addr, REG_WHO_AM_I, &who)) continue;  // 誰もいない
    Serial.printf("  %s 0x%02X: WHO_AM_I = 0x%02X", busName, addr, who);
    if (who != WHO_AM_I_VALUE) {
      // **応答はあるが別の素子。** 何も設定せずに見送る。
      Serial.printf("  ← IIS2ICLX ではない（期待 0x%02X）\n", WHO_AM_I_VALUE);
      continue;
    }
    Serial.println("  ← IIS2ICLX");
    if (sensorCount >= (int)(sizeof(sensors) / sizeof(sensors[0]))) continue;
    sensors[sensorCount] = Sensor{ &bus, busName, addr, false, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Stat{}, false, 0 };
    sensorCount++;
    found++;
  }
  return found;
}

/** 新しい標本があれば 1 つ取り込む。 */
static void poll(Sensor &s) {
  uint8_t st = 0;
  if (!readReg(*s.bus, s.addr, REG_STATUS, &st)) {
    s.readErrors++;
    return;
  }
  if ((st & 0x01) == 0) return;  // bit0 = XLDA。まだ新しい標本が無い

  uint8_t raw[4];
  if (!readRegs(*s.bus, s.addr, REG_OUTX_L_A, raw, 4)) {
    s.readErrors++;
    return;
  }
  // 下位バイトが先（リトルエンディアン）。
  const int16_t x = (int16_t)((uint16_t)raw[0] | ((uint16_t)raw[1] << 8));
  const int16_t y = (int16_t)((uint16_t)raw[2] | ((uint16_t)raw[3] << 8));

  s.count++;
  s.sumX += x;   s.sumY += y;
  s.sumXX += (double)x * x;
  s.sumYY += (double)y * y;
  if (x < s.minX) s.minX = x;
  if (x > s.maxX) s.maxX = x;
  if (y < s.minY) s.minY = y;
  if (y > s.maxY) s.maxY = y;
}

/** 標本の標準偏差（LSB）。2 件に満たなければ 0。 */
static double stddevLsb(double sum, double sumSq, uint32_t n) {
  if (n < 2) return 0.0;
  const double mean = sum / n;
  const double var = (sumSq - (double)n * mean * mean) / (double)(n - 1);
  return var > 0.0 ? sqrt(var) : 0.0;
}

/** 1 周期を締める。**シリアルへ出し、状態の口が読む値も更新する。** */
static void report(Sensor &s) {
  if (!s.initialized) {
    // **初期化できていない（設定が分からない）センサーの値は出さない。** 感度を
    // 取り違えた σ が正しい顔をして出てしまう。一覧には残るので、状態の口から
    // initialized:false として見える（黙って消えはしない）
    resetStats(s);
    s.last.ready = false;
    return;
  }
  if (s.discardNext) {
    // 測定範囲を切り替えた周期。値は出さずに捨てる（s.last.ready は false のまま）
    s.discardNext = false;
    resetStats(s);
    return;
  }
  const float mgPerLsb = FULL_SCALES[g_fsIndex].mgPerLsb;
  s.period++;
  if (s.count == 0) {
    // **件数 0 でも記録は残す。** 状態の口から「黙っている」ことが読めないと、
    // 初期化に失敗した個体と、そもそも見つからなかった個体を区別できない。
    s.last = Stat{ true, 0, s.readErrors, 0, 0, 0, 0, 0, 0 };
    Serial.printf("[%s 0x%02X] 標本なし（読み取り失敗 %u 件）\n", s.busName, s.addr, s.readErrors);
    resetStats(s);
    return;
  }
  const double mx = s.sumX / s.count, my = s.sumY / s.count;
  const double sx = stddevLsb(s.sumX, s.sumXX, s.count);
  const double sy = stddevLsb(s.sumY, s.sumYY, s.count);

  s.last = Stat{
    true, s.count, s.readErrors,
    mx * mgPerLsb, my * mgPerLsb,
    sx * mgPerLsb, sy * mgPerLsb,
    (double)(s.maxX - s.minX) * mgPerLsb, (double)(s.maxY - s.minY) * mgPerLsb,
  };

  // **件数は出力頻度が効いているかの裏付け。** 104 から大きく外れるなら
  // 設定が通っていないか、読みが追いついていない。
  Serial.printf("[%s 0x%02X] n=%u", s.busName, s.addr, s.count);
  if (s.readErrors > 0) Serial.printf(" 失敗=%u", s.readErrors);
  Serial.printf("  X: 平均 %+8.3f mg  幅 %6.3f mg  σ %6.4f mg (%6.4f gal)\n",
                s.last.meanX, s.last.spanX, s.last.sdX, s.last.sdX * GAL_PER_MG);
  Serial.printf("                      Y: 平均 %+8.3f mg  幅 %6.3f mg  σ %6.4f mg (%6.4f gal)\n",
                s.last.meanY, s.last.spanY, s.last.sdY, s.last.sdY * GAL_PER_MG);
  resetStats(s);
}

/**
 * 状態の口。**読み取りだけ。**
 *
 * 単位は mg（`*Mg`）。gal への換算は読む側に任せる —— 両方出すと、
 * どちらが元の値かが読めなくなる。
 */
static void handleStatus() {
  String out = "{\"node\":\"";
  out += NODE_NAME;
  out += "\",\"ip\":\"";
  out += WiFi.localIP().toString();
  out += "\",\"rssi\":";
  out += WiFi.RSSI();
  out += ",\"uptimeSec\":";
  out += (millis() - g_bootMs) / 1000;
  out += ",\"fullScale\":\"";
  out += FULL_SCALES[g_fsIndex].label;
  out += "\",\"fsGeneration\":";
  out += g_fsGeneration;
  out += ",\"odrHz\":";
  out += ODR_104HZ_NOMINAL;
  out += ",\"mgPerLsb\":";
  out += String(FULL_SCALES[g_fsIndex].mgPerLsb, 4);
  out += ",\"sensors\":[";
  for (int i = 0; i < sensorCount; i++) {
    const Sensor &s = sensors[i];
    if (i > 0) out += ",";
    out += "{\"bus\":\"";
    out += s.busName;
    out += "\",\"addr\":\"0x";
    out += String(s.addr, HEX);
    out += "\",\"initialized\":";
    out += s.initialized ? "true" : "false";
    // **まだ 1 周期も締めていない間は値を出さない。** 0 を返すと、
    // 「静かだった」と「まだ測っていない」が同じに見える。
    if (!s.last.ready) {
      out += ",\"measured\":false}";
      continue;
    }
    out += ",\"measured\":true,\"period\":";
    out += s.period;
    out += ",\"n\":";
    out += s.last.count;
    out += ",\"readErrors\":";
    out += s.last.readErrors;
    out += ",\"x\":{\"meanMg\":";
    out += String(s.last.meanX, 3);
    out += ",\"sdMg\":";
    out += String(s.last.sdX, 4);
    out += ",\"spanMg\":";
    out += String(s.last.spanX, 3);
    out += "},\"y\":{\"meanMg\":";
    out += String(s.last.meanY, 3);
    out += ",\"sdMg\":";
    out += String(s.last.sdY, 4);
    out += ",\"spanMg\":";
    out += String(s.last.spanY, 3);
    out += "}}";
  }
  out += "]}";
  http.send(200, "application/json; charset=utf-8", out);
}

/**
 * 測定範囲を切り替える口（`POST /fs?g=0.5|1|2|3`）。**全センサーへ同じ範囲を書く。**
 *
 * 測り比べのための口なので、**認証は無い**。この基板は LAN 内の切り分け用で、
 * 観測には使っていない。返すのは切り替え後の状態の口と同じ形ではなく、
 * 成否と範囲だけ（値は次の周期を待たないと出ないため）。
 */
static void handleFullScale() {
  if (http.method() != HTTP_POST) {
    http.send(405, "text/plain; charset=utf-8", "POST で呼ぶこと\n");
    return;
  }
  const String g = http.arg("g");
  int next = -1;
  for (int i = 0; i < FULL_SCALE_COUNT; i++) {
    if (g == FULL_SCALES[i].query) next = i;
  }
  if (next < 0) {
    http.send(400, "text/plain; charset=utf-8", "g は 0.5 / 1 / 2 / 3 のどれか\n");
    return;
  }
  g_fsIndex = next;
  g_fsGeneration++;
  int ok = 0, failed = 0;
  for (int i = 0; i < sensorCount; i++) {
    if (!sensors[i].initialized) continue;
    if (applyFullScale(sensors[i])) ok++; else failed++;
  }
  Serial.printf("# 測定範囲を %s へ（成功 %d・失敗 %d）\n", FULL_SCALES[next].label, ok, failed);
  String out = "{\"fullScale\":\"";
  out += FULL_SCALES[next].label;
  out += "\",\"fsGeneration\":";
  out += g_fsGeneration;
  out += ",\"applied\":";
  out += ok;
  out += ",\"failed\":";
  out += failed;
  out += "}";
  http.send(failed == 0 ? 200 : 500, "application/json; charset=utf-8", out);
}

/** Wi-Fi・OTA・状態の口。**繋がらなくてもシリアルでは動き続ける。** */
static void startNetwork() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Wi-Fi 接続中");
  for (int i = 0; i < 60 && WiFi.status() != WL_CONNECTED; i++) {
    delay(500);
    Serial.print('.');
  }
  Serial.println();

  if (WiFi.status() != WL_CONNECTED) {
    // **止めない。** 値そのものはシリアルから読める。ここで諦めると、
    // 電波が届かない場所へ置いた瞬間に切り分けの道具ごと使えなくなる。
    Serial.println("# wifi 繋がらず（シリアルでは動き続けます）");
    return;
  }
  g_wifiOk = true;
  Serial.printf("# wifi ok ip=%s rssi=%d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  if (MDNS.begin(NODE_NAME)) Serial.printf("# mdns %s.local\n", NODE_NAME);

  ArduinoOTA.setHostname(NODE_NAME);
  // **更新中は I²C を読まない。** 読みに行くと更新の受信が間延びする。
  ArduinoOTA.onStart([]() {
    g_otaBusy = true;
    Serial.println("\n# OTA 開始");
  });
  ArduinoOTA.onEnd([]() { Serial.println("\n# OTA 完了"); });
  ArduinoOTA.onError([](ota_error_t e) {
    g_otaBusy = false;
    Serial.printf("# OTA 失敗 code=%u\n", (unsigned)e);
  });
  ArduinoOTA.begin();
  Serial.printf("# ota %s:3232\n", WiFi.localIP().toString().c_str());

  http.on("/", handleStatus);
  http.on("/fs", handleFullScale);
  http.begin();
  Serial.printf("# http http://%s/\n", WiFi.localIP().toString().c_str());
}

void setup() {
  Serial.begin(115200);
  delay(300);
  g_bootMs = millis();
  Serial.println("\n\n===== IIS2ICLX 読み出し =====");
  Serial.println("読みと動作条件の設定だけを行います。校正値には触れません。");

  // **開けたかどうかを出す。** 黙って失敗すると「1 個も見つからない」に化けて、
  // 配線の問題と区別が付かない。
  const bool ok0 = Wire.begin();
  const bool ok1 = Wire1.begin(I2C1_SDA, I2C1_SCL);
  Serial.printf("バス 0 (GPIO21/22) begin=%s\n", ok0 ? "OK" : "失敗");
  Serial.printf("バス 1 (GPIO%d/%d) begin=%s\n", I2C1_SDA, I2C1_SCL, ok1 ? "OK" : "失敗");

  // 400 kHz。**104 Hz × 2 個の読み出しには 100 kHz でも足りる**が、
  // I²C スキャンで両バスとも素直に応答したので、余裕のある側で回す。
  Wire.setClock(400000);
  Wire1.setClock(400000);

  Serial.println("\n--- 素子を探す ---");
  probeBus(Wire, "バス0");
  probeBus(Wire1, "バス1");
  Serial.printf("  → %d 個\n", sensorCount);

  if (sensorCount == 0) {
    Serial.println("\n1 個も見つからない。疑う順:");
    Serial.println("  1. 3.3V が来ているか（5V ではない）");
    Serial.println("  2. SDA と SCL が入れ替わっていないか");
    Serial.println("  3. GND が繋がっているか");
    Serial.println("  4. I2C スキャンでは見えるか（見えるのに WHO_AM_I が違えば別の素子）");
  } else {
    Serial.println("\n--- 初期化 ---");
    int ready = 0;
    for (int i = 0; i < sensorCount; i++) {
      sensors[i].initialized = initSensor(sensors[i]);
      if (sensors[i].initialized) ready++;
    }
    Serial.printf("  → %d / %d 個\n", ready, sensorCount);
    // 初期化に失敗したものも一覧には残す。状態の口に initialized:false で出て、
    // 「黙って消える」のを防ぐ（値は report が出さない）。
  }

  // **素子が 1 個も無くても網は開く。** OTA が生きていれば、USB へ触らずに
  // 直したスケッチを送り込める（それがここへ網を足した理由）。
  Serial.println("\n--- ネットワーク ---");
  startNetwork();

  Serial.println("\n--- 読み出し（毎秒の統計）---");
  Serial.println("静止させて σ を見ること。これがノイズの下限になる。");
}

void loop() {
  static uint32_t lastReport = 0;

  ArduinoOTA.handle();
  if (g_wifiOk) http.handleClient();
  // **更新中は読みに行かない。** 戻ってくることは無い（更新後に再起動する）が、
  // 失敗して戻ったときのために印は下ろす。
  if (g_otaBusy) {
    delay(1);
    return;
  }

  for (int i = 0; i < sensorCount; i++) poll(sensors[i]);

  const uint32_t now = millis();
  // **経過時間で測る。** 回数で数えると、読みが詰まったときに周期まで伸びる。
  if (lastReport == 0) lastReport = now;
  if (now - lastReport >= REPORT_INTERVAL_MS) {
    lastReport += REPORT_INTERVAL_MS;
    for (int i = 0; i < sensorCount; i++) report(sensors[i]);
  }
}
