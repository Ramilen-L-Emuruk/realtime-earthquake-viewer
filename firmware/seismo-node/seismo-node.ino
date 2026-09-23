// 自作地震計のセンサーノード。
//
// **ESP32 に時刻を刻ませない。** 素朴に delay() のループで読むと Wi-Fi のスタックが
// 割り込んでサンプル間隔が揺れる。周期補正フィルタ（気象庁告示第4号）は等間隔
// サンプリングを前提にしているので、揺れた波形を等間隔だと思って解析すれば震度の
// 値そのものが信用できなくなる。MPU6050 自身のクロックで FIFO へ溜めさせ、ESP32 は
// 吸い出すだけにすれば、サンプリングの規則性が ESP32 の都合から切り離される。
//
// **gal への換算はしない。** 生カウントのまま送り、換算に必要なスケールはパケットの
// ヘッダで伝える。センサーを差し替えても受け手を直さずに済むようにするため。

#include <Wire.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <ESPmDNS.h>
#include <ArduinoOTA.h>
#include <WebServer.h>
#include <time.h>
#include <esp_mac.h>
#include "wifi_config.h"

static const uint8_t ADDR = 0x68;
static const uint8_t R_SMPLRT_DIV=0x19, R_CONFIG=0x1A, R_ACCEL_CFG=0x1C, R_FIFO_EN=0x23;
static const uint8_t R_INT_STATUS=0x3A, R_USER_CTRL=0x6A, R_PWR_MGMT_1=0x6B;
static const uint8_t R_FIFO_COUNTH=0x72, R_FIFO_RW=0x74, R_WHO_AM_I=0x75;

// DLPF_CFG=4 は加速度側の帯域を 21Hz へ落とす。100Hz のナイキストは 50Hz なので、
// 44Hz（=3）では余裕がなく帯域外が折り返して 0〜3Hz へ積もる。
static const uint8_t DLPF_CFG=4, SMPLRT_DIV=9, AFS_SEL=0;
static const int     SAMPLE_HZ  = 1000 / (1 + SMPLRT_DIV);
static const float   UG_PER_LSB = 1000000.0f / 16384.0f;   // ±2g は 16384 LSB/g
static const size_t  BPS = 6;                              // XYZ × 2 バイト
static const uint32_t DRAIN_MS = 300;
static const size_t  I2C_CHUNK = 120;   // Wire の受信バッファ超過は黙って切り捨てられる
static const size_t  MAX_PER_PACKET = 40;  // UDP を MTU 内へ収める

static WiFiUDP    udp;
static WebServer  http(80);
static uint32_t   g_seq = 0, g_overflow = 0, g_sent = 0, g_bootMs = 0;
static int16_t    g_last[3] = {0,0,0};
static bool       g_sensorOk = false;
static uint8_t    g_who = 0;
static char       g_node[24] = "";
static char       g_mac[18] = "";

// **ノード名は板そのものから引く。** ビルド時の定義で切り替える形だと、焼き直しの
// たびに取り違えうる——しかも取り違えても何のエラーも出ず、別のセンサーの波形として
// 静かに混ざるだけ。複数台で突き合わせるために増やした台数が、そこで意味を失う。
// 1 つのバイナリを全台へ焼ける形にしておけば、焼き間違いという事故が起こりえない。
//
// **どの MAC がどの名前かは `wifi_config.h` が持つ**（`NODE_NAMES`）。あれは
// 設置ごとの事実であって firmware の論理ではないので、送り先（`UDP_HOST`）と
// 同じ場所へ置く。手元の機材の識別子をリポジトリへ入れずに済む利点もある。

// 表に無い板は MAC の下 3 バイトで名乗る。既定の名前へ倒すと、4 台目を足したときに
// 同じ名前が 2 つ現れ、受け手はそれを 1 台のセンサーの波形として混ぜてしまう。
// 名前が一意でありさえすれば、表への追記を忘れても受け手側で気づける。
static void resolveNodeName(){
  uint8_t m[6] = {0,0,0,0,0,0};
  if (esp_read_mac(m, ESP_MAC_WIFI_STA) != ESP_OK) {
    Serial.println("# WARN MAC を読めなかった");
  }
  snprintf(g_mac, sizeof(g_mac), "%02x:%02x:%02x:%02x:%02x:%02x",
           m[0], m[1], m[2], m[3], m[4], m[5]);
  // NODE_NAMES は MAC と名前を交互に並べた表。**終端の番兵を置かず、配列の
  // 大きさから数える。** 番兵だと書き忘れたときに配列の外を読むが、こちらの形
  // なら書き忘れようがない。
  // **`i + 1 < n` で止めること。** 名前を書かずに MAC だけ足された表では、
  // `i < n` にすると最後の 1 つで配列の外を読む。
  const size_t n = sizeof(NODE_NAMES) / sizeof(NODE_NAMES[0]);
  for (size_t i = 0; i + 1 < n; i += 2) {
    if (strcmp(NODE_NAMES[i], g_mac) == 0) {
      // **切り詰めを黙って通さないこと。** 長い名前は snprintf が静かに詰めるので、
      // 頭が同じ 2 つの名前が同じ文字列へ落ちうる。「名前が一意でありさえすれば
      // 受け手側で気づける」という、この仕組みの拠り所がそこで崩れる。
      if (strlen(NODE_NAMES[i + 1]) >= sizeof(g_node)) {
        Serial.printf("# WARN 名前が長すぎる（%u 文字まで）。切り詰めると衝突しうる: %s\n",
                      (unsigned)(sizeof(g_node) - 1), NODE_NAMES[i + 1]);
      }
      snprintf(g_node, sizeof(g_node), "%s", NODE_NAMES[i + 1]);
      return;
    }
  }
  snprintf(g_node, sizeof(g_node), "seismo-%02x%02x%02x", m[3], m[4], m[5]);
  Serial.printf("# WARN mac %s は表に無い。仮に %s と名乗る\n", g_mac, g_node);
}

