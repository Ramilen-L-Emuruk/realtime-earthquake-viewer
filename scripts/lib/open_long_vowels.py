# 読み（カタカナ）の長音を、母音の重ねへ開く。
#
# 【なぜ要るか】気象庁のふりがなは長音を「う」「い」で書く（`ちょう`・`せいぶ`）。それを
# そのままカタカナにして読み上げへ渡すと、VOICEVOX は `ho`+`u` の 2 音として合成してしまい、
# 長音（`ho`+`o`）にならない。日本語として不自然な音になる。
#
# 【なぜ機械的に置換できないか】「オ段＋ウ」が長音かどうかは**語の切れ目**で決まる。
# `ちょう`（町）は長音だが、`のうら`（ノ＋浦）や `そとうみ`（外＋海）は長音ではない。
# ふりがなだけを見ても区別が付かないので、漢字を形態素へ割って判定する。
#
# 【やり方】形態素解析（fugashi ＋ unidic-lite）が返す「表記読み」(kana) と「発音」(pron) を使う。
# pron は長音を `ー` で持っているので、これを母音へ開けば正しい読みになる。
# **形態素ごとに照合し、ふりがなと一致した形態素だけ pron へ差し替える。** 一致しない形態素は
# ふりがなのまま残す（開かない＝安全側）。辞書に入っているのはエンジンが誤読する名前なので、
# 解析器の読みも違うことが普通にある。
#
# **先頭と末尾から貪欲に当てる。** 名前全体で長さを合わせる形だと、中央に 1 つ誤読があるだけで
# その名前をまるごと諦めることになる（実測で 2669 件中 1363 件が該当した）。端から当てれば
# 中央だけ残して両端を開ける（同じ実測で、値が変わる件数が 930 → 1325 件へ伸びた）。
#
# 【使い方】stdin へ JSON `[{"name": 漢字, "reading": カタカナ}, ...]`、stdout へ JSON
# `[開いた読み, ...]` を返す。呼び出し側は `scripts/lib/longVowel.ts`。
import json
import sys

import fugashi

_TAGGER = fugashi.Tagger()

# 長音記号の直前の字から母音を引く表。
_VOWEL_OF = {}
for _row, _vowel in (
    ('アカサタナハマヤラワガザダバパャ', 'ア'),
    ('イキシチニヒミリギジヂビピ', 'イ'),
    ('ウクスツヌフムユルグズヅブプュ', 'ウ'),
    ('エケセテネヘメレゲゼデベペェ', 'エ'),
    ('オコソトノホモヨロヲゴゾドボポョ', 'オ'),
):
    for _ch in _row:
        _VOWEL_OF[_ch] = _vowel


def open_long(pron: str) -> str:
    """長音記号を直前の母音へ開く。先頭に来た `ー` は開けないのでそのまま残す。"""
    out = ''
    for ch in pron:
        if ch == 'ー' and out:
            out += _VOWEL_OF.get(out[-1], out[-1])
        else:
            out += ch
    return out


def _morphemes(name: str):
    """(表記読み, 発音) の並び。読みを持たない語が混じれば None。"""
    out = []
    for word in _TAGGER(name):
        kana = getattr(word.feature, 'kana', None)
        if not kana or kana == '*':
            return None
        pron = getattr(word.feature, 'pron', None)
        out.append((kana, pron if pron and pron != '*' else kana))
    return out


def open_reading(name: str, reading: str) -> str:
    """
    漢字表記 `name` を手がかりに、`reading`（カタカナ）の長音を開く。

    **モーラ数は変えない。** 開いた結果の長さが元と変われば、その形態素は採らない
    （核の位置は読みの長さで数えているので、ずれると辞書の値が壊れる）。
    """
    morphemes = _morphemes(name)
    if morphemes is None:
        return reading

    def take(kana: str, pron: str, part: str) -> str:
        opened = open_long(pron)
        if len(opened) != len(part):
            return part
        # **採るのは長音の開き（ウ → オ・イ → エ）だけ。** 解析器の発音は現代仮名遣いへ寄せるので
        # `ヅ` → `ズ`・`ヂ` → `ジ` の書き換えが混じる（実測で 43 件）。音素は同じだが
        # （どちらも `zu`）、気象庁のふりがなから離れる理由が無いので元の字を残す。
        return ''.join(
            o if (o == c or (c == 'ウ' and o == 'オ') or (c == 'イ' and o == 'エ')) else c
            for c, o in zip(part, opened)
        )

    head = []
    i = 0
    pos = 0
    while i < len(morphemes) and reading.startswith(morphemes[i][0], pos):
        kana, pron = morphemes[i]
        head.append(take(kana, pron, reading[pos:pos + len(kana)]))
        pos += len(kana)
        i += 1

    tail = []
    j = len(morphemes) - 1
    end = len(reading)
    while j >= i and reading.endswith(morphemes[j][0], pos, end):
        kana, pron = morphemes[j]
        tail.insert(0, take(kana, pron, reading[end - len(kana):end]))
        end -= len(kana)
        j -= 1

    return ''.join(head) + reading[pos:end] + ''.join(tail)


def main() -> None:
    items = json.load(sys.stdin)
    out = [open_reading(item['name'], item['reading']) for item in items]
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
