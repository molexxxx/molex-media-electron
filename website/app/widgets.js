import { icon } from './icons.js';
import {
    store, loadReleases, loadNotes, installers, detectPlatform, linuxPackage, fmt, markdown, releaseSummary,
    LATEST_URL, RELEASES_URL,
} from './store.js';
import {
    opChip, link, logLine, notice, reducedMotion, NORMALIZE_LOG, TIMELINE, timecode,
    timelineLanes, timelineHeads, timelineTools,
} from './parts.js';

const PLATFORM_NAMES = { windows: 'Windows', mac: 'macOS', linux: 'Linux' };

/**
 * Subscribes a component to the release store for its lifetime.
 * @param {object} cmp Component instance with a numeric state.tick.
 */
function watchStore(cmp)
{
    cmp._unsub = store.subscribe(() =>
    {
        cmp.state.tick++;
    });
}

function releaseState()
{
    const { status } = store.state;
    const rel = store.getters.latest;
    return {
        loading: status === 'idle' || status === 'loading',
        failed: status === 'error',
        rel,
        files: installers(rel),
        version: fmt.version(rel),
    };
}

function fileMeta(asset, extra)
{
    return `<b>${$.escapeHtml(asset.name)}</b> · ${fmt.bytes(asset.size)}${extra ? ` · ${extra}` : ''}`;
}

$.component('get-block', {
    state: () => ({ tick: 0, copied: false }),

    mounted()
    {
        watchStore(this);
        loadReleases();
    },

    destroyed()
    {
        this._unsub?.();
    },

    retry()
    {
        loadReleases(true);
    },

    async copyLink()
    {
        try
        {
            await navigator.clipboard.writeText('https://media.molex.cloud/download');
            this.state.copied = true;
        }
        catch
        {
            this.state.copied = false;
        }
    },

    render()
    {
        const platform = detectPlatform();
        const { loading, failed, files, version } = releaseState();
        const terms = '<p class="get-terms">Free and open source under the MIT license. No account needed.</p>';
        const more = `<p class="get-more">${link('/download', 'Other platforms and install notes')}${version ? link('/changelog', `What's new in ${version}`) : ''}</p>`;
        const retry = failed
            ? `<p class="get-file">Release details did not load, so the button opens the latest release on GitHub. <button type="button" class="link-btn" @click="retry">Try again</button></p>`
            : '';

        if (platform === 'mobile')
        {
            return `<div class="get">
                <p class="get-note"><strong>molexMedia is a desktop app</strong> for Windows, macOS, and Linux. Open this page on your computer to download it, or keep the link for later.</p>
                <p class="get-more">
                    ${link('/download', `${icon('download', 16)} See every download`, 'btn btn-primary')}
                    <button type="button" class="btn btn-ghost" @click="copyLink">${icon(this.state.copied ? 'check' : 'copy', 16)}${this.state.copied ? 'Link copied' : 'Copy link'}</button>
                </p>
            </div>`;
        }

        if (platform === 'linux')
        {
            const first = linuxPackage();
            const second = first === 'deb' ? 'rpm' : 'deb';
            const btn = (kind, cls) =>
            {
                const asset = files[kind];
                return `<a class="btn ${cls}" href="${asset ? $.escapeHtml(asset.browser_download_url) : LATEST_URL}">${icon('download', 18)}Download .${kind}</a>`;
            };
            const meta = loading
                ? '<span class="skel" style="--w:26ch"></span>'
                : files[first] ? `${fileMeta(files[first], 'x64')}` : '';
            return `<div class="get">
                <p class="get-more">${btn(first, 'btn-primary btn-lg')}${btn(second, 'btn-ghost btn-lg')}</p>
                <p class="get-meta">${meta}</p>
                <p class="get-file">.deb for Debian and Ubuntu, .rpm for Fedora and openSUSE.</p>
                ${retry}${terms}${more}
            </div>`;
        }

        if (platform === 'windows' || platform === 'mac')
        {
            const asset = platform === 'windows' ? files.windows : files.mac;
            const extra = platform === 'windows' ? 'x64' : 'Universal: Apple Silicon and Intel';
            const meta = loading
                ? '<span class="skel" style="--w:30ch"></span>'
                : asset ? fileMeta(asset, extra) : '';
            return `<div class="get">
                <a class="btn btn-primary btn-lg" href="${asset ? $.escapeHtml(asset.browser_download_url) : LATEST_URL}">${icon('download', 20)}Download for ${PLATFORM_NAMES[platform]}</a>
                <p class="get-meta">${meta}</p>
                ${retry}${terms}${more}
            </div>`;
        }

        return `<div class="get">
            ${link('/download', `${icon('download', 20)}Choose your download`, 'btn btn-primary btn-lg')}
            ${terms}
        </div>`;
    },
});

