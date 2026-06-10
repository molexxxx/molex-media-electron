import { icon } from '../icons.js';
import { refreshReveals } from '../scroll-animations.js';
import { fmt } from '../store.js';

$.component('download-page', {
  state: () => ({ _t: 0 }),

  mounted() {
    this._unsub = $.getStore('app').subscribe(() => {
      this.state._t++;
    });
    setTimeout(refreshReveals, 50);
  },

  destroyed() {
    if (this._unsub) this._unsub();
  },

  render() {
    const s = $.getStore('app');
    const { loading, latestRelease } = s.state;
    const v = s.getters.version;
    const dl = s.getters.totalDownloads;
    const win = s.getters.win;
    const mac = s.getters.mac;
    const linux = s.getters.linux;

    setTimeout(refreshReveals, 30);

    const platformCard = (name, ico, asset, color) => {
      const href = asset
        ? $.escapeHtml(asset.browser_download_url)
        : 'https://github.com/tonywied17/molex-media-electron/releases/latest';
      const size = asset ? fmt.bytes(asset.size) : '--';
      const fname = asset ? asset.name : '';
      return `
      <a href="${href}" target="_blank" rel="noopener" class="card card-glow dl-card reveal">
        <div class="dl-icon" style="color:var(--${color})">${icon(ico, 44)}</div>
        <h3>${name}</h3>
        <p class="dl-meta">${loading ? '<span class="skel skel-ts" style="display:inline-block;width:100px"></span>' : fname}</p>
        <p style="font-size:.78rem;color:var(--text5);margin-bottom:14px">${loading ? '...' : size}</p>
        <span class="btn btn-primary btn-sm">${icon('download', 14)} Download</span>
      </a>`;
    };

    return `
<section class="hero" style="padding-bottom:32px">
  <div class="container hero-content">
    <div class="reveal">
      <span class="badge badge-accent" style="margin-bottom:16px">${loading ? 'Loading...' : v + ' - Latest Release'}</span>
      <h1>Download <span class="grad">Molex Media</span></h1>
      <p class="sub">Available for Windows, macOS, and Linux. Auto-updates keep you on the latest version.</p>
    </div>
    <div class="dl-stats reveal" style="transition-delay:0.1s">
      <div class="dl-stat">
        <div class="dl-stat-val">${loading ? '...' : fmt.num(dl)}</div>
        <div class="dl-stat-label">Total Downloads</div>
      </div>
      <div class="dl-stat">
        <div class="dl-stat-val">${loading ? '...' : v}</div>
        <div class="dl-stat-label">Latest Version</div>
      </div>
      <div class="dl-stat">
        <div class="dl-stat-val">${loading ? '...' : (latestRelease ? fmt.date(latestRelease.published_at) : '--')}</div>
        <div class="dl-stat-label">Released</div>
      </div>
    </div>
  </div>
</section>

<section class="section section-compact">
  <div class="container">
    <div class="dl-grid" data-parallax data-parallax-speed="0.05">
      ${platformCard('Windows', 'monitor', win, 'blue')}
      ${platformCard('macOS', 'monitor', mac, 'a400')}
      ${platformCard('Linux', 'monitor', linux, 'emerald')}
    </div>
  </div>
</section>

<!-- System Requirements -->
<section class="section section-alt">
  <div class="container">
    <div class="section-heading reveal"><h2>System Requirements</h2></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px;max-width:860px;margin:0 auto">
      <div class="card reveal" style="padding:24px">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
          <div class="feat-icon blue">${icon('cpu', 22)}</div>
          <h3 style="font-size:.95rem">Minimum</h3>
        </div>
        <table class="spec-table">
          <tr><td>OS</td><td>Windows 10+, macOS 11+, Ubuntu 20.04+</td></tr>
          <tr><td>RAM</td><td>4 GB</td></tr>
          <tr><td>Disk</td><td>500 MB free</td></tr>
          <tr><td>Internet</td><td>For first-run bootstrap & streaming</td></tr>
        </table>
      </div>
      <div class="card reveal" style="padding:24px">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
          <div class="feat-icon emerald">${icon('zap', 22)}</div>
          <h3 style="font-size:.95rem">Recommended</h3>
        </div>
        <table class="spec-table">
          <tr><td>OS</td><td>Latest stable release</td></tr>
          <tr><td>RAM</td><td>8 GB+</td></tr>
          <tr><td>GPU</td><td>Hardware-accel (NVENC, QSV, VT)</td></tr>
          <tr><td>Disk</td><td>SSD for faster batch processing</td></tr>
        </table>
      </div>
    </div>
  </div>
</section>

<!-- Zero Setup -->
<section class="section" style="text-align:center">
  <div class="container reveal">
    <div class="feat-icon amber" style="margin:0 auto 16px">${icon('flag', 22)}</div>
    <h2 style="margin-bottom:10px">Zero Configuration</h2>
    <p style="color:var(--text3);max-width:480px;margin:0 auto 20px">FFmpeg and yt-dlp are downloaded automatically on first launch. No PATH setup, no manual installs - just open and go.</p>
    <a z-link="/features" class="btn btn-secondary" z-to-top>Explore All Features ${icon('arrow-right', 16)}</a>
  </div>
</section>`;
  },
});
