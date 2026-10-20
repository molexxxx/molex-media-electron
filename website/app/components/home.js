import { icon } from '../icons.js';
import { opChip, link, logLine, NORMALIZE_LOG, CONVERT_LOG } from '../parts.js';

$.component('home-page', {
    render()
    {
        return `
<section class="hero" aria-labelledby="home-title">
    <div class="wrap hero-grid">
        <div class="hero-copy">
            <h1 id="home-title">Batch, edit, and play media in one window</h1>
            <p class="hero-pitch">molexMedia is a desktop app built on FFmpeg, with a batch processor, a multi-track timeline editor, and a media player. It uses the FFmpeg already on your system, or downloads a current build the first time it starts.</p>
            <get-block></get-block>
        </div>
        <div class="hero-demo">
            <app-window></app-window>
            <p class="shot-note">An HTML mockup of the app. Click Batch, Editor, Player, or Logs to switch screens. File names are examples.</p>
        </div>
    </div>
    <div class="wrap">
        <div class="steps steps-row">
            <h2>What happens on first launch</h2>
            <ol>
                <li>Run the installer for your system.</li>
                <li>molexMedia looks for FFmpeg and ffprobe. If they are missing, the setup wizard downloads them, with a retry and a manual fallback.</li>
                <li>Drop files on the queue, choose an operation, and press Process.</li>
            </ol>
        </div>
    </div>
</section>

<section class="sec band" aria-labelledby="h-batch">
    <div class="wrap split">
        <div>
            <h2 id="h-batch">Batch Processor</h2>
            <p class="lead">Set an operation in the panel and every queued file uses it. If you change the settings on one file, that file keeps them, so one batch can normalize a podcast and compress a clip for Discord.</p>
            <ul class="ops">
                <li>${opChip('normalize')}<span>Two-pass loudness normalization to ITU-R BS.1770-4, with eight presets from <code>-14 LUFS</code> for streaming to <code>-23 LUFS</code> for broadcast.</span></li>
                <li>${opChip('boost')}<span>Gain from -50% to +200%, an optional high-pass filter, and a true-peak limiter that oversamples 2x.</span></li>
                <li>${opChip('convert')}<span>29 presets for general use, web and social, devices, production, and audio only, with codec and container conflict checks.</span></li>
                <li>${opChip('compress')}<span>Quality-based encoding with H.264, H.265, VP9, and two AV1 encoders, or a target file size with optional two-pass.</span></li>
                <li>${opChip('extract')}<span>Pull out audio, silent video, a GIF, still frames, or subtitles, from 18 presets.</span></li>
            </ul>
            <p class="more-link">${link('/features/batch', `Presets, encoders, and formats ${icon('arrow', 16)}`)}</p>
        </div>
        <preset-card class="stick"></preset-card>
    </div>
</section>

<section class="sec" aria-labelledby="h-editor">
    <div class="wrap">
        <div class="sec-head">
            <h2 id="h-editor">Media Editor</h2>
            <p class="lead">A multi-track timeline. Cut on V1, layer on V2 with position, scale, rotation, opacity, and blend modes, and put music on A1. Drag across the timeline below or use the arrow keys to move the playhead.</p>
        </div>
        <tl-demo></tl-demo>
        <div class="facts">
            <div>
                <h3>Edit and trim</h3>
                <ul>
                    <li>Insert, Overwrite, Append, and On Top edits</li>
                    <li>Ripple, roll, slip, and slide trims</li>
                    <li>Split at the playhead, snapping, and 100 levels of undo</li>
                    <li>Export the timeline to MP4, WebM, MOV, or MKV</li>
                </ul>
            </div>
            <div>
                <h3>Composite</h3>
                <ul>
                    <li>Position, scale, rotation, anchor, and opacity per clip</li>
                    <li>Keyframes on every transform property</li>
                    <li>Normal, Multiply, Screen, Overlay, Darken, Lighten, Add, and Difference</li>
                </ul>
            </div>
            <div>
                <h3>Keyboard</h3>
                <ul>
                    <li><kbd>J</kbd> <kbd>K</kbd> <kbd>L</kbd> shuttle, doubling up to 8x</li>
                    <li><kbd>I</kbd> <kbd>O</kbd> mark in and out</li>
                    <li><kbd>S</kbd> split, <kbd>V</kbd> <kbd>T</kbd> <kbd>B</kbd> switch tools</li>
                    <li><kbd>?</kbd> lists every shortcut</li>
                </ul>
            </div>
        </div>
        <p class="more-link">${link('/features/editor', `Trims, export settings, and all shortcuts ${icon('arrow', 16)}`)}</p>
    </div>
</section>

<section class="sec band" aria-labelledby="h-player">
    <div class="wrap split split-flip">
        <div>
            <h2 id="h-player">Media Player</h2>
            <p class="lead">Plays local files and streams YouTube videos, YouTube playlists, and direct audio links. The popout player is a small window that stays on top of other windows.</p>
            <ul class="ops">
                <li><strong>Visualizations</strong><span>DMT, Space, Milkdrop, Plasma, Bars, Waveform, Horizon, and Rain, drawn on canvas from the Web Audio API.</span></li>
                <li><strong>Beat detection</strong><span>Six bands aligned to the Bark scale, from sub-bass at 20 Hz to treble at 20 kHz.</span></li>
                <li><strong>Streaming</strong><span>YouTube links resolve through yt-dlp, which molexMedia downloads the first time you paste a URL.</span></li>
            </ul>
            <p class="more-link">${link('/features/player', `Sources, visualizations, and popout sizes ${icon('arrow', 16)}`)}</p>
        </div>
        <viz-demo class="stick"></viz-demo>
    </div>
</section>

<section class="sec" aria-labelledby="h-proof">
    <div class="wrap">
        <div class="split">
            <div>
                <h2 id="h-proof">Fixes in 4.6 and 4.7</h2>
                <p class="lead">Versions 4.6.0 to 4.7.1 fixed a set of audio and encoding bugs, and each fix was measured with a real FFmpeg build before and after the change. The log shows what the app records for a two-pass normalize and for a convert that keeps all three audio tracks.</p>
            </div>
            <div class="log">
                <div class="log-head" aria-hidden="true">
                    <span class="log-filter">All</span><span class="log-filter">Info</span><span class="log-filter">Success</span><span class="log-filter" aria-current="true">FFmpeg</span>
                </div>
                <ol class="log-lines" aria-label="Example log">${[...NORMALIZE_LOG, ...CONVERT_LOG].map((l) => logLine(...l)).join('')}</ol>
            </div>
        </div>
        <ol class="audits" aria-label="Audit results">
            <li class="audit">
                <div><h3>True-peak limiter (4.7.0)</h3><p>The limiter now runs on audio oversampled 2x, because FFmpeg's <code>alimiter</code> only detects sample peaks. Output true peak with the ceiling set to -1 dBTP:</p></div>
                <dl class="audit-read"><div><dt>before</dt><dd><s>-0.3 dBTP</s></dd></div><div><dt>now</dt><dd><b>-1.0 dBTP</b></dd></div></dl>
            </li>
            <li class="audit">
                <div><h3>Multiple audio tracks (4.7.0)</h3><p>Convert and compress used to pass no <code>-map</code>, so FFmpeg kept only the audio track with the most channels. They now map each stream. For a film with a 5.1 mix, a commentary track, and a described-audio track:</p></div>
                <dl class="audit-read"><div><dt>before</dt><dd><s>1 of 3 tracks</s></dd></div><div><dt>now</dt><dd><b>3 of 3 tracks</b></dd></div></dl>
            </li>
            <li class="audit">
                <div><h3>Lossless encoding (4.7.1)</h3><p>The lossless tier used <code>-crf 0</code> for every encoder, which is only bit-exact for x264 and aom AV1. H.265 and VP9 now use their own lossless options. SVT-AV1 has no lossless mode, so the app encodes at CRF 0 and logs a warning. PSNR against the source, where <code>inf</code> means bit-exact:</p></div>
                <dl class="audit-read"><div><dt>x265</dt><dd><s>61.99 dB</s> <b>lossless=1</b></dd></div><div><dt>VP9</dt><dd><s>85.56 dB</s> <b>-lossless 1</b></dd></div><div><dt>x264, aom</dt><dd><b>inf</b></dd></div></dl>
            </li>
            <li class="audit">
                <div><h3>Loudness normalization (4.6.0)</h3><p>The analysis pass measured the untouched source while the second pass normalized a downmixed one. Both passes now run the same downmix. The output sample rate is also set explicitly, because <code>loudnorm</code> resamples to 192 kHz in dynamic mode. Output sample rate after a dynamic-mode fallback:</p></div>
                <dl class="audit-read"><div><dt>before</dt><dd><s>192 kHz</s></dd></div><div><dt>now</dt><dd><b>source rate</b></dd></div></dl>
            </li>
        </ol>
        <p class="more-link">${link('/changelog', `Full notes in the changelog ${icon('arrow', 16)}`)}</p>
    </div>
</section>

<section class="sec band" aria-labelledby="h-get">
    <div class="wrap close">
        <div>
            <h2 id="h-get">Download molexMedia</h2>
            <p class="lead">Free and open source under the MIT license, for Windows, macOS, and Linux. The Windows and macOS builds update themselves from GitHub Releases.</p>
            <p class="lead">The source code, issue tracker, and every past release are on <a href="https://github.com/molexxxx/molex-media-electron" rel="noopener">GitHub</a>.</p>
        </div>
        <platform-list></platform-list>
    </div>
</section>`;
    },
});