$.component('platform-list', {
    state: () => ({ tick: 0, copied: '' }),

    mounted()
    {
        watchStore(this);
        loadReleases();
    },

    destroyed()
    {
        this._unsub?.();
        clearTimeout(this._copyTimer);
    },

    retry()
    {
        loadReleases(true);
    },

    async copy(kind)
    {
        const cmd = this._el.querySelector(`[data-cmd="${kind}"]`)?.textContent || '';
        try
        {
            await navigator.clipboard.writeText(cmd);
            this.state.copied = kind;
            clearTimeout(this._copyTimer);
            this._copyTimer = setTimeout(() =>
            {
                this.state.copied = '';
            }, 2000);
        }
        catch
        {
            this.state.copied = '';
        }
    },

    render()
    {
        const detail = this.props.detail === true || this.props.detail === 'true';
        const detected = detectPlatform();
        const pkg = linuxPackage();
        const { loading, failed, files } = releaseState();
        const order = ['windows', 'mac', 'linux'].sort((a, b) => (b === detected) - (a === detected));

        const spec = (parts) => (loading ? '<span class="skel" style="--w:24ch"></span>' : parts.filter(Boolean).join(' · '));
        const size = (asset) => (asset ? fmt.bytes(asset.size) : '');
        const button = (asset, label, primary) =>
            `<a class="btn ${primary ? 'btn-primary' : 'btn-ghost'}" href="${asset ? $.escapeHtml(asset.browser_download_url) : LATEST_URL}">${icon('download', 16)}${label}</a>`;
        const file = (asset) => (asset ? `<p class="plat-file">${$.escapeHtml(asset.name)}</p>` : '');
        const cmd = (kind, text) => `<div class="cmd"><code data-cmd="${kind}">${$.escapeHtml(text)}</code><button type="button" class="copy" @click="copy('${kind}')">${icon(this.state.copied === kind ? 'check' : 'copy', 14)}${this.state.copied === kind ? 'Copied' : 'Copy'}</button></div>`;
        const card = (p, name, specHtml, purpose, buttons, help) => `<div class="plat" data-detected="${detected === p}">
                <div class="plat-main">
                    <h3 class="plat-name">${name}${p === detected ? '<span class="plat-you">Your system</span>' : ''}</h3>
                    <p class="plat-spec">${specHtml}</p>
                    <p class="plat-purpose">${purpose}</p>
                </div>
                <div class="plat-actions" data-count="${buttons.length}">${buttons.join('')}</div>
                ${detail ? `<div class="plat-help">${help}</div>` : ''}
            </div>`;

        const cards = {
            windows: () => card('windows', 'Windows',
                spec(['x64', '.exe installer', size(files.windows)]),
                'Choose the install folder. Updates itself from GitHub Releases.',
                [button(files.windows, 'Download .exe', detected === 'windows')],
                `${file(files.windows)}<p>The installer is not code-signed yet, so Windows SmartScreen may say it protected your PC. Choose <strong>More info</strong>, then <strong>Run anyway</strong>.</p>`),
            mac: () => card('mac', 'macOS',
                spec(['Universal', '.dmg', size(files.mac)]),
                'Runs natively on Apple Silicon and Intel. Updates itself from GitHub Releases.',
                [button(files.mac, 'Download .dmg', detected === 'mac')],
                `${file(files.mac)}<p>Open the disk image and drag molexMedia to Applications. On Apple Silicon, the FFmpeg that the setup wizard downloads is an Intel build that runs under Rosetta 2.</p>`),
            linux: () => card('linux', 'Linux',
                spec(['x64', files.deb ? `.deb ${size(files.deb)}` : '.deb', files.rpm ? `.rpm ${size(files.rpm)}` : '.rpm']),
                '.deb for Debian and Ubuntu, .rpm for Fedora and openSUSE.',
                [button(files.deb, '.deb', detected === 'linux' && pkg === 'deb'), button(files.rpm, '.rpm', detected === 'linux' && pkg === 'rpm')],
                `<p>Install the package from the folder you saved it to:</p>${cmd('deb', `sudo apt install ./${files.deb?.name || 'molexMedia-VERSION-Linux-Installer.deb'}`)}${cmd('rpm', `sudo dnf install ./${files.rpm?.name || 'molexMedia-VERSION-Linux-Installer.rpm'}`)}<p>Linux builds do not update themselves. Download the new package when a release comes out.</p>`),
        };

        const head = failed
            ? notice('Release details did not load.', 'The buttons below open the latest release on GitHub instead.', `<button type="button" class="link-btn" @click="retry">Try again</button><a href="${RELEASES_URL}" rel="noopener">All releases on GitHub</a>`)
            : '';
        const mobile = detected === 'mobile'
            ? '<p class="get-note"><strong>You are on a phone or tablet.</strong> molexMedia runs on Windows, macOS, and Linux desktops.</p>'
            : '';

        return `<div class="platforms">${head}${mobile}${order.map((p) => cards[p]()).join('')}</div>`;
    },
});

