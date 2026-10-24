import { icon } from '../icons.js';
import { link } from '../parts.js';

const COLUMNS = [
    {
        path: '/features/batch',
        title: 'Batch',
        items: [
            ['Queue, Review, Run, History', 'Four views of one batch. Review lists every output path, encoder, and warning before anything runs.'],
            ['Normalize to a standard', 'EBU R 128, ATSC A/85, Apple Podcasts, Spotify, EBU R 128 s2 and s4, AES TD1004, or your own target.'],
            ['Measured stamps', 'Every finished job is measured again and stamped Verified, or Returned with the reason.'],
            ['28 convert and 11 compress presets', 'From MP4 to ProRes and FFV1; x264, x265, VP9, AOM AV1, and SVT-AV1.'],
            ['GPU encoding', 'NVENC, Quick Sync, and AMF for H.264 and HEVC, found with a test encode.'],
            ['Every stream kept', 'Convert and compress map each stream the target container can hold.'],
            ['Originals untouched', 'Outputs go next to each source or to a folder you choose. Replace originals is chosen per batch.'],
        ],
    },
    {
        path: '/features/editor',
        title: 'Editor',
        items: [
            ['Trim', 'Cut one file between in and out points, then export video, audio, or a GIF.'],
            ['Timeline', 'Clips from several files on video and audio tracks, exported as one file.'],
            ['Inspect', 'The streams and tags of a file, and a copy without the ones you remove.'],
            ['Timecode readouts', 'In, out, and length in timecode, with frame stepping on the arrow keys.'],
            ['Export choices', 'MP4, WebM, MOV, or MKV at four CRF tiers and up to 4K.'],
            ['GPU where it fits', 'Exports encode with NVENC, Quick Sync, or AMF where the codec allows.'],
        ],
    },
    {
        path: '/features/player',
        title: 'Player',
        items: [
            ['Files and folders', 'Drop them anywhere on the page, or add them from the toolbar.'],
            ['Links through yt-dlp', 'YouTube and many other sites; a playlist or a direct media link.'],
            ['Video or visualization', 'The picture when there is one, or eight canvas visualizations.'],
            ['Subtitles and audio tracks', 'Chosen from the transport, with real full screen on F11.'],
            ['Playlist', 'Shuffle, repeat off, all, or one, and keyboard shortcuts for every action.'],
            ['Pop out', 'A small always-on-top window with its own compact transport.'],
        ],
    },
];

$.component('features-page', {
    render()
    {
        const cols = COLUMNS.map((c) => `
            <section class="index-col" aria-labelledby="idx-${c.path.split('/').pop()}">
                <h2 id="idx-${c.path.split('/').pop()}">${link(c.path, c.title)}<span class="more">${link(c.path, `Details ${icon('arrow', 14)}`)}</span></h2>
                <ul>${c.items.map(([t, d]) => `<li><strong>${t}</strong>${d}</li>`).join('')}</ul>
            </section>`).join('');

        return `
<div class="wrap">
    <header class="page-head">
        <h1>Features</h1>
        <p class="lead">molexMedia has three tools that share one FFmpeg install. Each tool's page lists its presets, settings, and shortcuts, taken from the app itself.</p>
    </header>
    <div class="index-grid">${cols}</div>
    <section class="sec sec-tight" aria-labelledby="idx-app">
        <div class="split">
            <div>
                <h2 id="idx-app">The rest of the app</h2>
            </div>
            <ul class="rows">
                <li><strong>Dashboard</strong><span>The front panel: recent files and folders, the last batch, and the state of FFmpeg, the GPU, and yt-dlp.</span></li>
                <li><strong>Setup</strong><span>Uses the FFmpeg and ffprobe on your PATH when they are at least 5.1, or downloads a pinned build, checks its SHA-256, and runs a self-test. You can also point it at a folder of your own.</span></li>
                <li><strong>Settings</strong><span>Batch defaults, presets, the FFmpeg and yt-dlp installs, and the application: start with the system, keep running in the tray, notifications, and updates.</span></li>
                <li><strong>Logs</strong><span>Every FFmpeg command and its output, the job engine, hardware encoding, updates, the player, and the editor, filtered by level and source, searchable, and copyable line by line.</span></li>
                <li><strong>Updates</strong><span>Windows and macOS builds update from GitHub Releases. Linux packages are updated by downloading the new release.</span></li>
            </ul>
        </div>
    </section>
</div>`;
    },
});
