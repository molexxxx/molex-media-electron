import { icon } from '../icons.js';
import { refreshReveals } from '../scroll-animations.js';
import { fmt } from '../store.js';

$.component('changelog-page', {
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
    const { releases, loading } = s.state;
    const latest = releases[0];

    setTimeout(refreshReveals, 30);

    if (loading)
      return `
<section class="hero" style="padding-bottom:24px">
  <div class="container hero-content">
    <h1>Changelog</h1>
    <div style="display:flex;flex-direction:column;gap:20px;margin-top:32px">
      ${Array(3).fill('<div class="card" style="padding:28px"><div class="skel skel-h"></div><div class="skel skel-ts" style="margin:10px 0"></div><div class="skel skel-p"></div><div class="skel skel-p" style="width:60%"></div></div>').join('')}
    </div>
  </div>
</section>`;

    return `
<section class="hero" style="padding-bottom:24px">
  <div class="container hero-content">
    <div class="reveal">
      <span class="badge badge-accent" style="margin-bottom:16px">${icon('flag', 14)} ${releases.length} Releases</span>
      <h1><span class="grad">Changelog</span></h1>
      <p class="sub">Release history, patch notes, and downloadable assets for every version.</p>
    </div>
  </div>
</section>

<section class="section">
  <div class="container" style="max-width:800px">
    <div class="changelog-timeline">
      ${releases.map((r, i) => {
        const isLatest = i === 0;
        const date = fmt.date(r.published_at);
        const body = fmt.md(r.body);
        const assetCount = r.assets?.length || 0;
        const dls = r.assets ? r.assets.reduce((t, a) => t + (a.download_count || 0), 0) : 0;

        return `
        <article class="cl-entry ${isLatest ? 'cl-latest' : ''} reveal" style="transition-delay:${Math.min(i * 0.06, 0.4)}s">
          <div class="cl-dot">${isLatest ? icon('star', 14) : ''}</div>
          <div class="cl-body card" style="padding:14px 18px">
            <div class="cl-head">
              <div>
                <h2 class="cl-version">${$.escapeHtml(r.tag_name || r.name)}${isLatest ? ' <span class="badge badge-accent" style="font-size:.65rem;margin-left:8px">Latest</span>' : ''}</h2>
                <div class="cl-meta">${icon('clock', 13)} ${date}${assetCount ? ` &middot; ${icon('package', 13)} ${assetCount} asset${assetCount > 1 ? 's' : ''}` : ''}${dls ? ` &middot; ${icon('download', 13)} ${fmt.num(dls)}` : ''}</div>
              </div>
              <a href="${$.escapeHtml(r.html_url)}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">${icon('external', 14)} GitHub</a>
            </div>
            ${body ? `<div class="cl-notes">${body}</div>` : '<p style="color:var(--text5);font-style:italic;margin-top:12px">No release notes.</p>'}
            ${assetCount ? `
            <details class="cl-assets">
              <summary>${icon('download', 14)} Download Assets (${assetCount})</summary>
              <ul>${r.assets.map(a => `
                <li><a href="${$.escapeHtml(a.browser_download_url)}" target="_blank" rel="noopener">${icon('package', 13)} ${$.escapeHtml(a.name)} <span class="cl-size">${fmt.bytes(a.size)}</span></a></li>`).join('')}
              </ul>
            </details>` : ''}
          </div>
        </article>`;
      }).join('')}
    </div>
    ${releases.length === 0 ? '<p style="text-align:center;color:var(--text5)">No releases found.</p>' : ''}
  </div>
</section>`;
  },
});
