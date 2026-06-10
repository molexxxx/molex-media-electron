import { icon } from '../icons.js';
import { refreshReveals } from '../scroll-animations.js';
import { fmt } from '../store.js';

$.component('home-page', {
  state: () => ({ _t: 0 }),

  mounted() {
    this._unsub = $.getStore('app').subscribe(() => {
      this.state._t++;
    });
    setTimeout(refreshReveals, 80);
  },

  destroyed() {
    if (this._unsub) this._unsub();
  },

  render() {
    const s = $.getStore('app');
    const { loading, workflows: rawWf, repoInfo, latestRelease } = s.state;
    const workflows = Array.isArray(rawWf) ? rawWf : [];
    const v = s.getters.version;
    const dl = s.getters.totalDownloads;
    const win = s.getters.win;
    const mac = s.getters.mac;
    const linux = s.getters.linux;

    const ua = navigator.userAgent || '';
    const plat = /Mac/i.test(ua) ? 'mac' : /Linux/i.test(ua) ? 'linux' : 'win';
    const platAsset = plat === 'mac' ? mac : plat === 'linux' ? linux : win;
    const platLabel = plat === 'mac' ? 'macOS' : plat === 'linux' ? 'Linux' : 'Windows';
    const hrefDl = platAsset
      ? $.escapeHtml(platAsset.browser_download_url)
      : 'https://github.com/tonywied17/molex-media-electron/releases/latest';

    const wfStatus = (w) => {
      const c = w.conclusion || w.status || 'unknown';
      if (c === 'success') return { cls: 'ok', label: 'Passing' };
      if (c === 'failure') return { cls: 'fail', label: 'Failing' };
      if (c === 'in_progress') return { cls: 'run', label: 'Running' };
      return { cls: 'unk', label: c };
    };

    setTimeout(refreshReveals, 30);

    return `
<!-- Hero -->
<section class="hero">
  <div class="container hero-split">
    <div class="hero-left reveal">
      <span class="badge badge-accent">${loading ? 'Loading...' : v + ' - Latest Release'}</span>
      <h1>The All-in-One<br><span class="grad">Media Toolkit</span></h1>
      <p class="sub">Cross-platform media processing powered by FFmpeg.<br>Batch normalize, convert, compress, edit, and play - all from one app.</p>
      <div class="hero-actions">
        <a href="${hrefDl}" class="btn btn-primary btn-lg" target="_blank" rel="noopener">${icon('download', 18)} Download for ${platLabel}</a>
        <a z-link="/features" class="btn btn-secondary btn-lg" z-to-top>Explore Features</a>
      </div>
    </div>
    <div class="hero-right reveal">
      <div class="stat-stack">
        <div class="stat-row">
          <div class="stat-val">${loading ? '\u2014' : fmt.num(dl)}</div>
          <div class="stat-label">Downloads</div>
        </div>
        <div class="stat-row">
          <div class="stat-val">35+</div>
          <div class="stat-label">Formats</div>
        </div>
        <div class="stat-row">
          <div class="stat-val">${loading ? '\u2014' : v}</div>
          <div class="stat-label">Version</div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- Three Pillars -->
<section class="section section-compact">
  <div class="container">
    <div class="section-heading reveal">
      <h2>Three Tools, One App</h2>
      <p>Professional media processing, editing, and playback \u2014 unified under one roof.</p>
    </div>
    <div class="pillar-grid stagger" data-parallax data-parallax-speed="0.06">
      <a z-link="/features/batch" class="pillar-card card reveal" z-to-top>
        <div class="pillar-icon purple">${icon('zap', 28)}</div>
        <div class="pillar-body">
          <h3>Batch Processor</h3>
          <p>Normalize, convert, compress, boost, and extract audio across hundreds of files simultaneously with concurrent workers.</p>
          <ul class="pillar-list">
            <li>5 operations, 24 format presets</li>
            <li>CRF + target-size compression</li>
            <li>ITU-R BS.1770-4 loudness</li>
          </ul>
          <span class="pillar-link">Explore Batch ${icon('arrow-right', 14)}</span>
        </div>
      </a>
      <a z-link="/features/editor" class="pillar-card card reveal" z-to-top>
        <div class="pillar-icon blue">${icon('scissors', 28)}</div>
        <div class="pillar-body">
          <h3>Media Editor</h3>
          <p>Full NLE timeline with multi-track editing, spatial compositing, keyframe animation, and 8 blend modes.</p>
          <ul class="pillar-list">
            <li>7 edit types, 4 trim types</li>
            <li>Per-clip transform + keyframes</li>
            <li>Two-pass GIF export pipeline</li>
          </ul>
          <span class="pillar-link">Explore Editor ${icon('arrow-right', 14)}</span>
        </div>
      </a>
      <a z-link="/features/player" class="pillar-card card reveal" z-to-top>
        <div class="pillar-icon emerald">${icon('play', 28)}</div>
        <div class="pillar-body">
          <h3>Media Player</h3>
          <p>Play local files or stream from YouTube with 8 real-time audio visualizations driven by multi-band frequency analysis.</p>
          <ul class="pillar-list">
            <li>8 vis modes with beat detection</li>
            <li>Playlists, popout, always-on-top</li>
            <li>yt-dlp streaming integration</li>
          </ul>
          <span class="pillar-link">Explore Player ${icon('arrow-right', 14)}</span>
        </div>
      </a>
    </div>
  </div>
</section>

<!-- Highlights -->
<section class="section section-compact section-alt">
  <div class="container">
    <div class="section-heading reveal">
      <h2>Why Molex Media?</h2>
      <p>Built for power users who want everything in one place.</p>
    </div>
    <div class="highlight-grid stagger" data-parallax data-parallax-speed="0.05">
      <div class="highlight-item reveal">
        <div class="feat-icon amber">${icon('layers', 20)}</div>
        <div class="highlight-text">
          <h4>24 Conversion Presets</h4>
          <p>General, Web/Social, Devices, Production, Audio-Only \u2014 with codec conflict detection.</p>
        </div>
      </div>
      <div class="highlight-item reveal">
        <div class="feat-icon cyan">${icon('flag', 20)}</div>
        <div class="highlight-text">
          <h4>Zero Configuration</h4>
          <p>FFmpeg and yt-dlp download automatically on first launch. No manual setup.</p>
        </div>
      </div>
      <div class="highlight-item reveal">
        <div class="feat-icon red">${icon('monitor', 20)}</div>
        <div class="highlight-text">
          <h4>Cross-Platform</h4>
          <p>Windows, macOS, and Linux. Native installers with auto-update from GitHub Releases.</p>
        </div>
      </div>
      <div class="highlight-item reveal">
        <div class="feat-icon purple">${icon('wand', 20)}</div>
        <div class="highlight-text">
          <h4>Setup Wizard</h4>
          <p>Guided first-run with progress tracking, retry on failure, and manual fallback.</p>
        </div>
      </div>
      <div class="highlight-item reveal">
        <div class="feat-icon blue">${icon('refresh-cw', 20)}</div>
        <div class="highlight-text">
          <h4>Auto-Updater</h4>
          <p>One-click updates directly from GitHub Releases with download progress.</p>
        </div>
      </div>
      <div class="highlight-item reveal">
        <div class="feat-icon emerald">${icon('folder', 20)}</div>
        <div class="highlight-text">
          <h4>File Browser</h4>
          <p>VLC-style with known-folder shortcuts. Multi-file/folder select. Drag-drop everywhere.</p>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- Live Project Stats -->
<section class="section section-compact">
  <div class="container">
    <div class="section-heading reveal">
      <h2>Open Source</h2>
      <p>Built in public on GitHub. Track development, report issues, and contribute.</p>
    </div>
    <div class="gh-stats-grid reveal" data-parallax data-parallax-speed="0.04">
      <div class="gh-stat-card card">
        <div class="gh-stat-number">${loading ? '\u2014' : fmt.num(repoInfo?.forks_count || 0)}</div>
        <div class="gh-stat-label">Forks</div>
      </div>
      <div class="gh-stat-card card">
        <div class="gh-stat-number">${loading ? '\u2014' : fmt.num(dl)}</div>
        <div class="gh-stat-label">Total Downloads</div>
      </div>
      <div class="gh-stat-card card">
        <div class="gh-stat-number">${loading ? '\u2014' : (s.state.releases?.length || 0)}</div>
        <div class="gh-stat-label">Releases</div>
      </div>
      <div class="gh-stat-card card">
        <div class="gh-stat-number">${loading ? '\u2014' : fmt.num(repoInfo?.open_issues_count || 0)}</div>
        <div class="gh-stat-label">Open Issues</div>
      </div>
    </div>
    ${!loading && workflows.length ? `
    <div class="wf-section reveal">
      <h4 class="wf-section-title">CI / CD Pipelines</h4>
      <div class="wf-badges-row">
        ${workflows.map(w => {
          const st = wfStatus(w);
          return `<div class="wf-badge-item"><span class="wf-dot ${st.cls}"></span><span class="wf-badge-name">${$.escapeHtml(w.name)}</span><span class="wf-badge-status ${st.cls}">${st.label}</span></div>`;
        }).join('')}
      </div>
    </div>` : ''}
  </div>
</section>

<!-- Tech stack -->
<section class="section section-compact section-alt">
  <div class="container">
    <div class="section-heading reveal">
      <h2>Built With</h2>
      <p>Modern stack for a professional desktop experience.</p>
    </div>
    <div class="tech-row reveal" data-parallax data-parallax-speed="0.04">
      ${['Electron', 'React 19', 'TypeScript', 'Tailwind CSS', 'Vite', 'Zustand', 'Framer Motion', 'FFmpeg', 'yt-dlp', 'Web Audio API'].map(t => `<div class="tech-chip">${t}</div>`).join('')}
    </div>
  </div>
</section>

<!-- CTA -->
<section class="section cta-section">
  <div class="container" style="text-align:center">
    <div class="reveal">
      <h2 class="cta-title">Ready to Get Started?</h2>
      <p class="cta-sub">Download Molex Media and start processing your media files in seconds.</p>
      <div class="hero-actions">
        <a z-link="/download" class="btn btn-primary btn-lg" z-to-top>${icon('download', 18)} Download Now</a>
        <a href="https://github.com/tonywied17/molex-media-electron" target="_blank" rel="noopener" class="btn btn-secondary btn-lg">${icon('github', 18)} View on GitHub</a>
      </div>
    </div>
  </div>
</section>`;
  },
});
