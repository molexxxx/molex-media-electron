import { icon } from '../icons.js';
import { refreshReveals } from '../scroll-animations.js';

$.component('player-page', {
  mounted() {
    setTimeout(refreshReveals, 80);
  },

  destroyed() {},

  render() {
    return `
<!-- Hero -->
<section class="hero" style="padding-bottom:24px">
  <div class="container hero-content">
    <div class="reveal">
      <div class="hero-nav">
        <a z-link="/features" class="breadcrumb">${icon('arrow-left', 14)} All Features</a>
        <span class="badge badge-success">Media Player</span>
      </div>
      <h1>Built-in <span class="grad">Playback & Streaming</span></h1>
      <p class="sub">Play local files or stream from YouTube with 8 stunning real-time visualizations and beat-reactive effects.</p>
    </div>
  </div>
</section>

<!-- Player at a Glance -->
<section class="section section-compact">
  <div class="container">
    <div class="section-heading reveal">
      <h2>Player at a Glance</h2>
      <p>Full-featured media playback with real-time audio visualization.</p>
    </div>
    <div class="gh-stats-grid reveal" data-parallax data-parallax-speed="0.04">
      <div class="gh-stat-card card"><div class="gh-stat-number">8</div><div class="gh-stat-label">Vis Modes</div></div>
      <div class="gh-stat-card card"><div class="gh-stat-number">6</div><div class="gh-stat-label">Frequency Bands</div></div>
      <div class="gh-stat-card card"><div class="gh-stat-number">3</div><div class="gh-stat-label">Popout Sizes</div></div>
      <div class="gh-stat-card card"><div class="gh-stat-number">\u221e</div><div class="gh-stat-label">Playlist Items</div></div>
    </div>
    <div class="highlight-grid stagger" style="margin-top:24px">
      <div class="highlight-item reveal">
        <div class="feat-icon emerald">${icon('play', 20)}</div>
        <div class="highlight-text"><h4>Local Playback</h4><p>Any audio or video from disk. Seamless 2 GiB+ support with full playlist management.</p></div>
      </div>
      <div class="highlight-item reveal">
        <div class="feat-icon red">${icon('globe', 20)}</div>
        <div class="highlight-text"><h4>YouTube Streaming</h4><p>Paste a URL and stream instantly via yt-dlp. Auto-retries expired CDN tokens.</p></div>
      </div>
      <div class="highlight-item reveal">
        <div class="feat-icon blue">${icon('activity', 20)}</div>
        <div class="highlight-text"><h4>Beat Detection</h4><p>Multi-band frequency analysis: sub-bass, bass, low-mid, mid, high-mid, treble.</p></div>
      </div>
      <div class="highlight-item reveal">
        <div class="feat-icon amber">${icon('list', 20)}</div>
        <div class="highlight-text"><h4>Playlist Management</h4><p>Drag-to-reorder, shuffle, repeat, now-playing indicator, auto-scroll, folder browser.</p></div>
      </div>
      <div class="highlight-item reveal">
        <div class="feat-icon purple">${icon('monitor', 20)}</div>
        <div class="highlight-text"><h4>Popout Player</h4><p>Always-on-top mini window. Pin/unpin, 3 size presets, custom size memory.</p></div>
      </div>
      <div class="highlight-item reveal">
        <div class="feat-icon cyan">${icon('headphones', 20)}</div>
        <div class="highlight-text"><h4>Audio Analysis</h4><p>Web Audio API AnalyserNode with configurable FFT size and raw frequency data.</p></div>
      </div>
    </div>
  </div>
</section>

<!-- Visualization Modes -->
<section class="section section-alt">
  <div class="container">
    <div class="section-heading reveal">
      <h2>8 Visualization Modes</h2>
      <p>Each mode responds to real-time frequency data across sub-bass through treble bands.</p>
    </div>
    <div class="feat-grid stagger">
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon purple">${icon('sparkles', 22)}</div>
        <div class="feat-text"><h3>DMT</h3><p>Psychedelic color-cycling with morphing geometry. Hue shifts based on bass intensity, geometry on mids.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon blue">${icon('globe', 22)}</div>
        <div class="feat-text"><h3>Space</h3><p>Star field with parallax depth layers. Stars pulse and connect on beat detections.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon emerald">${icon('activity', 22)}</div>
        <div class="feat-text"><h3>Milkdrop</h3><p>Fluid simulation with bloom and motion trails. Inspired by classic Winamp visualizations.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon amber">${icon('target', 22)}</div>
        <div class="feat-text"><h3>Plasma</h3><p>Sine-based plasma field with time-varying color palettes. Smooth, hypnotic, always-different.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon cyan">${icon('bar-chart', 22)}</div>
        <div class="feat-text"><h3>Bars</h3><p>Classic frequency bar display with gradient fills and peak hold indicators.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon red">${icon('waves', 22)}</div>
        <div class="feat-text"><h3>Wave</h3><p>Oscilloscope-style waveform. Time-domain visualization with adjustable line thickness and color.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon blue">${icon('layers', 22)}</div>
        <div class="feat-text"><h3>Horizon</h3><p>Layered mountain-range effect with scrolling terrain. Frequency data drives the landscape height.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon emerald">${icon('code', 22)}</div>
        <div class="feat-text"><h3>Rain</h3><p>Matrix-style digital rain where each strand is driven by its own frequency band - bass strands fall slow and heavy, mid strands pulse with vocals, treble strands race with sparkle.</p></div>
      </div>
    </div>
  </div>
</section>

<!-- Playback Features -->
<section class="section">
  <div class="container">
    <div class="section-heading reveal"><h2>Playback Features</h2></div>
    <div class="feat-grid stagger">
      <div class="card feat-card reveal">
        <div class="feat-icon emerald">${icon('play', 22)}</div>
        <div class="feat-text"><h3>Local Files</h3><p>Play any audio or video file from disk. Seamless support for files over 2 GiB. Full playlist management.</p></div>
      </div>
      <div class="card feat-card reveal">
        <div class="feat-icon red">${icon('globe', 22)}</div>
        <div class="feat-text"><h3>YouTube Streaming</h3><p>Paste a URL and stream instantly via yt-dlp. Supports videos, playlists, and channels. Auto-retries expired CDN tokens.</p></div>
      </div>
      <div class="card feat-card reveal">
        <div class="feat-icon blue">${icon('activity', 22)}</div>
        <div class="feat-text"><h3>Beat Detection</h3><p>Multi-band frequency analysis: sub-bass, bass, low-mid, mid, high-mid, treble. Beat events trigger visual effects.</p></div>
      </div>
      <div class="card feat-card reveal">
        <div class="feat-icon amber">${icon('list', 22)}</div>
        <div class="feat-text"><h3>Playlists</h3><p>Drag-to-reorder, shuffle, repeat one or all, now-playing indicator, auto-scroll, and a built-in folder browser.</p></div>
      </div>
      <div class="card feat-card reveal">
        <div class="feat-icon purple">${icon('monitor', 22)}</div>
        <div class="feat-text"><h3>Popout Player</h3><p>Always-on-top mini window. Pin/unpin, 3 size presets, custom size memory. Auto-resumes on reopen.</p></div>
      </div>
      <div class="card feat-card reveal">
        <div class="feat-icon cyan">${icon('headphones', 22)}</div>
        <div class="feat-text"><h3>Audio Analysis</h3><p>Web Audio API AnalyserNode with configurable FFT size. Raw frequency and time-domain data available to all visualization modes.</p></div>
      </div>
    </div>
  </div>
</section>

<!-- CTA -->
<section class="section section-alt" style="text-align:center">
  <div class="container reveal">
    <h2>Ready to listen?</h2>
    <p style="max-width:500px;margin:12px auto 24px;color:var(--s400)">Download Molex Media and experience visualizations like never before.</p>
    <a z-link="/download" class="btn btn-primary" z-to-top>${icon('download', 18)} Download Now</a>
  </div>
</section>`;
  },
});
