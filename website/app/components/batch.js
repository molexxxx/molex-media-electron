import { link, MINUS } from '../parts.js';

const STANDARDS = [
    ['EBU R 128', `${MINUS}23.0 LUFS`, `${MINUS}1.0 dBTP`, '±0.2 LU', 'Broadcast programs in Europe'],
    ['ATSC A/85 (short-form method)', `${MINUS}24 LKFS`, `${MINUS}2.0 dBTP`, '±2 dB', 'Broadcast programs in North America'],
    ['Film and series (EBU R 128 s4)', `${MINUS}23.0 LUFS`, `${MINUS}1.0 dBTP`, '±0.2 LU', 'Long-form drama and film'],
    ['Podcast (Apple Podcasts)', `${MINUS}16 LKFS`, `${MINUS}1.0 dBTP`, '±1 dB', 'Spoken word for podcast platforms'],
    ['Music streaming (Spotify reference)', `${MINUS}14 LUFS`, `${MINUS}1.0 dBTP`, 'None stated', `Louder masters keep ${MINUS}2.0 dBTP`],
    ['Streaming (EBU R 128 s2)', `${MINUS}18 LUFS`, `${MINUS}1.0 dBTP`, 'None stated', `Target editable from ${MINUS}20 to ${MINUS}16`],
    ['Streaming (AES TD1004, superseded)', `${MINUS}18 LUFS`, `${MINUS}1.0 dBTP`, '±0.5 LU', `Target editable from ${MINUS}20 to ${MINUS}16`],
    ['Clear dialogue (movies and shows)', `${MINUS}18 LUFS`, `${MINUS}1.0 dBTP`, 'App preset', 'Night compressor for quiet rooms'],
    ['Custom', `${MINUS}60 to ${MINUS}5 LUFS`, `${MINUS}1.0 dBTP`, 'Yours', 'Your own target and tolerance'],
];

const GAIN = [
    ['Gentle lift', '+1 dB', 'Off'],
    ['Quiet recording', '+3.5 dB', '60 Hz'],
    ['Voice clarity', '+2.5 dB', '80 Hz'],
    ['Phone audio', '+5 dB', '100 Hz'],
    ['Louder', '+6 dB', 'Off'],
    ['Tone down', `${MINUS}2.5 dB`, 'Off'],
];

const CONVERT = [
    ['General', [
        ['MP4 (H.264/AAC)', 'MP4', 'H.264, 5000k', 'AAC 256k', ''],
        ['MKV (HEVC/AAC)', 'MKV', 'H.265, 5000k', 'AAC 256k', ''],
        ['WebM (VP9/Opus)', 'WebM', 'VP9, 2500k', 'Opus 192k', ''],
        ['MP3 320k', 'MP3', '', 'MP3 320k', ''],
    ]],
    ['Web', [
        ['MP4 720p 30 fps, about 1.6 Mb/s', 'MP4', 'H.264, 1500k', 'AAC 128k', '1280 × 720, 30 fps'],
        ['MP4, about 10.3 Mb/s', 'MP4', 'H.264, 10000k', 'AAC 256k', ''],
        ['MP4 1080x1920 30 fps, about 4.2 Mb/s', 'MP4', 'H.264, 4000k', 'AAC 192k', '1080 × 1920 padded, 30 fps'],
        ['MP4 1080x1920 30 fps, about 3.6 Mb/s', 'MP4', 'H.264, 3500k', 'AAC 128k', '1080 × 1920 padded, 30 fps'],
        ['MP4 720p 30 fps, about 2.6 Mb/s', 'MP4', 'H.264, 2500k', 'AAC 128k', '1280 × 720, 30 fps'],
        ['720p Web', 'MP4', 'H.264, 2500k', 'AAC 192k', '1280 × 720, 30 fps'],
        ['MP4 480p 24 fps, about 0.6 Mb/s', 'MP4', 'H.264, 500k', 'AAC 96k', '854 × 480, 24 fps'],
        ['MP4 HEVC 1080p, about 4.2 Mb/s', 'MP4', 'H.265, 4000k', 'AAC 192k', '1920 × 1080'],
    ]],
    ['Devices', [
        ['MOV (H.264/AAC)', 'MOV', 'H.264, 8000k', 'AAC 256k', ''],
        ['MP4, about 4.2 Mb/s', 'MP4', 'H.264, 4000k', 'AAC 192k', ''],
        ['MP4 1080p, about 5.3 Mb/s', 'MP4', 'H.264, 5000k', 'AAC 256k', '1920 × 1080'],
    ]],
    ['Production', [
        ['MP4 (AV1/Opus)', 'MP4', 'AOM AV1, 2500k', 'Opus 192k', ''],
        ['ProRes (Editing)', 'MOV', 'ProRes, source pixel format', 'PCM', ''],
        ['FFV1 Lossless', 'MKV', 'FFV1, source pixel format', 'FLAC', ''],
        ['4K Archive (HEVC/FLAC)', 'MKV', 'H.265, 25000k, source pixel format', 'FLAC', '3840 × 2160'],
        ['MPEG-2 Broadcast (TS)', 'TS', 'MPEG-2, 8000k', 'AC-3 192k per pair', ''],
    ]],
    ['Audio only', [
        ['WAV (PCM)', 'WAV', '', 'PCM', ''],
        ['FLAC Lossless', 'FLAC', '', 'FLAC', ''],
        ['ALAC Lossless (M4A)', 'M4A', '', 'ALAC', ''],
        ['M4A AAC 256k', 'M4A', '', 'AAC 256k', ''],
        ['Opus 128k (Ogg)', 'OGG', '', 'Opus 128k', ''],
        ['Podcast MP3 96k mono', 'MP3', '', 'MP3, mono', ''],
        ['Audiobook M4A 96k mono', 'M4A', '', 'AAC, mono', ''],
        ['AC-3 Surround 448k at 5.1', 'AC3', '', 'AC-3 448k', ''],
    ]],
];

