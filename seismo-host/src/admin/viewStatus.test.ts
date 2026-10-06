import { describe, expect, it } from 'vitest'

import { STALE_AFTER_MS } from './dom'
import {
  assignedBoardsOf,
  assignedSilenceWarnings,
  boardClockWarnings,
  boardClocksOf,
  countLive,
  memberCell,
  mseedSummary,
  mseedWarnings,
  sensorRowHtml,
  stationRowHtml,
  worstPairDiff,
} from './viewStatus'

const MSEED_QUIET = {
  writeErrors: 0,
  lostRecords: 0,
  recordsWritten: 41235,
  unreadableWritten: 3,
  lastWriteError: null,
  lastInternalError: null,
} as const

describe('mseedWarnings / mseedSummary', () => {
  it('正: 書き込みの理由と組み立ての例外を、それぞれ 1 行で出す', () => {
    expect(mseedWarnings({ ...MSEED_QUIET, lastWriteError: 'ENOSPC', lastInternalError: 'TypeError: x' })).toEqual([
      '生データの書き込みエラー: ENOSPC',
      '生データの組み立てで想定外の例外: TypeError: x',
    ])
  })

  it('対照: どちらの理由も無ければ何も出さない', () => {
    expect(mseedWarnings(MSEED_QUIET)).toEqual([])
  })

  it('安全弁: 理由の文面はエスケープする（無認証の UDP 由来の中身が混ざりうる）', () => {
    expect(mseedWarnings({ ...MSEED_QUIET, lastInternalError: '<img src=x>' })[0]).toContain('&lt;img')
  })

  it('欄の 1 行に 4 つの数を並べる', () => {
    expect(mseedSummary(MSEED_QUIET)).toBe(
      '書き込みエラー: 0 件 / 失った記録: 0 本 / 書けたレコード: 41235 本 / 中身ごと残した読めないパケット: 3 件',
    )
  })
})

/** センサー対 1 組ぶんの差分の強さ（`/status` から読む形）。 */
function pair(rmsGal: readonly (number | null)[], id = 'a') {
  return {
    a: { boardKey: `mac:${id}`, sensorId: 's0' },
    b: { boardKey: 'mac:zz', sensorId: 's0' },
    rmsGal,
    sampleCount: rmsGal.map(() => 30),
  }
}

describe('memberCell', () => {
  it('正: 揃っていれば本数、揺れていれば幅で出す（#315）', () => {
    expect(memberCell(9, 9)).toBe('9 本')
    expect(memberCell(1, 7)).toContain('1〜7 本')
  })

  it('安全弁: 幅が出ていても警めの色にしない', () => {
    // **実機は正常運転でも幅が出る**（まとまりの末尾で 1〜3 本欠ける。
    // REQUIREMENTS.md §7）。色を付けると常に警告が出ている状態になり、
    // #362 の本物の乱れと区別が付かないまま印そのものが信用されなくなる。
    // **どこからが異常かの物差しは未設計**（#374）。
    expect(memberCell(1, 7)).not.toContain('badge')
    expect(memberCell(8, 9)).not.toContain('badge')
  })

  it('対照: まだ合成していなければ「—」', () => {
    expect(memberCell(null, null)).toBe('—')
  })

  it('安全弁: 欄が無い（undefined）ときも「—」へ倒す', () => {
    // **`/status` は無検証のキャストで読んでいる。** 版がずれて欄が落ちると
    // `undefined` が来るが、`undefined === undefined` は真なので `null` だけを
    // 見る形だと**「undefined 本」というそれらしい文字列が画面へ出る**。
    expect(memberCell(undefined, undefined)).toBe('—')
    expect(memberCell(undefined, 9)).toBe('—')
    // 数として読めない値も同じ扱い（`readFinite` が倒す）。
    expect(memberCell('9', '9')).toBe('—')
    expect(memberCell(Number.NaN, Number.NaN)).toBe('—')
  })
})

