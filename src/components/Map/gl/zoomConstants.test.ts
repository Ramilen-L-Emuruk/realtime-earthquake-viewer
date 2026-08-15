import { describe, it, expect } from 'vitest'
import { MAX_ZOOM } from './camera'
import { QUAKE_MAX_ZOOM } from '../../../hooks/useQuakeLayerData'
import {
  desiredTileZoom,
  GEBCO_HIRES_MIN_ZOOM,
  GEBCO_OVERVIEW_MAX_ZOOM,
  GEBCO_SOURCE_MAX_ZOOM,
  GEBCO_TILE_SIZE,
  MAX_TILE_ZOOM,
} from '../../../utils/gebcoPrefetch'

// 複数モジュールに散らばるズーム閾値の「相互関係」を固定する回帰テスト。
//
// MapLibre GL JS のズームは 512px タイル基準で、Leaflet（256px 基準）の同じ数値より 1 段深い。
// 移行時にこの差を無視して Leaflet 版の値をそのまま持ち込んだため、自動フィットの上限が意図の
// 2 倍寄っていた（かつラベルの表示開始ズームには届かず地名が出なかった）という事故があった。
// 同種の取り違えを機械的に検出できるよう、値そのものではなく定数どうしの関係を固定する。
//
// テスト対象がモジュール横断のため、個々のモジュールの単体テスト（camera.test.ts 等）ではなく
// 専用ファイルに置く。

describe('ズーム閾値の相互関係', () => {
  it('区域集約の閾値がカメラの寄り上限と同値（フィット着地後は必ず区域集約になる前提）', () => {
    // useQuakeLayerData は MAX_ZOOM から導出しているため現状は自明に真。
    // 将来また独自リテラルへ戻された場合に落ちることを狙ったガード。
    expect(QUAKE_MAX_ZOOM).toBe(MAX_ZOOM)
  })

  it('GEBCO 先読みの最大タイル z がマップズーム上限より深い（タイル座標系との混同検出）', () => {
    // 512px より小さいタイルのソースは、マップズーム z のときタイル z+1 を要求する。
    // MAX_ZOOM をそのままタイル z として使うと、自動フィット上限で実際に使うタイルが先読みから漏れる。
    // なお MAX_ZOOM を GEBCO_SOURCE_MAX_ZOOM 以上まで上げるとクランプが効いて両者が並び、この
    // 不等号は意図的に成り立たなくなる（そのときは先読み範囲の設計自体を見直すこと）。
    expect(GEBCO_TILE_SIZE).toBeLessThan(512)
    expect(MAX_TILE_ZOOM).toBeGreaterThan(MAX_ZOOM)
  })

  it('GEBCO 先読みの最大タイル z がタイルセットの実在最大 z を超えない', () => {
    // 超えると存在しないタイルを叩くが、先読みは失敗を握りつぶすため無症状で空回りする。
    expect(MAX_TILE_ZOOM).toBeLessThanOrEqual(GEBCO_SOURCE_MAX_ZOOM)
  })

  it('海底地形の高解像度層の下限ズームが、下地層と同一タイルを要求する帯のちょうど外側にある', () => {
    // 下限ズームでは、上層が下地層（maxzoom でクランプされる）より深いタイルを要求する。ここが崩れると
    // 2 層が同じタイルを個別に取得するだけの帯が残る（実測でその帯の存在を確認済み）。
    expect(desiredTileZoom(GEBCO_HIRES_MIN_ZOOM)).toBeGreaterThan(GEBCO_OVERVIEW_MAX_ZOOM)
    // わずかに下のズームでは重複帯の内側にいる（＝そこで上層を描かない判断が正しい）。下限を必要以上に
    // 高くすると、二重取得は起きないままここが破れる。境界を両側から締めることで「寄っても高解像度が
    // 出ない」劣化を検出する。
    expect(desiredTileZoom(GEBCO_HIRES_MIN_ZOOM - 0.01)).toBeLessThanOrEqual(GEBCO_OVERVIEW_MAX_ZOOM)
    // 自動フィットの寄り上限では必ず高解像度層が出る。
    expect(GEBCO_HIRES_MIN_ZOOM).toBeLessThan(MAX_ZOOM)
  })
})