const COMPRESS = [
    ['Archive', ['Archival (x265 10-bit)', 'HQ Master (x265)']],
    ['Web', ['Web 1080p', 'Web 720p Compact', 'Target 25 MB', 'Target 500 MB', 'Upload Master (x264 CRF 18)']],
    ['Mobile', ['Mobile Friendly (fast decode)']],
    ['Special', ['Animation (x265)', 'Film Grain Preserve (x265 10-bit)']],
    ['Modern', ['AV1 Streaming']],
];

const ENCODERS = [
    ['H.264', 'libx264', '-crf 0'],
    ['H.265', 'libx265', '-x265-params lossless=1'],
    ['VP9', 'libvpx-vp9', '-lossless 1'],
    ['AOM AV1', 'libaom-av1', '-crf 0 -b:v 0'],
    ['SVT-AV1', 'libsvtav1', 'None. The app encodes at CRF 0 and says the result is near-lossless.'],
];

const EXTRACT = [
    ['Audio', 'One audio stream to its own file, with sample rate and channel rules', 'MP3 320k; AAC 256k (M4A); Opus 128k; FLAC Lossless; WAV (PCM); Podcast MP3 96k mono, 44.1 kHz'],
    ['Video', 'The picture without its audio, stream-copied or re-encoded', 'Silent Video (copy); Silent Video (x264 CRF 20)'],
    ['GIF', 'Two-step palette generation for clean color, with width, frame rate, and dither', 'GIF 720 px wide; GIF 480 px wide; GIF 360 px wide'],
    ['Frames', 'PNG or JPEG stills at an interval, an even count, or one midpoint thumbnail', 'Single Thumbnail; Every 1 Second; Every 5 Seconds; 50 Evenly Spaced Frames'],
    ['Subtitles', 'Text subtitles saved as sidecar files', 'Subtitles to SRT; Subtitles to WebVTT; Subtitles to ASS'],
];