const QUEUE = [
    { op: 'normalize', tag: '-16 LUFS', name: 'podcast-ep41-master.wav', meta: '58:12 · 612 MB', result: 'at -16 LUFS', speed: 1.1 },
    { op: 'convert', tag: 'MKV › MP4', name: 'lecture-03.mkv', meta: '47:05 · 1.4 GB', result: '5 of 5 streams kept', speed: 0.8 },
    { op: 'compress', tag: '25 MB', name: 'drone-reel-4k.mov', meta: '2:14 · 1.8 GB', result: 'fits 25 MB', speed: 0.65 },
    { op: 'extract', tag: '› FLAC', name: 'concert-cam-b.mp4', meta: '1:32:18 · 4.2 GB', result: 'saved as FLAC', speed: 1.5 },
    { op: 'boost', tag: '+50%', name: 'field-recording-07.wav', meta: '12:40 · 146 MB', result: 'peaks at -1 dBTP', speed: 1.7 },
    { op: 'normalize', tag: 'Broadcast', name: 'interview-cam-a.mkv', meta: '1:12:40 · 2.1 GB', result: 'at -23 LUFS', speed: 0.9 },
];
const WORKERS = 4;
const SCREENS = [
    { id: 'batch', label: 'Batch', icon: 'batch', group: 'Workflow' },
    { id: 'editor', label: 'Editor', icon: 'editor', group: 'Tools' },
    { id: 'player', label: 'Player', icon: 'player' },
    { id: 'logs', label: 'Logs', icon: 'logs', group: 'System' },
];

function barsSvg(count, seed)
{
    let bars = '';
    for (let i = 0; i < count; i++)
    {
        const h = 0.18 + 0.72 * Math.abs(Math.sin(i * 0.37 + seed) * Math.cos(i * 0.11 + seed * 2));
        const x = i * (100 / count);
        bars += `<rect x="${x + 0.3}" y="${100 - h * 100}" width="${100 / count - 0.6}" height="${h * 100}" rx="0.4"/>`;
    }
    return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%" aria-hidden="true"><g fill="#6d28d9" opacity="0.8">${bars}</g></svg>`;
}

const freshRows = (state = 'queued') => QUEUE.map(() => ({ p: state === 'done' ? 1 : 0, state }));

