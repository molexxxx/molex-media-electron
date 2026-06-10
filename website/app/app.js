// app.js - main entry point
import { routes } from './routes.js';
import { fetchGitHubData, API_BASE } from './store.js';
import { startBgCanvas } from './bg-canvas.js';
import { initScrollAnimations, refreshReveals } from './scroll-animations.js';

// Import all page components (registers them with $)
import './components/home.js';
import './components/features.js';
import './components/batch.js';
import './components/editor.js';
import './components/player.js';
import './components/download.js';
import './components/changelog.js';
import './components/not-found.js';

// Configure HTTP client
$.http.configure({ baseURL: API_BASE });

// Setup router
$.router({
  routes,
  fallback: 'not-found',
  afterEach() {
    window.scrollTo(0, 0);
    setTimeout(refreshReveals, 50);
  },
});

// Fetch initial data
fetchGitHubData();

// Start ambient background
startBgCanvas();

// DOM ready
$.ready(() => {
  initScrollAnimations();

  const burger = $.id('nav-burger');
  const mobileNav = $.id('nav-mobile');
  const backdrop = $.id('nav-backdrop');

  function openMobileNav() {
    if (!mobileNav) return;
    mobileNav.classList.add('open');
    if (burger) burger.classList.add('active');
    if (backdrop) backdrop.classList.add('visible');
    document.body.classList.add('nav-open');
  }

  function closeMobileNav() {
    if (!mobileNav) return;
    mobileNav.classList.remove('open');
    if (burger) burger.classList.remove('active');
    if (backdrop) backdrop.classList.remove('visible');
    document.body.classList.remove('nav-open');
  }

  if (burger)
    burger.addEventListener('click', () => {
      mobileNav && mobileNav.classList.contains('open')
        ? closeMobileNav()
        : openMobileNav();
    });

  if (backdrop) backdrop.addEventListener('click', closeMobileNav);

  document.addEventListener('click', (e) => {
    if (
      e.target.closest('.nav-mobile a') &&
      !e.target.closest('.nav-dropdown-trigger')
    ) {
      closeMobileNav();
    }
  });

  const dropdownTrigger =
    mobileNav && mobileNav.querySelector('.nav-dropdown-trigger');
  if (dropdownTrigger) {
    dropdownTrigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dropdown = dropdownTrigger.closest('.nav-dropdown');
      if (dropdown) dropdown.classList.toggle('expanded');
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMobileNav();
  });
});
