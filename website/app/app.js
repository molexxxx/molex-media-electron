import { routes } from './routes.js';
import { API_BASE, loadReleases } from './store.js';
import './widgets.js';
import './components/home.js';
import './components/features.js';
import './components/batch.js';
import './components/editor.js';
import './components/player.js';
import './components/download.js';
import './components/changelog.js';
import './components/not-found.js';

$.http.configure({ baseURL: API_BASE, timeout: 15000 });

const nav = document.getElementById('nav');
const toggle = document.getElementById('nav-toggle');
const toggleLabel = toggle.querySelector('.sr');
const menu = document.getElementById('nav-links');
const narrow = window.matchMedia('(max-width: 760px)');
const description = document.querySelector('meta[name="description"]');
const defaults = { title: document.title, description: description?.content || '' };

/**
 * Opens or closes the mobile menu. While it is open the page behind it is inert and does not scroll.
 * @param {boolean} open Desired state; ignored above the mobile breakpoint, where the links are always shown.
 */
function setMenu(open)
{
    const on = open && narrow.matches;
    if (!on && menu.contains(document.activeElement))
    {
        toggle.focus();
    }
    nav.dataset.open = String(on);
    toggle.setAttribute('aria-expanded', String(on));
    toggleLabel.textContent = on ? 'Close menu' : 'Open menu';
    document.documentElement.classList.toggle('menu-open', on);
    for (const el of document.querySelectorAll('#skip-link, main, .foot'))
    {
        el.inert = on;
    }
}

/**
 * Marks the nav link for the current section and updates the document metadata.
 * @param {{path: string, route?: object}} to Resolved route.
 */
function syncChrome(to)
{
    const path = to?.path || location.pathname;
    for (const a of document.querySelectorAll('[data-route]'))
    {
        const base = a.dataset.route;
        const hit = path === base || path.startsWith(`${base}/`);
        if (hit)
        {
            a.setAttribute('aria-current', 'page');
        }
        else
        {
            a.removeAttribute('aria-current');
        }
    }
    const route = to?.route && routes.find((r) => r.path === to.route.path);
    document.title = route?.title || 'Page not found | molexMedia';
    if (description)
    {
        description.content = route?.description || defaults.description;
    }
}

const router = $.router({ routes, fallback: 'not-found' });

let first = true;
router.onChange((to) =>
{
    syncChrome(to);
    setMenu(false);
    if (!first)
    {
        requestAnimationFrame(() =>
        {
            const heading = document.querySelector('main h1');
            if (heading)
            {
                heading.setAttribute('tabindex', '-1');
                heading.focus({ preventScroll: true });
            }
        });
    }
    first = false;
});

toggle.addEventListener('click', () => setMenu(nav.dataset.open !== 'true'));
document.getElementById('nav-scrim').addEventListener('click', () => setMenu(false));
narrow.addEventListener('change', () => setMenu(false));

document.addEventListener('keydown', (e) =>
{
    if (e.key === 'Escape' && nav.dataset.open === 'true')
    {
        setMenu(false);
        toggle.focus();
    }
});

document.getElementById('skip-link').addEventListener('click', (e) =>
{
    e.preventDefault();
    const main = document.getElementById('main');
    main.focus();
    main.scrollIntoView();
});

syncChrome(router.current);
loadReleases();
