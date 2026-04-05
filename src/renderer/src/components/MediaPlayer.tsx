import { useRef, useState, useEffect, useCallback } from 'react'

type VisMode = 'bars' | 'wave' | 'circular' | 'spectrum'

const VIS_LABELS: Record<VisMode, string> = {
  bars: 'Bars',
  wave: 'Waveform',
  circular: 'Radial',
  spectrum: 'Spectrum'
}

function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function MediaPlayer(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number>(0)
  const dropRef = useRef<HTMLDivElement>(null)

  const [file, setFile] = useState<{ name: string; path: string } | null>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(0.8)
  const [visMode, setVisMode] = useState<VisMode>('bars')
  const [dragging, setDragging] = useState(false)

  // ── Audio context setup ──
  const setupAudio = useCallback((url: string) => {
    // Tear down previous
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.src = ''
    }

    const audio = new Audio(url)
    audio.crossOrigin = 'anonymous'
    audio.volume = volume
    audioRef.current = audio

    if (!ctxRef.current) {
      ctxRef.current = new AudioContext()
    }
    const actx = ctxRef.current

    // Disconnect old source to avoid InvalidStateError
    if (sourceRef.current) {
      try { sourceRef.current.disconnect() } catch { /* already disconnected */ }
    }

    const source = actx.createMediaElementSource(audio)
    const analyser = actx.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.82
    source.connect(analyser)
    analyser.connect(actx.destination)

    sourceRef.current = source
    analyserRef.current = analyser

    audio.addEventListener('loadedmetadata', () => setDuration(audio.duration))
    audio.addEventListener('timeupdate', () => setCurrentTime(audio.currentTime))
    audio.addEventListener('ended', () => setPlaying(false))

    audio.play().then(() => {
      setPlaying(true)
      if (actx.state === 'suspended') actx.resume()
    })
  }, [volume])

  // ── File drop handler ──
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (!f) return
    const ext = f.name.split('.').pop()?.toLowerCase() || ''
    const audioExts = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus', 'webm', 'mp4']
    if (!audioExts.includes(ext)) return
    setFile({ name: f.name, path: URL.createObjectURL(f) })
    setupAudio(URL.createObjectURL(f))
  }, [setupAudio])

  const handleFileSelect = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'audio/*,.mp3,.wav,.flac,.ogg,.m4a,.aac,.opus'
    input.onchange = () => {
      const f = input.files?.[0]
      if (!f) return
      setFile({ name: f.name, path: URL.createObjectURL(f) })
      setupAudio(URL.createObjectURL(f))
    }
    input.click()
  }, [setupAudio])

  // ── Playback controls ──
  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (ctxRef.current?.state === 'suspended') ctxRef.current.resume()
    if (audio.paused) {
      audio.play()
      setPlaying(true)
    } else {
      audio.pause()
      setPlaying(false)
    }
  }, [])

  const seek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = parseFloat(e.target.value)
  }, [])

  const changeVolume = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value)
    setVolume(v)
    if (audioRef.current) audioRef.current.volume = v
  }, [])

  // ── Canvas visualizer ──
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    let running = true
    const resizeCanvas = (): void => {
      const rect = canvas.parentElement?.getBoundingClientRect()
      if (!rect) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.scale(dpr, dpr)
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
    }
    resizeCanvas()
    const ro = new ResizeObserver(resizeCanvas)
    ro.observe(canvas.parentElement!)

    const freqData = new Uint8Array(1024)
    const timeData = new Uint8Array(2048)

    // Smooth values for bars mode
    const smoothBars = new Float32Array(128).fill(0)

    const draw = (): void => {
      if (!running) return
      rafRef.current = requestAnimationFrame(draw)

      const W = canvas.width / (window.devicePixelRatio || 1)
      const H = canvas.height / (window.devicePixelRatio || 1)

      ctx.fillStyle = '#0a0a0f'
      ctx.fillRect(0, 0, W, H)

      const analyser = analyserRef.current
      if (!analyser) {
        drawIdle(ctx, W, H)
        return
      }

      analyser.getByteFrequencyData(freqData)
      analyser.getByteTimeDomainData(timeData)

      switch (visMode) {
        case 'bars':
          drawBars(ctx, freqData, smoothBars, W, H)
          break
        case 'wave':
          drawWave(ctx, timeData, W, H)
          break
        case 'circular':
          drawCircular(ctx, freqData, timeData, W, H)
          break
        case 'spectrum':
          drawSpectrum(ctx, freqData, W, H)
          break
      }
    }

    draw()

    return () => {
      running = false
      cancelAnimationFrame(rafRef.current)
      ro.disconnect()
    }
  }, [visMode])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.src = ''
      }
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  const cycleVisMode = useCallback(() => {
    const modes: VisMode[] = ['bars', 'wave', 'circular', 'spectrum']
    setVisMode((m) => modes[(modes.indexOf(m) + 1) % modes.length])
  }, [])

  return (
    <div className="flex flex-col h-full animate-fade-in gap-4">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-white">Media Player</h1>
          <p className="text-sm text-surface-400 mt-0.5">
            {file ? file.name : 'Drop an audio file or click to browse'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={cycleVisMode}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-surface-800 border border-surface-600 text-surface-300 hover:text-white hover:border-accent-500 transition-colors"
          >
            {VIS_LABELS[visMode]}
          </button>
          <button
            onClick={handleFileSelect}
            className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-accent-600 hover:bg-accent-500 text-white shadow-glow hover:shadow-glow-lg transition-all"
          >
            Open File
          </button>
        </div>
      </div>

      {/* Canvas area */}
      <div
        ref={dropRef}
        className={`flex-1 relative rounded-2xl overflow-hidden border transition-colors ${
          dragging ? 'border-accent-400 bg-accent-500/5' : 'border-white/5 bg-surface-900/50'
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
        />
        {!file && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="mx-auto text-surface-600 mb-3">
                <path d="M9 18V5l12-2v13" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="16" r="3" />
              </svg>
              <p className="text-surface-500 text-sm">Drop audio file here</p>
            </div>
          </div>
        )}
        {dragging && (
          <div className="absolute inset-0 flex items-center justify-center bg-accent-500/10 backdrop-blur-sm">
            <p className="text-accent-300 font-semibold text-lg">Drop to play</p>
          </div>
        )}
      </div>

      {/* Transport controls */}
      <div className="shrink-0 glass rounded-xl px-5 py-4 space-y-3">
        {/* Seek bar */}
        <div className="flex items-center gap-3">
          <span className="text-2xs text-surface-500 font-mono w-10 text-right">{formatTime(currentTime)}</span>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={currentTime}
            onChange={seek}
            className="flex-1 h-1 accent-accent-500 cursor-pointer"
            style={{ accentColor: 'var(--tw-accent-500, #8b5cf6)' }}
          />
          <span className="text-2xs text-surface-500 font-mono w-10">{formatTime(duration)}</span>
        </div>
        {/* Buttons row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={togglePlay}
              disabled={!file}
              className="w-10 h-10 rounded-full bg-accent-600 hover:bg-accent-500 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center text-white transition-all shadow-glow hover:shadow-glow-lg"
            >
              {playing ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20" /></svg>
              )}
            </button>
            {file && (
              <span className="text-xs text-surface-300 font-medium truncate max-w-[300px]">{file.name}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-surface-500">
              <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
            </svg>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={changeVolume}
              className="w-20 h-1 accent-surface-400 cursor-pointer"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Visualization renderers ──

function drawIdle(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const cy = H / 2
  ctx.strokeStyle = 'rgba(139, 92, 246, 0.15)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  for (let x = 0; x < W; x++) {
    const y = cy + Math.sin(x * 0.02 + Date.now() * 0.001) * 8
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  }
  ctx.stroke()
}

function drawBars(
  ctx: CanvasRenderingContext2D,
  freq: Uint8Array,
  smooth: Float32Array,
  W: number,
  H: number
): void {
  const count = 64
  const gap = 2
  const barW = (W - gap * (count - 1)) / count
  const scale = H / 255

  for (let i = 0; i < count; i++) {
    // Use logarithmic frequency mapping for a more musical distribution
    const fi = Math.floor(Math.pow(i / count, 1.5) * freq.length * 0.5)
    const raw = freq[fi] || 0
    // Smooth with lerp
    smooth[i] += (raw - smooth[i]) * 0.25
    const h = smooth[i] * scale * 0.85

    const x = i * (barW + gap)
    const y = H - h

    // Gradient per bar
    const grad = ctx.createLinearGradient(x, H, x, y)
    grad.addColorStop(0, 'rgba(139, 92, 246, 0.9)')  // accent purple
    grad.addColorStop(0.5, 'rgba(168, 85, 247, 0.7)')
    grad.addColorStop(1, 'rgba(59, 130, 246, 0.5)')   // blue top

    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.roundRect(x, y, barW, h, [3, 3, 0, 0])
    ctx.fill()

    // Glow
    ctx.shadowColor = 'rgba(139, 92, 246, 0.3)'
    ctx.shadowBlur = 8
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.roundRect(x, y, barW, Math.min(h, 4), [3, 3, 0, 0])
    ctx.fill()
    ctx.shadowBlur = 0

    // Reflection
    const reflGrad = ctx.createLinearGradient(x, H, x, H + h * 0.3)
    reflGrad.addColorStop(0, 'rgba(139, 92, 246, 0.12)')
    reflGrad.addColorStop(1, 'rgba(139, 92, 246, 0)')
    ctx.fillStyle = reflGrad
    ctx.fillRect(x, H, barW, h * 0.3)
  }
}

function drawWave(
  ctx: CanvasRenderingContext2D,
  time: Uint8Array,
  W: number,
  H: number
): void {
  const cy = H / 2
  const sliceW = W / time.length

  // Filled wave body
  ctx.beginPath()
  ctx.moveTo(0, cy)
  for (let i = 0; i < time.length; i++) {
    const v = time[i] / 128.0
    const y = v * cy
    ctx.lineTo(i * sliceW, y)
  }
  ctx.lineTo(W, cy)
  ctx.closePath()

  const grad = ctx.createLinearGradient(0, 0, 0, H)
  grad.addColorStop(0, 'rgba(59, 130, 246, 0.08)')
  grad.addColorStop(0.5, 'rgba(139, 92, 246, 0.15)')
  grad.addColorStop(1, 'rgba(59, 130, 246, 0.08)')
  ctx.fillStyle = grad
  ctx.fill()

  // Stroke line
  ctx.beginPath()
  for (let i = 0; i < time.length; i++) {
    const v = time[i] / 128.0
    const y = v * cy
    i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * sliceW, y)
  }
  ctx.strokeStyle = 'rgba(139, 92, 246, 0.8)'
  ctx.lineWidth = 2
  ctx.shadowColor = 'rgba(139, 92, 246, 0.5)'
  ctx.shadowBlur = 12
  ctx.stroke()
  ctx.shadowBlur = 0

  // Mirror line
  ctx.beginPath()
  for (let i = 0; i < time.length; i++) {
    const v = time[i] / 128.0
    const y = H - v * cy
    i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * sliceW, y)
  }
  ctx.strokeStyle = 'rgba(139, 92, 246, 0.2)'
  ctx.lineWidth = 1
  ctx.stroke()
}

function drawCircular(
  ctx: CanvasRenderingContext2D,
  freq: Uint8Array,
  time: Uint8Array,
  W: number,
  H: number
): void {
  const cx = W / 2
  const cy = H / 2
  const baseR = Math.min(W, H) * 0.22
  const maxR = Math.min(W, H) * 0.42
  const count = 180
  const angleStep = (Math.PI * 2) / count
  const t = Date.now() * 0.0003

  // Outer frequency ring
  ctx.beginPath()
  for (let i = 0; i < count; i++) {
    const fi = Math.floor((i / count) * freq.length * 0.5)
    const v = (freq[fi] || 0) / 255
    const r = baseR + v * (maxR - baseR)
    const angle = i * angleStep - Math.PI / 2 + t
    const x = cx + Math.cos(angle) * r
    const y = cy + Math.sin(angle) * r
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.strokeStyle = 'rgba(139, 92, 246, 0.7)'
  ctx.lineWidth = 2
  ctx.shadowColor = 'rgba(139, 92, 246, 0.4)'
  ctx.shadowBlur = 16
  ctx.stroke()
  ctx.shadowBlur = 0

  // Fill
  const grad = ctx.createRadialGradient(cx, cy, baseR * 0.5, cx, cy, maxR)
  grad.addColorStop(0, 'rgba(139, 92, 246, 0.05)')
  grad.addColorStop(1, 'rgba(139, 92, 246, 0.02)')
  ctx.fillStyle = grad
  ctx.fill()

  // Inner waveform ring
  ctx.beginPath()
  const innerR = baseR * 0.7
  for (let i = 0; i < count; i++) {
    const ti = Math.floor((i / count) * time.length)
    const v = (time[ti] - 128) / 128
    const r = innerR + v * innerR * 0.3
    const angle = i * angleStep - Math.PI / 2 + t
    const x = cx + Math.cos(angle) * r
    const y = cy + Math.sin(angle) * r
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.strokeStyle = 'rgba(59, 130, 246, 0.5)'
  ctx.lineWidth = 1.5
  ctx.stroke()

  // Center dot
  ctx.beginPath()
  ctx.arc(cx, cy, 3, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(139, 92, 246, 0.6)'
  ctx.fill()
}

function drawSpectrum(
  ctx: CanvasRenderingContext2D,
  freq: Uint8Array,
  W: number,
  H: number
): void {
  const count = 256
  const sliceW = W / count

  // Filled spectrum
  ctx.beginPath()
  ctx.moveTo(0, H)
  for (let i = 0; i < count; i++) {
    const fi = Math.floor(Math.pow(i / count, 1.8) * freq.length * 0.6)
    const v = (freq[fi] || 0) / 255
    const h = v * H * 0.85
    ctx.lineTo(i * sliceW, H - h)
  }
  ctx.lineTo(W, H)
  ctx.closePath()

  const grad = ctx.createLinearGradient(0, 0, 0, H)
  grad.addColorStop(0, 'rgba(59, 130, 246, 0.5)')
  grad.addColorStop(0.4, 'rgba(139, 92, 246, 0.3)')
  grad.addColorStop(1, 'rgba(139, 92, 246, 0.02)')
  ctx.fillStyle = grad
  ctx.fill()

  // Edge line
  ctx.beginPath()
  for (let i = 0; i < count; i++) {
    const fi = Math.floor(Math.pow(i / count, 1.8) * freq.length * 0.6)
    const v = (freq[fi] || 0) / 255
    const h = v * H * 0.85
    i === 0 ? ctx.moveTo(0, H - h) : ctx.lineTo(i * sliceW, H - h)
  }
  ctx.strokeStyle = 'rgba(139, 92, 246, 0.6)'
  ctx.lineWidth = 1.5
  ctx.shadowColor = 'rgba(139, 92, 246, 0.4)'
  ctx.shadowBlur = 10
  ctx.stroke()
  ctx.shadowBlur = 0

  // Frequency labels
  ctx.font = '9px monospace'
  ctx.fillStyle = 'rgba(148, 163, 184, 0.3)'
  const labels = ['100', '500', '1k', '5k', '10k', '20k']
  labels.forEach((label, idx) => {
    const x = (idx / (labels.length - 1)) * W
    ctx.fillText(label, x + 2, H - 4)
  })
}
