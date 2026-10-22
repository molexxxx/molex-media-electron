import { icon } from './icons.js';

export const MINUS = '−';

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
 * A status word with its icon, in the app's status inks.
 * @param {'ready'|'queued'|'pending'|'analyzing'|'encoding'|'verifying'|'finalizing'|'done'|'warning'|'error'|'info'} status
 * @param {string} word Visible text.
 */
export function statusLabel(status, word)
{
    const glyph = {
        ready: 'pending', queued: 'queued', pending: 'pending',
        analyzing: 'spinner', encoding: 'spinner', verifying: 'spinner', finalizing: 'spinner',
        done: 'done', warning: 'warning', error: 'error', info: 'info',
    }[status] || 'pending';
    const spin = glyph === 'spinner' ? 'spin' : '';
    return `<span class="status" data-status="${status}">${icon(glyph, 14, undefined, spin)}<span>${word}</span></span>`;
}

/**
 * A finished job's stamp: the outcome word and the values measured in its output.
 * @param {'verified'|'returned'} outcome
 * @param {string} values Measured values, already formatted.
 * @param {boolean} [landing] Plays the landing animation once.
 */
export function stamp(outcome, values, landing = false)
{
    const word = outcome === 'verified' ? 'Verified' : 'Returned';
    return `<span class="stamp" data-outcome="${outcome}"${landing ? ' data-landing' : ''}><span>${word}</span><span class="vals">${values}</span></span>`;
}

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
 * Formats seconds as m:ss or h:mm:ss.
 * @param {number} s Seconds.
 */
export function clock(s)
{
    const whole = Math.max(0, Math.floor(s));
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const sec = String(whole % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
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