// The queue run paints rows in place instead of re-rendering, so the sidebar tabs keep their hover and click state.
$.component('app-window', {
    state: () => ({
        tick: 0,
        screen: 'batch',
        running: false,
    }),

    init()
    {
        this._rows = freshRows();
    },

    mounted()
    {
        watchStore(this);
        if (reducedMotion() || !('IntersectionObserver' in window))
        {
            return;
        }
        this._io = new IntersectionObserver((entries) =>
        {
            if (entries.some((e) => e.isIntersecting))
            {
                this._io.disconnect();
                this._start = setTimeout(() => this.run(), 700);
            }
        }, { threshold: 0.35 });
        this._io.observe(this._el);
    },

    destroyed()
    {
        this._unsub?.();
        this._io?.disconnect();
        clearTimeout(this._start);
        clearInterval(this._timer);
    },

    show(id)
    {
        this.state.screen = id;
    },

    onKey(e)
    {
        const ids = SCREENS.map((s) => s.id);
        const i = ids.indexOf(this.state.screen);
        const moves = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: ids.length - 1 };
        if (!(e.key in moves))
        {
            return;
        }
        e.preventDefault();
        const next = ids[(moves[e.key] + ids.length) % ids.length];
        this.state.screen = next;
        requestAnimationFrame(() => this._el.querySelector(`#win-tab-${next}`)?.focus());
    },

    run()
    {
        if (this.state.running)
        {
            return;
        }
        if (reducedMotion())
        {
            this._rows = freshRows('done');
            this.state.tick++;
            return;
        }
        this._rows = freshRows();
        this.state.running = true;
        clearInterval(this._timer);
        this._timer = setInterval(() => this.step(), 100);
    },

    step()
    {
        const rows = this._rows;
        let active = rows.filter((r) => r.state === 'running').length;
        for (const r of rows)
        {
            if (active >= WORKERS)
            {
                break;
            }
            if (r.state === 'queued')
            {
                r.state = 'running';
                active++;
            }
        }
        rows.forEach((r, i) =>
        {
            if (r.state === 'running')
            {
                r.p = Math.min(1, r.p + QUEUE[i].speed * 0.034);
                if (r.p >= 1)
                {
                    r.state = 'done';
                }
            }
        });
        if (rows.every((r) => r.state === 'done'))
        {
            clearInterval(this._timer);
            this._timer = null;
            this.state.running = false;
            return;
        }
        this.paint();
    },

    counts()
    {
        const done = this._rows.filter((r) => r.state === 'done').length;
        const active = this._rows.filter((r) => r.state === 'running').length;
        return { done, active, queued: this._rows.length - done - active, total: this._rows.length };
    },

    rowMeta(i)
    {
        const r = this._rows[i];
        if (r.state === 'done')
        {
            return `${icon('check', 12)}${QUEUE[i].result}`;
        }
        return r.state === 'running' ? `${Math.round(r.p * 100)}%` : QUEUE[i].meta;
    },

    subText()
    {
        const c = this.counts();
        if (this.state.running)
        {
            return `Processing ${c.done + c.active} of ${c.total}`;
        }
        return c.done === c.total ? `${c.total} files processed` : `${c.total} files queued`;
    },

    statusText()
    {
        const c = this.counts();
        if (this.state.running)
        {
            return `Processing ${c.done}/${c.total}`;
        }
        return c.done === c.total ? `Done ${c.done}/${c.total}` : 'Ready';
    },

    paint()
    {
        const el = this._el;
        this._rows.forEach((r, i) =>
        {
            const row = el.querySelector(`.q-row[data-row="${i}"]`);
            if (!row)
            {
                return;
            }
            if (row.dataset.state !== r.state)
            {
                row.dataset.state = r.state;
            }
            row.querySelector('.q-bar').style.setProperty('--p', r.p);
            const meta = row.querySelector('.q-meta');
            const html = this.rowMeta(i);
            if (meta.innerHTML !== html)
            {
                meta.innerHTML = html;
            }
        });
        const c = this.counts();
        for (const key of ['queued', 'active', 'done'])
        {
            const node = el.querySelector(`[data-stat="${key}"]`);
            if (node)
            {
                node.textContent = c[key];
            }
        }
        const sub = el.querySelector('[data-sub]');
        if (sub)
        {
            sub.textContent = this.subText();
        }
        const status = el.querySelector('[data-status]');
        if (status)
        {
            status.textContent = this.statusText();
        }
    },

    batchScreen()
    {
        const c = this.counts();
        const finished = c.done === c.total && !this.state.running;
        const label = this.state.running ? 'Processing' : finished ? 'Run again' : `Process ${c.total}`;
        const list = QUEUE.map((q, i) => `<li class="q-row" data-row="${i}" data-state="${this._rows[i].state}">
                <span class="q-idx">${i + 1}</span>${opChip(q.op)}<span class="tag" data-op="${q.op}">${q.tag}</span>
                <span class="q-name">${q.name}</span><span class="q-meta">${this.rowMeta(i)}</span>
                <span class="q-bar" style="--p:${this._rows[i].p}"></span>
            </li>`).join('');

        return `<div class="scr-head">
                <div><p class="scr-title">Batch Processor</p><p class="scr-sub" data-sub>${this.subText()}</p></div>
                <button type="button" class="btn-go" @click="run" ${this.state.running ? 'disabled' : ''}>${icon(finished ? 'refresh' : 'play', 12)}${label}</button>
            </div>
            <ol class="queue" aria-label="Queued files">${list}</ol>
            <div class="q-foot q-foot-gap">${icon('zap', 13)}Workers<span class="slider" style="--v:40%" aria-hidden="true"></span><span class="mono">${WORKERS}</span>
                <span class="scr-stats" style="margin-left:auto"><span><b data-stat="queued">${c.queued}</b>Queued</span><span><b data-stat="active">${c.active}</b>Active</span><span><b data-stat="done">${c.done}</b>Done</span></span>
            </div>`;
    },

    editorScreen()
    {
        return `<div class="scr-head"><div><p class="scr-title">Timeline</p><p class="scr-sub">3 tracks · 5 clips · ${timecode(TIMELINE.seconds)}</p></div></div>
            <div class="tl" style="--track-h:44px">${timelineTools(true)}
                <div class="tl-grid">${timelineHeads()}<div class="tl-lanes" style="cursor:default">${timelineLanes({ ph: 0.34, compact: true })}</div></div>
                <div class="tl-status"><span>1 clip selected</span><span>Playhead <b>${timecode(0.34 * TIMELINE.seconds)}</b></span></div>
            </div>`;
    },

    playerScreen()
    {
        return `<div class="scr-head"><div><p class="scr-title">Media Player</p><p class="scr-sub">Harbor at dawn (field recording) · Bars</p></div></div>
            <div class="viz" style="height:210px;padding:16px 16px 0">${barsSvg(42, 1.3)}</div>
            <div class="transport">
                <div class="seek"><span>1:12</span><span class="seek-track" style="--p:34%"><span></span></span><span>3:31</span></div>
                <span class="transport-now">Harbor at dawn (field recording)</span>
                <span class="transport-btns">${icon('shuffle', 15)}${icon('back', 15)}<span class="transport-play">${icon('pause', 15)}</span>${icon('next', 15)}${icon('repeat', 15)}</span>
                <span class="transport-vol">${icon('volume', 15)}<span class="slider" style="--v:70%;width:70px"></span></span>
            </div>`;
    },

    logsScreen()
    {
        return `<div class="scr-head"><div><p class="scr-title">Logs</p><p class="scr-sub">A normalize job, as the log viewer records it</p></div></div>
            <div class="log"><ol class="log-lines">${NORMALIZE_LOG.map((l) => logLine(...l)).join('')}</ol></div>`;
    },

    render()
    {
        const s = this.state;
        const tabs = SCREENS.map((t) => `${t.group ? `<div class="win-group" aria-hidden="true">${t.group}</div>` : ''}
            <button type="button" role="tab" id="win-tab-${t.id}" class="win-tab" aria-selected="${s.screen === t.id}" aria-controls="win-panel" tabindex="${s.screen === t.id ? 0 : -1}" @click="show('${t.id}')" @keydown="onKey">
                ${icon(t.icon, 15)}${t.label}${t.id === 'batch' ? `<span class="win-count">${QUEUE.length}</span>` : ''}
            </button>`).join('');
        const screen = { batch: 'batchScreen', editor: 'editorScreen', player: 'playerScreen', logs: 'logsScreen' }[s.screen];
        const version = fmt.version(store.getters.latest);

        return `<div class="win" role="group" aria-label="molexMedia app window, recreated">
            <div class="win-bar" aria-hidden="true">
                <span class="win-dot"></span><span class="win-name">MOLEXMEDIA</span><span class="win-ver">${version ? `v${version}` : ''}</span>
                <span class="win-ctl">${icon('minus', 13)}${icon('square', 12)}${icon('close', 13)}</span>
            </div>
            <div class="win-body">
                <div class="win-side" role="tablist" aria-label="App screens" aria-orientation="vertical">
                    ${tabs}
                    <div class="win-status" aria-hidden="true"><span class="dot" data-busy="${s.running}"></span><span data-status>${this.statusText()}</span></div>
                </div>
                <div class="win-main" role="tabpanel" id="win-panel" aria-labelledby="win-tab-${s.screen}">${this[screen]()}</div>
            </div>
        </div>`;
    },
});

