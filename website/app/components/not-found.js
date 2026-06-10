import { icon } from '../icons.js';

$.component('not-found', {
  render() {
    return `
<section class="hero" style="min-height:70vh;display:flex;align-items:center;justify-content:center">
  <div class="container" style="text-align:center">
    <div class="nf-icon">${icon('x-circ', 64)}</div>
    <h1 style="font-size:clamp(3rem,8vw,5rem);font-weight:800;margin:16px 0 8px"><span class="grad">404</span></h1>
    <p style="color:var(--text3);font-size:1.1rem;margin-bottom:28px">This page doesn't exist or has been moved.</p>
    <a z-link="/" class="btn btn-primary" z-to-top>${icon('arrow-left', 16)} Back to Home</a>
  </div>
</section>`;
  },
});