static void w8(uint8_t r, uint8_t v){ Wire.beginTransmission(ADDR); Wire.write(r); Wire.write(v); Wire.endTransmission(); }
static bool r8(uint8_t r, uint8_t &o){
  Wire.beginTransmission(ADDR); Wire.write(r);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((uint8_t)ADDR, (uint8_t)1) != 1) return false;
  o = Wire.read(); return true;
}
static void fifoReset(){ w8(R_USER_CTRL, 0x04); delay(2); w8(R_USER_CTRL, 0x40); }

static void sensorInit(){
  w8(R_PWR_MGMT_1, 0x80); delay(100);
  w8(R_PWR_MGMT_1, 0x01); delay(50);      // CLKSEL=1（ジャイロ X の PLL 参照）
  w8(R_CONFIG, DLPF_CFG);
  w8(R_SMPLRT_DIV, SMPLRT_DIV);
  w8(R_ACCEL_CFG, (uint8_t)(AFS_SEL << 3));
  w8(R_FIFO_EN, 0x08);                    // 加速度 XYZ だけ
  fifoReset();
  g_sensorOk = r8(R_WHO_AM_I, g_who) && (g_who == 0x68);
}

static void handleStatus(){
  time_t now = time(nullptr);
  char buf[512];
  snprintf(buf, sizeof(buf),
    "{\"node\":\"%s\",\"mac\":\"%s\",\"sensor\":\"MPU6050\",\"sensor_ok\":%s,\"who_am_i\":\"0x%02X\","
    "\"uptime_s\":%lu,\"rssi\":%d,\"ip\":\"%s\",\"time_synced\":%s,\"unix\":%ld,"
    "\"sample_hz\":%d,\"ug_per_lsb\":%.4f,\"seq\":%lu,\"packets\":%lu,\"overflow\":%lu,"
    "\"last\":[%d,%d,%d]}",
    g_node, g_mac, g_sensorOk ? "true":"false", g_who,
    (unsigned long)((millis()-g_bootMs)/1000), WiFi.RSSI(), WiFi.localIP().toString().c_str(),
    now > 1700000000 ? "true":"false", (long)now,
    SAMPLE_HZ, UG_PER_LSB, (unsigned long)g_seq, (unsigned long)g_sent, (unsigned long)g_overflow,
    g_last[0], g_last[1], g_last[2]);
  http.send(200, "application/json", buf);
}

void setup(){
  Serial.begin(115200);
  delay(300);
  g_bootMs = millis();
  resolveNodeName();
  Wire.begin(); Wire.setClock(400000);
  sensorInit();

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);          // 省電力で受信が遅れると取りこぼしの原因になる
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("\n# %s (%s) booting sensor_ok=%d who=0x%02X\n", g_node, g_mac, g_sensorOk, g_who);
  for (int i = 0; i < 60 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print('.'); }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("# wifi ok ip=%s rssi=%d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    configTime(0, 0, "ntp.nict.jp", "pool.ntp.org");   // UTC で持つ。表示側で直す
    if (MDNS.begin(g_node)) Serial.printf("# mdns %s.local\n", g_node);
    ArduinoOTA.setHostname(g_node);
    ArduinoOTA.begin();
    http.on("/", handleStatus);
    http.begin();
    udp.begin(0);
  } else {
    Serial.println("# wifi FAILED (シリアルでは動き続ける)");
  }
  // Wi-Fi の接続待ちは最大 30 秒あり、そのあいだ FIFO を吸い出せない。FIFO は
  // 1.7 秒ぶんしか無いので必ずあふれている。ここで作り直さないと、起動直後の
  // 1 回は必ず OVERFLOW として数えられる。
  fifoReset();
  // **INT_STATUS のあふれビットはラッチで、読むまで消えない。** FIFO を作り直しても
  // 旗は立ったままなので、ここで読み捨てないと最初の loop() が古い旗を見て 1 回
  // 数えてしまう。取りこぼしを受け手へ伝えるための値が、起動直後から 1 になる。
  uint8_t discard = 0;
  r8(R_INT_STATUS, discard);
  g_overflow = 0;
}

