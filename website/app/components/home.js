import { icon } from '../icons.js';
import { link, stamp, statusLabel, MINUS } from '../parts.js';

$.component('home-page', {
    render()
    {
        return `
<section class="hero" aria-labelledby="home-title">
    <div class="wrap hero-grid">
        <div class="hero-copy">
            <h1 id="home-title">Batch, trim, and play media on FFmpeg</h1>
            <p class="hero-pitch">molexMedia normalizes whole folders to named loudness standards, converts and compresses with your GPU, trims and edits on a timeline, and plays files and links, in one desktop window. It downloads and verifies its own FFmpeg the first time it runs.</p>
            <get-block></get-block>
        </div>
        <div class="hero-demo">
            <app-window></app-window>
            <p class="shot-note">A recreation of the app in HTML. Switch between Batch, Editor, Player, and Logs, and press Start to run the queue. File names are examples.</p>
        </div>
    </div>
    <div class="wrap">
        <div class="steps steps-row">
            <h2>What happens on the first run</h2>
            <ol>
                <li>Run the installer for your system and open molexMedia.</li>
                <li>It looks for FFmpeg and ffprobe on your computer. If they are missing or too old, it downloads a pinned build, checks the size and SHA-256, and runs a self-test before it installs them.</li>
                <li>Drop files on Batch, choose an operation, read the Review, and press Start.</li>
            </ol>
        </div>
    </div>
</section>

<section class="sec band" aria-labelledby="h-batch">
    <div class="wrap split">
        <div>
            <h2 id="h-batch">Batch</h2>
            <p class="lead">Add files, give each job an operation, and read the Review before anything runs: every output path, encoder, and warning is listed, and originals are never touched unless you choose Replace originals for that batch. Each finished job is stamped with what was measured in its output.</p>
            <ul class="rows ops-list">
                <li><strong>Normalize</strong><span>To a named standard: EBU R 128, ATSC A/85, Apple Podcasts, Spotify, EBU R 128 s2 and s4, or AES TD1004. Loudness is measured with FFmpeg's ebur128 meter, the gain is planned from the measurement, and a true-peak limiter oversampled 2x holds the ceiling.</span></li>
                <li><strong>Gain</strong><span>Plain gain in dB with an optional high-pass filter, from six app presets or your own numbers, limited at ${MINUS}1.0 dBTP.</span></li>
                <li><strong>Convert</strong><span>28 presets from MP4 and MKV to ProRes, FFV1, and audio-only formats, or your own container, encoder, bitrate, frame size, and frame rate.</span></li>
                <li><strong>Compress</strong><span>x264, x265, VP9, AOM AV1, or SVT-AV1 by quality tier, exact CRF, or a target file size with two-pass. NVENC, Quick Sync, and AMF take H.264 and HEVC when the GPU is on.</span></li>
                <li><strong>Extract</strong><span>Audio, silent video, a GIF, still frames, or text subtitles, from 18 presets.</span></li>
            </ul>
            <p class="more-link">${link('/features/batch', `Standards, presets, and encoders ${icon('arrow', 16)}`)}</p>
        </div>
        <div class="stampcase stick">
            <h3>What a finished job says</h3>
            <div class="stampcase-row"><span>podcast-ep41-master.wav</span>${stamp('verified', `${MINUS}16.0 LKFS · ${MINUS}1.6 dBTP`)}</div>
            <div class="stampcase-row"><span>interview-cam-a.mkv</span>${stamp('verified', `${MINUS}23.0 LUFS · ${MINUS}1.4 dBTP`)}</div>
            <div class="stampcase-row"><span>voice-memo-0412.mp3</span>${stamp('returned', `${MINUS}17.3 LKFS · 1.3 LU under`)}</div>
            <div class="stampcase-row"><span>lecture-03.mkv</span>${statusLabel('done', 'Done')}</div>
            <p>Verified means the output was measured again after encoding and sits inside the standard's tolerance. Returned means it does not, with the reason, and the job waits for your decision instead of being called finished.</p>
        </div>
    </div>
</section>

<section class="sec" aria-labelledby="h-editor">
    <div class="wrap">
        <div class="sec-head">
            <h2 id="h-editor">Editor</h2>
            <p class="lead">Three modes under one header, switched with the tabs or Ctrl+1 to Ctrl+3.</p>
        </div>
        <ul class="rows rows-wide">
            <li><strong>Trim</strong><span>Cut one file between an in and an out point, then export video, audio, or a GIF. In, out, and length sit in lit readouts; a lossless cut copies the streams and lands on the nearest keyframe, while a CRF quality re-encodes on the exact frame. The cut can also go straight onto the timeline.</span></li>
            <li><strong>Timeline</strong><span>Arrange clips from several files on video and audio tracks, then export one file as MP4, WebM, MOV, or MKV at CRF 28, 23, 18, or 10, in the source size or 720p, 1080p, or 4K, for the whole timeline, in to out, or the selected clips.</span></li>
            <li><strong>Inspect</strong><span>See the streams and tags of a file, and save a copy without the ones you remove. The copy is remuxed with stream copy, so nothing is re-encoded.</span></li>
        </ul>
        <figure class="shot"><img src="assets/screens/editor.webp" width="1440" height="922" alt="The Editor in Trim: a video frame above lit In, Out, and Length readouts, a thumbnail strip, and the export panel." loading="lazy"><figcaption>Trim, with the export panel open. Video: Big Buck Bunny, Blender Foundation, CC BY 3.0.</figcaption></figure>
        <p class="more-link">${link('/features/editor', `Export settings and every shortcut ${icon('arrow', 16)}`)}</p>
    </div>
</section>

<section class="sec band" aria-labelledby="h-player">
    <div class="wrap">
        <div class="sec-head">
            <h2 id="h-player">Player</h2>
            <p class="lead">Drop audio or video files anywhere on the page, or add a link. Links play through yt-dlp, from YouTube and many other sites, and molexMedia keeps its own copy of yt-dlp current.</p>
        </div>
        <ul class="rows rows-wide">
            <li><strong>Video</strong><span>The picture when the track has one, with subtitle and audio track menus on the transport, and real full screen on F11 or a double-click.</span></li>
            <li><strong>Visualization</strong><span>Eight canvas visualizations drawn from the audio: DMT, Space, Milkdrop, Plasma, Bars, Waveform, Horizon, and Rain. The Show control switches between the picture and the visualization.</span></li>
            <li><strong>Links</strong><span>A video, a playlist, or a direct link to a media file. Sound and picture quality are chosen per link, and a stream that cannot be played directly is downloaded first.</span></li>
            <li><strong>Pop out</strong><span>A small window that stays on top of other windows, with its own compact transport. Playback continues where it was.</span></li>
        </ul>
        <figure class="shot"><img src="assets/screens/player.webp" width="1440" height="922" alt="The Player showing a video with the playlist beside it and the transport below." loading="lazy"><figcaption>The Player with the playlist shown. Video: Big Buck Bunny, Blender Foundation, CC BY 3.0.</figcaption></figure>
        <p class="more-link">${link('/features/player', `Sources, shortcuts, and the pop-out ${icon('arrow', 16)}`)}</p>
    </div>
</section>

<section class="sec" aria-labelledby="h-under">
    <div class="wrap split">
        <div>
            <h2 id="h-under">What runs underneath</h2>
            <p class="lead">molexMedia does not bundle FFmpeg. It uses the FFmpeg and ffprobe already on your computer when they are at least version 5.1, and otherwise downloads a build pinned by version, size, and SHA-256. The download is verified before it is extracted, and the binaries run a self-test before they are used.</p>
            <p class="lead">On Apple Silicon the pin is held at FFmpeg 7.1.1. The arm64 builds of 8.0 through 9.0.2 read the loudness of surround sound up to 33 LU too loud, which would turn 5.1 films down by about 30 dB and call them verified. 7.1.1 measures them correctly, and the app refuses multichannel loudness work on any build that fails its meter self-test.</p>
            <p class="lead">yt-dlp is downloaded from its stable channel and replaced in place when a new version is out. Every install must match the release's signed SHA-256 list and must start and report its version before it takes over, so a failed update keeps the working copy.</p>
        </div>
        <div class="spec-wrap stick"><table class="spec">
            <thead><tr><th scope="col">System</th><th scope="col">FFmpeg</th><th scope="col">Build</th></tr></thead>
            <tbody>
                <tr><th scope="row">Windows x64 and arm64</th><td class="num">9.0.2</td><td>BtbN GPL build, Gyan full build as the fallback on x64</td></tr>
                <tr><th scope="row">Linux x64 and arm64</th><td class="num">9.0.2</td><td>BtbN GPL build, Martin Riedl as the fallback</td></tr>
                <tr><th scope="row">macOS Intel</th><td class="num">9.0.2</td><td>Martin Riedl</td></tr>
                <tr><th scope="row">macOS Apple Silicon</th><td class="num">7.1.1</td><td>Martin Riedl, held for the surround meter</td></tr>
            </tbody>
        </table></div>
    </div>
</section>

<section class="sec band" aria-labelledby="h-get">
    <div class="wrap close">
        <div>
            <h2 id="h-get">Download molexMedia</h2>
            <p class="lead">Free and open source under the MIT license, for Windows, macOS, and Linux. The Windows and macOS builds update themselves from GitHub Releases.</p>
            <p class="lead">The source code, the issue tracker, and every past release are on <a href="https://github.com/molexxxx/molex-media-electron" rel="noopener">GitHub</a>.</p>
        </div>
        <platform-list></platform-list>
    </div>
</section>`;
    },
});