describe('worstPairDiff', () => {
  it('正: いちばん離れている対と、その軸の値を返す（#315）', () => {
    const worst = worstPairDiff([pair([1, 2, 3], 'a'), pair([0.5, 9, 0.5], 'b'), pair([4, 4, 4], 'c')])

    expect(worst?.rmsGal).toBe(9)
    expect(worst?.pair.a.boardKey).toBe('mac:b')
  })

  it('正: 軸ごとの最大を採る（3 軸を平均しない）', () => {
    // **感度のずれは軸ごとに現れる**（#367）。平均すると 1 軸だけおかしい対が薄まる。
    const worst = worstPairDiff([pair([5, 5, 5], 'flat'), pair([0, 0, 9], 'oneAxis')])

    expect(worst?.pair.a.boardKey).toBe('mac:oneAxis')
  })

  it('対照: 測れなかった軸（null）は候補にしない', () => {
    // 0 で埋めると「差が無かった」対として最大の争いに混ざる。
    const worst = worstPairDiff([pair([null, null, 2])])

    expect(worst?.rmsGal).toBe(2)
  })

  it('安全弁: 1 組も無い・全軸が測れなかったなら null', () => {
    expect(worstPairDiff([])).toBeNull()
    expect(worstPairDiff([pair([null, null, null])])).toBeNull()
  })
})

/** 画面を組み立てた時刻（`/status` の `generatedAtMs`）。 */
const NOW = 1_800_000_000_000

/** 観測点 1 つぶん（`/status` から読む形）。 */
function station(lastPacketMs: number | null, lastSkipReason: string | null = null) {
  return {
    stationId: 'station-1',
    lastPacketMs,
    lastIntensity: 1.23,
    lastSkipReason,
    lastMemberCountMin: 8,
    lastMemberCountMax: 9,
    pairDiffs: [pair([1, 2, 3])],
  }
}

/** センサー 1 個ぶん（同上）。 */
function sensor(lastPacketMs: number | null, lastSkipReason: string | null = null) {
  return {
    boardKey: 'mac:aa',
    sensorId: 's0',
    lastPacketMs,
    lastIntensity: 0.45,
    lastSkipReason,
    enabled: true,
    calibrationConfigured: true,
    station: { displayName: '自宅' },
  }
}

describe('stationRowHtml', () => {
  it('正: 途絶したら震度・混ざった本数・差分の 3 欄を赤くする（#373）', () => {
    // **合成の帳面は設定を変えても作り直さない**ので、管理コンソールで消した観測点の
    // 行はホストを入れ直すまで残る。3 欄はどれも「最後に合成できたときの値」なので、
    // 1 つだけ赤くすると残りが今の姿だと読めてしまう。
    const html = stationRowHtml(NOW, station(NOW - STALE_AFTER_MS - 1))

    expect(html.match(/stale-value/g)?.length).toBe(3)
  })

  it('対照: 受信中の行には印を付けない（境界のちょうどは受信中）', () => {
    expect(stationRowHtml(NOW, station(NOW - 1000))).not.toContain('stale-value')
    // `isStale` は「超えたら」途絶（`dom.ts`）。ここを `>=` へ倒すと、
    // ちょうど 60 秒の行だけが赤くなったり戻ったりする。
    expect(stationRowHtml(NOW, station(NOW - STALE_AFTER_MS))).not.toContain('stale-value')
  })

  it('正: 届いていても震度を出せていない間は、震度の欄だけ赤くする', () => {
    // **`lastSkipReason` が立っている間、震度は 1 つも出ていない。** それでも駆動役の
    // 到着で受信の時刻は動き続けるので、到着だけを見ていると「基板は生きているが
    // 合成だけ壊れている」状態で最後の震度が平常の色のまま居座る。
    //
    // **混ざった本数と差分は赤くしない。** あの 2 つは合成波形が出た回に書き換わり、
    // `noteSkip` はその同じ回に呼ばれる（`main.ts` の `deliverStationFusion`）
    // ——つまり波形は出ている＝あの 2 つは今の姿。
    const html = stationRowHtml(NOW, station(NOW - 1000, 'no-stream'))

    expect(html).toContain('<td class="stale-value">1.23</td>')
    expect(html.match(/stale-value/g)?.length).toBe(1)
  })

  it('安全弁: 欄が無い（undefined）ときは理由が立っていないものとして扱う', () => {
    // `/status` は無検証のキャストで読んでいるので、版がずれて欄が落ちると
    // `undefined` が来る。**真偽で見ると `undefined` は偽**だが、うっかり
    // `!== null` で書くと**全行の震度が赤くなる**（誰も震度を出せていないように見える）。
    const row = { ...station(NOW - 1000), lastSkipReason: undefined } as unknown as ReturnType<typeof station>
    const html = stationRowHtml(NOW, row)

    expect(html).not.toContain('stale-value')
  })

  it('安全弁: 観測点 ID と受信欄には印を付けない', () => {
    // 行を丸ごと赤くすると「どれの話か」が読み取りにくくなる。受信欄には既に
    // 同じ色の「途絶」の札が出ているので、重ねて色を足さない。
    const html = stationRowHtml(NOW, station(null))

    expect(html).toContain('<td>station-1</td>')
    expect(html).toContain('<td><span class="badge stale">途絶</span> 未受信</td>')
  })
})

