const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

export const API_BASE = isLocal ? 'http://localhost:3610' : 'https://media-api.molex.cloud';
export const REPO = 'https://github.com/molexxxx/molex-media-electron';
export const RELEASES_URL = `${REPO}/releases`;
export const LATEST_URL = `${REPO}/releases/latest`;
const CHANGELOG_URL = 'https://raw.githubusercontent.com/molexxxx/molex-media-electron/main/CHANGELOG.md';

export const store = $.store('app', {
    state: {
        releases: [],
        status: 'idle',
        notes: {},
        notesStatus: 'idle',
    },
    actions: {
        setReleases(state, list)
        {
            state.releases = list;
        },
        setStatus(state, status)
        {
            state.status = status;
        },
        setNotes(state, notes)
        {
            state.notes = notes;
        },
        setNotesStatus(state, status)
        {
            state.notesStatus = status;
        },
    },
    getters: {
        published(state)
        {
            return state.releases.filter((r) => !r.draft && !r.prerelease);
        },
        latest(state)
        {
            return state.releases.find((r) => !r.draft && !r.prerelease) || null;
        },
    },
});

/**
 * Loads the cached GitHub releases from website-api once, or again when forced.
 * @param {boolean} [force=false] Reload even after a successful or failed load.
 */
export async function loadReleases(force = false)
{
    const { status } = store.state;
    if (!force && (status === 'loading' || status === 'ready'))
    {
        return;
    }
    store.dispatch('setStatus', 'loading');
    try
    {
        const res = await $.get('/releases');
        if (Array.isArray(res.data))
        {
            store.dispatch('setReleases', res.data);
            store.dispatch('setStatus', 'ready');
        }
        else
        {
            store.dispatch('setStatus', 'error');
        }
    }
    catch
    {
        store.dispatch('setStatus', 'error');
    }
}

/**
 * Loads CHANGELOG.md from the repository and indexes its entries by version.
 * @param {boolean} [force=false] Reload even after a previous attempt.
 */
export async function loadNotes(force = false)
{
    const { notesStatus } = store.state;
    if (!force && (notesStatus === 'loading' || notesStatus === 'ready'))
    {
        return;
    }
    store.dispatch('setNotesStatus', 'loading');
    try
    {
        const res = await fetch(CHANGELOG_URL, { cache: 'no-cache' });
        if (!res.ok)
        {
            throw new Error(`HTTP ${res.status}`);
        }
        store.dispatch('setNotes', parseChangelog(await res.text()));
        store.dispatch('setNotesStatus', 'ready');
    }
    catch
    {
        store.dispatch('setNotesStatus', 'error');
    }
}

/**
 * Splits CHANGELOG.md into entries keyed by version. A version can carry several entries.
 * @param {string} text Raw markdown.
 * @returns {Record<string, {date: string|null, title: string, body: string}[]>}
 */
export function parseChangelog(text)
{
    const out = {};
    const head = /^## \[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?(?:\s*-\s*(.+))?\s*$/;
    let current = null;
    for (const line of text.split(/\r?\n/))
    {
        const m = line.match(head);
        if (m)
        {
            current = { date: m[2] || null, title: (m[3] || '').trim(), lines: [] };
            (out[m[1]] = out[m[1]] || []).push(current);
        }
        else if (current)
        {
            current.lines.push(line);
        }
    }
    for (const list of Object.values(out))
    {
        for (const entry of list)
        {
            entry.body = entry.lines.join('\n').trim();
            delete entry.lines;
        }
    }
    return out;
}

/**
 * Picks the installer assets out of a release, ignoring updater metadata and blockmaps.
 * @param {object|null} release GitHub release object.
 * @returns {{windows: object|null, mac: object|null, deb: object|null, rpm: object|null}}
 */
export function installers(release)
{
    const assets = release?.assets || [];
    const find = (ext) => assets.find((a) => a.name.toLowerCase().endsWith(ext)) || null;
    return { windows: find('.exe'), mac: find('.dmg'), deb: find('.deb'), rpm: find('.rpm') };
}

/**
 * Guesses the visitor's desktop platform from the user agent.
 * @returns {'windows'|'mac'|'linux'|'mobile'|'unknown'}
 */
export function detectPlatform()
{
    const ua = navigator.userAgent || '';
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    const touchMac = /Mac/i.test(platform) && navigator.maxTouchPoints > 1;
    if (/Android|iPhone|iPad|iPod/i.test(ua) || touchMac)
    {
        return 'mobile';
    }
    if (/Win/i.test(platform) || /Windows/i.test(ua))
    {
        return 'windows';
    }
    if (/Mac/i.test(platform) || /Mac OS X/i.test(ua))
    {
        return 'mac';
    }
    if (/Linux|X11|CrOS/i.test(platform) || /Linux|X11/i.test(ua))
    {
        return 'linux';
    }
    return 'unknown';
}

/**
 * Prefers the rpm package on distributions that identify themselves as rpm-based.
 * @returns {'deb'|'rpm'}
 */
export function linuxPackage()
{
    return /Fedora|Red Hat|RHEL|CentOS|openSUSE|SUSE/i.test(navigator.userAgent || '') ? 'rpm' : 'deb';
}

const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';
const CP437_BYTE = new Map([...CP437_HIGH].map((c, i) => [c, 0x80 + i]));
/**
 * Repairs UTF-8 text that was decoded as code page 437 when some release notes were generated.
 * Runs that do not form valid UTF-8 are left untouched.
 * @param {string} text Possibly garbled text.
 * @returns {string}
 */
