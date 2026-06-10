import { icon } from '../icons.js';
import { refreshReveals } from '../scroll-animations.js';

$.component('features-page', {
  mounted() {
    setTimeout(refreshReveals, 50);
  },

  render() {
    return `
<section class="hero" style="padding-bottom:32px">
  <div class="container hero-content">
    <div class="reveal">
      <span class="badge badge-accent" style="margin-bottom:16px">All Features</span>
      <h1>Powerful Features,<br><span class="grad">Zero Complexity</span></h1>
      <p class="sub">Every tool you need for media processing, editing, and playback - in one beautiful app.</p>
    </div>
  </div>
</section>

<!-- Batch -->
<section class="section section-compact">
  <div class="container">
    <div class="section-heading reveal">
      <span class="badge badge-accent" style="margin-bottom:14px">Batch Processing</span>
      <h2>Process Hundreds of Files</h2>
      <p>Queue mixed operations with concurrent workers and real-time progress tracking.</p>
    </div>
    <div class="feat-grid stagger" data-parallax data-parallax-speed="0.05">
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon purple">${icon('waves', 22)}</div>
        <div class="feat-text"><h3>Loudness Normalization</h3><p>ITU-R BS.1770-4 two-pass analysis with configurable LUFS, True Peak, and LRA. 5 built-in presets.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon blue">${icon('refresh-cw', 22)}</div>
        <div class="feat-text"><h3>Format Conversion</h3><p>24 presets across General, Web/Social, Devices, Production, Audio. Codec/container conflict detection.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon amber">${icon('package', 22)}</div>
        <div class="feat-text"><h3>Compression</h3><p>CRF-based with H.264, HEVC, VP9, AV1. 4 quality presets, per-codec speed tiers, target-size limiting.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon emerald">${icon('volume', 22)}</div>
        <div class="feat-text"><h3>Volume Boost</h3><p>Percentage-based amplification. Preserves channel layout and sample rate across all audio streams.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon cyan">${icon('music', 22)}</div>
        <div class="feat-text"><h3>Audio Extraction</h3><p>Demux to MP3, AAC, FLAC, WAV, OGG, Opus, M4A. Configurable bitrate, sample rate, channels.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon red">${icon('activity', 22)}</div>
        <div class="feat-text"><h3>Concurrent Workers</h3><p>Configurable worker pool with pause, resume, cancel. Per-task speed, ETA, progress bars.</p></div>
      </div>
    </div>
    <div style="text-align:center;margin-top:32px" class="reveal">
      <a z-link="/features/batch" class="btn btn-secondary" z-to-top>Learn more about Batch Processing ${icon('arrow-right', 16)}</a>
    </div>
  </div>
</section>

<!-- Editor -->
<section class="section section-compact">
  <div class="container">
    <div class="section-heading reveal">
      <span class="badge badge-blue" style="margin-bottom:14px">Media Editor</span>
      <h2>Full NLE Timeline Editor</h2>
      <p>Multi-track editing with spatial compositing, keyframe animation, and frame-accurate ops.</p>
    </div>
    <div class="feat-grid stagger" data-parallax data-parallax-speed="0.05">
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon blue">${icon('video', 22)}</div>
        <div class="feat-text"><h3>NLE Timeline</h3><p>V1/A1 tracks, source bin, drag-to-timeline, 7 edit types: Insert, Overwrite, Ripple, and more.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon purple">${icon('scissors', 22)}</div>
        <div class="feat-text"><h3>4 Trim Types</h3><p>Roll, Ripple, Slip, and Slide with context-sensitive cursors. Fast or precise mode.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon emerald">${icon('maximize', 22)}</div>
        <div class="feat-text"><h3>Spatial Compositing</h3><p>Position, scale, rotation, anchor, opacity per clip. Interactive canvas preview composites all layers.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon amber">${icon('target', 22)}</div>
        <div class="feat-text"><h3>Keyframe Animation</h3><p>4 easing curves, angle shortest-path interpolation, binary search lookup. Per-property keyframes.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon cyan">${icon('blend', 22)}</div>
        <div class="feat-text"><h3>8 Blend Modes</h3><p>Normal, Multiply, Screen, Overlay, Darken, Lighten, Add, Difference - canvas & export.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon red">${icon('gif', 22)}</div>
        <div class="feat-text"><h3>GIF Export</h3><p>Two-pass palette generation for high-quality GIFs. Configurable loop, FPS 1-30, width.</p></div>
      </div>
    </div>
    <div style="text-align:center;margin-top:32px" class="reveal">
      <a z-link="/features/editor" class="btn btn-secondary" z-to-top>Learn more about the Editor ${icon('arrow-right', 16)}</a>
    </div>
  </div>
</section>

<!-- Player -->
<section class="section section-compact">
  <div class="container">
    <div class="section-heading reveal">
      <span class="badge badge-success" style="margin-bottom:14px">Media Player</span>
      <h2>Built-in Playback & Streaming</h2>
      <p>Play local files or stream from YouTube with stunning visualizations.</p>
    </div>
    <div class="feat-grid stagger" data-parallax data-parallax-speed="0.05">
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon emerald">${icon('play', 22)}</div>
        <div class="feat-text"><h3>Local Playback</h3><p>Audio/video from disk with full playlist management. Seamless 2 GiB+ support.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon red">${icon('globe', 22)}</div>
        <div class="feat-text"><h3>YouTube Streaming</h3><p>Resolve videos, playlists, direct URLs via yt-dlp. Auto-retry expired CDN tokens.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon purple">${icon('sparkles', 22)}</div>
        <div class="feat-text"><h3>8 Visualizations</h3><p>DMT, Space, Milkdrop, Plasma, Bars, Wave, Horizon, Rain. Real-time canvas + Web Audio.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon blue">${icon('activity', 22)}</div>
        <div class="feat-text"><h3>Beat Detection</h3><p>Multi-band frequency analysis across sub-bass through treble. Beat-reactive visuals.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon amber">${icon('list', 22)}</div>
        <div class="feat-text"><h3>Playlists</h3><p>Drag-to-reorder, shuffle, repeat modes, now-playing, auto-scroll, folder browser.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon cyan">${icon('monitor', 22)}</div>
        <div class="feat-text"><h3>Popout Player</h3><p>Always-on-top window. Pin/unpin, 3 size presets, custom size memory, auto-resume.</p></div>
      </div>
    </div>
    <div style="text-align:center;margin-top:32px" class="reveal">
      <a z-link="/features/player" class="btn btn-secondary" z-to-top>Learn more about the Player ${icon('arrow-right', 16)}</a>
    </div>
  </div>
</section>

<!-- App & UI -->
<section class="section section-compact">
  <div class="container">
    <div class="section-heading reveal">
      <span class="badge badge-amber" style="margin-bottom:14px">App & UI</span>
      <h2>Polished Desktop Experience</h2>
      <p>Custom title bar, collapsible sidebar, tray, auto-updater and more.</p>
    </div>
    <div class="feat-grid stagger" data-parallax data-parallax-speed="0.05">
      <div class="card feat-card reveal">
        <div class="feat-icon purple">${icon('wand', 22)}</div>
        <div class="feat-text"><h3>Setup Wizard</h3><p>First-run flow: Welcome, Downloading, Complete, Error. Retry + manual fallback.</p></div>
      </div>
      <div class="card feat-card reveal">
        <div class="feat-icon blue">${icon('dashboard', 22)}</div>
        <div class="feat-text"><h3>Dashboard</h3><p>Stats, 5 workflow launchers, animated canvas cards, system info, activity feed.</p></div>
      </div>
      <div class="card feat-card reveal">
        <div class="feat-icon emerald">${icon('refresh-cw', 22)}</div>
        <div class="feat-text"><h3>Auto-Updater</h3><p>Check/download/install from GitHub Releases. Progress forwarding, persistent status.</p></div>
      </div>
      <div class="card feat-card reveal">
        <div class="feat-icon amber">${icon('folder', 22)}</div>
        <div class="feat-text"><h3>File Browser</h3><p>VLC-style with known-folder shortcuts. Multi-file/folder select. Drag-drop everywhere.</p></div>
      </div>
      <div class="card feat-card reveal">
        <div class="feat-icon cyan">${icon('scroll', 22)}</div>
        <div class="feat-text"><h3>Log Viewer</h3><p>Filter by level, search, auto-scroll, copy entries, open log directory.</p></div>
      </div>
      <div class="card feat-card reveal">
        <div class="feat-icon red">${icon('settings', 22)}</div>
        <div class="feat-text"><h3>Settings</h3><p>Application, Audio, Processing tabs. Per-tool reset-to-defaults.</p></div>
      </div>
    </div>
  </div>
</section>`;
  },
});
