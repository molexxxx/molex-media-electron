import { icon } from '../icons.js';
import { refreshReveals } from '../scroll-animations.js';

$.component('batch-page', {
  mounted() {
    setTimeout(refreshReveals, 50);
  },

  render() {
    setTimeout(refreshReveals, 30);

    return `
<section class="hero" style="padding-bottom:24px">
  <div class="container hero-content">
    <div class="reveal">
      <div class="hero-nav">
        <a z-link="/features" class="breadcrumb">${icon('arrow-left', 14)} All Features</a>
        <span class="badge badge-accent">Batch Processing</span>
      </div>
      <h1>Process <span class="grad">Hundreds</span> of Files</h1>
      <p class="sub">Queue mixed operations, configure concurrent workers, and watch real-time progress.</p>
    </div>
  </div>
</section>

<!-- Batch at a Glance -->
<section class="section">
  <div class="container">
    <div class="section-heading reveal">
      <h2>Batch at a Glance</h2>
      <p>Five operations, unlimited files, real-time progress on every task.</p>
    </div>
    <div class="gh-stats-grid reveal">
      <div class="gh-stat-card card"><div class="gh-stat-number">5</div><div class="gh-stat-label">Operations</div></div>
      <div class="gh-stat-card card"><div class="gh-stat-number">24</div><div class="gh-stat-label">Format Presets</div></div>
      <div class="gh-stat-card card"><div class="gh-stat-number">16</div><div class="gh-stat-label">Max Workers</div></div>
      <div class="gh-stat-card card"><div class="gh-stat-number">35+</div><div class="gh-stat-label">Supported Formats</div></div>
    </div>
    <div class="highlight-grid stagger" style="margin-top:24px">
      <div class="highlight-item reveal">
        <div class="feat-icon blue">${icon('refresh-cw', 20)}</div>
        <div class="highlight-text"><h4>Format Conversion</h4><p>24 presets across General, Web/Social, Devices, Production, Audio with codec conflict detection.</p></div>
      </div>
      <div class="highlight-item reveal">
        <div class="feat-icon purple">${icon('sliders', 20)}</div>
        <div class="highlight-text"><h4>Loudness Normalization</h4><p>ITU-R BS.1770-4 two-pass analysis. 5 presets: Defaults, Dialogue, Music, Broadcast, Cinema.</p></div>
      </div>
      <div class="highlight-item reveal">
        <div class="feat-icon emerald">${icon('volume', 20)}</div>
        <div class="highlight-text"><h4>Volume Boost</h4><p>Percentage-based amplification from -50% to +200%. Preserves channel layout and sample rate.</p></div>
      </div>
      <div class="highlight-item reveal">
        <div class="feat-icon amber">${icon('package', 20)}</div>
        <div class="highlight-text"><h4>Compression</h4><p>CRF-based encoding with H.264, HEVC, VP9, AV1. 4 quality tiers and optional target file size.</p></div>
      </div>
      <div class="highlight-item reveal">
        <div class="feat-icon cyan">${icon('music', 20)}</div>
        <div class="highlight-text"><h4>Audio Extraction</h4><p>Demux to MP3, AAC, FLAC, WAV, OGG, Opus, M4A with configurable bitrate and channels.</p></div>
      </div>
      <div class="highlight-item reveal">
        <div class="feat-icon red">${icon('activity', 20)}</div>
        <div class="highlight-text"><h4>Concurrent Workers</h4><p>Configurable worker pool with pause, resume, cancel. Per-task speed, ETA, and progress bars.</p></div>
      </div>
    </div>
  </div>
</section>

<!-- Operations Detail -->
<section class="section section-alt">
  <div class="container">
    <div class="section-heading reveal"><h2>Supported Operations</h2></div>
    <div class="op-detail-grid">
      <div class="card card-glow reveal">
        <h3>${icon('sliders', 20)} Loudness Normalization</h3>
        <p>ITU-R BS.1770-4 two-pass FFmpeg pipeline with configurable LUFS, True Peak, and LRA.</p>
        <table class="spec-table">
          <tr><td>Target LUFS</td><td>-14 to -23</td></tr>
          <tr><td>True Peak</td><td>-1 to -3 dBTP</td></tr>
          <tr><td>Presets</td><td>Defaults, Dialogue, Music, Broadcast, Cinema</td></tr>
        </table>
      </div>
      <div class="card card-glow reveal">
        <h3>${icon('refresh-cw', 20)} Format Conversion</h3>
        <p>24 presets across General, Web/Social, Devices, Production, and Audio with conflict detection.</p>
        <table class="spec-table">
          <tr><td>Video</td><td>H.264, HEVC, VP9, AV1, ProRes</td></tr>
          <tr><td>Audio</td><td>AAC, MP3, FLAC, Opus, Vorbis</td></tr>
          <tr><td>Containers</td><td>MP4, MKV, WebM, MOV, AVI, TS</td></tr>
        </table>
      </div>
      <div class="card card-glow reveal">
        <h3>${icon('package', 20)} Compression</h3>
        <p>CRF-based encoding with per-codec quality and speed tiers. Optional target file size.</p>
        <table class="spec-table">
          <tr><td>Codecs</td><td>H.264, HEVC, VP9, AV1</td></tr>
          <tr><td>Quality</td><td>Lossless / High / Medium / Low</td></tr>
        </table>
      </div>
      <div class="card card-glow reveal">
        <h3>${icon('volume', 20)} Volume Boost</h3>
        <p>Percentage-based amplification preserving channel layout and sample rate.</p>
        <table class="spec-table">
          <tr><td>Range</td><td>-50% to +200%</td></tr>
          <tr><td>Method</td><td>FFmpeg volume filter</td></tr>
        </table>
      </div>
      <div class="card card-glow reveal">
        <h3>${icon('music', 20)} Audio Extraction</h3>
        <p>Demux audio to 7 formats with configurable bitrate, sample rate, and channels.</p>
        <table class="spec-table">
          <tr><td>Formats</td><td>MP3, AAC, FLAC, WAV, OGG, Opus, M4A</td></tr>
          <tr><td>Bitrate</td><td>64k \u2013 320k</td></tr>
        </table>
      </div>
    </div>
  </div>
</section>

<!-- CTA -->
<section class="section" style="text-align:center">
  <div class="container reveal">
    <h2>Ready to process?</h2>
    <p style="max-width:500px;margin:12px auto 24px;color:var(--s400)">Download Molex Media and start batch processing in seconds.</p>
    <a z-link="/download" class="btn btn-primary" z-to-top>${icon('download', 18)} Download Now</a>
  </div>
</section>`;
  },
});
