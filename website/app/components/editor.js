import { link } from '../parts.js';

const SHORTCUTS = [
    ['Editor', [
        [['Ctrl', 'O'], 'Open a file'],
        [['Ctrl', '1'], 'Trim'],
        [['Ctrl', '2'], 'Timeline'],
        [['Ctrl', '3'], 'Inspect'],
        [['?'], 'Keyboard shortcuts'],
    ]],
    ['Playback', [
        [['Space'], 'Play or pause'],
        [['←', '→'], 'Step one frame'],
        [['Shift', '←', '→'], 'Step ten frames'],
        [['Home', 'End'], 'Go to the start or the end'],
        [['J', 'K', 'L'], 'Play backward, stop, play forward'],
    ]],
    ['Trim', [
        [['I'], 'Mark in at the playhead'],
        [['O'], 'Mark out at the playhead'],
        [['Esc'], 'Reset in and out to the whole file'],
    ]],
    ['Timeline', [
        [['V'], 'Select tool'],
        [['T'], 'Trim tool'],
        [['B'], 'Split tool'],
        [['N'], 'Snap to edges'],
        [['S'], 'Split at the playhead'],
        [['Del'], 'Delete the selected clips'],
        [['Shift', 'Del'], 'Delete and close the gap'],
        [[','], 'Insert the source at the playhead'],
        [['.'], 'Overwrite at the playhead'],
        [['↑', '↓'], 'Previous or next edit point'],
        [['Ctrl', 'A'], 'Select every clip'],
        [['Ctrl', 'Z'], 'Undo'],
        [['Ctrl', 'Shift', 'Z'], 'Redo'],
        [['Ctrl', '='], 'Zoom in'],
        [['Ctrl', '−'], 'Zoom out'],
        [['Ctrl', '0'], 'Fit the timeline to the view'],
    ]],
];

$.component('editor-page', {
    render()
    {
        const keys = SHORTCUTS.map(([group, rows]) => `
            <h3>${group}</h3>
            <dl class="keys">${rows.map(([k, what]) => `<div><dt>${what}</dt><dd>${k.map((x) => `<kbd>${x}</kbd>`).join('')}</dd></div>`).join('')}</dl>`).join('');

        return `
<div class="wrap">
    <header class="page-head">
        <p class="crumbs">${link('/features', 'Features')}<span aria-hidden="true">/</span><span>Editor</span></p>
        <h1>Editor</h1>
        <p class="lead">Three modes under one header: Trim for one file, Timeline for several, and Inspect for what a file holds. Open a file with Ctrl+O, or drop it anywhere on the page.</p>
        <figure class="shot"><img src="assets/screens/editor.webp" width="1440" height="922" alt="The Editor in Trim: a video frame above the In, Out, and Length readouts, a thumbnail strip, and the export panel." loading="lazy"><figcaption>Trim, with the export panel open. Video: Big Buck Bunny, Blender Foundation, CC BY 3.0.</figcaption></figure>
    </header>
    <div class="doc">
        <nav class="toc" aria-label="On this page">
            <p class="toc-title">On this page</p>
            <a href="/features/editor#trim">Trim</a>
            <a href="/features/editor#timeline">Timeline</a>
            <a href="/features/editor#inspect">Inspect</a>
            <a href="/features/editor#keys">Keyboard shortcuts</a>
        </nav>
        <div>
            <section class="doc-sec" id="trim" aria-labelledby="h-trim">
                <h2 id="h-trim">Trim</h2>
                <p>Cut one file between an in and an out point, then export video, audio, or a GIF. In, out, and length are shown in timecode above a thumbnail strip; the playhead steps a frame at a time and the strip scrubs with the pointer.</p>
                <div class="spec-wrap"><table class="spec">
                    <tbody>
                        <tr><th scope="row">Formats</th><td>Video, audio, or GIF, chosen in the export panel</td></tr>
                        <tr><th scope="row">Lossless</th><td>Copies the streams without re-encoding, so the cut lands on the nearest keyframe. MP4 always re-encodes.</td></tr>
                        <tr><th scope="row">Quality</th><td>Re-encodes at the chosen CRF and cuts on the exact frame; audio exports re-encode the audio</td></tr>
                        <tr><th scope="row">GIF</th><td>Width, frame rate, and dither, with more settings folded away</td></tr>
                        <tr><th scope="row">Hardware</th><td>Video encodes with NVENC, Quick Sync, or AMF where the codec allows, when the GPU is on in Settings</td></tr>
                        <tr><th scope="row">Add to timeline</th><td>Sends the cut to the Timeline as a clip instead of exporting it</td></tr>
                    </tbody>
                </table></div>
            </section>

            <section class="doc-sec" id="timeline" aria-labelledby="h-timeline">
                <h2 id="h-timeline">Timeline</h2>
                <p>Arrange clips from several files on video and audio tracks, then export one file. Sources sit in a bin; the Select, Trim, and Split tools cut and move clips, snapping pulls edges together, and every clip has position, scale, rotation, anchor, and opacity that can be keyframed.</p>
                <div class="spec-wrap"><table class="spec">
                    <tbody>
                        <tr><th scope="row">Formats</th><td>MP4 (H.264), WebM (VP9), MOV (H.264), MKV (H.264)</td></tr>
                        <tr><th scope="row">Quality</th><td class="num">Low (CRF 28), Medium (CRF 23), High (CRF 18), Very high (CRF 10)</td></tr>
                        <tr><th scope="row">Audio</th><td class="num">128, 192, 256, or 320 kbps</td></tr>
                        <tr><th scope="row">Frame size</th><td>Source, 720p, 1080p, or 4K</td></tr>
                        <tr><th scope="row">Range</th><td>Whole timeline, in to out, or the selected clips</td></tr>
                        <tr><th scope="row">Speed</th><td>Changes above 2x chain FFmpeg's <code>atempo</code> in stages, so no stage skips samples</td></tr>
                    </tbody>
                </table></div>
            </section>

            <section class="doc-sec" id="inspect" aria-labelledby="h-inspect">
                <h2 id="h-inspect">Inspect</h2>
                <p>See the streams and tags of a file as ffprobe reports them, keep or drop streams, and save a copy without the ones you remove. The copy is remuxed with stream copy, so nothing is re-encoded. The keyframe view shows where I, P, and B frames land, which is where a lossless trim will cut.</p>
            </section>

            <section class="doc-sec" id="keys" aria-labelledby="h-keys">
                <h2 id="h-keys">Keyboard shortcuts</h2>
                <p>As listed in the editor's own shortcut panel. On macOS, Ctrl reads Cmd.</p>
                ${keys}
            </section>
        </div>
    </div>
</div>`;
    },
});