describe('sensorRowHtml', () => {
  it('正: 途絶したら計測震度を赤くする（#373）', () => {
    const html = sensorRowHtml(NOW, sensor(NOW - STALE_AFTER_MS - 1))

    expect(html).toContain('<td class="stale-value">0.45</td>')
    expect(html.match(/stale-value/g)?.length).toBe(1)
  })

  it('対照: 受信中のセンサーには印を付けない', () => {
    expect(sensorRowHtml(NOW, sensor(NOW - 1000))).not.toContain('stale-value')
  })

  it('正: 届いていても震度を出せていない間は赤くする', () => {
    // センサー側の `lastSkipReason` も観測点と同じ意味（軸数が違う・流し込みを作れない）。
    // **パケットは届くのに震度が出ない**状態が何日続いてもここが唯一の手掛かりになる。
    expect(sensorRowHtml(NOW, sensor(NOW - 1000, 'axis-mismatch'))).toContain('<td class="stale-value">0.45</td>')
  })

  it('安全弁: 設定そのものの欄（有効・校正）は古くならないので赤くしない', () => {
    // あの 2 つは `/status` を組み立てる時点の設定から引いている（`statusReport.ts`）。
    // 届かなくなっても古くならないので、赤くすると「設定が壊れた」と読める。
    const html = sensorRowHtml(NOW, sensor(null))

    expect(html).toContain('<td>有効</td>')
    expect(html).toContain('<td>設定あり</td>')
  })
})

describe('countLive', () => {
  it('正: 途絶していない行だけを数える（#373）', () => {
    // 要約カードを全体の件数だけで出すと、観測点を 1 つへ減らした後も減らす前の
    // 数を数え続ける（帳面が作り直されないため）。
    const rows = [{ lastPacketMs: NOW - 1000 }, { lastPacketMs: NOW - STALE_AFTER_MS - 1 }]

    expect(countLive(NOW, rows)).toBe(1)
  })

  it('安全弁: まだ一度も届いていない（null）行は数えない', () => {
    expect(countLive(NOW, [{ lastPacketMs: null }])).toBe(0)
  })
})

describe('assignedBoardsOf', () => {
  it('安全弁: この欄を持たない古いホストからは空として読む（画面ごと倒さない）', () => {
    expect(assignedBoardsOf({})).toEqual([])
  })
})

describe('boardClocksOf', () => {
  it('安全弁: この欄を持たない古いホストからは空として読む（画面ごと倒さない）', () => {
    expect(boardClocksOf({})).toEqual([])
    expect(boardClocksOf({ boardClocks: { boards: 'x' } as unknown as never })).toEqual([])
  })
})