$.component('batch-page', {
    render()
    {
        const convertRows = CONVERT.map(([group, rows]) =>
            `<tr class="grp"><th colspan="5" scope="colgroup">${group}</th></tr>` +
            rows.map(([n, c, v, a, x]) => `<tr><th scope="row">${n}</th><td>${c}</td><td>${v || 'None'}</td><td>${a}</td><td>${x}</td></tr>`).join('')).join('');

        return `
<div class="wrap">
    <header class="page-head">
        <p class="crumbs">${link('/features', 'Features')}<span aria-hidden="true">/</span><span>Batch</span></p>
        <h1>Batch</h1>
        <p class="lead">Add files, give each job an operation, read the Review, and press Start. The tables below list each preset with the values the app applies.</p>
        <figure class="shot"><img src="assets/screens/batch.webp" width="1440" height="922" alt="The Batch page: six queued jobs in the table, the run header above, and the inspector at the right." loading="lazy"><figcaption>The queue with six jobs and the inspector. File names are examples.</figcaption></figure>
    </header>
    <div class="doc">
        <nav class="toc" aria-label="On this page">
            <p class="toc-title">On this page</p>
            <a href="/features/batch#flow">Queue, Review, Run, History</a>
            <a href="/features/batch#normalize">Normalize</a>
            <a href="/features/batch#gain">Gain</a>
            <a href="/features/batch#convert">Convert</a>
            <a href="/features/batch#compress">Compress</a>
            <a href="/features/batch#extract">Extract</a>
            <a href="/features/batch#output">Output and streams</a>
        </nav>
        <div>
            <section class="doc-sec" id="flow" aria-labelledby="h-flow">
                <h2 id="h-flow">Queue, Review, Run, History</h2>
                <p>A job is a source file and the settings it will run with. Files you add get the New files operation; select rows to change their settings in the inspector, or press Ctrl+K to set any operation and Alt+1 to Alt+9 to set pinned ones.</p>
                <ul class="bullets" style="margin-top:16px">
                    <li><strong>Review</strong> lists every output path, encoder, and warning before anything runs, and says what will be written and what will not be touched.</li>
                    <li><strong>Run</strong> shows each job's status, progress, time, and speed, with Pause and Cancel run in the header. Workers and output are chosen there too.</li>
                    <li><strong>Stamps.</strong> Each finished job is measured again in its output and stamped Verified, or Returned with the reason, such as "True peak ${MINUS}0.4 dBTP over ${MINUS}1.0". A returned job waits for your decision.</li>
                    <li><strong>History</strong> keeps every batch with its report, which can be exported.</li>
                    <li><strong>Hardware encoding.</strong> NVENC, Quick Sync, and AMF take H.264 and HEVC, found with a one-frame test encode. A job that cannot get a GPU session waits or runs on the CPU and says so.</li>
                </ul>
            </section>

            <section class="doc-sec" id="normalize" aria-labelledby="h-normalize">
                <h2 id="h-normalize">Normalize</h2>
                <p>Loudness is measured with FFmpeg's <code>ebur128</code> meter to ITU-R BS.1770, the gain is planned from that measurement, and a true-peak limiter oversampled 2x holds the ceiling. The output is measured again before the job is stamped. Each standard is cited to its source document in the app, with the tolerance it states.</p>
                <div class="spec-wrap"><table class="spec">
                    <thead><tr><th scope="col">Preset</th><th scope="col">Loudness</th><th scope="col">True peak</th><th scope="col">Tolerance</th><th scope="col">Notes</th></tr></thead>
                    <tbody>${STANDARDS.map(([n, i, tp, tol, note]) => `<tr><th scope="row">${n}</th><td class="num">${i}</td><td class="num">${tp}</td><td class="num">${tol}</td><td>${note}</td></tr>`).join('')}</tbody>
                </table></div>
                <h3>What the measurement cannot fix</h3>
                <ul class="bullets">
                    <li>A target that cannot be reached without more than the allowed limiting is reported as reachable level instead of being forced, and the stamp says so.</li>
                    <li>Silent, very short, or very quiet sources are copied and labeled, not pushed to the target.</li>
                    <li>Surround sources are refused on an FFmpeg build whose meter fails the self-test, with the downmix offered as the fix.</li>
                </ul>
            </section>

            <section class="doc-sec" id="gain" aria-labelledby="h-gain">
                <h2 id="h-gain">Gain</h2>
                <p>Gain in dB on every audio stream, keeping each stream's own channel layout and sample rate. The limiter runs <code>alimiter</code> with <code>level=disabled</code> and <code>latency=1</code>, oversampled 2x, at ${MINUS}1.0 dBTP with up to 3 dB of limiting before the job is returned.</p>
                <div class="spec-wrap"><table class="spec">
                    <thead><tr><th scope="col">Preset</th><th scope="col">Gain</th><th scope="col">High-pass</th></tr></thead>
                    <tbody>${GAIN.map(([n, g, h]) => `<tr><th scope="row">${n}</th><td class="num">${g}</td><td class="num">${h}</td></tr>`).join('')}</tbody>
                </table></div>
            </section>

            <section class="doc-sec" id="convert" aria-labelledby="h-convert">
                <h2 id="h-convert">Convert</h2>
                <p>28 presets, or your own container, encoder, bitrate, frame size, frame rate, and pixel format, with stream copy or a full re-encode. Frame sizes fit, pad, or crop to the target without upscaling. A container that cannot hold the chosen codec is caught before the job starts.</p>
                <div class="spec-wrap"><table class="spec">
                    <thead><tr><th scope="col">Preset</th><th scope="col">Container</th><th scope="col">Video</th><th scope="col">Audio</th><th scope="col">Frame</th></tr></thead>
                    <tbody>${convertRows}</tbody>
                </table></div>
            </section>

            <section class="doc-sec" id="compress" aria-labelledby="h-compress">
                <h2 id="h-compress">Compress</h2>
                <p>Choose an encoder and a quality tier, an exact CRF, or a target file size with optional two-pass. Speed maps to each encoder's own preset scale, and tunes such as film, grain, and animation are passed through.</p>
                <div class="spec-wrap"><table class="spec">
                    <thead><tr><th scope="col">Encoder</th><th scope="col">FFmpeg</th><th scope="col">Lossless tier</th></tr></thead>
                    <tbody>${ENCODERS.map(([n, f, x]) => `<tr><th scope="row">${n}</th><td><code>${f}</code></td><td>${x.startsWith('-') ? `<code>${x}</code>` : x}</td></tr>`).join('')}</tbody>
                </table></div>
                <h3>Presets</h3>
                <div class="spec-wrap"><table class="spec">
                    <tbody>${COMPRESS.map(([g, names]) => `<tr><th scope="row">${g}</th><td>${names.join(', ')}</td></tr>`).join('')}</tbody>
                </table></div>
                <h3>Target size</h3>
                <ul class="bullets">
                    <li>The video bitrate is the target size over the duration, minus the bitrate of every audio stream being written.</li>
                    <li>Rate control caps at twice that bitrate with a buffer of four times, and two-pass is available on the software encoders.</li>
                    <li>Parallel two-pass jobs each get their own pass log.</li>
                </ul>
            </section>

            <section class="doc-sec" id="extract" aria-labelledby="h-extract">
                <h2 id="h-extract">Extract</h2>
                <p>Five modes and 18 presets for pulling one part out of a file.</p>
                <div class="spec-wrap"><table class="spec">
                    <thead><tr><th scope="col">Mode</th><th scope="col">What you get</th><th scope="col">Presets</th></tr></thead>
                    <tbody>${EXTRACT.map(([m, w, p]) => `<tr><th scope="row">${m}</th><td>${w}</td><td>${p}</td></tr>`).join('')}</tbody>
                </table></div>
            </section>

            <section class="doc-sec" id="output" aria-labelledby="h-output">
                <h2 id="h-output">Output and streams</h2>
                <ul class="bullets">
                    <li><strong>Where outputs go.</strong> Next to each source or into a folder you choose, named by a template with the source name, extension, subfolder, and catalog number. A name that already exists is renamed, skipped, or overwritten by the rule you set.</li>
                    <li><strong>Originals.</strong> Never touched unless you choose Replace originals for that batch, and then the displaced file goes to the trash or is kept.</li>
                    <li><strong>Every stream mapped.</strong> Convert and compress name each stream explicitly, so a film with a 5.1 mix, a commentary, and a described track keeps all three. Nothing relies on FFmpeg's automatic selection, which keeps one stream per type.</li>
                    <li><strong>Subtitles</strong> become the container's own format, <code>mov_text</code> for MP4 and MOV and copied for MKV, and are left out where the container cannot hold them. Image subtitles are left out where only text fits.</li>
                    <li><strong>Audio encoders</strong> are chosen by what the container holds and what the source layout allows, with AAC passed <code>-aac_coder fast</code> so an abrupt start does not decode above the ceiling.</li>
                </ul>
            </section>
        </div>
    </div>
</div>`;
    },
});
