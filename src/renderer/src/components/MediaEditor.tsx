import { useRef, useState, useEffect, useCallback } from 'react'

interface Clip {
  id: string
  name: string
  path: string
  objectUrl: string
  duration: number
  isVideo: boolean
  inPoint: number
  outPoint: number
}

function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00.0'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.floor((sec % 1) * 10)
  return `${m}:${s.toString().padStart(2, '0')}.${ms}`
}

const AUDIO_EXTS = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus']
const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'm4v', 'ts']
const ALL_EXTS = [...AUDIO_EXTS, ...VIDEO_EXTS]

export default function MediaEditor(): JSX.Element {
  const [clips, setClips] = useState<Clip[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [message, setMessage] = useState('')

  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number>(0)

  const clip = clips[activeIdx] || null

  // ── File loading ──
  const loadFile = useCallback((file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase() || ''
    if (!ALL_EXTS.includes(ext)) return

    const isVideo = VIDEO_EXTS.includes(ext)
    const objectUrl = URL.createObjectURL(file)
    const tempEl = isVideo ? document.createElement('video') : new Audio()
    tempEl.src = objectUrl

    tempEl.addEventListener('loadedmetadata', () => {
      const dur = tempEl.duration || 0
      const newClip: Clip = {
        id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: file.name,
        path: (file as File & { path: string }).path || file.name,
        objectUrl,
        duration: dur,
        isVideo,
        inPoint: 0,
        outPoint: dur
      }
      setClips((prev) => [...prev, newClip])
      setActiveIdx((prev) => prev === 0 && clips.length === 0 ? 0 : clips.length)
    })
  }, [clips.length])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    for (const file of Array.from(e.dataTransfer.files)) {
      loadFile(file)
    }
  }, [loadFile])

  const handleFileSelect = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = ALL_EXTS.map((e) => `.${e}`).join(',')
    input.onchange = () => {
      for (const f of Array.from(input.files || [])) loadFile(f)
    }
    input.click()
  }, [loadFile])

  // ── Audio analyser for waveform ──
  useEffect(() => {
    if (!clip || clip.isVideo) return

    const audio = audioRef.current
    if (!audio) return

    audio.src = clip.objectUrl
    audio.currentTime = clip.inPoint

    if (!ctxRef.current) ctxRef.current = new AudioContext()
    const actx = ctxRef.current

    if (sourceRef.current) {
      try { sourceRef.current.disconnect() } catch { /* ok */ }
    }

    const source = actx.createMediaElementSource(audio)
    const analyser = actx.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.8
    source.connect(analyser)
    analyser.connect(actx.destination)
    sourceRef.current = source
    analyserRef.current = analyser

    return () => {
      audio.pause()
      audio.src = ''
    }
  }, [clip?.id])

  // ── Video source ──
  useEffect(() => {
    if (!clip || !clip.isVideo) return
    const video = videoRef.current
    if (!video) return
    video.src = clip.objectUrl
    video.currentTime = clip.inPoint
  }, [clip?.id])

  // ── Playback time tracking ──
  useEffect(() => {
    if (!clip) return
    const el = clip.isVideo ? videoRef.current : audioRef.current
    if (!el) return

    const onTime = (): void => {
      setCurrentTime(el.currentTime)
      // Auto-stop at out point
      if (el.currentTime >= clip.outPoint) {
        el.pause()
        el.currentTime = clip.outPoint
        setPlaying(false)
      }
    }
    const onEnd = (): void => setPlaying(false)

    el.addEventListener('timeupdate', onTime)
    el.addEventListener('ended', onEnd)
    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('ended', onEnd)
    }
  }, [clip?.id, clip?.outPoint])

  // ── Canvas visualizer (audio-only preview) ──
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !clip || clip.isVideo) return

    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    let running = true
    const resize = (): void => {
      const rect = canvas.parentElement?.getBoundingClientRect()
      if (!rect) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.scale(dpr, dpr)
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas.parentElement!)

    const freqData = new Uint8Array(1024)
    const smoothBars = new Float32Array(80).fill(0)

    const draw = (): void => {
      if (!running) return
      rafRef.current = requestAnimationFrame(draw)

      const W = canvas.width / (window.devicePixelRatio || 1)
      const H = canvas.height / (window.devicePixelRatio || 1)
      ctx.fillStyle = '#0a0a0f'
      ctx.fillRect(0, 0, W, H)

      const analyser = analyserRef.current
      if (!analyser) return

      analyser.getByteFrequencyData(freqData)

      const count = 80
      const gap = 2
      const barW = (W - gap * (count - 1)) / count

      for (let i = 0; i < count; i++) {
        const fi = Math.floor(Math.pow(i / count, 1.5) * freqData.length * 0.5)
        const raw = freqData[fi] || 0
        smoothBars[i] += (raw - smoothBars[i]) * 0.25
        const h = (smoothBars[i] / 255) * H * 0.85
        const x = i * (barW + gap)
        const y = H - h

        const grad = ctx.createLinearGradient(x, H, x, y)
        grad.addColorStop(0, 'rgba(139, 92, 246, 0.9)')
        grad.addColorStop(0.6, 'rgba(168, 85, 247, 0.6)')
        grad.addColorStop(1, 'rgba(59, 130, 246, 0.4)')
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.roundRect(x, y, barW, h, [2, 2, 0, 0])
        ctx.fill()
      }
    }
    draw()

    return () => {
      running = false
      cancelAnimationFrame(rafRef.current)
      ro.disconnect()
    }
  }, [clip?.id, clip?.isVideo])

  // ── Controls ──
  const togglePlay = useCallback(() => {
    if (!clip) return
    const el = clip.isVideo ? videoRef.current : audioRef.current
    if (!el) return

    if (ctxRef.current?.state === 'suspended') ctxRef.current.resume()

    if (el.paused) {
      if (el.currentTime >= clip.outPoint || el.currentTime < clip.inPoint) {
        el.currentTime = clip.inPoint
      }
      el.play()
      setPlaying(true)
    } else {
      el.pause()
      setPlaying(false)
    }
  }, [clip])

  const seek = useCallback((time: number) => {
    if (!clip) return
    const el = clip.isVideo ? videoRef.current : audioRef.current
    if (el) el.currentTime = time
    setCurrentTime(time)
  }, [clip])

  const setIn = useCallback(() => {
    if (!clip) return
    setClips((prev) => prev.map((c, i) => i === activeIdx ? { ...c, inPoint: currentTime } : c))
  }, [activeIdx, currentTime, clip])

  const setOut = useCallback(() => {
    if (!clip) return
    setClips((prev) => prev.map((c, i) => i === activeIdx ? { ...c, outPoint: currentTime } : c))
  }, [activeIdx, currentTime, clip])

  const resetPoints = useCallback(() => {
    if (!clip) return
    setClips((prev) => prev.map((c, i) => i === activeIdx ? { ...c, inPoint: 0, outPoint: c.duration } : c))
  }, [activeIdx, clip])

  const removeClip = useCallback((idx: number) => {
    setClips((prev) => {
      const next = prev.filter((_, i) => i !== idx)
      URL.revokeObjectURL(prev[idx].objectUrl)
      return next
    })
    setActiveIdx((prev) => Math.min(prev, Math.max(0, clips.length - 2)))
  }, [clips.length])

  // ── Export ──
  const handleCut = useCallback(async () => {
    if (!clip) return
    setProcessing(true)
    setMessage('')
    try {
      const result = await window.api.cutMedia(clip.path, clip.inPoint, clip.outPoint)
      if (result?.success) {
        setMessage(`Saved: ${result.outputPath.split(/[\\/]/).pop()}`)
      } else {
        setMessage(`Error: ${result?.error || 'Cut failed'}`)
      }
    } catch (err: any) {
      setMessage(`Error: ${err.message}`)
    } finally {
      setProcessing(false)
    }
  }, [clip])

  const handleMerge = useCallback(async () => {
    if (clips.length < 2) return
    setProcessing(true)
    setMessage('')
    try {
      const segments = clips.map((c) => ({ path: c.path, inPoint: c.inPoint, outPoint: c.outPoint }))
      const result = await window.api.mergeMedia(segments)
      if (result?.success) {
        setMessage(`Merged: ${result.outputPath.split(/[\\/]/).pop()}`)
      } else {
        setMessage(`Error: ${result?.error || 'Merge failed'}`)
      }
    } catch (err: any) {
      setMessage(`Error: ${err.message}`)
    } finally {
      setProcessing(false)
    }
  }, [clips])

  // ── Timeline drag ──
  const handleTimelineClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!clip || !timelineRef.current) return
    const rect = timelineRef.current.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    seek(pct * clip.duration)
  }, [clip, seek])

  const clipDuration = clip ? clip.outPoint - clip.inPoint : 0

  return (
    <div className="flex flex-col h-full animate-fade-in gap-4">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-white">Editor</h1>
          <p className="text-sm text-surface-400 mt-0.5">
            {clip ? `${clip.name} — ${formatTime(clipDuration)} selected` : 'Cut, trim, and merge media clips'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleFileSelect}
            className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-accent-600 hover:bg-accent-500 text-white shadow-glow hover:shadow-glow-lg transition-all"
          >
            Add Files
          </button>
        </div>
      </div>

      {/* Main area: Preview + Clip List */}
      <div className="flex-1 flex gap-4 min-h-0">
        {/* Preview */}
        <div
          className={`flex-1 relative rounded-2xl overflow-hidden border transition-colors ${
            dragging ? 'border-accent-400 bg-accent-500/5' : 'border-white/5 bg-surface-900/50'
          }`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          {clip && clip.isVideo && (
            <video
              ref={videoRef}
              className="absolute inset-0 w-full h-full object-contain bg-black"
              playsInline
              muted={false}
            />
          )}
          {clip && !clip.isVideo && (
            <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
          )}
          {!clip && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="mx-auto text-surface-600 mb-3">
                  <path d="M15.6 11.6L22 7v10l-6.4-4.6" />
                  <rect x="2" y="6" width="14" height="12" rx="2" />
                </svg>
                <p className="text-surface-500 text-sm">Drop media files here to begin</p>
              </div>
            </div>
          )}
          {dragging && (
            <div className="absolute inset-0 flex items-center justify-center bg-accent-500/10 backdrop-blur-sm z-10">
              <p className="text-accent-300 font-semibold text-lg">Drop to add</p>
            </div>
          )}
          <audio ref={audioRef} className="hidden" />
        </div>

        {/* Clip list sidebar */}
        {clips.length > 0 && (
          <div className="w-52 shrink-0 glass rounded-xl p-3 flex flex-col gap-2 overflow-auto">
            <div className="flex items-center justify-between mb-1">
              <span className="text-2xs font-semibold uppercase tracking-wider text-surface-500">Clips ({clips.length})</span>
              {clips.length >= 2 && (
                <button
                  onClick={handleMerge}
                  disabled={processing}
                  className="text-2xs font-semibold text-accent-400 hover:text-accent-300 disabled:opacity-40 transition-colors"
                >
                  Merge All
                </button>
              )}
            </div>
            {clips.map((c, i) => (
              <button
                key={c.id}
                onClick={() => setActiveIdx(i)}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-all ${
                  i === activeIdx
                    ? 'bg-accent-500/15 text-accent-300 border border-accent-500/20'
                    : 'text-surface-300 hover:bg-surface-700/50 border border-transparent'
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate font-medium">{c.name}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeClip(i) }}
                    className="text-surface-500 hover:text-red-400 transition-colors shrink-0"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
                <div className="text-2xs text-surface-500 mt-0.5 font-mono">
                  {formatTime(c.inPoint)} → {formatTime(c.outPoint)}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Timeline */}
      {clip && (
        <div className="shrink-0 glass rounded-xl px-5 py-4 space-y-3">
          {/* Timeline bar */}
          <div
            ref={timelineRef}
            className="relative h-10 bg-surface-800 rounded-lg cursor-pointer group"
            onClick={handleTimelineClick}
          >
            {/* In/Out region */}
            <div
              className="absolute top-0 bottom-0 bg-accent-500/15 border-l-2 border-r-2 border-accent-500/60"
              style={{
                left: `${(clip.inPoint / clip.duration) * 100}%`,
                width: `${((clip.outPoint - clip.inPoint) / clip.duration) * 100}%`
              }}
            />

            {/* Playhead */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_6px_rgba(255,255,255,0.5)] z-10"
              style={{ left: `${(currentTime / clip.duration) * 100}%` }}
            >
              <div className="absolute -top-1 -left-1.5 w-3.5 h-2.5 bg-white rounded-sm" />
            </div>

            {/* Time markers */}
            <div className="absolute bottom-0 left-0 right-0 flex justify-between px-1 pointer-events-none">
              {Array.from({ length: 11 }).map((_, i) => (
                <span key={i} className="text-[8px] text-surface-600 font-mono">
                  {formatTime((clip.duration / 10) * i)}
                </span>
              ))}
            </div>
          </div>

          {/* Controls row */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {/* Play/Pause */}
              <button
                onClick={togglePlay}
                className="w-9 h-9 rounded-full bg-accent-600 hover:bg-accent-500 flex items-center justify-center text-white transition-all shadow-glow hover:shadow-glow-lg"
              >
                {playing ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20" /></svg>
                )}
              </button>

              {/* Time display */}
              <span className="text-xs font-mono text-surface-300 min-w-[70px]">
                {formatTime(currentTime)} / {formatTime(clip.duration)}
              </span>
            </div>

            {/* In/Out controls */}
            <div className="flex items-center gap-1.5">
              <button onClick={setIn} className="px-2.5 py-1 text-2xs font-semibold rounded-md bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 border border-blue-500/20 transition-all" title="Set In Point">
                In [{formatTime(clip.inPoint)}]
              </button>
              <button onClick={setOut} className="px-2.5 py-1 text-2xs font-semibold rounded-md bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/20 transition-all" title="Set Out Point">
                Out [{formatTime(clip.outPoint)}]
              </button>
              <button onClick={resetPoints} className="px-2.5 py-1 text-2xs font-medium rounded-md text-surface-400 hover:text-surface-200 bg-surface-700/50 hover:bg-surface-600/50 transition-all">
                Reset
              </button>
              <div className="w-px h-5 bg-surface-700 mx-1" />
              <button
                onClick={handleCut}
                disabled={processing || clipDuration <= 0}
                className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-accent-600 hover:bg-accent-500 disabled:opacity-40 text-white shadow-glow hover:shadow-glow-lg transition-all"
              >
                {processing ? 'Exporting...' : 'Export Clip'}
              </button>
            </div>
          </div>

          {/* Status message */}
          {message && (
            <div className={`text-xs px-3 py-2 rounded-lg ${
              message.startsWith('Error') ? 'bg-red-500/10 text-red-300' : 'bg-emerald-500/10 text-emerald-300'
            }`}>
              {message}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