describe('boardClockWarnings', () => {
  const clock = (boardKey: string, offsetMs: number | null, lastPacketMs: number | null = NOW - 100) => ({
    boardKey,
    offsetMs,
    windowEndMs: NOW - 1_000,
    packets: 600,
    lastPacketMs,
  })

  it('正: 許容を超えた基板をまとめて 1 行で出す（ホストのログと同じ判定）', () => {
    expect(boardClockWarnings(NOW, [clock('mac:a0b7', 1301), clock('mac:1c8f', -400), clock('mac:3c8a', 40)])).toEqual([
      '時計がホストとずれている基板: mac:a0b7（1301 ms 遅れ）、mac:1c8f（400 ms 進み）' +
        '（100 ms を超えると、観測点の合成がその基板を欠きはじめる）',
    ])
  })

  it('対照: 許容の内・まだ測れていない・黙った基板は出さない', () => {
    expect(
      boardClockWarnings(NOW, [
        clock('mac:aa', 40),
        clock('mac:bb', null),
        clock('mac:cc', 1301, NOW - STALE_AFTER_MS - 1),
      ]),
    ).toEqual([])
  })

  it('安全弁: 基板 Key はエスケープする（無認証の UDP 由来）', () => {
    const [line] = boardClockWarnings(NOW, [clock('name:<img>', 1301)])
    expect(line).not.toContain('<img>')
    expect(line).toContain('&lt;img&gt;')
  })
})

describe('assignedSilenceWarnings', () => {
  type SensorRow = { sensorId: string; lastPacketMs: number | null; state: string }
  const board = (state: string, lastPacketMs: number | null = null, sensors: SensorRow[] = []) => ({
    boardKey: 'mac:aa',
    stationId: 'garage',
    lastPacketMs,
    state,
    sensors,
  })

  it('正: 黙った基板を「いつから」付きで出す（ホストのログと同じ文面）', () => {
    expect(assignedSilenceWarnings(NOW, [board('silent')])).toEqual([
      '観測点に割り当てた基板が届いていない: mac:aa（観測点 garage・一度も届いていない）',
    ])
    expect(assignedSilenceWarnings(NOW, [board('silent', NOW - 95_000)])[0]).toContain(
      '（観測点 garage・最後に届いてから 95 秒）',
    )
  })

  it('安全弁: 時刻の欄が無い版（undefined）でも「一度も」に倒れ、NaN 秒を出さない', () => {
    const legacy = { boardKey: 'mac:aa', stationId: 'garage', state: 'silent', sensors: [] }
    const [line] = assignedSilenceWarnings(NOW, [legacy as unknown as ReturnType<typeof board>])
    expect(line).toContain('一度も届いていない')
    expect(line).not.toContain('NaN')
  })

  it('対照: 受信中と保留（起動直後）は出さない', () => {
    expect(assignedSilenceWarnings(NOW, [board('live', NOW), board('waiting')])).toEqual([])
  })

  it('正: 基板が届いているときだけ、名前を書いたセンサーの沈黙を出す', () => {
    const silentSensor = [{ sensorId: 's1', lastPacketMs: NOW - 168_000, state: 'silent' }]
    expect(assignedSilenceWarnings(NOW, [board('live', NOW, silentSensor)])[0]).toContain(
      'mac:aa / s1（最後に届いてから 168 秒）',
    )
    expect(assignedSilenceWarnings(NOW, [board('silent', null, silentSensor)])).toHaveLength(1)
  })

  it('安全弁: 基板 Key・観測点はエスケープする（無認証の UDP 由来・運用者の入力）', () => {
    const [line] = assignedSilenceWarnings(NOW, [
      { boardKey: 'name:<img>', stationId: '"x"', lastPacketMs: null, state: 'silent', sensors: [] },
    ])
    expect(line).not.toContain('<img>')
    expect(line).toContain('&lt;img&gt;')
    expect(line).toContain('&quot;x&quot;')
  })
})
