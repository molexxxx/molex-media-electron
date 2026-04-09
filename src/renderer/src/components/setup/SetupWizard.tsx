/**
 * @module components/setup/SetupWizard
 * @description First-run wizard for FFmpeg download and installation.
 *
 * Guides the user through a multi-step flow:
 * 1. **Welcome** - explains FFmpeg requirement with feature highlights.
 * 2. **Downloading** - progress bar during automatic download.
 * 3. **Complete** - success confirmation with "Get Started" action.
 * 4. **Error** - failure message with retry and manual-install options.
 */

import React, { useState } from 'react'
import { useAppStore } from '../../stores/appStore'

export default function SetupWizard(): React.JSX.Element {
  const { setFFmpegReady, setShowSetup, setConfig, downloadProgress, setDownloadProgress } = useAppStore()
  const [step, setStep] = useState<'welcome' | 'downloading' | 'complete' | 'error'>('welcome')
  const [error, setError] = useState('')

  const handleDownload = async () => {
    setStep('downloading')
    setError('')
    try {
      const result = await window.api.downloadFFmpeg()
      if (result.success) {
        setStep('complete')
        setFFmpegReady(true, result.version)
        const config = await window.api.loadConfig()
        setConfig(config)
      } else {
        setError(result.error || 'Unknown error')
        setStep('error')
      }
    } catch (err: any) {
      setError(err.message)
      setStep('error')
    }
  }

  const handleSkip = async () => {
    // Check again in case user installed manually
    const result = await window.api.checkFFmpeg()
    if (result.found) {
      setFFmpegReady(true, result.version)
      const config = await window.api.loadConfig()
      setConfig(config)
      setShowSetup(false)
    }
  }

  const handleDone = () => {
    setShowSetup(false)
    setDownloadProgress(null)
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="w-full max-w-lg">
        {/* Logo */}
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold gradient-text mb-2">molexMedia</h1>
          <p className="text-surface-400 text-sm">Professional Media Processing Toolkit</p>
        </div>

        <div className="glass rounded-2xl p-8">
          {step === 'welcome' && (
            <div className="space-y-6">
              <div className="text-center">
                <div className="w-16 h-16 rounded-2xl bg-accent-500/10 border border-accent-500/20 flex items-center justify-center mx-auto mb-4">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-accent-400">
                    <path d="M9 18V5l12-2v13" />
                    <circle cx="6" cy="18" r="3" />
                    <circle cx="18" cy="16" r="3" />
                  </svg>
                </div>
                <h2 className="text-xl font-semibold text-white mb-2">Welcome to molexMedia</h2>
                <p className="text-surface-400 text-sm leading-relaxed">
                  FFmpeg is required for audio processing. We&apos;ll download and configure it automatically - no command line needed.
                </p>
              </div>

              <div className="space-y-2 text-sm">
                <div className="flex items-start gap-3 p-3 rounded-lg bg-surface-800/50">
                  <span className="text-emerald-400 mt-0.5">✓</span>
                  <div>
                    <p className="text-surface-200 font-medium">Automatic Download</p>
                    <p className="text-surface-500 text-xs">FFmpeg will be downloaded for your operating system</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 rounded-lg bg-surface-800/50">
                  <span className="text-emerald-400 mt-0.5">✓</span>
                  <div>
                    <p className="text-surface-200 font-medium">Portable Installation</p>
                    <p className="text-surface-500 text-xs">Stored in app data - no system modifications required</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 rounded-lg bg-surface-800/50">
                  <span className="text-emerald-400 mt-0.5">✓</span>
                  <div>
                    <p className="text-surface-200 font-medium">Cross-Platform</p>
                    <p className="text-surface-500 text-xs">Works on Windows, macOS, and Linux</p>
                  </div>
                </div>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={handleDownload}
                  className="flex-1 py-2.5 px-4 bg-accent-600 hover:bg-accent-500 text-white text-sm font-semibold rounded-xl transition-all duration-150"
                >
                  Download FFmpeg
                </button>
                <button
                  onClick={handleSkip}
                  className="px-4 py-2.5 text-surface-400 hover:text-surface-200 text-sm font-medium rounded-xl hover:bg-surface-700/50 transition-all"
                >
                  I have it
                </button>
              </div>
            </div>
          )}

          {step === 'downloading' && (
            <div className="space-y-6 text-center">
              <div className="w-16 h-16 rounded-2xl bg-accent-500/10 border border-accent-500/20 flex items-center justify-center mx-auto">
                <div className="w-8 h-8 border-2 border-accent-400 border-t-transparent rounded-full animate-spin" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white mb-1">
                  {downloadProgress?.message || 'Setting up FFmpeg...'}
                </h2>
                <p className="text-surface-500 text-xs">This may take a minute depending on your connection</p>
              </div>

              {downloadProgress && (
                <div className="space-y-2">
                  <div className="w-full h-2 bg-surface-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-accent-600 to-accent-400 rounded-full transition-all duration-300"
                      style={{ width: `${downloadProgress.percent}%` }}
                    />
                  </div>
                  <p className="text-2xs text-surface-500 font-mono">{downloadProgress.percent}%</p>
                </div>
              )}
            </div>
          )}

          {step === 'complete' && (
            <div className="space-y-6 text-center">
              <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-emerald-400">
                  <polyline points="20,6 9,17 4,12" />
                </svg>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white mb-1">All Set!</h2>
                <p className="text-surface-400 text-sm">FFmpeg is installed and ready. Let&apos;s process some media.</p>
              </div>
              <button
                onClick={handleDone}
                className="w-full py-2.5 px-4 bg-accent-600 hover:bg-accent-500 text-white text-sm font-semibold rounded-xl transition-all duration-150"
              >
                Get Started
              </button>
            </div>
          )}

          {step === 'error' && (
            <div className="space-y-6 text-center">
              <div className="w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="15" y1="9" x2="9" y2="15" />
                  <line x1="9" y1="9" x2="15" y2="15" />
                </svg>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white mb-1">Download Failed</h2>
                <p className="text-surface-400 text-sm mb-2">{error}</p>
                <p className="text-surface-500 text-xs">
                  You can install FFmpeg manually and add it to your PATH, then click &quot;I have it&quot;.
                </p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={handleDownload}
                  className="flex-1 py-2.5 px-4 bg-accent-600 hover:bg-accent-500 text-white text-sm font-semibold rounded-xl transition-all"
                >
                  Retry
                </button>
                <button
                  onClick={handleSkip}
                  className="px-4 py-2.5 text-surface-400 hover:text-surface-200 text-sm font-medium rounded-xl hover:bg-surface-700/50 transition-all"
                >
                  I have it
                </button>
              </div>
            </div>
          )}
        </div>

        <p className="text-center text-2xs text-surface-600 mt-6">
          FFmpeg is licensed under LGPL/GPL. molexMedia downloads it from trusted sources.
        </p>
      </div>
    </div>
  )
}