const PRESETS = [
    { id: 'defaults', name: 'Defaults', I: -16, TP: -1.5, LRA: 11, drc: 'Off', layout: 'Keep', codec: 'Inherit, 256k' },
    { id: 'movie-balance', name: 'Movie: Balanced', I: -18, TP: -1.5, LRA: 9, drc: 'Medium', layout: 'Keep', codec: 'Inherit, 384k' },
    { id: 'movie-dialog', name: 'Movie: Dialog Boost', I: -16, TP: -1.5, LRA: 7, drc: 'Medium', layout: 'Dialog stereo', codec: 'AAC 256k' },
    { id: 'movie-latenight', name: 'Movie: Late Night', I: -15, TP: -2, LRA: 5, drc: 'Heavy', layout: 'Dialog stereo', codec: 'AAC 256k' },
    { id: 'podcast', name: 'Podcast', I: -16, TP: -1.5, LRA: 8, drc: 'Light', layout: 'Keep', codec: 'AAC 128k' },
    { id: 'music-streaming', name: 'Music: Streaming', I: -14, TP: -1, LRA: 11, drc: 'Off', layout: 'Keep', codec: 'AAC 320k' },
    { id: 'music-album', name: 'Music: Album', I: -18, TP: -1, LRA: 14, drc: 'Off', layout: 'Keep', codec: 'AAC 320k' },
    { id: 'broadcast', name: 'Broadcast', I: -23, TP: -1, LRA: 15, drc: 'Off', layout: 'Keep', codec: 'AC-3 448k' },
];

export { PRESETS };