export function repairText(text)
{
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const decode = (chars) =>
    {
        try
        {
            return decoder.decode(Uint8Array.from(chars.map((c) => CP437_BYTE.get(c))));
        }
        catch
        {
            return chars.join('');
        }
    };
    let out = '';
    let run = [];
    for (const c of text || '')
    {
        if (CP437_BYTE.has(c))
        {
            run.push(c);
            continue;
        }
        out += run.length > 1 ? decode(run) : run.join('');
        run = [];
        out += c;
    }
    return out + (run.length > 1 ? decode(run) : run.join(''));
}

const CHORE = /\b(tests?|testing|ci|lint|eslint|ts\d{4}|unused|typecheck|bump|pin|pinned|dependabot|deps?|dependencies|readme|badge)\b|@[\w-]+\//i;

/**
 * One-line summary for a generated release note: the first feature, else the first fix,
 * skipping test, CI, lint, and dependency housekeeping unless nothing else exists.
 * @param {string} body Release body markdown from GitHub.
 * @returns {string} Plain text.
 */
export function releaseSummary(body)
{
    const items = [];
    let section = '';
    for (const line of repairText(body).split(/\r?\n/))
    {
        const heading = line.match(/^#{3,4}\s+(.+)$/);
        if (heading)
        {
            section = heading[1].replace(/[^\p{L}\s]/gu, '').trim().toLowerCase();
            continue;
        }
        const item = line.match(/^[-*]\s+(.+)$/);
        if (item)
        {
            items.push({ section, text: item[1] });
        }
    }
    const clean = (t) => t
        .replace(/\s*\(\[[0-9a-f]{7,}\]\([^)]*\)\)/gi, '')
        .replace(/\s*\(#\d+\)/g, '')
        .replace(/^\*\*[^*]+:\*\*\s*/, '')
        .replace(/\*\*|\x60/g, '')
        .replace(/^v?\d+(?:\.\d+)+\s*(?:[-:\u2014]\s*)?/i, '')
        .replace(/\s+\u2014\s+/g, ': ')
        .trim();
    const useful = items.filter((i) => !CHORE.test(i.text) && !/depend|misc|doc|chore|style|test|ci/.test(i.section));
    const pick = useful.find((i) => i.section.includes('feature'))
        || useful.find((i) => i.section.includes('fix'))
        || useful[0];
    let text = pick ? clean(pick.text) : '';
    if (!pick && items[0])
    {
        const chore = clean(items[0].text);
        text = /^initial commit$/i.test(chore)
            ? 'Initial release'
            : chore ? `Maintenance: ${chore.charAt(0).toLowerCase()}${chore.slice(1)}` : '';
    }
    if (!text)
    {
        text = clean(repairText(body).replace(/^#.*$/gm, '').split(/\n\s*\n/).map((p) => p.trim()).find(Boolean) || '');
    }
    if (!text)
    {
        return 'See the release on GitHub';
    }
    text = text.charAt(0).toUpperCase() + text.slice(1);
    if (text.length > 84)
    {
        text = `${text.slice(0, text.lastIndexOf(' ', 80))}\u2026`;
    }
    return text;
}

export const fmt = {
    version(release)
    {
        return (release?.tag_name || '').replace(/^v/i, '');
    },
    date(iso)
    {
        if (!iso)
        {
            return '';
        }
        const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
        return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
    },
    bytes(n)
    {
        if (!n)
        {
            return '';
        }
        const units = ['B', 'KB', 'MB', 'GB'];
        const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
        return `${(n / 1024 ** i).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
    },
};

/**
 * Renders the subset of markdown used by CHANGELOG.md and generated release notes.
 * @param {string} src Markdown source.
 * @returns {string} Escaped HTML.
 */
export function markdown(src)
{
    src = repairText(src);
    const inline = (s) => $.escapeHtml(s)
        .replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>')
        .replace(/\p{Extended_Pictographic}️?\s*/gu, '');

    const out = [];
    let list = null;
    let para = null;
    let skip = false;

    const flush = () =>
    {
        if (para)
        {
            out.push(`<p>${inline(para.join(' '))}</p>`);
            para = null;
        }
        if (list)
        {
            out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
            list = null;
        }
    };

    for (const raw of src.split(/\r?\n/))
    {
        const line = raw.replace(/\s+$/, '');
        const heading = line.match(/^(#{2,4})\s+(.+)$/);
        if (heading)
        {
            flush();
            const text = heading[2].trim();
            if (heading[1] === '##')
            {
                skip = false;
                continue;
            }
            skip = /^files touched$/i.test(text);
            if (!skip)
            {
                const tag = heading[1] === '###' ? 'h3' : 'h4';
                out.push(`<${tag}>${inline(text)}</${tag}>`);
            }
            continue;
        }
        if (skip)
        {
            continue;
        }
        const item = line.match(/^\s{0,1}[-*]\s+(.*)$/);
        if (item)
        {
            if (para)
            {
                flush();
            }
            list = list || [];
            list.push(item[1]);
            continue;
        }
        if (!line.trim())
        {
            flush();
            continue;
        }
        if (list && /^\s{2,}\S/.test(line))
        {
            list[list.length - 1] += ` ${line.trim()}`;
            continue;
        }
        if (list)
        {
            flush();
        }
        para = para || [];
        para.push(line.trim());
    }
    flush();
    return out.join('');
}
