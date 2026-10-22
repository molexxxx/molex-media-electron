import { link } from '../parts.js';

const VISUALS = ['DMT', 'Space', 'Milkdrop', 'Plasma', 'Bars', 'Waveform', 'Horizon', 'Rain'];

const SHORTCUTS = [
    ['Playback', [
        [['Space'], 'Play or pause'],
        [['←', '→'], 'Back or ahead 5 seconds'],
        [['Shift', '←', '→'], 'Back or ahead 30 seconds'],
        [['↑', '↓'], 'Volume up or down'],
        [['M'], 'Mute or unmute'],
        [['N', 'P'], 'Next or previous track'],
        [['S'], 'Shuffle'],
        [['R'], 'Repeat: off, all, this track'],
    ]],
    ['View', [
        [['B'], 'Video or visualization'],
        [['V', 'Shift', 'V'], 'Next or previous visualization'],
        [['F11'], 'Full screen, or double-click the picture'],
        [['Ctrl', 'U'], 'Add a link'],
        [['F1'], 'Keyboard shortcuts'],
    ]],
];

$.component('player-page', {
    render()
    {
        const keys = SHORTCUTS.map(([group, rows]) => `
            <h3>${group}</h3>
            <dl class="keys">${rows.map(([k, what]) => `<div><dt>${what}</dt><dd>${k.map((x) => `<kbd>${x}</kbd>`).join('')}</dd></div>`).join('')}</dl>`).join('');

        return `
<div class="wrap">
    <header class="page-head">
        <p class="crumbs">${link('/features', 'Features')}<span aria-hidden="true">/</span><span>Player</span></p>
        <h1>Player</h1>
        <p class="lead">Plays local files and links, with the picture when there is one and a visualization when there is not. Keyboard media keys play, pause, and skip.</p>
        <figure class="shot"><img src="assets/screens/player.webp" width="1440" height="922" alt="The Player showing a video with the playlist beside it and the transport below." loading="lazy"><figcaption>The Player with the playlist shown. Video: Big Buck Bunny, Blender Foundation, CC BY 3.0.</figcaption></figure>
    </header>
    <div class="doc">
        <nav class="toc" aria-label="On this page">
            <p class="toc-title">On this page</p>
            <a href="/features/player#sources">Sources</a>
            <a href="/features/player#video">Video and full screen</a>
            <a href="/features/player#visuals">Visualizations</a>
            <a href="/features/player#popout">Pop-out window</a>
            <a href="/features/player#keys">Keyboard shortcuts</a>
        </nav>
        <div>
            <section class="doc-sec" id="sources" aria-labelledby="h-sources">
                <h2 id="h-sources">Sources</h2>
                <ul class="bullets" style="margin-top:16px">
                    <li><strong>Files and folders.</strong> Drop audio or video files anywhere on the page, or add files and folders from the toolbar. A folder adds the media it holds.</li>
                    <li><strong>Links.</strong> A video, a playlist, or a direct link to a media file. Links resolve through yt-dlp, from YouTube and many other sites. Recent links are kept and can be forgotten.</li>
                    <li><strong>Quality.</strong> Sound and picture quality are chosen per link in the player's menu. A stream that cannot be played directly is downloaded first, and the player says so.</li>
                    <li><strong>yt-dlp.</strong> molexMedia installs and updates its own copy from yt-dlp's stable channel, checking the release's signed SHA-256 list before a new version takes over. A yt-dlp already on your computer can be used instead, and is then left to the tool that installed it.</li>
                    <li><strong>HEVC and other codecs</strong> that the window cannot decode take a route through FFmpeg, so the file still plays.</li>
                </ul>
            </section>

            <section class="doc-sec" id="video" aria-labelledby="h-video">
                <h2 id="h-video">Video and full screen</h2>
                <p>The Show control switches between the picture and the visualization. The transport carries the seek bar, the title and its facts, play, previous, next, shuffle and repeat, the audio track and subtitle menus, volume, and full screen.</p>
                <ul class="bullets" style="margin-top:16px">
                    <li>Full screen is the real window state on F11 or a double-click, not a stretched element.</li>
                    <li>Text subtitles are drawn over the picture; the track is chosen from the transport.</li>
                    <li>A track with several audio streams lists them by language and title.</li>
                </ul>
            </section>

            <section class="doc-sec" id="visuals" aria-labelledby="h-visuals">
                <h2 id="h-visuals">Visualizations</h2>
                <p>Eight visualizations drawn on a canvas from the Web Audio API, chosen from the toolbar or stepped with V. ${VISUALS.join(', ')}.</p>
            </section>

            <section class="doc-sec" id="popout" aria-labelledby="h-popout">
                <h2 id="h-popout">Pop-out window</h2>
                <p>Pop out moves the player into a small window that stays on top of other windows, with the title, the seek bar, and a compact transport. Playback continues where it was, and Back to the app brings the player back into the main window.</p>
            </section>

            <section class="doc-sec" id="keys" aria-labelledby="h-keys">
                <h2 id="h-keys">Keyboard shortcuts</h2>
                <p>As listed in the player's own shortcut panel. On macOS, Ctrl reads Cmd.</p>
                ${keys}
            </section>
        </div>
    </div>
</div>`;
    },
});
