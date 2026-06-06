import { useState, useRef } from 'react'
import type { KnetRecord } from '../../types/replay'
import { parseKnetAscii, buildKnetRecord } from '../../services/knetParser'
import type { KnetFileData } from '../../services/knetParser'

interface Props {
  onLoad: (knet: KnetRecord) => void
}

export function KnetUpload({ onLoad }: Props) {
  const [loaded, setLoaded] = useState<{ files: KnetFileData[]; record: KnetRecord } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const processFiles = async (fileList: FileList) => {
    setError(null)
    const parsed: KnetFileData[] = []

    for (const file of Array.from(fileList)) {
      try {
        const text = await file.text()
        parsed.push(parseKnetAscii(text))
      } catch (e) {
        setError(`${file.name}: ${e instanceof Error ? e.message : '解析失敗'}`)
        return
      }
    }

    if (parsed.length === 0) return

    try {
      const record = buildKnetRecord(parsed)
      setLoaded({ files: parsed, record })
      onLoad(record)
    } catch (e) {
      setError(e instanceof Error ? e.message : '変換失敗')
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer.files.length > 0) processFiles(e.dataTransfer.files)
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) processFiles(e.target.files)
  }

  const handleClear = () => {
    setLoaded(null)
    setError(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  if (loaded) {
    const { files, record } = loaded
    const originStr = record.originTime.toLocaleString('ja-JP', {
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    return (
      <div className="bg-card border border-green-800 rounded-lg p-3 text-xs space-y-1">
        <div className="flex justify-between items-center">
          <span className="text-green-400 font-medium">K-NET 読み込み済み</span>
          <button onClick={handleClear} className="text-secondary hover:text-white text-base leading-none">×</button>
        </div>
        <div className="text-secondary space-y-0.5">
          <div>観測点: <span className="text-white">{record.stationCode}</span></div>
          <div>震源時刻: <span className="text-white">{originStr}</span></div>
          <div>M{record.magnitude}　深さ {record.depthKm} km</div>
          <div>チャンネル: {files.map(f => f.channel.direction).join(' / ')}</div>
        </div>
      </div>
    )
  }

  return (
    <div
      onDrop={handleDrop}
      onDragOver={e => e.preventDefault()}
      onClick={() => inputRef.current?.click()}
      className="border-2 border-dashed border-border hover:border-blue-500 rounded-lg p-4 text-center cursor-pointer transition-colors"
    >
      <input
        ref={inputRef}
        type="file"
        accept=".txt,.knet,.EW,.NS,.UD,.NS2,.EW2,.UD2"
        multiple
        className="hidden"
        onChange={handleChange}
      />
      <div className="text-sm text-white mb-1">K-NET ファイルを選択</div>
      <div className="text-xs text-secondary space-y-0.5">
        <div>クリックまたはドラッグ＆ドロップ</div>
        <div>K-NET ASCII 形式（.txt など）</div>
        <div>1〜3 ファイル（NS / EW / UD）同時選択可</div>
      </div>
      {error && <div className="text-red-400 text-xs mt-2 text-left break-all">{error}</div>}
    </div>
  )
}
