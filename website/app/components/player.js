import { link } from '../parts.js';

const VISUALS = ['DMT', 'Space', 'Milkdrop', 'Plasma', 'Bars', 'Waveform', 'Horizon', 'Rain'];

$.component('player-page', {
    render()
    {
        return `
<div class="wrap">
    <header class="page-head">
        <p class="crumbs">${link('/features', 'Features')}<span aria-hidden="true">/</span><span>Media Player</span></p>
        <h1>Media Player</h1>
        <p class="lead">Plays local files and streams YouTube and direct audio links, with eight real-time visualizations. The Bars demo below is driven by a generated signal, not real audio.</p>
        <div class="doc-fig"><viz-demo></viz-demo></div>
    </header>
    <div class="doc">
        <nav class="toc" aria-label="On this page">
            <p class="toc-title">On this page</p>
            <a href="/features/player#sources">Sources</a>
            <a href="/features/player#visuals">Visualizations</a>
            <a href="/features/player#playlist">Playlist</a>
            <a href="/features/player#popout">Popout player</a>
        </nav>
        <div>
            <section class="doc-sec" id="sources" aria-labelledby="h-sources">
                <h2 id="h-sources">Sources</h2>
                <ul class="bullets" style="margin-top:16px">
                    <li><strong>Local files.</strong> Drop files or folders, or browse with the built-in folder browser and its shortcuts to your system folders. Files over 2 GiB play normally.</li>
                    <li><strong>YouTube.</strong> Paste a video, a Short, a live stream, or a playlist. Links resolve through yt-dlp, which molexMedia downloads the first time you paste a URL.</li>
                    <li><strong>Direct links.</strong> Any other URL is added as a direct audio stream.</li>
                    <li><strong>Quality.</strong> Best, Good, or Low for YouTube audio. Good caps the stream at 160 kbps.</li>
                    <li><strong>Resilience.</strong> Expired stream links are retried automatically, and browser cookies can be used for videos that need a signed-in account.</li>
                    <li><strong>History.</strong> The last 50 URLs you played are kept with their titles and track counts.</li>
                </ul>
            </section>

            <section class="doc-sec" id="visuals" aria-labelledby="h-visuals">
                <h2 id="h-visuals">Visualizations</h2>
                <p>Each visualization is drawn on a canvas from the Web Audio API. Beat detection splits the spectrum into six bands aligned to the Bark scale and applies A-weighting.</p>
                <div class="spec-wrap"><table class="spec">
                    <thead><tr><th scope="col">Band</th><th scope="col">Range</th><th scope="col">Typical content</th></tr></thead>
                    <tbody>
                        <tr><th scope="row">Sub</th><td class="num">20-60 Hz</td><td>Sub-bass rumble</td></tr>
                        <tr><th scope="row">Bass</th><td class="num">60-250 Hz</td><td>Kick drum, bass guitar</td></tr>
                        <tr><th scope="row">Low mid</th><td class="num">250-500 Hz</td><td>Low vocals, guitar body</td></tr>
                        <tr><th scope="row">Mid</th><td class="num">500 Hz-2 kHz</td><td>Vocals, snare</td></tr>
                        <tr><th scope="row">High mid</th><td class="num">2-6 kHz</td><td>Clarity, hi-hat</td></tr>
                        <tr><th scope="row">Treble</th><td class="num">6-20 kHz</td><td>Cymbals, air</td></tr>
                    </tbody>
                </table></div>
                <h3>The eight visualizations</h3>
                <p>${VISUALS.join(', ')}.</p>
            </section>

            <section class="doc-sec" id="playlist" aria-labelledby="h-playlist">
                <h2 id="h-playlist">Playlist</h2>
                <ul class="bullets" style="margin-top:16px">
                    <li>Drag to reorder, shuffle, and repeat off, all, or one.</li>
                    <li>The playing track is marked and kept in view as the list scrolls.</li>
                    <li>A track that fails to play is skipped; playback stops after repeated failures instead of looping.</li>
                    <li>A custom seek bar, previous and next, and a volume slider with mute.</li>
                </ul>
            </section>

            <section class="doc-sec" id="popout" aria-labelledby="h-popout">
                <h2 id="h-popout">Popout player</h2>
                <p>The popout moves the player into its own always-on-top window with compact transport controls. Playback continues from where it was.</p>
                <div class="spec-wrap"><table class="spec">
                    <tbody>
                        <tr><th scope="row">Small</th><td class="num">360x480</td></tr>
                        <tr><th scope="row">Medium</th><td class="num">420x560</td></tr>
                        <tr><th scope="row">Large</th><td class="num">560x680</td></tr>
                        <tr><th scope="row">Custom</th><td>Resize the window and save the current size</td></tr>
                    </tbody>
                </table></div>
            </section>
        </div>
    </div>
</div>`;
    },
});