$.component('preset-card', {
    state: () => ({ preset: 'movie-dialog' }),

    pick(id)
    {
        this.state.preset = id;
    },

    render()
    {
        const p = PRESETS.find((x) => x.id === this.state.preset);
        const chips = PRESETS.map((x) => `<button type="button" class="preset" aria-pressed="${x.id === p.id}" @click="pick('${x.id}')">${x.name}</button>`).join('');
        const num = (n) => (n > 0 ? `+${n}` : `${n}`).replace('-', '−');
        return `<div class="card-panel set">
            <div class="set-head">${opChip('normalize')}<span class="q-name">interview-cam-a.mkv</span><span class="tag" data-op="normalize">${p.name}</span></div>
            <div class="presets" role="group" aria-label="Normalization presets">${chips}</div>
            <dl class="readout">
                <div><dt>Loudness</dt><dd>${num(p.I)} <small>LUFS</small></dd></div>
                <div><dt>True peak</dt><dd>${num(p.TP)} <small>dBTP</small></dd></div>
                <div><dt>Range</dt><dd>${p.LRA} <small>LU</small></dd></div>
                <div><dt>Compression</dt><dd>${p.drc}</dd></div>
                <div><dt>Channels</dt><dd>${p.layout}</dd></div>
                <div><dt>Audio</dt><dd>${p.codec}</dd></div>
            </dl>
            <p class="set-note">Choose a preset to see the targets it applies. This file keeps its own settings; the rest of the queue follows the panel.</p>
        </div>`;
    },
});

$.component('tl-demo', {
    state: () => ({ ph: 0.34, dragging: false }),

    setFrom(e)
    {
        const lanes = this.refs.lanes;
        if (!lanes)
        {
            return;
        }
        const box = lanes.getBoundingClientRect();
        this.state.ph = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    },

    down(e)
    {
        if (e.button !== 0)
        {
            return;
        }
        this.state.dragging = true;
        this.refs.lanes?.setPointerCapture?.(e.pointerId);
        this.setFrom(e);
    },

    move(e)
    {
        if (this.state.dragging)
        {
            this.setFrom(e);
        }
    },

    up()
    {
        this.state.dragging = false;
    },

    key(e)
    {
        const frame = 1 / (TIMELINE.seconds * TIMELINE.fps);
        const step = { ArrowLeft: -frame, ArrowRight: frame }[e.key];
        if (step !== undefined)
        {
            e.preventDefault();
            this.state.ph = Math.min(1, Math.max(0, this.state.ph + step * (e.shiftKey ? 10 : 1)));
        }
        else if (e.key === 'Home' || e.key === 'End')
        {
            e.preventDefault();
            this.state.ph = e.key === 'Home' ? 0 : 1;
        }
    },

    render()
    {
        const secs = this.state.ph * TIMELINE.seconds;
        const tc = timecode(secs);
        return `<div class="tl">
            ${timelineTools()}
            <div class="tl-grid">
                ${timelineHeads()}
                <div class="tl-lanes" z-ref="lanes" tabindex="0" role="slider" aria-label="Playhead position"
                    aria-valuemin="0" aria-valuemax="${TIMELINE.seconds}" aria-valuenow="${Math.round(secs)}" aria-valuetext="${tc}"
                    @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @keydown="key">
                    ${timelineLanes({ ph: this.state.ph })}
                </div>
            </div>
            <div class="tl-status">
                <span>1 clip selected</span><span>In <b>00:00:42:00</b></span><span>Out <b>00:01:49:06</b></span>
                <span>Playhead <b>${tc}</b></span><span>3 tracks · 5 clips</span>
            </div>
        </div>`;
    },
});

const BANDS = [
    ['Sub', '20-60 Hz'],
    ['Bass', '60-250 Hz'],
    ['Low mid', '250-500 Hz'],
    ['Mid', '0.5-2 kHz'],
    ['High mid', '2-6 kHz'],
    ['Treble', '6-20 kHz'],
];

const TRACKS = [
    { title: 'Harbor at dawn (field recording)', src: 'Local file · FLAC', len: 211 },
    { title: 'score-draft-2.wav', src: 'Local file · WAV', len: 184 },
    { title: 'Episode 41 master', src: 'Direct audio link', len: 3492 },
    { title: 'Night market ambience', src: 'YouTube playlist', len: 1260 },
];