// `q`（通し番号）は「送れたサンプル」しか数えないので、FIFO があふれて落とした分は
// 番号が飛ばずに詰まってしまう。取りこぼしを見つけるための番号が取りこぼしを隠す形。
// そこで累積の OVERFLOW 回数を `o` として同梱し、受け手が不連続を知れるようにする。
// 時刻 `t` と件数 `c` の突き合わせも併せて使えば、どこで落ちたかまで辿れる。
static void sendChunk(const int16_t *s, size_t n, uint32_t seq0, int64_t tFirstMs){
  if (WiFi.status() != WL_CONNECTED) return;
  char head[240];
  int hl = snprintf(head, sizeof(head),
    "{\"n\":\"%s\",\"s\":\"MPU6050\",\"ug\":%.4f,\"hz\":%d,\"r\":%d,\"t\":%lld,\"q\":%lu,\"c\":%u,\"o\":%lu}\n",
    g_node, UG_PER_LSB, SAMPLE_HZ, 2 << AFS_SEL, (long long)tFirstMs,
    (unsigned long)seq0, (unsigned)n, (unsigned long)g_overflow);
  udp.beginPacket(UDP_HOST, UDP_PORT);
  udp.write((const uint8_t*)head, hl);
  for (size_t i = 0; i < n; i++) {
    char line[32];
    int ll = snprintf(line, sizeof(line), "%d,%d,%d\n", s[i*3], s[i*3+1], s[i*3+2]);
    udp.write((const uint8_t*)line, ll);
  }
  if (udp.endPacket()) g_sent++;
}

void loop(){
  ArduinoOTA.handle();
  http.handleClient();

  static uint32_t last = 0;
  if (millis() - last < DRAIN_MS) return;
  last = millis();
  if (!g_sensorOk) return;

  uint8_t st = 0;
  if (r8(R_INT_STATUS, st) && (st & 0x10)) {
    // FIFO があふれた＝サンプルを落とし、6 バイト境界も合わなくなっている。
    // 黙って続けると軸が入れ替わるので必ず作り直す。
    g_overflow++; Serial.printf("# OVERFLOW n=%lu\n", (unsigned long)g_overflow);
    fifoReset(); return;
  }
  uint8_t hi=0, lo=0;
  if (!r8(R_FIFO_COUNTH, hi) || !r8((uint8_t)(R_FIFO_COUNTH+1), lo)) return;
  uint16_t cnt = ((uint16_t)hi << 8) | lo;
  if (cnt < BPS) return;
  if (cnt % BPS != 0) { g_overflow++; fifoReset(); return; }

  // 抜き出した時点を基準に、先頭サンプルの時刻を逆算する。サンプル「間隔」は
  // FIFO が保証しているので、不確かなのは絶対位置だけ。
  struct timeval tv; gettimeofday(&tv, nullptr);
  int64_t nowMs = (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
  uint16_t total = cnt / BPS;
  int64_t tFirstMs = nowMs - (int64_t)((total - 1) * 1000 / SAMPLE_HZ);

  static int16_t buf[MAX_PER_PACKET * 3];
  size_t inBuf = 0;
  uint32_t seq0 = g_seq;
  int64_t  tBuf = tFirstMs;
  uint16_t remain = cnt;
  while (remain >= BPS) {
    size_t want = remain > I2C_CHUNK ? I2C_CHUNK : remain;
    want -= want % BPS;
    Wire.beginTransmission(ADDR); Wire.write(R_FIFO_RW);
    if (Wire.endTransmission(false) != 0) { fifoReset(); return; }
    if (Wire.requestFrom((uint8_t)ADDR, (uint8_t)want) != want) { g_overflow++; fifoReset(); return; }
    for (size_t i = 0; i < want; i += BPS) {
      // **1 つの式の中で Wire.read() を 2 回呼ばないこと。** `|` の左右の評価順は
      // C++ で規定されておらず、上位バイトと下位バイトが入れ替わりうる。
      const uint8_t xh=Wire.read(), xl=Wire.read();
      const uint8_t yh=Wire.read(), yl=Wire.read();
      const uint8_t zh=Wire.read(), zl=Wire.read();
      buf[inBuf*3+0] = g_last[0] = (int16_t)(((uint16_t)xh<<8)|xl);
      buf[inBuf*3+1] = g_last[1] = (int16_t)(((uint16_t)yh<<8)|yl);
      buf[inBuf*3+2] = g_last[2] = (int16_t)(((uint16_t)zh<<8)|zl);
      inBuf++; g_seq++;
      if (inBuf == MAX_PER_PACKET) {
        sendChunk(buf, inBuf, seq0, tBuf);
        tBuf += (int64_t)inBuf * 1000 / SAMPLE_HZ;
        seq0 = g_seq; inBuf = 0;
      }
    }
    remain -= want;
  }
  if (inBuf > 0) sendChunk(buf, inBuf, seq0, tBuf);
}
