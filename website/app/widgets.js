import { icon } from './icons.js';
import {
    store, loadReleases, loadNotes, installers, detectPlatform, linuxPackage, fmt, markdown, releaseSummary,
    LATEST_URL, RELEASES_URL,
} from './store.js';
import { link, notice, reducedMotion, statusLabel, stamp, timecode, clock, MINUS } from './parts.js';

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
        const more = `<p class="get-more">${link('/download', 'Other platforms and install notes')}${version ? link('/changelog', `What is new in ${version}`) : ''}</p>`;
        const retry = failed
            ? `<p class="get-file">Release details did not load, so the button opens the latest release on GitHub. <button type="button" class="link-btn" @click="retry">Try again</button></p>`
            : '';

        if (platform === 'mobile')
        {
            return `<div class="get">
                <p class="get-note"><strong>molexMedia is a desktop app</strong> for Windows, macOS, and Linux. Open this page on your computer to download it, or keep the link for later.</p>
                <p class="get-more">
                    ${link('/download', `${icon('download', 16)} See every download`, 'btn btn-primary')}
                    <button type="button" class="btn btn-secondary" @click="copyLink">${icon(this.state.copied ? 'check' : 'copy', 16)}${this.state.copied ? 'Link copied' : 'Copy link'}</button>
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
                : files[first] ? fileMeta(files[first], 'x64') : '';
            return `<div class="get">
                <p class="get-more">${btn(first, 'btn-primary btn-lg')}${btn(second, 'btn-secondary btn-lg')}</p>
                <p class="get-meta">${meta}</p>
                <p class="get-file">.deb for Debian and Ubuntu, .rpm for Fedora and openSUSE.</p>
                ${retry}${terms}${more}
            </div>`;
        }

        if (platform === 'windows' || platform === 'mac')
        {
            const asset = platform === 'windows' ? files.windows : files.mac;
            const extra = platform === 'windows' ? 'x64 installer' : 'Universal: Apple Silicon and Intel';
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

        const spec = (parts) => (loading ? '<span class="skel" style="--w:24ch"></span>' : parts.filter(Boolean).join(' · '));
        const size = (asset) => (asset ? fmt.bytes(asset.size) : '');
        const button = (asset, label, primary) =>
            `<a class="btn ${primary ? 'btn-primary' : 'btn-secondary'}" href="${asset ? $.escapeHtml(asset.browser_download_url) : LATEST_URL}">${icon('download', 16)}${label}</a>`;
        const file = (asset) => (asset ? `<p class="plat-file">${$.escapeHtml(asset.name)}</p>` : '');
        const cmd = (kind, text) => `<div class="cmd"><code data-cmd="${kind}">${$.escapeHtml(text)}</code><button type="button" class="copy" @click="copy('${kind}')">${icon(this.state.copied === kind ? 'check' : 'copy', 14)}${this.state.copied === kind ? 'Copied' : 'Copy'}</button></div>`;
        const row = (p, name, specHtml, purpose, buttons, help) => `<div class="plat" data-detected="${detected === p}">
                <div class="plat-main">
                    <h3 class="plat-name">${name}${p === detected ? '<span class="plat-you">Your system</span>' : ''}</h3>
                    <p class="plat-spec">${specHtml}</p>
                    <p class="plat-purpose">${purpose}</p>
                </div>
                <div class="plat-actions">${buttons.join('')}</div>
                ${detail ? `<div class="plat-help">${help}</div>` : ''}
            </div>`;

        const rows = [
            row('windows', 'Windows',
                spec(['x64', '.exe installer', size(files.windows)]),
                'Choose the install folder. Updates itself from GitHub Releases.',
                [button(files.windows, 'Download .exe', detected !== 'mac' && detected !== 'linux')],
                `${file(files.windows)}<p>The installer is not code-signed, so Windows SmartScreen may say it protected your PC. Choose <strong>More info</strong>, then <strong>Run anyway</strong>.</p>`),
            row('mac', 'macOS',
                spec(['Universal', '.dmg', size(files.mac)]),
                'Runs natively on Apple Silicon and Intel. Updates itself from GitHub Releases.',
                [button(files.mac, 'Download .dmg', detected === 'mac')],
                `${file(files.mac)}<p>Open the disk image and drag molexMedia to Applications. On Apple Silicon the app installs FFmpeg 7.1.1 rather than 9.0.2: the newer arm64 builds misread the loudness of surround sound, and 7.1.1 measures it correctly.</p>`),
            row('linux', 'Linux',
                spec(['x64', files.deb ? `.deb ${size(files.deb)}` : '.deb', files.rpm ? `.rpm ${size(files.rpm)}` : '.rpm']),
                '.deb for Debian and Ubuntu, .rpm for Fedora and openSUSE.',
                [button(files.deb, '.deb', detected === 'linux' && pkg === 'deb'), button(files.rpm, '.rpm', detected === 'linux' && pkg === 'rpm')],
                `<p>Install the package from the folder you saved it to:</p>${cmd('deb', `sudo apt install ./${files.deb?.name || 'molexMedia-VERSION-Linux-Installer.deb'}`)}${cmd('rpm', `sudo dnf install ./${files.rpm?.name || 'molexMedia-VERSION-Linux-Installer.rpm'}`)}<p>Linux packages do not update themselves. Download the new package when a release comes out.</p>`),
        ];

        const head = failed
            ? notice('Release details did not load.', 'The buttons below open the latest release on GitHub instead.', `<button type="button" class="link-btn" @click="retry">Try again</button><a href="${RELEASES_URL}" rel="noopener">All releases on GitHub</a>`)
            : '';
        const mobile = detected === 'mobile'
            ? '<p class="get-note"><strong>You are on a phone or tablet.</strong> molexMedia runs on Windows, macOS, and Linux desktops.</p>'
            : '';

        return `<div>${head}${mobile}<div class="platforms">${rows.join('')}</div></div>`;
    },
});

const JOBS = [
    { file: 'podcast-ep41-master.wav', op: 'Normalize to Apple Podcasts', size: '612 MB', dur: '58:12', speed: 1.05, audio: true, result: { stamp: `${MINUS}16.0 LKFS · ${MINUS}1.6 dBTP` } },
    { file: 'interview-cam-a.mkv', op: 'Normalize to EBU R 128', size: '2.1 GB', dur: '1:12:40', speed: 0.8, audio: true, result: { stamp: `${MINUS}23.0 LUFS · ${MINUS}1.4 dBTP` } },
    { file: 'lecture-03.mkv', op: 'Convert, MP4 (H.264/AAC)', size: '1.4 GB', dur: '47:05', speed: 0.7, audio: false, result: { done: '5 streams kept' } },
    { file: 'drone-reel-4k.mov', op: 'Compress, Target 25 MB', size: '1.8 GB', dur: '2:14', speed: 0.6, audio: false, result: { done: '24.6 MB' } },
    { file: 'field-recording-07.wav', op: 'Gain, Quiet recording', size: '146 MB', dur: '12:40', speed: 1.6, audio: true, result: { stamp: `+3.5 dB · ${MINUS}1.0 dBTP` } },
    { file: 'concert-cam-b.mp4', op: 'Extract audio, FLAC Lossless', size: '4.2 GB', dur: '1:32:18', speed: 1.3, audio: false, result: { done: 'FLAC written' } },
];
const WORKERS = 4;

const SCREENS = [
    { id: 'batch', label: 'Batch', icon: 'batch' },
    { id: 'editor', label: 'Editor', icon: 'editor' },
    { id: 'player', label: 'Player', icon: 'player' },
    { id: 'logs', label: 'Logs', icon: 'logs' },
];

const TRIM = { seconds: 192.3, fps: 30, in: 12.133, out: 108.567 };

const TRACKS = [
    { name: 'holiday-reel-2025.mp4', facts: '1920 × 1080 · H.264 · AAC stereo', len: 464 },
    { name: 'concert-set-02.flac', facts: 'FLAC · 48 kHz · stereo', len: 3517 },
    { name: 'lecture-week-07.m4a', facts: 'AAC · 44.1 kHz · mono', len: 2892 },
    { name: 'Field recording, harbor at dawn', facts: 'Link · yt-dlp · Opus', len: 611 },
];

const LOG_LINES = [
    ['11:42:03', 'info', 'Job engine', 'Batch 14 started: 6 jobs, 4 workers, output next to each source'],
    ['11:42:03', 'info', 'Job engine', 'MM-0141 podcast-ep41-master.wav: measuring loudness with ebur128'],
    ['11:42:03', 'cmd', 'FFmpeg command', 'ffmpeg -nostdin -i podcast-ep41-master.wav -filter_complex [0:a:0]ebur128=peak=true:framelog=verbose[m] -map [m] -f null -'],
    ['11:42:41', 'info', 'Job engine', `MM-0141 measured ${MINUS}19.8 LUFS, ${MINUS}3.1 dBTP; planned gain +3.8 dB to ${MINUS}16 LKFS`],
    ['11:42:41', 'cmd', 'FFmpeg command', 'ffmpeg -nostdin -i podcast-ep41-master.wav -filter_complex [0:a:0]volume=3.8dB,aresample=96000,alimiter=limit=-1.0dB:level=disabled:latency=1,aresample=48000[a] -map [a] -c:a aac -aac_coder fast -b:a 256k podcast-ep41-master.m4a'],
    ['11:43:12', 'warning', 'Hardware encoding', 'NVENC session limit reached; MM-0144 drone-reel-4k.mov waits for a session'],
    ['11:43:58', 'info', 'Job engine', `MM-0141 verified: ${MINUS}16.0 LKFS, ${MINUS}1.6 dBTP, within ±1.0 dB of Apple Podcasts`],
    ['11:44:06', 'error', 'FFmpeg output', 'MM-0146 concert-cam-b.mp4: moov atom not found; the file ends early. Retry after the copy finishes.'],
];

const freshRows = (done = false) => JOBS.map(() => ({ p: done ? 1 : 0, state: done ? 'done' : 'queued', landed: false }));

/**
 * The status word for a running job at a given progress, in the words the app's status column uses.
 * @param {object} job Mock job.
 * @param {number} p Progress 0 to 1.
 */
function runningWord(job, p)
{
    if (job.audio)
    {
        return p < 0.35 ? ['analyzing', 'Analyzing'] : p < 0.92 ? ['encoding', 'Encoding'] : ['verifying', 'Verifying'];
    }
    return p < 0.95 ? ['encoding', 'Encoding'] : ['finalizing', 'Finalizing'];
}

$.component('app-window', {
    state: () => ({
        tick: 0,
        screen: 'batch',
        phase: 'idle',
        ph: 41.8,
        playing: false,
        pos: 112,
        track: 0,
    }),

    init()
    {
        this._rows = freshRows();
        this._elapsed = 0;
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
                this._start = setTimeout(() => this.run(), 900);
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
        clearInterval(this._clock);
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
        if (this.state.phase === 'running')
        {
            return;
        }
        clearTimeout(this._start);
        if (reducedMotion())
        {
            this._rows = freshRows(true);
            this.state.phase = 'done';
            return;
        }
        this._rows = freshRows();
        this._elapsed = 0;
        this.state.phase = 'running';
        clearInterval(this._timer);
        this._timer = setInterval(() => this.step(), 100);
    },

    step()
    {
        const rows = this._rows;
        this._elapsed += 0.1;
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
                r.started = this._elapsed;
                active++;
            }
        }
        rows.forEach((r, i) =>
        {
            if (r.state === 'running')
            {
                r.p = Math.min(1, r.p + JOBS[i].speed * 0.03);
                if (r.p >= 1)
                {
                    r.state = 'done';
                    r.landed = false;
                    r.ended = this._elapsed;
                }
            }
        });
        if (rows.every((r) => r.state === 'done'))
        {
            clearInterval(this._timer);
            this._timer = null;
            this.state.phase = 'done';
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

    statusCell(i)
    {
        const r = this._rows[i];
        const job = JOBS[i];
        if (r.state === 'done')
        {
            const landing = this.state.phase === 'running' && !r.landed;
            r.landed = true;
            return job.result.stamp ? stamp('verified', job.result.stamp, landing) : `${statusLabel('done', 'Done')}<span class="mono" style="margin-left:8px;color:var(--ink-3)">${job.result.done}</span>`;
        }
        if (r.state === 'running')
        {
            const [key, word] = runningWord(job, r.p);
            return statusLabel(key, word);
        }
        return this.state.phase === 'idle' ? statusLabel('ready', 'Ready') : statusLabel('queued', 'Queued');
    },

    progressCell(i)
    {
        const r = this._rows[i];
        return `<span class="c-progress"><span class="bar" style="--p:${r.p}"${r.state === 'done' ? ' data-done' : ''}></span><span class="pct">${Math.round(r.p * 100)}%</span></span>`;
    },

    timeCell(i)
    {
        const r = this._rows[i];
        if (r.state === 'queued')
        {
            return '';
        }
        const span = (r.state === 'done' ? r.ended : this._elapsed) - (r.started || 0);
        return clock(span * 14);
    },

    speedCell(i)
    {
        const r = this._rows[i];
        return r.state === 'queued' ? '' : `${(JOBS[i].speed * 1.6).toFixed(1)}x`;
    },

    sentence()
    {
        const c = this.counts();
        if (this.state.phase === 'running')
        {
            const left = Math.max(1, Math.round((c.total - c.done) * 0.6));
            return `<span class="lit">${c.done}</span><span class="unit">of ${c.total} finished</span> · about ${left} min left`;
        }
        if (this.state.phase === 'done')
        {
            const verified = JOBS.filter((j) => j.result.stamp).length;
            return `<span class="lit">${c.total}</span><span class="unit">of ${c.total} finished</span> · ${verified} verified, ${c.total - verified} done`;
        }
        return `<span class="lit">${c.total}</span><span class="unit">jobs</span> · <span class="lit">10.3</span><span class="unit">GB</span> · <span class="lit">4 h 45 min</span><span class="unit">of media</span>`;
    },

    consequence()
    {
        if (this.state.phase === 'running')
        {
            return 'Writing next to each source. Finished jobs keep their outputs.';
        }
        if (this.state.phase === 'done')
        {
            return 'Next batch: add files, then Review and Start.';
        }
        return 'Writes next to each source · Renames if the name is taken · Originals are not touched';
    },

    paint()
    {
        const el = this._el;
        this._rows.forEach((r, i) =>
        {
            const row = el.querySelector(`.grid-row[data-row="${i}"]`);
            if (!row)
            {
                return;
            }
            const status = row.querySelector('.c-status');
            const html = this.statusCell(i);
            if (status && status.innerHTML !== html)
            {
                status.innerHTML = html;
            }
            const progress = row.querySelector('.c-prog');
            if (progress)
            {
                progress.innerHTML = this.progressCell(i);
            }
            const time = row.querySelector('.c-time');
            if (time)
            {
                time.textContent = this.timeCell(i);
            }
            const speed = row.querySelector('.c-speed');
            if (speed)
            {
                speed.textContent = this.speedCell(i);
            }
        });
        const sentence = el.querySelector('[data-sentence]');
        if (sentence)
        {
            sentence.innerHTML = this.sentence();
        }
        const trail = el.querySelector('[data-trail]');
        if (trail)
        {
            const c = this.counts();
            const sum = this._rows.reduce((acc, r) => acc + r.p, 0);
            trail.textContent = `${Math.round((sum / c.total) * 100)}%`;
        }
    },

    batchScreen()
    {
        const phase = this.state.phase;
        const running = phase === 'running';
        const runSet = phase !== 'idle';
        const tabs = `<div class="tabs" aria-hidden="true">
                <span class="tab" aria-current="${!runSet}">Queue <b class="count">${JOBS.length}</b></span>
                <span class="tab">Review</span>
                <span class="tab" aria-current="${runSet}">Run</span>
                <span class="tab">History</span>
            </div>`;
        const controls = running
            ? `<span class="ub ub-secondary">${icon('pause', 14)}Pause${icon('chevron', 14)}</span><span class="ub ub-ghost">${icon('stop', 14)}Cancel run</span>`
            : phase === 'done'
                ? `<span class="ub ub-secondary">${icon('folder', 14)}Open folder${icon('chevron', 14)}</span><button type="button" class="ub ub-primary" @click="run">${icon('refresh', 14)}Run again</button>`
                : `<span class="ub ub-secondary">Output${icon('chevron', 14)}</span><span class="ub ub-secondary">${WORKERS} workers · GPU on${icon('chevron', 14)}</span><button type="button" class="ub ub-primary" @click="run">${icon('play', 14)}Start</button>`;

        const head = runSet
            ? '<span class="c-no">#</span><span>File</span><span>Status</span><span>Progress</span><span class="end opt">Time</span><span class="end opt">Speed</span>'
            : '<span class="c-no">#</span><span>File</span><span class="opt">Operation</span><span>Status</span><span class="end opt">Size</span><span class="end opt">Duration</span>';
        const cols = runSet
            ? '--cols: 52px minmax(0, 1.5fr) minmax(0, 2fr) minmax(0, 1fr) 64px 68px; --cols-narrow: 44px minmax(0, 1fr) minmax(0, 1.9fr) 56px'
            : '--cols: 52px minmax(0, 2fr) minmax(0, 1.7fr) minmax(0, 1.3fr) 72px 84px; --cols-narrow: 44px minmax(0, 1.5fr) minmax(0, 1fr)';
        const rows = JOBS.map((job, i) => runSet
            ? `<div class="grid-row" data-row="${i}"><span class="c-no">${101 + i}</span><span class="c-file">${job.file}</span><span class="c-status">${this.statusCell(i)}</span><span class="c-prog">${this.progressCell(i)}</span><span class="end opt num c-time">${this.timeCell(i)}</span><span class="end opt num c-speed">${this.speedCell(i)}</span></div>`
            : `<div class="grid-row" data-row="${i}"${i === 0 ? ' aria-selected="true"' : ''}><span class="c-no">${101 + i}</span><span class="c-file">${job.file}</span><span class="opt">${job.op}</span><span class="c-status">${this.statusCell(i)}</span><span class="end opt num">${job.size}</span><span class="end opt num">${job.dur}</span></div>`).join('');

        return `<div class="scr" aria-label="Batch">
            <div class="rh">
                <div class="rh-display well">
                    <p class="rh-sentence" data-sentence>${this.sentence()}</p>
                    <p class="rh-line">${this.consequence()}</p>
                </div>
                <div class="rh-controls">${controls}</div>
            </div>
            <div class="tb" aria-hidden="true">
                ${tabs}
                <span class="sep"></span>
                <span class="ub ub-secondary">${icon('plus', 14)}Add${icon('chevron', 14)}</span>
                <span class="ub ub-secondary">Set operation</span>
                <span class="cap opt">New files</span>
                <span class="sel opt">Normalize · Podcast (Apple Podcasts)${icon('chevron', 14)}</span>
                <span class="field-search">${icon('search', 14)}Filter by name or folder</span>
                <span class="ub ub-ghost">${icon('filter', 14)}Filter${icon('chevron', 14)}</span>
            </div>
            <div class="grid" style="${cols}" role="img" aria-label="The job table, ${JOBS.length} jobs">
                <div class="grid-head">${head}</div>
                ${rows}
            </div>
        </div>`;
    },

    stripDown(e)
    {
        if (e.button !== 0)
        {
            return;
        }
        this._dragging = true;
        this.refs.strip?.setPointerCapture?.(e.pointerId);
        this.stripSet(e);
    },

    stripMove(e)
    {
        if (this._dragging)
        {
            this.stripSet(e);
        }
    },

    stripUp()
    {
        this._dragging = false;
    },

    stripKey(e)
    {
        const frame = 1 / TRIM.fps;
        const step = { ArrowLeft: -frame, ArrowRight: frame }[e.key];
        if (step !== undefined)
        {
            e.preventDefault();
            this.setPlayhead(this.state.ph + step * (e.shiftKey ? 10 : 1));
        }
        else if (e.key === 'Home' || e.key === 'End')
        {
            e.preventDefault();
            this.setPlayhead(e.key === 'Home' ? 0 : TRIM.seconds);
        }
    },

    stripSet(e)
    {
        const strip = this.refs.strip;
        if (!strip)
        {
            return;
        }
        const box = strip.getBoundingClientRect();
        this.setPlayhead(((e.clientX - box.left) / box.width) * TRIM.seconds);
    },

    setPlayhead(seconds)
    {
        const ph = Math.min(TRIM.seconds, Math.max(0, seconds));
        this.state.ph = ph;
        const strip = this.refs.strip;
        if (strip)
        {
            strip.style.setProperty('--ph', `${(ph / TRIM.seconds) * 100}%`);
            strip.setAttribute('aria-valuenow', String(Math.round(ph)));
            strip.setAttribute('aria-valuetext', timecode(ph, TRIM.fps));
        }
        const readout = this._el.querySelector('[data-playhead]');
        if (readout)
        {
            readout.textContent = timecode(ph, TRIM.fps);
        }
    },

    editorScreen()
    {
        const tc = (s) => timecode(s, TRIM.fps);
        const pct = (s) => `${(s / TRIM.seconds) * 100}%`;
        const thumbs = Array.from({ length: 12 }, () => '<i></i>').join('');
        return `<div class="scr" aria-label="Editor">
            <div class="eh" aria-hidden="true">
                <div class="tabs"><span class="tab" aria-current="true">Trim</span><span class="tab">Timeline</span><span class="tab">Inspect</span></div>
                <span class="ub ub-ghost">holiday-reel-2025.mp4${icon('chevron', 14)}</span>
                <span class="spacer"></span>
                <span class="ub ub-secondary opt">${icon('folder', 14)}Open</span>
                <span class="ib ib-sm">${icon('keyboard', 16)}</span>
            </div>
            <div class="eb">
                <div class="ec">
                    <div class="stage" aria-hidden="true">
                        <div class="frame"><span class="horizon"></span><span class="pill">1920 × 1080 · 29.97 fps · H.264</span></div>
                    </div>
                    <div class="rb" aria-hidden="true">
                        <div class="readouts">
                            <div class="ro"><span>In</span><b class="lit">${tc(TRIM.in)}</b></div>
                            <div class="ro"><span>Out</span><b class="lit">${tc(TRIM.out)}</b></div>
                            <div class="ro"><span>Length</span><b class="lit">${tc(TRIM.out - TRIM.in)}</b></div>
                        </div>
                        <div class="tr">
                            <span class="ib">${icon('toIn', 16)}</span><span class="ib">${icon('stepBack', 16)}</span><span class="ib ib-primary">${icon('play', 16)}</span><span class="ib">${icon('stepForward', 16)}</span><span class="ib">${icon('toOut', 16)}</span>
                            <div class="ro"><span>Playhead</span><b data-playhead>${tc(this.state.ph)}</b></div>
                        </div>
                        <div class="marks"><span class="ub ub-secondary ub-sm">Mark in</span><span class="ub ub-secondary ub-sm">Mark out</span></div>
                    </div>
                    <div class="ct">
                        <div class="strip" z-ref="strip" tabindex="0" role="slider" aria-label="Playhead position"
                            aria-valuemin="0" aria-valuemax="${Math.round(TRIM.seconds)}" aria-valuenow="${Math.round(this.state.ph)}" aria-valuetext="${tc(this.state.ph)}"
                            style="--in:${pct(TRIM.in)};--out:${pct(TRIM.out)};--ph:${pct(this.state.ph)}"
                            @pointerdown="stripDown" @pointermove="stripMove" @pointerup="stripUp" @pointercancel="stripUp" @keydown="stripKey">
                            ${thumbs}<span class="scrim-l"></span><span class="scrim-r"></span><span class="range"></span><span class="ph"></span>
                        </div>
                        <div class="ct-times" aria-hidden="true"><span>${tc(0)}</span><span>${tc(TRIM.seconds)}</span></div>
                    </div>
                </div>
                <aside class="ex" aria-hidden="true">
                    <div class="ex-body">
                        <div><h3>Export</h3><p class="sub">${tc(TRIM.out - TRIM.in)} from ${tc(TRIM.in)}</p></div>
                        <div class="fld"><span>Format</span><span class="sel">MP4 video${icon('chevron', 14)}</span></div>
                        <div class="fld"><span>Quality</span><span class="sel">High (CRF 20)${icon('chevron', 14)}</span></div>
                        <p class="sub">Re-encodes at this CRF, cutting on the exact frame.</p>
                        <span class="disc">${icon('chevron', 14)}More settings</span>
                    </div>
                    <div class="ex-foot">
                        <div class="row"><span class="ub ub-primary">${icon('export', 14)}Export</span><span class="ub ub-secondary">Add to timeline</span></div>
                        <p class="note">Video encodes with NVENC where the codec allows.</p>
                    </div>
                </aside>
            </div>
        </div>`;
    },

    togglePlay()
    {
        this.state.playing = !this.state.playing;
        this.tickClock();
    },

    pick(i)
    {
        this.state.track = i;
        this.state.pos = 0;
        this.state.playing = true;
        this.tickClock();
    },

    tickClock()
    {
        clearInterval(this._clock);
        if (!this.state.playing)
        {
            return;
        }
        this._clock = setInterval(() =>
        {
            const len = TRACKS[this.state.track].len;
            this.state.pos = (this.state.pos + 1) % len;
            const el = this._el;
            const track = el.querySelector('.seek-track');
            if (track)
            {
                track.style.setProperty('--p', `${(this.state.pos / len) * 100}%`);
            }
            const at = el.querySelector('[data-at]');
            if (at)
            {
                at.textContent = clock(this.state.pos);
            }
            const left = el.querySelector('[data-left]');
            if (left)
            {
                left.textContent = `${MINUS}${clock(len - this.state.pos)}`;
            }
        }, 1000);
    },

    playerScreen()
    {
        const s = this.state;
        const tr = TRACKS[s.track];
        const list = TRACKS.map((t, i) => `<button type="button" class="plist-row" ${i === s.track ? 'aria-current="true"' : ''} @click="pick(${i})">
                <span class="n">${i === s.track ? icon(s.playing ? 'play' : 'pause', 10) : i + 1}</span>
                <span><span class="t">${t.name}</span><span class="s">${t.facts} · ${clock(t.len)}</span></span>
            </button>`).join('');
        return `<div class="scr" aria-label="Player">
            <div class="ph-bar" aria-hidden="true">
                <span class="ub ub-secondary">${icon('plus', 14)}Add files${icon('chevron', 14)}</span>
                <span class="ub ub-secondary">${icon('link', 14)}Add link</span>
                <span class="spacer"></span>
                <span class="cap">Show</span>
                <span class="seg"><span class="seg-opt" aria-checked="true">${icon('video', 14)}Video</span><span class="seg-opt">${icon('bars', 14)}Visualization</span></span>
                <span class="sel opt" style="width:104px">DMT${icon('chevron', 14)}</span>
                <span class="ib" aria-pressed="true">${icon('panel', 16)}</span>
                <span class="ub ub-secondary">${icon('popout', 14)}Pop out</span>
                <span class="ib">${icon('more', 16)}</span>
            </div>
            <div class="pb">
                <div class="stage pstage" aria-hidden="true">
                    <div class="frame"><span class="horizon"></span><span class="pill">${tr.facts}</span>
                        ${s.track === 0 ? '<div class="subs"><span>The tide was already turning when we reached the pier.</span></div>' : ''}
                    </div>
                </div>
                <aside class="plist">
                    <div class="plist-head"><span>Playlist</span><span>${TRACKS.length} tracks · ${clock(TRACKS.reduce((a, t) => a + t.len, 0))}</span></div>
                    <div role="group" aria-label="Playlist">${list}</div>
                </aside>
            </div>
            <div class="transport">
                <div class="seek"><span data-at>${clock(s.pos)}</span><span class="seek-track" style="--p:${(s.pos / tr.len) * 100}%"></span><span data-left>${MINUS}${clock(tr.len - s.pos)}</span></div>
                <div class="tgrid">
                    <div class="now"><b>${tr.name}</b><span>${tr.facts}</span></div>
                    <div class="tbtns">
                        <span class="ib" aria-hidden="true">${icon('shuffle', 16)}</span>
                        <span class="ib" aria-hidden="true">${icon('back', 16)}</span>
                        <button type="button" class="ib ib-primary" @click="togglePlay" aria-label="${s.playing ? 'Pause' : 'Play'}">${icon(s.playing ? 'pause' : 'play', 16)}</button>
                        <span class="ib" aria-hidden="true">${icon('next', 16)}</span>
                        <span class="ib" aria-hidden="true">${icon('repeat', 16)}</span>
                    </div>
                    <div class="tright" aria-hidden="true">
                        <span class="ib">${icon('track', 16)}</span><span class="ib">${icon('captions', 16)}</span>
                        <span class="ib">${icon('volume', 16)}</span><span class="vol"></span>
                        <span class="ib">${icon('fullscreen', 16)}</span>
                    </div>
                </div>
            </div>
        </div>`;
    },

    logsScreen()
    {
        const rows = LOG_LINES.map(([time, level, source, text]) =>
        {
            const status = level === 'cmd' ? statusLabel('info', 'Info') : statusLabel(level, level === 'info' ? 'Info' : level === 'warning' ? 'Warning' : 'Error');
            return `<div class="grid-row"><span class="c-time">${time}</span><span>${status}</span><span class="c-src opt">${source}</span><span class="c-msg${level === 'cmd' ? ' mono' : ''}">${$.escapeHtml(text)}</span></div>`;
        }).join('');
        return `<div class="scr" aria-label="Logs">
            <header class="lh" aria-hidden="true">
                <div><p class="lh-title">Logs</p><p class="lh-sum">1,284 lines, 7 FFmpeg commands</p></div>
                <div class="lh-actions"><span class="ub ub-secondary">${icon('copy', 14)}Copy lines</span><span class="ub ub-secondary">${icon('folder', 14)}Open log folder</span><span class="ub ub-danger">${icon('close', 14)}Clear</span></div>
            </header>
            <div class="lt" aria-hidden="true">
                <span class="cap">Level</span>
                <span class="seg"><span class="seg-opt" aria-checked="true">All</span><span class="seg-opt">Info</span><span class="seg-opt">Warnings</span><span class="seg-opt">Errors</span></span>
                <span class="ub ub-secondary">${icon('filter', 14)}All sources${icon('chevron', 14)}</span>
                <span class="field-search">${icon('search', 14)}Search the log</span>
                <span class="spacer"></span>
                <span class="switch">Follow new lines<i></i></span>
            </div>
            <div class="grid logs" style="--cols: 72px 100px 132px minmax(0, 1fr); --cols-narrow: 72px 92px minmax(0, 1fr)" role="img" aria-label="The log table, eight lines">
                <div class="grid-head"><span>Time</span><span>Level</span><span class="opt">Source</span><span>Message</span></div>
                ${rows}
            </div>
        </div>`;
    },

    render()
    {
        const s = this.state;
        const running = s.phase === 'running';
        const tab = (t, extra = '') => `<button type="button" role="tab" id="win-tab-${t.id}" class="win-tab" aria-selected="${s.screen === t.id}" aria-controls="win-panel" tabindex="${s.screen === t.id ? 0 : -1}" @click="show('${t.id}')" @keydown="onKey">
                ${icon(t.icon, 16)}<span>${t.label}</span>${extra}
            </button>`;
        const fixed = (label, name) => `<span class="win-tab" data-static>${icon(name, 16)}<span>${label}</span></span>`;
        const trail = running ? '<span class="trail" data-trail>0%</span>' : '';
        const screen = { batch: 'batchScreen', editor: 'editorScreen', player: 'playerScreen', logs: 'logsScreen' }[s.screen];
        const version = fmt.version(store.getters.latest);

        return `<div class="win" role="group" aria-label="molexMedia app window, recreated">
            <div class="win-bar" aria-hidden="true">
                <span class="win-name">molex<em>Media</em></span>
                <span class="win-ver">${version || ''}</span>
                ${running ? `<span class="win-run">${icon('play', 12)}<span>Batch running</span></span>` : ''}
                <span class="win-ctl"><span>${icon('minimize', 14)}</span><span>${icon('maximize', 12)}</span><span>${icon('close', 14)}</span></span>
            </div>
            <div class="win-body">
                <div class="win-side">
                    <div class="win-side-top" aria-hidden="true">${icon('collapse', 16)}</div>
                    <div class="win-group">${fixed('Dashboard', 'dashboard')}</div>
                    <div class="win-group" role="tablist" aria-label="App screens" aria-orientation="vertical">
                        <span class="win-cap" aria-hidden="true">Tools</span>
                        ${tab(SCREENS[0], trail)}${tab(SCREENS[1])}${tab(SCREENS[2])}
                        <span class="win-cap" aria-hidden="true" style="margin-top:14px">System</span>
                        ${fixed('Settings', 'settings')}${tab(SCREENS[3])}
                    </div>
                </div>
                <div class="win-main" role="tabpanel" id="win-panel" aria-labelledby="win-tab-${s.screen}">${this[screen]()}</div>
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