$.component('viz-demo', {
    state: () => ({ playing: false, pos: 72, track: 0 }),

    mounted()
    {
        this._canvas = this._el.querySelector('canvas');
        this._ctx = this._canvas.getContext('2d');
        this._t = 0;
        this._levels = new Float32Array(48);
        this._resize = () => this.size();
        this._ro = 'ResizeObserver' in window ? new ResizeObserver(this._resize) : null;
        this._ro?.observe(this._canvas);
        this.size();
        if ('IntersectionObserver' in window && !reducedMotion())
        {
            this._io = new IntersectionObserver((entries) =>
            {
                this._visible = entries.some((e) => e.isIntersecting);
                if (this._visible && !this._autoplayed)
                {
                    this._autoplayed = true;
                    this.state.playing = true;
                }
                this.loop();
            }, { threshold: 0.2 });
            this._io.observe(this._el);
        }
        else
        {
            this._visible = true;
            this.draw(0.016);
        }
    },

    destroyed()
    {
        cancelAnimationFrame(this._raf);
        this._ro?.disconnect();
        this._io?.disconnect();
    },

    toggle()
    {
        this.state.playing = !this.state.playing;
        this._visible = true;
        this.loop();
    },

    pick(i)
    {
        this.state.track = i;
        this.state.pos = 0;
        this.state.playing = true;
        this._visible = true;
        this.loop();
    },

    size()
    {
        const c = this._canvas;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = c.clientWidth;
        const h = c.clientHeight;
        if (w && h)
        {
            c.width = Math.round(w * dpr);
            c.height = Math.round(h * dpr);
            this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            this.draw(0);
        }
    },

    loop()
    {
        cancelAnimationFrame(this._raf);
        if (!this.state.playing || !this._visible)
        {
            return;
        }
        let last = performance.now();
        let acc = 0;
        const frame = (now) =>
        {
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            this.draw(dt);
            acc += dt;
            if (acc >= 1)
            {
                acc -= 1;
                const len = TRACKS[this.state.track].len;
                this.state.pos = (this.state.pos + 1) % len;
            }
            if (this.state.playing && this._visible)
            {
                this._raf = requestAnimationFrame(frame);
            }
        };
        this._raf = requestAnimationFrame(frame);
    },

    draw(dt)
    {
        const c = this._canvas;
        const ctx = this._ctx;
        const w = c.clientWidth;
        const h = c.clientHeight;
        if (!w || !h)
        {
            return;
        }
        this._t += dt;
        const t = this._t;
        const n = this._levels.length;
        const beat = Math.pow(Math.max(0, Math.sin(t * Math.PI * 2 * 1.02)), 12);
        ctx.clearRect(0, 0, w, h);
        const gap = 3;
        const bw = (w - gap * (n - 1)) / n;
        for (let i = 0; i < n; i++)
        {
            const f = i / n;
            const shape = 0.55 * Math.exp(-f * 2.2) + 0.25;
            const wobble = 0.5 + 0.5 * Math.sin(t * (1.3 + f * 3.1) + i * 0.9) * Math.cos(t * 0.7 + i * 0.37);
            const target = Math.min(1, shape * (0.45 + 0.55 * wobble) + beat * 0.35 * Math.exp(-f * 4));
            const lv = this._levels[i];
            this._levels[i] = dt ? lv + (target - lv) * Math.min(1, dt * 14) : target;
            const bh = Math.max(2, this._levels[i] * (h - 12));
            const x = i * (bw + gap);
            ctx.fillStyle = 'rgba(109, 40, 217, 0.85)';
            ctx.fillRect(x, h - bh, bw, bh);
            ctx.fillStyle = '#b5a0ff';
            ctx.fillRect(x, h - bh, bw, 2);
        }
        if (this.refs.bands)
        {
            const bars = this.refs.bands.querySelectorAll('i');
            bars.forEach((el, b) =>
            {
                const from = Math.floor((b / 6) * n);
                const to = Math.floor(((b + 1) / 6) * n);
                let sum = 0;
                for (let i = from; i < to; i++)
                {
                    sum += this._levels[i];
                }
                el.style.setProperty('--v', `${Math.round((sum / (to - from)) * 100)}%`);
            });
        }
    },

    render()
    {
        const s = this.state;
        const tr = TRACKS[s.track];
        const mmss = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
        const list = TRACKS.map((t, i) => `<li ${i === s.track ? 'aria-current="true"' : ''}>
                <span class="pl-n">${i === s.track ? icon('normalize', 12) : i + 1}</span>
                <button type="button" style="text-align:left;min-width:0" @click="pick(${i})"><span class="pl-t">${t.title}</span><span class="pl-s">${t.src}</span></button>
            </li>`).join('');
        const bands = BANDS.map(([name, range]) => `<div class="band-m"><i style="--v:0%"></i><span>${name}</span><small>${range}</small></div>`).join('');

        return `<div class="pl">
            <div class="pl-main">
                <div class="viz" z-skip><canvas aria-label="Bars visualization, animated from a synthetic signal" role="img"></canvas></div>
                <div class="bands" z-ref="bands" z-skip aria-hidden="true">${bands}</div>
                <div class="transport">
                    <div class="seek"><span>${mmss(s.pos)}</span><span class="seek-track" style="--p:${(s.pos / tr.len) * 100}%"><span></span></span><span>${mmss(tr.len)}</span></div>
                    <span class="transport-now">${tr.title}</span>
                    <span class="transport-btns">
                        ${icon('shuffle', 16)}${icon('back', 16)}
                        <button type="button" class="transport-play" @click="toggle" aria-label="${s.playing ? 'Pause' : 'Play'}">${icon(s.playing ? 'pause' : 'play', 16)}</button>
                        ${icon('next', 16)}${icon('repeat', 16)}
                    </span>
                    <span class="transport-vol">${icon('volume', 16)}<span class="slider" style="--v:70%;width:80px"></span></span>
                </div>
            </div>
            <div class="pl-side">
                <p class="pl-head">Playlist</p>
                <ol class="playlist">${list}</ol>
            </div>
        </div>`;
    },
});

