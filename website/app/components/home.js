import { icon } from '../icons.js';
import { link, stamp, statusLabel, reducedMotion, MINUS } from '../parts.js';

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
            <p class="shot-note">${reducedMotion()
                ? 'A recreation of the app in HTML. Press Start to run the queue, and switch between Batch, Editor, Player, and Logs. File names are examples.'
                : 'A recreation of the app in HTML. The queue runs once when it comes into view, and Run again replays it. Switch between Batch, Editor, Player, and Logs. File names are examples.'}</p>
        </div>
    </div>
    <div class="wrap">
        <div class="steps steps-row">
            <h2>What happens on the first run</h2>
            <ol>
                <li>Run the installer for your system and open molexMedia.</li>
                <li>It uses your FFmpeg when it is 5.1 or newer. Otherwise it downloads a pinned build, checks its size and SHA-256, and self-tests it.</li>
                <li>Drop files on Batch, choose an operation, read the Review, and press Start.</li>
            </ol>
        </div>
    </div>
</section>

<section class="sec band" aria-labelledby="h-batch">
    <div class="wrap split">
        <div>
            <h2 id="h-batch">Batch</h2>
            <p class="lead">Give each file an operation, read the Review, then run the whole queue. Originals stay untouched unless you choose Replace originals, and every finished job is stamped with what was measured in its output.</p>
            <ul class="rows ops-list">
                <li><strong>Normalize</strong><span>To a named standard such as EBU R 128, ATSC A/85, or Apple Podcasts. Measured with ebur128, then a planned gain and a true-peak limiter oversampled 2x.</span></li>
                <li><strong>Gain</strong><span>Plain gain in dB with an optional high-pass filter, limited at ${MINUS}1.0 dBTP.</span></li>
                <li><strong>Convert</strong><span>28 presets, from MP4 and MKV to ProRes, FFV1, and audio-only formats, or your own settings.</span></li>
                <li><strong>Compress</strong><span>x264, x265, VP9, AOM AV1, or SVT-AV1 by quality tier, exact CRF, or target size. NVENC, Quick Sync, and AMF take H.264 and HEVC when the GPU is on.</span></li>
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
            <p><strong>Verified</strong> means the output was measured again after encoding and sits inside the standard's tolerance.</p>
            <p><strong>Returned</strong> means it does not. The reason is shown, and the job waits for your decision instead of being called finished.</p>
            <p>LKFS and LUFS are the same unit. Each value is shown in the unit its standard is written in.</p>
        </div>
    </div>
</section>

<section class="sec" aria-labelledby="h-editor">
    <div class="wrap split">
        <div>
            <h2 id="h-editor">Editor</h2>
            <p class="lead">Trim, Timeline, and Inspect under one header, switched with the tabs or Ctrl+1 to Ctrl+3.</p>
            <ul class="rows">
                <li><strong>Trim</strong><span>Cut between an in and an out point, then export video, audio, or a GIF. A lossless cut copies the streams and lands on the nearest keyframe; a CRF re-encode cuts on the exact frame.</span></li>
                <li><strong>Timeline</strong><span>Arrange clips from several files on video and audio tracks, then export one MP4, WebM, MOV, or MKV.</span></li>
                <li><strong>Inspect</strong><span>See every stream and tag, and save a copy without the ones you remove. Nothing is re-encoded.</span></li>
            </ul>
            <p class="more-link">${link('/features/editor', `Export settings and every shortcut ${icon('arrow', 16)}`)}</p>
        </div>
        <figure class="shot"><img src="assets/screens/editor.webp" width="1440" height="922" alt="The Editor in Trim: a video frame above the In, Out, and Length readouts, a thumbnail strip, and the export panel." loading="lazy"><figcaption>Trim, with the export panel open. Video: Big Buck Bunny, Blender Foundation, CC BY 3.0.</figcaption></figure>
    </div>
</section>

<section class="sec band" aria-labelledby="h-player">
    <div class="wrap split split-flip">
        <div>
            <h2 id="h-player">Player</h2>
            <p class="lead">Drop audio or video files anywhere on the page, or add a link. Links play through yt-dlp, which molexMedia keeps current.</p>
            <ul class="rows">
                <li><strong>Video</strong><span>Subtitle and audio track menus on the transport, and real full screen on F11 or a double-click.</span></li>
                <li><strong>Visualization</strong><span>Eight canvas visualizations drawn from the audio. The Show control switches between them and the picture.</span></li>
                <li><strong>Links</strong><span>A video, a playlist, or a direct link to a media file, with sound and picture quality chosen per link.</span></li>
                <li><strong>Pop out</strong><span>A small window that stays on top, with its own transport. Playback continues where it was.</span></li>
            </ul>
            <p class="more-link">${link('/features/player', `Sources, shortcuts, and the pop-out ${icon('arrow', 16)}`)}</p>
        </div>
        <figure class="shot"><img src="assets/screens/player.webp" width="1440" height="922" alt="The Player showing a video with the playlist beside it and the transport below." loading="lazy"><figcaption>The Player with the playlist shown. Video: Big Buck Bunny, Blender Foundation, CC BY 3.0.</figcaption></figure>
    </div>
</section>

<section class="sec" aria-labelledby="h-under">
    <div class="wrap split">
        <div>
            <h2 id="h-under">What runs underneath</h2>
            <p class="lead">molexMedia does not bundle FFmpeg. It uses yours when it is version 5.1 or newer, and otherwise downloads a build pinned by version, size, and SHA-256, verifies it before extracting it, and self-tests it before use.</p>
            <p class="lead">On Apple Silicon the pin is held at FFmpeg 7.1.1. The arm64 builds of 8.0 through 9.0.2 read surround loudness up to 33 LU too loud, which would turn 5.1 films down by about 30 dB and still call them verified.</p>
            <p class="lead">yt-dlp comes from its stable channel. An update takes over only after it matches the release's signed SHA-256 list and reports its version, so a failed update keeps the working copy.</p>
        </div>
        <div class="stick"><div class="spec-wrap"><table class="spec">
            <thead><tr><th scope="col">System</th><th scope="col">FFmpeg</th><th scope="col">Build</th></tr></thead>
            <tbody>
                <tr><th scope="row">Windows x64 and arm64</th><td class="num">9.0.2</td><td>BtbN GPL build, Gyan full build as the fallback on x64</td></tr>
                <tr><th scope="row">Linux x64 and arm64</th><td class="num">9.0.2</td><td>BtbN GPL build, Martin Riedl as the fallback</td></tr>
                <tr><th scope="row">macOS Intel</th><td class="num">9.0.2</td><td>Martin Riedl</td></tr>
                <tr><th scope="row">macOS Apple Silicon</th><td class="num">7.1.1</td><td>Martin Riedl, held for the surround meter</td></tr>
            </tbody>
        </table></div>
        <p class="spec-note">The Windows and Linux installers are x64 and use the x64 builds. The arm64 builds apply when molexMedia is built from source for arm64.</p></div>
    </div>
</section>

<section class="sec band" aria-labelledby="h-get">
    <div class="wrap close">
        <div>
            <h2 id="h-get">Download molexMedia</h2>
            <p class="lead">Free and open source under the MIT license, for Windows, macOS, and Linux. The Windows and macOS builds update themselves from GitHub Releases. The source code, the issue tracker, and every past release are on <a href="https://github.com/molexxxx/molex-media-toolkit" rel="noopener">GitHub</a>.</p>
        </div>
        <platform-list></platform-list>
    </div>
</section>`;
    },
});
