import { icon } from '../icons.js';
import { refreshReveals } from '../scroll-animations.js';

$.component('editor-page', {
  mounted() {
    setTimeout(refreshReveals, 80);
  },

  destroyed() {},

  render() {
    return `
<!-- Hero -->
<section class="hero" style="padding-bottom:24px">
  <div class="container hero-content">
    <div class="reveal">
      <div class="hero-nav">
        <a z-link="/features" class="breadcrumb">${icon('arrow-left', 14)} All Features</a>
        <span class="badge badge-blue">Media Editor</span>
      </div>
      <h1>Full NLE <span class="grad">Timeline Editor</span></h1>
      <p class="sub">Multi-track editing with spatial compositing, keyframe animation, 4 trim types, 8 blend modes, and frame-accurate precision.</p>
    </div>
  </div>
</section>

<!-- Editor At a Glance -->
<section class="section section-compact">
  <div class="container">
    <div class="section-heading reveal">
      <h2>Editor at a Glance</h2>
      <p>Professional NLE capabilities in a lightweight desktop app.</p>
    </div>
    <div class="gh-stats-grid reveal" data-parallax data-parallax-speed="0.04">
      <div class="gh-stat-card card"><div class="gh-stat-number">7</div><div class="gh-stat-label">Edit Types</div></div>
      <div class="gh-stat-card card"><div class="gh-stat-number">4</div><div class="gh-stat-label">Trim Types</div></div>
      <div class="gh-stat-card card"><div class="gh-stat-number">8</div><div class="gh-stat-label">Blend Modes</div></div>
      <div class="gh-stat-card card"><div class="gh-stat-number">4</div><div class="gh-stat-label">Easing Curves</div></div>
    </div>
    <div class="highlight-grid stagger" style="margin-top:24px">
      <div class="highlight-item reveal">
        <div class="feat-icon blue">${icon('video', 20)}</div>
        <div class="highlight-text"><h4>Multi-Track Timeline</h4><p>V1/V2 video + A1/A2 audio tracks with drag-to-timeline, snapping, and playhead scrubbing.</p></div>
      </div>
      <div class="highlight-item reveal">
        <div class="feat-icon purple">${icon('maximize', 20)}</div>
        <div class="highlight-text"><h4>Spatial Compositing</h4><p>Position, scale, rotation, anchor, opacity per clip with interactive canvas preview.</p></div>
      </div>
      <div class="highlight-item reveal">
        <div class="feat-icon emerald">${icon('target', 20)}</div>
        <div class="highlight-text"><h4>Keyframe Animation</h4><p>Per-property keyframes with 4 easing curves and binary search lookup.</p></div>
      </div>
      <div class="highlight-item reveal">
        <div class="feat-icon amber">${icon('blend', 20)}</div>
        <div class="highlight-text"><h4>Blend Modes</h4><p>Normal, Multiply, Screen, Overlay, Darken, Lighten, Add, Difference.</p></div>
      </div>
      <div class="highlight-item reveal">
        <div class="feat-icon red">${icon('gif', 20)}</div>
        <div class="highlight-text"><h4>GIF Export</h4><p>Two-pass palette generation. Configurable FPS (1-30), width, and loop count.</p></div>
      </div>
      <div class="highlight-item reveal">
        <div class="feat-icon cyan">${icon('play', 20)}</div>
        <div class="highlight-text"><h4>Real-Time Preview</h4><p>Canvas preview composites all layers with transforms and blend modes as you edit.</p></div>
      </div>
    </div>
  </div>
</section>

<!-- Edit Types -->
<section class="section section-alt">
  <div class="container">
    <div class="section-heading reveal">
      <h2>7 Edit Types</h2>
      <p>Choose the right edit for every situation.</p>
    </div>
    <div class="feat-grid stagger">
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon blue">${icon('layers', 22)}</div>
        <div class="feat-text"><h3>Insert</h3><p>Pushes all downstream clips forward to make room. The default non-destructive edit.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon purple">${icon('columns', 22)}</div>
        <div class="feat-text"><h3>Overwrite</h3><p>Replaces content at the playhead position. Destructive to anything it covers.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon emerald">${icon('move', 22)}</div>
        <div class="feat-text"><h3>Ripple Delete</h3><p>Removes a clip and closes the gap automatically. Keeps the timeline tight.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon amber">${icon('scissors', 22)}</div>
        <div class="feat-text"><h3>Lift</h3><p>Removes without closing the gap - leaves empty space where the clip was.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon cyan">${icon('maximize', 22)}</div>
        <div class="feat-text"><h3>Replace</h3><p>Swaps one clip for another in-place. Duration matches the shorter of the two.</p></div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon red">${icon('crop', 22)}</div>
        <div class="feat-text"><h3>Fit to Fill</h3><p>Speed-changes the source to exactly fill the marked gap on the timeline.</p></div>
      </div>
    </div>
  </div>
</section>

<!-- Trim Types -->
<section class="section">
  <div class="container">
    <div class="section-heading reveal">
      <h2>4 Trim Types</h2>
      <p>Frame-accurate trimming with context-sensitive cursors.</p>
    </div>
    <div class="feat-grid stagger">
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon blue">${icon('move', 22)}</div>
        <div class="feat-text">
          <h3>Roll</h3>
          <p>Moves the cut point between two adjacent clips. Total duration stays the same - one clip grows as the other shrinks.</p>
          <div class="tip"><div class="tip-icon">${icon('lightbulb', 14)}</div><div class="tip-body"><p>Hold <span class="kbd">Shift</span> for single-frame precision.</p></div></div>
        </div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon purple">${icon('scissors', 22)}</div>
        <div class="feat-text">
          <h3>Ripple</h3>
          <p>Extends or shortens a clip and shifts everything downstream. Timeline duration changes with the edit.</p>
          <div class="tip"><div class="tip-icon">${icon('lightbulb', 14)}</div><div class="tip-body"><p>Use <span class="kbd">Alt + [</span> and <span class="kbd">Alt + ]</span> for keyboard ripple trim.</p></div></div>
        </div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon emerald">${icon('maximize', 22)}</div>
        <div class="feat-text">
          <h3>Slip</h3>
          <p>Shifts the source in/out points while keeping the clip's position and duration unchanged. Reveals hidden media.</p>
          <div class="tip"><div class="tip-icon">${icon('lightbulb', 14)}</div><div class="tip-body"><p>Slip is only available when the source has media beyond the visible range.</p></div></div>
        </div>
      </div>
      <div class="card card-glow feat-card reveal">
        <div class="feat-icon amber">${icon('crop', 22)}</div>
        <div class="feat-text">
          <h3>Slide</h3>
          <p>Moves a clip between its neighbors - the neighbors grow or shrink to fill the space. Source stays the same.</p>
          <div class="tip"><div class="tip-icon">${icon('lightbulb', 14)}</div><div class="tip-body"><p>Slide mode uses a special two-arrow cursor to indicate direction.</p></div></div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- Spatial Compositing -->
<section class="section section-alt">
  <div class="container">
    <div class="section-heading reveal">
      <h2>Spatial Compositing</h2>
      <p>Per-clip transform controls with interactive canvas preview.</p>
    </div>
    <div class="grid-2col reveal" style="align-items:center">
      <div>
        <div style="display:flex;flex-direction:column;gap:16px">
          <div class="card" style="padding:16px;display:flex;align-items:center;gap:12px">
            <div class="feat-icon blue">${icon('move', 20)}</div>
            <div><h4 style="font-size:.88rem;font-weight:600">Position</h4><p style="font-size:.78rem;color:var(--text4)">X/Y offset in pixels. Drag on canvas or type values.</p></div>
          </div>
          <div class="card" style="padding:16px;display:flex;align-items:center;gap:12px">
            <div class="feat-icon purple">${icon('maximize', 20)}</div>
            <div><h4 style="font-size:.88rem;font-weight:600">Scale</h4><p style="font-size:.78rem;color:var(--text4)">Uniform or independent X/Y scaling with anchor point.</p></div>
          </div>
          <div class="card" style="padding:16px;display:flex;align-items:center;gap:12px">
            <div class="feat-icon emerald">${icon('rotate-cw', 20)}</div>
            <div><h4 style="font-size:.88rem;font-weight:600">Rotation</h4><p style="font-size:.78rem;color:var(--text4)">Degrees with shortest-path interpolation for keyframes.</p></div>
          </div>
          <div class="card" style="padding:16px;display:flex;align-items:center;gap:12px">
            <div class="feat-icon amber">${icon('eye', 20)}</div>
            <div><h4 style="font-size:.88rem;font-weight:600">Opacity</h4><p style="font-size:.78rem;color:var(--text4)">0-100% blending. Combine with blend modes for effects.</p></div>
          </div>
        </div>
      </div>
      <div class="card" style="padding:0;overflow:hidden;border-color:rgba(124,58,237,0.15)">
        <div style="aspect-ratio:16/9;background:var(--s950);display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden">
          <div style="width:60%;height:60%;border:2px dashed rgba(124,58,237,0.5);border-radius:4px;display:flex;align-items:center;justify-content:center;position:relative;transform:rotate(-3deg)">
            <span style="font-size:.75rem;color:var(--text5);font-weight:500">interview.mp4</span>
            <div style="position:absolute;top:-5px;left:-5px;width:10px;height:10px;border:2px solid var(--a400);border-radius:2px;background:var(--s950)"></div>
            <div style="position:absolute;top:-5px;right:-5px;width:10px;height:10px;border:2px solid var(--a400);border-radius:2px;background:var(--s950)"></div>
            <div style="position:absolute;bottom:-5px;left:-5px;width:10px;height:10px;border:2px solid var(--a400);border-radius:2px;background:var(--s950)"></div>
            <div style="position:absolute;bottom:-5px;right:-5px;width:10px;height:10px;border:2px solid var(--a400);border-radius:2px;background:var(--s950)"></div>
            <div style="position:absolute;top:50%;left:50%;width:8px;height:8px;border-radius:50%;background:var(--a400);transform:translate(-50%,-50%)"></div>
          </div>
        </div>
        <div style="padding:10px 14px;font-size:.72rem;color:var(--text5);border-top:1px solid var(--border);display:flex;gap:16px">
          <span>X: -120</span><span>Y: 40</span><span>Scale: 85%</span><span>Rot: -3.0</span><span>Opacity: 100%</span>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- Keyframes & Blend Modes -->
<section class="section">
  <div class="container">
    <div class="grid-2col">
      <div class="reveal">
        <div style="display:flex;align-items:flex-start;gap:16px">
          <div class="feat-icon purple" style="flex-shrink:0">${icon('target', 22)}</div>
          <div>
            <h3 style="font-size:1.3rem;font-weight:800;margin-bottom:10px">Keyframe Animation</h3>
            <p style="color:var(--text3);font-size:.88rem;line-height:1.65;margin-bottom:16px">Animate any spatial property over time. Set keyframes at specific frames and the engine interpolates the values between them.</p>
            <table class="spec-table">
              <tr><td>Easing</td><td>Linear, Ease-In, Ease-Out, Ease-In-Out</td></tr>
              <tr><td>Rotation</td><td>Shortest-path angle interpolation</td></tr>
              <tr><td>Lookup</td><td>Binary search for O(log n) performance</td></tr>
              <tr><td>Properties</td><td>Position, Scale, Rotation, Opacity</td></tr>
            </table>
          </div>
        </div>
      </div>
      <div class="reveal">
        <div style="display:flex;align-items:flex-start;gap:16px">
          <div class="feat-icon cyan" style="flex-shrink:0">${icon('blend', 22)}</div>
          <div>
            <h3 style="font-size:1.3rem;font-weight:800;margin-bottom:10px">8 Blend Modes</h3>
            <p style="color:var(--text3);font-size:.88rem;line-height:1.65;margin-bottom:16px">Apply compositing blend modes per clip. All modes render on the canvas preview and export identically via FFmpeg filtergraph.</p>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              ${['Normal','Multiply','Screen','Overlay','Darken','Lighten','Add','Difference'].map(m =>
                `<span class="badge badge-accent">${m}</span>`
              ).join('')}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- Keyboard Shortcuts -->
<section class="section section-alt">
  <div class="container">
    <div class="section-heading reveal">
      <div class="feat-icon amber" style="margin:0 auto 16px">${icon('keyboard', 22)}</div>
      <h2>Keyboard Shortcuts</h2>
      <p>Speed up your workflow with these essential shortcuts.</p>
    </div>
    <div class="shortcut-grid">
      <div class="card reveal" style="padding:12px">
        <h4 style="font-size:.78rem;font-weight:700;margin-bottom:8px;color:var(--a300)">Playback</h4>
        <div class="shortcut-row"><span class="kbd">Space</span><span>Play / Pause</span></div>
        <div class="shortcut-row"><span class="kbd">J</span> <span class="kbd">K</span> <span class="kbd">L</span><span>Reverse / Stop / Forward</span></div>
        <div class="shortcut-row"><span class="kbd">,</span> <span class="kbd">.</span><span>Frame back / forward</span></div>
        <div class="shortcut-row"><span class="kbd">Home</span><span>Go to start</span></div>
        <div class="shortcut-row"><span class="kbd">End</span><span>Go to end</span></div>
      </div>
      <div class="card reveal" style="padding:12px">
        <h4 style="font-size:.78rem;font-weight:700;margin-bottom:8px;color:var(--blue)">Editing</h4>
        <div class="shortcut-row"><span class="kbd">V</span><span>Select tool</span></div>
        <div class="shortcut-row"><span class="kbd">C</span><span>Razor tool</span></div>
        <div class="shortcut-row"><span class="kbd">I</span> <span class="kbd">O</span><span>Mark In / Out</span></div>
        <div class="shortcut-row"><span class="kbd">Del</span><span>Ripple delete selection</span></div>
        <div class="shortcut-row"><span class="kbd">Ctrl+Z</span><span>Undo</span></div>
      </div>
      <div class="card reveal" style="padding:12px">
        <h4 style="font-size:.78rem;font-weight:700;margin-bottom:8px;color:var(--emerald)">Timeline</h4>
        <div class="shortcut-row"><span class="kbd">Ctrl+=</span><span>Zoom in</span></div>
        <div class="shortcut-row"><span class="kbd">Ctrl+-</span><span>Zoom out</span></div>
        <div class="shortcut-row"><span class="kbd">Ctrl+Shift+F</span><span>Fit all in view</span></div>
        <div class="shortcut-row"><span class="kbd">Alt+[</span> <span class="kbd">Alt+]</span><span>Ripple trim</span></div>
        <div class="shortcut-row"><span class="kbd">Shift+Drag</span><span>Precision mode</span></div>
      </div>
    </div>
  </div>
</section>

<!-- GIF Export & Tips -->
<section class="section">
  <div class="container">
    <div class="grid-2col">
      <div class="reveal">
        <div style="display:flex;align-items:flex-start;gap:16px">
          <div class="feat-icon red" style="flex-shrink:0">${icon('gif', 22)}</div>
          <div>
            <h3 style="font-size:1.3rem;font-weight:800;margin-bottom:10px">GIF Export</h3>
            <p style="color:var(--text3);font-size:.88rem;line-height:1.65;margin-bottom:16px">Export your timeline as high-quality animated GIFs using a two-pass palette generation pipeline.</p>
            <table class="spec-table">
              <tr><td>Method</td><td>Two-pass palettegen + paletteuse</td></tr>
              <tr><td>FPS</td><td>1 \u2013 30 (configurable)</td></tr>
              <tr><td>Width</td><td>Configurable, height auto-calculated</td></tr>
              <tr><td>Loop</td><td>Infinite or N times</td></tr>
            </table>
          </div>
        </div>
      </div>
      <div class="reveal">
        <div style="display:flex;align-items:flex-start;gap:16px">
          <div class="feat-icon emerald" style="flex-shrink:0">${icon('lightbulb', 22)}</div>
          <div>
            <h3 style="font-size:1.3rem;font-weight:800;margin-bottom:10px">Pro Tips</h3>
            <div style="display:flex;flex-direction:column;gap:10px">
              <div class="tip"><div class="tip-icon">${icon('lightbulb', 14)}</div><div class="tip-body"><h4>Use the Source Bin</h4><p>Add files to the source bin first, then drag them to the timeline. This lets you set in/out points before editing.</p></div></div>
              <div class="tip"><div class="tip-icon">${icon('lightbulb', 14)}</div><div class="tip-body"><h4>Snap to Playhead</h4><p>Clips snap to the playhead and to each other. Hold <span class="kbd">Alt</span> to temporarily disable snapping.</p></div></div>
              <div class="tip"><div class="tip-icon">${icon('lightbulb', 14)}</div><div class="tip-body"><h4>Canvas Preview</h4><p>The canvas preview updates in real-time as you scrub or trim. Use it to verify spatial compositing changes.</p></div></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- CTA -->
<section class="section section-alt" style="text-align:center">
  <div class="container reveal">
    <h2>Ready to edit?</h2>
    <p style="max-width:500px;margin:12px auto 24px;color:var(--s400)">Download Molex Media and start editing your media on a professional timeline.</p>
    <a z-link="/download" class="btn btn-primary" z-to-top>${icon('download', 18)} Download Now</a>
  </div>
</section>`;
  },
});
