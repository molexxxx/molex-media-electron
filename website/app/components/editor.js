import { icon } from '../icons.js';
import { link } from '../parts.js';

const SHORTCUTS = [
    ['Transport', [
        [['Space'], 'Play or pause'],
        [['←', '→'], 'Step one frame'],
        [['Shift', '←', '→'], 'Step ten frames'],
        [['Home', 'End'], 'Go to start or end'],
        [['↑', '↓'], 'Previous or next edit point'],
        [['J', 'K', 'L'], 'Reverse, stop, forward, doubling up to 8x'],
    ]],
    ['Tools and edits', [
        [['V'], 'Select tool'],
        [['T'], 'Trim tool'],
        [['B'], 'Razor tool'],
        [['N'], 'Toggle snap'],
        [['S'], 'Split at the playhead'],
        [['I', 'O'], 'Mark in and out'],
        [[','], 'Insert edit'],
        [['.'], 'Overwrite edit'],
        [['Del'], 'Delete selected clips'],
        [['Shift', 'Del'], 'Ripple delete'],
    ]],
    ['Selection and history', [
        [['Ctrl', 'A'], 'Select all clips'],
        [['Ctrl', 'C'], 'Copy'],
        [['Ctrl', 'X'], 'Cut'],
        [['Ctrl', 'V'], 'Paste'],
        [['Ctrl', 'Z'], 'Undo'],
        [['Ctrl', 'Shift', 'Z'], 'Redo'],
    ]],
    ['View', [
        [['Ctrl', '='], 'Zoom in'],
        [['Ctrl', '−'], 'Zoom out'],
        [['Ctrl', '0'], 'Fit the timeline to the view'],
        [['?'], 'Show every shortcut'],
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
        <p class="crumbs">${link('/features', 'Features')}<span aria-hidden="true">/</span><span>Media Editor</span></p>
        <h1>Media Editor</h1>
        <p class="lead">A multi-track timeline for cutting and layering, a clip mode for quick trims, and an inspector for streams and metadata. Drag across the timeline below, or focus it and use the arrow keys.</p>
        <div class="doc-fig"><tl-demo></tl-demo></div>
    </header>
    <div class="doc">
        <nav class="toc" aria-label="On this page">
            <p class="toc-title">On this page</p>
            <a href="/features/editor#timeline">Timeline and edits</a>
            <a href="/features/editor#trims">Trims</a>
            <a href="/features/editor#compositing">Compositing</a>
            <a href="/features/editor#clip">Clip mode</a>
            <a href="/features/editor#export">Export</a>
            <a href="/features/editor#inspect">Inspect and remux</a>
            <a href="/features/editor#keys">Keyboard shortcuts</a>
        </nav>
        <div>
            <section class="doc-sec" id="timeline" aria-labelledby="h-timeline">
                <h2 id="h-timeline">Timeline and edits</h2>
                <p>Import sources into the bin, drag them onto video or audio tracks, and cut with the Select, Trim, and Razor tools. Snapping pulls clips and trims to neighboring edges, and there are 100 levels of undo.</p>
                <ul class="bullets" style="margin-top:16px">
                    <li><strong>Insert</strong> pushes later clips along the track to make room.</li>
                    <li><strong>Overwrite</strong> replaces whatever sits under the new clip.</li>
                    <li><strong>Append</strong> adds the clip at the end of the track.</li>
                    <li><strong>On Top</strong> places the clip on the next track above, for layering.</li>
                    <li>Split at the playhead, or split at the in and out points.</li>
                    <li>Speed changes above 2x chain FFmpeg's <code>atempo</code> in stages, so no stage skips samples.</li>
                </ul>
            </section>

            <section class="doc-sec" id="trims" aria-labelledby="h-trims">
                <h2 id="h-trims">Trims</h2>
                <p>With the Trim tool, the edge you grab decides the trim.</p>
                <div class="spec-wrap"><table class="spec">
                    <thead><tr><th scope="col">Trim</th><th scope="col">How</th><th scope="col">What moves</th></tr></thead>
                    <tbody>
                        <tr><th scope="row">Roll</th><td>Drag an edit point between two clips</td><td>The cut moves; both clips change length and the track length stays the same.</td></tr>
                        <tr><th scope="row">Ripple</th><td>Drag an edge with no neighbor</td><td>The clip changes length and everything after it shifts.</td></tr>
                        <tr><th scope="row">Slip</th><td><kbd>Alt</kbd> and drag</td><td>The clip's content slides inside its fixed position and length.</td></tr>
                        <tr><th scope="row">Slide</th><td><kbd>Alt</kbd> <kbd>Shift</kbd> and drag</td><td>The clip moves between its neighbors, which trim to fit.</td></tr>
                    </tbody>
                </table></div>
            </section>

            <section class="doc-sec" id="compositing" aria-labelledby="h-compositing">
                <h2 id="h-compositing">Compositing</h2>
                <p>Every clip has position, scale with a uniform lock, rotation, an anchor point, and opacity. Drag the handles in the preview or type values into the transform inspector, and add keyframes to animate any of them.</p>
                <ul class="bullets" style="margin-top:16px">
                    <li>Eight blend modes: Normal, Multiply, Screen, Overlay, Darken, Lighten, Add, and Difference.</li>
                    <li>The preview composites every video layer on a canvas in real time.</li>
                    <li>Export builds the same layers with FFmpeg's overlay and <code>blend</code> filters.</li>
                </ul>
            </section>

            <section class="doc-sec" id="clip" aria-labelledby="h-clip">
                <h2 id="h-clip">Clip mode</h2>
                <p>For a single file, set in and out points and export. Lossless cuts copy the streams and are fast; High, Medium, and Low re-encode for a frame-accurate cut. Clip mode writes MP4, MKV, WebM, WAV, MP3, or GIF.</p>
            </section>

            <section class="doc-sec" id="export" aria-labelledby="h-export">
                <h2 id="h-export">Export</h2>
                <div class="spec-wrap"><table class="spec">
                    <tbody>
                        <tr><th scope="row">Formats</th><td>MP4 (H.264), WebM (VP9), MOV (H.264), MKV (H.264)</td></tr>
                        <tr><th scope="row">Quality</th><td class="num">CRF 28, 23, 18, or 10</td></tr>
                        <tr><th scope="row">Resolution</th><td>Source, 720p, 1080p, or 4K</td></tr>
                        <tr><th scope="row">Range</th><td>The entire timeline, in to out, or the selected clips</td></tr>
                    </tbody>
                </table></div>
            </section>

            <section class="doc-sec" id="inspect" aria-labelledby="h-inspect">
                <h2 id="h-inspect">Inspect and remux</h2>
                <p>Open any file to read what FFprobe sees, then keep or drop streams and edit metadata tags. Saving remuxes with stream copy, so nothing is re-encoded.</p>
                <div class="doc-fig insp" aria-label="Example stream inspector">
                    <div class="insp-stream">
                        <p class="insp-title"><span class="insp-check">${icon('check', 11)}</span>Video · stream #0</p>
                        <dl class="insp-kv"><dt>Codec</dt><dd>hevc (Main 10)</dd><dt>Resolution</dt><dd>3840x2160</dd><dt>Frame rate</dt><dd>23.976 fps</dd><dt>Pixel format</dt><dd>yuv420p10le</dd></dl>
                    </div>
                    <div class="insp-stream">
                        <p class="insp-title"><span class="insp-check">${icon('check', 11)}</span>Audio · stream #1</p>
                        <dl class="insp-kv"><dt>Codec</dt><dd>eac3</dd><dt>Channels</dt><dd>6 (5.1)</dd><dt>Sample rate</dt><dd>48000 Hz</dd><dt>Disposition</dt><dd>default</dd></dl>
                    </div>
                    <div class="insp-stream">
                        <p class="insp-title"><span class="insp-check">${icon('check', 11)}</span>Audio · stream #2</p>
                        <dl class="insp-kv"><dt>Codec</dt><dd>aac (LC)</dd><dt>Channels</dt><dd>2 (stereo)</dd><dt>Title</dt><dd>Commentary</dd></dl>
                    </div>
                    <p class="insp-map">-map 0:0 -map 0:1 -map 0:2 <span>-c copy</span></p>
                </div>
                <p style="margin-top:16px">The inspector also counts I, P, and B frames across the file, so you can see where keyframes land before a fast cut.</p>
            </section>

            <section class="doc-sec" id="keys" aria-labelledby="h-keys">
                <h2 id="h-keys">Keyboard shortcuts</h2>
                <p>Timeline shortcuts, as listed in the editor's own shortcut panel.</p>
                ${keys}
            </section>
        </div>
    </div>
</div>`;
    },
});
