import { icon } from '../icons.js';
import { link } from '../parts.js';

const COLUMNS = [
    {
        path: '/features/batch',
        title: 'Batch Processor',
        color: 'var(--normalize)',
        items: [
            ['Five operations in one queue', 'Normalize, boost, convert, compress, and extract, set per file.'],
            ['Two-pass loudness normalization', 'ITU-R BS.1770-4 with eight presets and manual targets.'],
            ['29 conversion presets', 'From MP4 H.264 to ProRes, FFV1, and audio-only formats.'],
            ['Five compression encoders', 'x264, x265, VP9, SVT-AV1, and aom AV1, by quality or target size.'],
            ['18 extraction presets', 'Audio, silent video, GIF, frames, and subtitles.'],
            ['All tracks kept', 'Convert and compress map each audio and subtitle track that the target container can hold.'],
            ['Parallel workers', 'One per CPU core by default, adjustable during a batch.'],
        ],
    },
    {
        path: '/features/editor',
        title: 'Media Editor',
        color: 'var(--convert)',
        items: [
            ['Multi-track timeline', 'Video tracks for cutting and layering, plus audio tracks.'],
            ['Four edit types', 'Insert, Overwrite, Append, and On Top.'],
            ['Ripple, roll, slip, and slide', 'Picked by which clip edge you drag and which keys you hold.'],
            ['Transforms and keyframes', 'Position, scale, rotation, anchor, and opacity per clip.'],
            ['Eight blend modes', 'Rendered in the preview and in the FFmpeg export.'],
            ['Clip mode', 'Trim a single file with a fast lossless cut or a precise re-encode.'],
            ['Stream inspector', 'Streams, metadata, keyframes, and remux without re-encoding.'],
        ],
    },
    {
        path: '/features/player',
        title: 'Media Player',
        color: 'var(--extract)',
        items: [
            ['Local playback', 'Audio and video files, with a folder browser and drag and drop.'],
            ['URL streaming', 'YouTube videos and playlists through yt-dlp, and direct audio links.'],
            ['Eight visualizations', 'DMT, Space, Milkdrop, Plasma, Bars, Waveform, Horizon, and Rain.'],
            ['Beat detection', 'Six Bark-aligned frequency bands drive the visuals.'],
            ['Playlist', 'Reorder by dragging, shuffle, and repeat one or all.'],
            ['Popout player', 'A small always-on-top window in three sizes or your own.'],
        ],
    },
];

$.component('features-page', {
    render()
    {
        const cols = COLUMNS.map((c) => `
            <section class="index-col" style="--c:${c.color}" aria-labelledby="idx-${c.path.split('/').pop()}">
                <h2 id="idx-${c.path.split('/').pop()}">${link(c.path, c.title)}<span class="more">${link(c.path, `Details ${icon('arrow', 14)}`)}</span></h2>
                <ul>${c.items.map(([t, d]) => `<li><strong>${t}</strong>${d}</li>`).join('')}</ul>
            </section>`).join('');

        return `
<div class="wrap">
    <header class="page-head">
        <h1>Features</h1>
        <p class="lead">molexMedia has three tools that share one FFmpeg install. Each tool's page lists its presets, encoders, and shortcuts.</p>
    </header>
    <div class="index-grid">${cols}</div>
    <section class="sec sec-tight" aria-labelledby="idx-app">
        <div class="split">
            <div>
                <h2 id="idx-app">The rest of the app</h2>
            </div>
            <ul class="ops">
                <li><strong>Setup</strong><span>Uses the FFmpeg and ffprobe on your PATH, or downloads them in a setup wizard with a retry and a manual fallback.</span></li>
                <li><strong>Tray</strong><span>Keeps running in the system tray, shows batch progress in the tray tooltip and menu, and opens any tool from the menu.</span></li>
                <li><strong>Notifications</strong><span>A desktop notification when a batch finishes, with how many files succeeded or failed.</span></li>
                <li><strong>Logs</strong><span>Every FFmpeg command and result, filterable by level, searchable, and copyable.</span></li>
                <li><strong>GPU</strong><span>NVENC, Quick Sync, and AMF for H.264 and HEVC, found with a one-frame test encode. Off by default.</span></li>
                <li><strong>Formats</strong><span>21 video and 14 audio input extensions, from MP4 and MKV to DTS, APE, and WavPack.</span></li>
                <li><strong>Updates</strong><span>Windows and macOS builds update from GitHub Releases. Linux packages are updated by downloading the new release.</span></li>
            </ul>
        </div>
    </section>
</div>`;
    },
});