$.component('release-list', {
    state: () => ({ tick: 0 }),

    mounted()
    {
        watchStore(this);
        loadReleases();
        loadNotes();
    },

    destroyed()
    {
        this._unsub?.();
    },

    retry()
    {
        loadReleases(true);
        loadNotes(true);
    },

    render()
    {
        const { status, notes, notesStatus } = store.state;
        const releases = store.getters.published;
        const loadingAny = status === 'idle' || status === 'loading' || notesStatus === 'idle' || notesStatus === 'loading';

        if (loadingAny && !releases.length)
        {
            return `<div class="rel-list" aria-busy="true">${[1, 2, 3].map(() => `<div class="rel"><div class="rel-sum"><span class="skel" style="--w:6ch"></span><span class="skel" style="--w:28ch"></span><span class="skel" style="--w:14ch"></span></div></div>`).join('')}</div>`;
        }

        const noteBody = (ver) =>
        {
            const entries = notes[ver];
            if (!entries?.length)
            {
                return '';
            }
            if (entries.length === 1)
            {
                return markdown(entries[0].body);
            }
            return entries.map((e) => `<h3>${$.escapeHtml(e.title || ver)}</h3>${markdown(e.body)}`).join('');
        };

        let items;
        if (releases.length)
        {
            items = releases.map((r, i) =>
            {
                const ver = fmt.version(r);
                const entry = notes[ver]?.[0];
                const title = entry?.title || (r.name || '').replace(/^v?[\d.]+\s*[-:]?\s*/i, '') || releaseSummary(r.body);
                const body = noteBody(ver) || markdown(r.body || '') || '<p>No notes were published for this release.</p>';
                const files = installers(r);
                const dl = [['windows', 'Windows'], ['mac', 'macOS'], ['deb', 'Linux .deb'], ['rpm', 'Linux .rpm']]
                    .filter(([k]) => files[k])
                    .map(([k, label]) => `<a href="${$.escapeHtml(files[k].browser_download_url)}">${label} (${fmt.bytes(files[k].size)})</a>`)
                    .join('');
                return `<details class="rel" ${i === 0 ? 'open' : ''}>
                    <summary class="rel-sum">
                        <span class="rel-ver">${ver}</span>
                        <h2 class="rel-title">${$.escapeHtml(title)}${i === 0 ? '<span class="rel-latest-tag">Latest</span>' : ''}</h2>
                        <time class="rel-date" datetime="${r.published_at || ''}">${fmt.date(r.published_at)}</time>
                    </summary>
                    <div class="rel-body">
                        <div class="prose">${body}</div>
                        <p class="rel-links">${dl}<a href="${$.escapeHtml(r.html_url)}" rel="noopener">Release on GitHub</a></p>
                    </div>
                </details>`;
            }).join('');
        }
        else if (notesStatus === 'ready')
        {
            items = Object.entries(notes).map(([ver, entries], i) => `<details class="rel" ${i === 0 ? 'open' : ''}>
                    <summary class="rel-sum"><span class="rel-ver">${$.escapeHtml(ver)}</span><h2 class="rel-title">${$.escapeHtml(entries[0].title || ver)}</h2><span class="rel-date">${fmt.date(entries[0].date)}</span></summary>
                    <div class="rel-body"><div class="prose">${noteBody(ver)}</div></div>
                </details>`).join('');
        }

        const failed = status === 'error';
        const head = failed
            ? notice('Release data did not load.', releases.length || notesStatus === 'ready' ? 'Showing the notes that did load.' : 'Every release is still listed on GitHub.', `<button type="button" class="link-btn" @click="retry">Try again</button><a href="${RELEASES_URL}" rel="noopener">Releases on GitHub</a>`)
            : '';

        if (!items)
        {
            return `<div class="rel-list">${head || notice('Nothing to show yet.', 'No releases were found.', `<a href="${RELEASES_URL}" rel="noopener">Releases on GitHub</a>`)}</div>`;
        }
        return `<div class="rel-list">${head}${items}</div>`;
    },
});
