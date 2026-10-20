import { opChip, link } from '../parts.js';
import { PRESETS } from '../widgets.js';

const CONVERT = [
    ['General', [
        ['MP4 (H.264/AAC)', 'MP4', 'H.264, 5000k', 'AAC 256k', ''],
        ['MKV (HEVC/AAC)', 'MKV', 'H.265, 5000k', 'AAC 256k', ''],
        ['WebM (VP9/Opus)', 'WebM', 'VP9, 2500k', 'Opus 192k', ''],
        ['MP3 320k', 'MP3', '', 'MP3 320k', ''],
        ['FLAC Lossless', 'FLAC', '', 'FLAC', ''],
    ]],
    ['Web and social', [
        ['Discord (25 MB)', 'MP4', 'H.264, 1500k', 'AAC 128k', '1280x720, 30 fps'],
        ['YouTube Upload', 'MP4', 'H.264, 10000k', 'AAC 256k', ''],
        ['TikTok / Reels', 'MP4', 'H.264, 4000k', 'AAC 192k', '1080x1920, 30 fps'],
        ['Instagram Reels', 'MP4', 'H.264, 3500k', 'AAC 128k', '1080x1920, 30 fps'],
        ['Twitter / X', 'MP4', 'H.264, 2500k', 'AAC 128k', '1280x720, 30 fps'],
        ['720p Web', 'MP4', 'H.264, 2500k', 'AAC 192k', '1280x720, 30 fps'],
        ['Email (10 MB)', 'MP4', 'H.264, 500k', 'AAC 96k', '854x480, 24 fps'],
        ['Telegram (2 GB)', 'MP4', 'H.265, 4000k', 'AAC 192k', '1920x1080'],
    ]],
    ['Devices', [
        ['Apple Device', 'MOV', 'H.264, 8000k', 'AAC 256k', ''],
        ['Android', 'MP4', 'H.264, 4000k', 'AAC 192k', ''],
        ['Chromecast', 'MP4', 'H.264, 5000k', 'AAC 256k', '1920x1080'],
    ]],
    ['Production', [
        ['MP4 AV1', 'MP4', 'AV1 (aom), 2500k', 'Opus 192k', ''],
        ['ProRes (Editing)', 'MOV', 'ProRes', 'PCM 24-bit', ''],
        ['FFV1 Lossless', 'MKV', 'FFV1', 'FLAC', ''],
        ['4K Archive', 'MKV', 'H.265, 25000k', 'FLAC', '3840x2160'],
        ['MPEG-2 Broadcast', 'TS', 'MPEG-2, 8000k', 'AC-3 256k', ''],
    ]],
    ['Audio only', [
        ['WAV 16-bit', 'WAV', '', 'PCM 16-bit', ''],
        ['WAV 24-bit', 'WAV', '', 'PCM 24-bit', ''],
        ['ALAC (Apple Lossless)', 'M4A', '', 'ALAC', ''],
        ['M4A AAC 256k', 'M4A', '', 'AAC 256k', ''],
        ['Opus 128k', 'OGG', '', 'Opus 128k', ''],
        ['Podcast MP3 96k', 'MP3', '', 'MP3 96k', ''],
        ['Audiobook (M4A 64k)', 'M4A', '', 'AAC 64k', ''],
        ['AC3 Surround', 'AC3', '', 'AC-3 448k', ''],
    ]],
];

const ENCODERS = [
    ['H.264', 'libx264', '18', '23', '28', '-crf 0'],
    ['H.265', 'libx265', '22', '28', '33', '-x265-params lossless=1'],
    ['VP9', 'libvpx-vp9', '24', '31', '38', '-lossless 1'],
    ['AV1 (aom)', 'libaom-av1', '22', '28', '35', '-crf 0 -b:v 0'],
    ['AV1 (SVT)', 'libsvtav1', '24', '30', '36', 'None. Encodes at CRF 0 and logs that the result is near-lossless.'],
];

const DELIVERY = [
    'Archival (Visually Lossless)', 'HQ Master', 'Web 1080p', 'Web 720p Compact', 'Discord (25 MB)', 'Discord Nitro (500 MB)',
    'Mobile Friendly', 'YouTube Master', 'Animation / Cartoons', 'Film Grain Preserve', 'AV1 Streaming',
    'Audio: Lossless (FLAC)', 'Audio: High AAC (256k)',
];

const EXTRACT = [
    ['Audio', 'MP3, AAC, Opus, FLAC, or WAV, with bitrate, sample rate, and channel overrides', 'MP3 320k, AAC 256k, Opus 128k, FLAC Lossless, WAV PCM 16-bit, Podcast Mono 96k'],
    ['Video', 'The video without its audio, stream-copied or re-encoded to H.264', 'Silent Video (copy), Silent Video (H.264)'],
    ['GIF', 'Two-step palettegen and paletteuse for clean color, with width, frame rate, dither, and loop', 'GIF: HQ 720p, GIF: Web 480p, GIF: Social 360p'],
    ['Frames', 'PNG, JPG, or WebP stills at an interval, a frame rate, an even count, or one midpoint thumbnail', 'Single Thumbnail, Every 1 Second, Every 5 Seconds, 50 Evenly-Spaced Frames'],
    ['Subtitles', 'Text subtitles saved as sidecar files. Image-based subtitles are refused up front with an explanation.', 'Subtitles to SRT, WebVTT, or ASS'],
];

