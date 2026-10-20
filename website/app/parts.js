import { icon } from './icons.js';

export const OPS = {
    normalize: 'Normalize',
    boost: 'Boost',
    convert: 'Convert',
    compress: 'Compress',
    extract: 'Extract',
};

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Operation chip in the app's colors.
 * @param {keyof OPS} op Operation id.
 * @param {string} [label] Override for the visible label.
 */
export function opChip(op, label)
{
    return `<span class="op" data-op="${op}">${icon(op, 12)}${label || OPS[op]}</span>`;
}

/**
 * Internal SPA link with a real href so it works without JavaScript and with modifier keys.
 * @param {string} path Route path.
 * @param {string} html Link content.
 * @param {string} [cls] Class list.
 */
export function link(path, html, cls = '')
{
    return `<a href="${path}" z-link="${path}" z-to-top${cls ? ` class="${cls}"` : ''}>${html}</a>`;
}

/**
 * Wraps FFmpeg flags in spans so the command reads like the app's log viewer.
 * @param {string} cmd Command line.
 */
export function highlight(cmd)
{
    return $.escapeHtml(cmd).replace(/(^|\s)(-[a-z][\w:.]*)/gi, '$1<span class="arg">$2</span>');
}

/**
 * One line in the recreated log viewer.
 * @param {string} time Timestamp.
 * @param {'INF'|'OK'|'FF'|'WRN'} level Log level tag.
 * @param {string} text Plain text, or an FFmpeg command when level is FF.
 */
export function logLine(time, level, text)
{
    const body = level === 'FF' ? `[CMD] ${highlight(text)}` : $.escapeHtml(text);
    return `<li class="ll"><time>${time}</time><b class="lv" data-lv="${level}">${level}</b><code>${body}</code></li>`;
}

export const NORMALIZE_LOG = [
    ['12:41:15', 'INF', 'Normalizing interview-cam-a.mkv, pass 1 of 2 (analysis)'],
    ['12:41:15', 'FF', 'ffmpeg -i interview-cam-a.mkv -threads 0 -map 0:a:0 -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null -'],
    ['12:41:52', 'INF', 'Measured: input_i -20.0, input_tp -3.0, input_lra 8.0, input_thresh -30.0, target_offset 4.0'],
    ['12:41:52', 'FF', 'ffmpeg -y -analyzeduration 200M -probesize 200M -i interview-cam-a.mkv -threads 0 -filter_complex [0:a:0]loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-20.0:measured_TP=-3.0:measured_LRA=8.0:measured_thresh=-30.0:offset=4.0,aresample=48000[a0] -map 0:v -map 0:s? -map [a0] -metadata:s:a:0 "title=[molexMedia Normalized] Main" -c:a:0 aac -b:a:0 256k -c:v copy -c:s copy interview-cam-a.normalized.mkv'],
    ['12:43:10', 'OK', 'interview-cam-a.mkv normalized to -16 LUFS'],
];

export const CONVERT_LOG = [
    ['12:44:02', 'INF', 'Converting lecture-03.mkv to MP4: 1 video, 3 audio, 2 text subtitle streams (encoder arguments shortened)'],
    ['12:44:02', 'FF', 'ffmpeg -i lecture-03.mkv -map 0:v? -map 0:a? -map 0:s:0? -map 0:s:1? … -c:s mov_text lecture-03.mp4'],
    ['12:46:31', 'OK', 'lecture-03.mp4 written with 3 audio and 2 subtitle tracks'],
];

/**
 * Deterministic waveform drawn as vertical strokes, for audio clips on the timeline.
 * @param {number} [seed=1] Varies the shape between clips.
 */
export function waveform(seed = 1)
{
    let d = '';
    for (let i = 0; i < 160; i++)
    {
        const env = 0.35 + 0.65 * Math.abs(Math.sin(i * 0.045 * seed + seed));
        const amp = env * (0.35 + 0.65 * Math.abs(Math.sin(i * 1.7 + seed * 3) * Math.cos(i * 0.31 + seed)));
        const h = Math.max(0.6, amp * 9.5);
        d += `M${i + 0.5} ${10 - h}V${10 + h}`;
    }
    return `<svg viewBox="0 0 160 20" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" stroke="currentColor" stroke-width="0.6" fill="none"/></svg>`;
}

