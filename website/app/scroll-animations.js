// scroll-animations.js - reveal on scroll, parallax, header opacity

let reveals = [];
let parallaxEls = [];
let ticking = false;

function checkReveals() {
  const viewH = window.innerHeight;
  for (const el of reveals) {
    const rect = el.getBoundingClientRect();
    if (rect.top < viewH + 40) {
      el.classList.add('visible');
    }
  }
  ticking = false;
}

function updateParallax(scrollY) {
  const viewH = window.innerHeight;
  for (const el of parallaxEls) {
    const rect = el.getBoundingClientRect();
    const center = rect.top + rect.height / 2;
    const ratio = (center - viewH / 2) / (viewH / 2);
    const speed = parseFloat(el.dataset.parallaxSpeed || '0.08');
    const offset = ratio * viewH * speed;
    el.style.transform = `translateY(${offset}px)`;
  }
}

let rafParallax = false;

function onScroll() {
  if (!ticking) {
    requestAnimationFrame(checkReveals);
    ticking = true;
  }
  if (!rafParallax) {
    requestAnimationFrame(() => {
      updateParallax(window.scrollY);
      rafParallax = false;
    });
    rafParallax = true;
  }

  const scrollY = window.scrollY;
  const pxEls = document.querySelectorAll('.parallax-bg');
  for (const el of pxEls) {
    el.style.transform = `translateY(${scrollY * 0.15}px)`;
  }

  const header = document.getElementById('site-header');
  if (header) {
    header.style.background =
      scrollY > 30 ? 'rgba(8,11,20,0.92)' : 'rgba(8,11,20,0.7)';
  }
}

export function initScrollAnimations() {
  reveals = Array.from(
    document.querySelectorAll(
      '.reveal, .reveal-left, .reveal-right, .reveal-scale',
    ),
  );
  parallaxEls = Array.from(document.querySelectorAll('[data-parallax]'));
  checkReveals();
  updateParallax(window.scrollY);
  window.addEventListener('scroll', onScroll, { passive: true });
}

export function refreshReveals() {
  reveals = Array.from(
    document.querySelectorAll(
      '.reveal, .reveal-left, .reveal-right, .reveal-scale',
    ),
  );
  parallaxEls = Array.from(document.querySelectorAll('[data-parallax]'));
  checkReveals();
  updateParallax(window.scrollY);
}
