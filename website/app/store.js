// store.js - global app store

const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
export const API_BASE = isLocal ? 'http://localhost:3610' : 'https://media-api.molex.cloud';

export const store = $.store('app', {
  state: {
    releases: [],
    latestRelease: null,
    workflows: [],
    repoInfo: null,
    loading: true,
    error: null,
  },
  actions: {
    setReleases(state, r) {
      state.releases = r;
      if (r.length) state.latestRelease = r[0];
    },
    setWorkflows(state, w) {
      state.workflows = Array.isArray(w) ? w : [];
    },
    setRepoInfo(state, i) {
      state.repoInfo = i;
    },
    setLoading(state, l) {
      state.loading = l;
    },
    setError(state, e) {
      state.error = e;
    },
  },
  getters: {
    totalDownloads(state) {
      let t = 0;
      for (const r of state.releases)
        for (const a of r.assets || []) t += a.download_count || 0;
      return t;
    },
    version(state) {
      return state.latestRelease?.tag_name || '...';
    },
    win(state) {
      return state.latestRelease?.assets?.find((a) => a.name.endsWith('.exe'));
    },
    mac(state) {
      return state.latestRelease?.assets?.find((a) => a.name.endsWith('.dmg'));
    },
    linux(state) {
      return state.latestRelease?.assets?.find((a) =>
        a.name.endsWith('.AppImage'),
      );
    },
  },
});

export async function fetchGitHubData() {
  const store = $.getStore('app');
  if (!store || typeof store.dispatch !== 'function') {
    setTimeout(fetchGitHubData, 200);
    return;
  }
  store.dispatch('setLoading', true);
  try {
    const [relRes, repoRes, wfRes] = await $.http.all([
      $.get('/releases'),
      $.get('/repo'),
      $.get('/workflows'),
    ]);
    if (relRes.ok && Array.isArray(relRes.data))
      store.dispatch('setReleases', relRes.data);
    if (repoRes.ok && repoRes.data && typeof repoRes.data === 'object')
      store.dispatch('setRepoInfo', repoRes.data);
    if (wfRes.ok && Array.isArray(wfRes.data))
      store.dispatch('setWorkflows', wfRes.data);
  } catch {
    store.dispatch('setError', 'Failed to load data.');
  } finally {
    store.dispatch('setLoading', false);
  }
}

export const fmt = {
  date(d) {
    return new Date(d).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  },
  num(n) {
    return n >= 1e6
      ? (n / 1e6).toFixed(1) + 'M'
      : n >= 1e3
        ? (n / 1e3).toFixed(1) + 'K'
        : String(n);
  },
  bytes(b) {
    if (!b) return '0 B';
    const k = 1024,
      s = ['B', 'KB', 'MB', 'GB'],
      i = Math.floor(Math.log(b) / Math.log(k));
    return parseFloat((b / Math.pow(k, i)).toFixed(1)) + ' ' + s[i];
  },
  md(raw) {
    if (!raw) return '';
    let h = $.escapeHtml(raw);
    // Strip release title lines
    h = h.replace(/^##?\s*\[[\d.]+\]\s*-\s*\d{4}-\d{2}-\d{2}\s*\n*/gm, '');
    h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>');
    h = h.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
    h = h.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
    // Shorten commit hashes
    h = h.replace(
      /\(<a [^>]*>([a-f0-9]{7})[a-f0-9]*<\/a>\)/g,
      '(<code>$1</code>)',
    );
    h = h.replace(
      /\(https:\/\/github\.com\/[^)]+\/commit\/([a-f0-9]{7})[a-f0-9]*\)/g,
      '(<code>$1</code>)',
    );
    h = h.replace(
      /\(\[([a-f0-9]{7})[a-f0-9]*\]\([^)]*\)\)/g,
      '(<code>$1</code>)',
    );

    const emojiMap = {
      '\uD83D\uDC1B': 'alert-circ',
      '\uD83C\uDFA8': 'image',
      '\u2728': 'sparkles',
      '\uD83D\uDE80': 'zap',
      '\uD83D\uDD27': 'settings',
      '\uD83D\uDCDD': 'scroll',
      '\u267B\uFE0F': 'refresh-cw',
      '\u267B': 'refresh-cw',
      '\uD83D\uDCA5': 'alert-circ',
      '\uD83C\uDF89': 'star',
      '\u2705': 'check-circ',
      '\uD83D\uDEA8': 'alert-circ',
      '\uD83D\uDD0A': 'volume',
      '\uD83D\uDCE6': 'package',
      '\uD83C\uDFAC': 'film',
      '\uD83D\uDDC3\uFE0F': 'folder',
      '\uD83D\uDDC3': 'folder',
      '\u2699\uFE0F': 'settings',
      '\u2699': 'settings',
      '\uD83D\uDEE0\uFE0F': 'settings',
      '\uD83D\uDEE0': 'settings',
      '\uD83E\uDDEA': 'check-circ',
      '\uD83D\uDD28': 'settings',
      '\u270F\uFE0F': 'scroll',
      '\u270F': 'scroll',
      '\uD83D\uDCCB': 'list',
      '\uD83E\uDDF9': 'refresh-cw',
      '\uD83E\uDE79': 'alert-circ',
      '\uD83D\uDD0D': 'search',
      '\uD83D\uDD12': 'check-circ',
      '\uD83C\uDD95': 'plus',
      '\u26A1': 'zap',
      '\uD83D\uDCC8': 'activity',
      '\uD83D\uDCCC': 'pin',
      '\uD83D\uDCA1': 'lightbulb',
      '\uD83C\uDF10': 'globe',
      '\uD83C\uDFF7\uFE0F': 'flag',
      '\uD83C\uDFF7': 'flag',
    };

    for (const [emoji, name] of Object.entries(emojiMap)) {
      const svg = `<svg class="ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><title>${name}</title></svg>`;
      h = h.replaceAll(emoji, svg);
    }

    const _p = {
      'alert-circ':
        '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
      image:
        '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
      sparkles:
        '<path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/><path d="M19 13l.75 2.25L22 16l-2.25.75L19 19l-.75-2.25L16 16l2.25-.75L19 13z"/>',
      zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
      settings:
        '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
      scroll:
        '<path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/>',
      'refresh-cw':
        '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
      star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
      'check-circ':
        '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
      volume:
        '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
      package:
        '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
      film: '<rect x="2" y="2" width="20" height="20" rx="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/><line x1="17" y1="17" x2="22" y2="17"/>',
      folder:
        '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
      list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
      search:
        '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
      plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
      activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
      pin: '<path d="M21 10c0 6-9 13-9 13S3 16 3 10a9 9 0 1 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
      lightbulb:
        '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>',
      globe:
        '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
      flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
    };

    h = h.replace(
      /<svg class="ico"([^>]*)><title>([^<]+)<\/title><\/svg>/g,
      (_, attrs, name) => {
        const paths = _p[name] || '';
        return `<svg class="ico"${attrs}>${paths}</svg>`;
      },
    );

    // Clean up excessive line breaks
    h = h.replace(/(<br\s*\/?>[\s]*){3,}/gi, '<br>');
    h = h.replace(/(<\/(h[23]|ul)>)\s*(<br\s*\/?>[\s]*)+/gi, '$1');
    h = h.replace(/(<br\s*\/?>[\s]*)+(<h[23]>)/gi, '$2');
    h = h.replace(/^(\s*<br\s*\/?>[\s]*)+/i, '');
    h = h.replace(/(\s*<br\s*\/?>[\s]*)+$/i, '');
    return h;
  },
};