const BOOST = [
    ['Gentle Lift', '+15%', 'Off', '-1 dBTP'],
    ['Quiet Recording', '+50%', '60 Hz', '-1 dBTP'],
    ['Voice Clarity', '+30%', '80 Hz', '-1 dBTP'],
    ['Phone Audio', '+75%', '100 Hz', '-1 dBTP'],
    ['Maximize', '+100%', 'Off', '-0.3 dBTP'],
    ['Tone Down', '-25%', 'Off', 'No limiter'],
];

const VIDEO_EXT = 'mp4 mkv avi mov flv wmv webm m4v mpg mpeg ts vob 3gp mts m2ts divx f4v ogv rm rmvb asf';
const AUDIO_EXT = 'mp3 wav flac ogg m4a wma aac opus ac3 eac3 dts amr ape wv';

const minus = (s) => String(s).replace(/^-/, '−');

$.component('batch-page', {
    render()
    {
        const convertRows = CONVERT.map(([group, rows]) =>
            `<tr class="grp"><th colspan="5" scope="colgroup">${group}</th></tr>` +
            rows.map(([n, c, v, a, x]) => `<tr><th scope="row">${n}</th><td>${c}</td><td>${v || 'None'}</td><td>${a}</td><td>${x}</td></tr>`).join('')).join('');

        return `
<div class="wrap">
    <header class="page-head">
        <p class="crumbs">${link('/features', 'Features')}<span aria-hidden="true">/</span><span>Batch Processor</span></p>
        <h1>Batch Processor</h1>
        <p class="lead">Queue files, give each one an operation, and run them in parallel. The tables below list each preset with its actual values.</p>
    </header>
    <div class="doc">
        <nav class="toc" aria-label="On this page">
            <p class="toc-title">On this page</p>
            <a href="/features/batch#queue">Queue and workers</a>
            <a href="/features/batch#normalize">Normalize</a>
            <a href="/features/batch#boost">Boost</a>
            <a href="/features/batch#convert">Convert</a>
            <a href="/features/batch#compress">Compress</a>
            <a href="/features/batch#extract">Extract</a>
            <a href="/features/batch#formats">Input formats</a>
        </nav>
        <div>
            <section class="doc-sec" id="queue" aria-labelledby="h-queue">
                <h2 id="h-queue">Queue and workers</h2>
                <p>Files follow the operation panel until you edit one; from then on that file keeps its own settings. A batch can mix all five operations.</p>
                <ul class="bullets" style="margin-top:16px">
                    <li><strong>Workers.</strong> One per CPU core by default, up to 32 in Settings, and adjustable while a batch runs.</li>
                    <li><strong>Control.</strong> Pause, resume, or cancel mid-batch, with progress on every file.</li>
                    <li><strong>Output.</strong> Zero-byte output is detected and cleaned up, and failures show FFmpeg's own error text.</li>
                    <li><strong>Tray and notifications.</strong> The tray tooltip reads <code>molexMedia - Processing 3/12</code>, and a desktop notification reports how many files succeeded.</li>
                    <li><strong>GPU encoding.</strong> NVENC, Quick Sync, and AMF for H.264 and HEVC, detected with a one-frame test encode. Off by default; other codecs stay on the CPU.</li>
                </ul>
            </section>

            <section class="doc-sec" id="normalize" aria-labelledby="h-normalize">
                <h2 id="h-normalize">Normalize ${opChip('normalize')}</h2>
                <p>Two-pass loudness normalization with FFmpeg's <code>loudnorm</code> filter, measured to ITU-R BS.1770-4. Pass one measures the file; pass two applies the measured values. Both passes run the same downmix, so the analysis describes the signal that gets normalized, and the output sample rate is pinned to the source.</p>
                <div class="spec-wrap"><table class="spec">
                    <thead><tr><th scope="col">Preset</th><th scope="col">Loudness</th><th scope="col">True peak</th><th scope="col">Range</th><th scope="col">Compression</th><th scope="col">Channels</th><th scope="col">Audio</th></tr></thead>
                    <tbody>${PRESETS.map((p) => `<tr><th scope="row">${p.name}</th><td class="num">${minus(p.I)} LUFS</td><td class="num">${minus(p.TP)} dBTP</td><td class="num">${p.LRA} LU</td><td>${p.drc}</td><td>${p.layout}</td><td>${p.codec}</td></tr>`).join('')}</tbody>
                </table></div>
                <h3>Manual targets</h3>
                <ul class="bullets">
                    <li>Loudness from -30 to -5 LUFS, loudness range from 1 to 25 LU, and a true-peak ceiling from -9 to 0 dBTP, with a warning above -1 dBTP.</li>
                    <li>Dynamic compression presets use <code>acompressor</code> with makeup gain written in dB, so a +3 dB makeup is +3 dB and not a linear factor of 3.</li>
                    <li>Channel layout can stay as it is, fold down to stereo, or fold down to a dialog-forward stereo mix.</li>
                </ul>
            </section>

            <section class="doc-sec" id="boost" aria-labelledby="h-boost">
                <h2 id="h-boost">Boost ${opChip('boost')}</h2>
                <p>Percentage gain from -50% to +200% on every audio stream, keeping each stream's own channel layout and sample rate. The limiter runs <code>alimiter</code> with <code>level=disabled</code> and <code>latency=1</code>, oversampled 2x so the dBTP ceiling you set is the one delivered.</p>
                <div class="spec-wrap"><table class="spec">
                    <thead><tr><th scope="col">Preset</th><th scope="col">Gain</th><th scope="col">High-pass</th><th scope="col">Ceiling</th></tr></thead>
                    <tbody>${BOOST.map(([n, g, h, c]) => `<tr><th scope="row">${n}</th><td class="num">${minus(g)}</td><td class="num">${h}</td><td class="num">${minus(c)}</td></tr>`).join('')}</tbody>
                </table></div>
            </section>

            <section class="doc-sec" id="convert" aria-labelledby="h-convert">
                <h2 id="h-convert">Convert ${opChip('convert')}</h2>
                <p>29 presets, or your own codec, bitrate, resolution, and frame rate, with stream copy or a full re-encode. Conflicts between codec and container are caught before the job starts.</p>
                <div class="spec-wrap"><table class="spec">
                    <thead><tr><th scope="col">Preset</th><th scope="col">Container</th><th scope="col">Video</th><th scope="col">Audio</th><th scope="col">Size</th></tr></thead>
                    <tbody>${convertRows}</tbody>
                </table></div>
                <h3>Streams</h3>
                <ul class="bullets">
                    <li>Every audio track is mapped explicitly, so a film with commentary and described tracks keeps all of them.</li>
                    <li>Subtitles become the container's own format: <code>mov_text</code> for MP4 and MOV, copied for MKV and TS, and left out for containers that cannot hold them.</li>
                    <li>Image-based subtitles such as PGS are left out where the container only takes text, instead of failing the encode.</li>
                    <li>Audio-only targets receive exactly one audio stream and no video.</li>
                </ul>
            </section>

            <section class="doc-sec" id="compress" aria-labelledby="h-compress">
                <h2 id="h-compress">Compress ${opChip('compress')}</h2>
                <p>Choose an encoder and a quality tier, set a custom CRF from 0 to 51, or give a target file size. Speed runs from Very Fast to Very Slow and maps to each encoder's own preset scale.</p>
                <div class="spec-wrap"><table class="spec">
                    <thead><tr><th scope="col">Encoder</th><th scope="col">FFmpeg</th><th scope="col">High</th><th scope="col">Medium</th><th scope="col">Low</th><th scope="col">Lossless</th></tr></thead>
                    <tbody>${ENCODERS.map(([n, f, h, m, l, x]) => `<tr><th scope="row">${n}</th><td><code>${f}</code></td><td class="num">CRF ${h}</td><td class="num">CRF ${m}</td><td class="num">CRF ${l}</td><td>${x.startsWith('-') ? `<code>${x}</code>` : x}</td></tr>`).join('')}</tbody>
                </table></div>
                <h3>Target size</h3>
                <ul class="bullets">
                    <li>The video bitrate is the target size over the duration, minus the bitrate of every audio stream being written.</li>
                    <li>Rate control caps at twice that bitrate with a buffer of four times, and two-pass is available on software encoders.</li>
                    <li>Parallel two-pass jobs each get their own pass log, so workers never overwrite each other's statistics.</li>
                </ul>
                <h3>Delivery presets</h3>
                <p>${DELIVERY.join(', ')}.</p>
            </section>

            <section class="doc-sec" id="extract" aria-labelledby="h-extract">
                <h2 id="h-extract">Extract ${opChip('extract')}</h2>
                <p>Five extraction modes and 18 presets for pulling one part out of a file.</p>
                <div class="spec-wrap"><table class="spec">
                    <thead><tr><th scope="col">Mode</th><th scope="col">What you get</th><th scope="col">Presets</th></tr></thead>
                    <tbody>${EXTRACT.map(([m, w, p]) => `<tr><th scope="row">${m}</th><td>${w}</td><td>${p}</td></tr>`).join('')}</tbody>
                </table></div>
            </section>

            <section class="doc-sec" id="formats" aria-labelledby="h-formats">
                <h2 id="h-formats">Input formats</h2>
                <p>21 video and 14 audio extensions are accepted by the queue.</p>
                <div class="spec-wrap"><table class="spec">
                    <tbody>
                        <tr><th scope="row">Video</th><td class="num" style="white-space:normal">${VIDEO_EXT.split(' ').map((e) => `.${e}`).join(' ')}</td></tr>
                        <tr><th scope="row">Audio</th><td class="num" style="white-space:normal">${AUDIO_EXT.split(' ').map((e) => `.${e}`).join(' ')}</td></tr>
                    </tbody>
                </table></div>
            </section>
        </div>
    </div>
</div>`;
    },
});