export const TIMELINE = {
    seconds: 240,
    fps: 30,
    tracks: [
        { id: 'V2', icons: ['eye', 'lock'], clips: [{ kind: 'overlay', name: 'lower-third.mov', from: 0.2, to: 0.52, keys: [0.03, 0.5, 0.97] }] },
        {
            id: 'V1',
            icons: ['eye', 'lock'],
            clips: [
                { kind: 'video', name: 'interview-cam-a.mkv', from: 0, to: 0.47 },
                { kind: 'video', name: 'harbor-b-roll.mp4', from: 0.47, to: 0.79 },
                { kind: 'video', name: 'interview-cam-a.mkv', from: 0.79, to: 0.96 },
            ],
        },
        { id: 'A1', icons: ['lock'], clips: [{ kind: 'audio', name: 'score-draft-2.wav', from: 0.08, to: 0.92, seed: 2 }] },
    ],
};

/**
 * Formats seconds as the editor's HH:MM:SS:FF timecode.
 * @param {number} s Seconds.
 * @param {number} [fps=30] Frame rate.
 */
export function timecode(s, fps = 30)
{
    const total = Math.round(s * fps);
    const f = total % fps;
    const sec = Math.floor(total / fps);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}:${pad(f)}`;
}

/**
 * Timeline lanes, ruler, and clips. The playhead position is a 0 to 1 fraction.
 * @param {{ph: number, compact?: boolean}} opts
 */
export function timelineLanes({ ph, compact = false })
{
    const steps = compact ? 4 : 8;
    const ruler = Array.from({ length: steps }, (_, i) =>
    {
        const at = i / steps;
        return `<span style="left:${at * 100}%">${timecode(at * TIMELINE.seconds).slice(0, 8)}</span>`;
    }).join('');

    const lanes = TIMELINE.tracks.map((t) =>
    {
        const clips = t.clips.map((c) =>
        {
            const style = `left:${c.from * 100}%;width:calc(${(c.to - c.from) * 100}% - 2px)`;
            const keys = (c.keys || []).map((k) => `<span class="clip-key" style="left:${k * 100}%" aria-hidden="true"></span>`).join('');
            const wave = c.kind === 'audio' ? waveform(c.seed) : '';
            return `<div class="clip clip-${c.kind}" style="${style}"><span class="clip-label">${c.name}</span>${wave}${keys}</div>`;
        }).join('');
        return `<div class="tl-lane">${clips}</div>`;
    }).join('');

    return `<div class="tl-ruler" aria-hidden="true">${ruler}</div>${lanes}<div class="tl-playhead" style="--ph:${ph * 100}%" aria-hidden="true"></div>`;
}

export function timelineHeads()
{
    const heads = TIMELINE.tracks.map((t) =>
        `<div class="tl-head">${t.id}${t.icons.map((i) => icon(i, 12)).join('')}</div>`).join('');
    return `<div class="tl-heads" aria-hidden="true"><div></div>${heads}</div>`;
}

export function timelineTools(compact = false)
{
    const keys = compact ? '' : `<div class="tl-keys"><span><kbd>J</kbd><kbd>K</kbd><kbd>L</kbd> shuttle</span><span><kbd>S</kbd> split</span><span><kbd>Space</kbd> play</span></div>`;
    return `<div class="tl-tools" aria-hidden="true">
        <div class="tl-seg"><span class="tl-btn" aria-pressed="true">${icon('pointer', 12)}Select</span><span class="tl-btn">Trim</span><span class="tl-btn">${icon('editor', 12)}Razor</span></div>
        <div class="tl-seg"><span class="tl-btn">Insert</span><span class="tl-btn">Overwrite</span><span class="tl-btn">Append</span><span class="tl-btn">On Top</span></div>
        <div class="tl-seg"><span class="tl-btn" aria-pressed="true">Snap ${icon('check', 12)}</span></div>
        ${keys}
    </div>`;
}

/**
 * Error or notice block with optional actions.
 * @param {string} title Bold first line.
 * @param {string} body Explanation.
 * @param {string} [actions] Action markup.
 */
export function notice(title, body, actions = '')
{
    return `<div class="state" data-kind="error" role="status">${icon('alert', 18)}<div><strong>${title}</strong> ${body}${actions ? `<div class="state-actions">${actions}</div>` : ''}</div></div>`;
}
