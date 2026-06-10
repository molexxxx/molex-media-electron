// bg-canvas.js - ambient background particle/wave/glow canvas

const canvas = document.getElementById('bg-canvas');
const ctx = canvas ? canvas.getContext('2d') : null;
let particles = [];
let w = 0,
  h = 0,
  animId = 0,
  time = 0;

function resize() {
  if (!canvas) return;
  w = canvas.width = window.innerWidth;
  h = canvas.height = window.innerHeight;
}

function initParticles() {
  particles = [];
  const count = Math.min(80, Math.floor((w * h) / 18000));
  for (let i = 0; i < count; i++) {
    particles.push({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      r: Math.random() * 1.5 + 0.5,
      alpha: Math.random() * 0.4 + 0.1,
      hue: Math.random() > 0.7 ? 265 : 240,
    });
  }
}

function drawParticles() {
  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;
    if (p.x < -10) p.x = w + 10;
    if (p.x > w + 10) p.x = -10;
    if (p.y < -10) p.y = h + 10;
    if (p.y > h + 10) p.y = -10;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${p.hue}, 70%, 65%, ${p.alpha})`;
    ctx.fill();
  }

  for (let i = 0; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      const dx = particles[i].x - particles[j].x;
      const dy = particles[i].y - particles[j].y;
      const dist = dx * dx + dy * dy;
      if (dist < 25000) {
        const alpha = (1 - dist / 25000) * 0.06;
        ctx.beginPath();
        ctx.moveTo(particles[i].x, particles[i].y);
        ctx.lineTo(particles[j].x, particles[j].y);
        ctx.strokeStyle = `rgba(124, 58, 237, ${alpha})`;
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
    }
  }
}

function drawWave() {
  const amp = 30;
  const freq = 0.003;
  ctx.beginPath();
  for (let x = 0; x < w; x += 2) {
    const y =
      h * 0.5 +
      Math.sin(x * freq + time * 0.5) * amp +
      Math.sin(x * freq * 2.5 + time * 0.8) * amp * 0.4;
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = 'rgba(124, 58, 237, 0.06)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.beginPath();
  for (let x = 0; x < w; x += 2) {
    const y =
      h * 0.5 + Math.sin(x * freq * 1.5 + time * 0.3 + 2) * amp * 0.6;
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = 'rgba(59, 130, 246, 0.04)';
  ctx.lineWidth = 0.8;
  ctx.stroke();
}

function drawGlow() {
  const cx = w * 0.5 + Math.sin(time * 0.15) * 100;
  const cy = h * 0.3 + Math.cos(time * 0.1) * 50;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 400);
  grad.addColorStop(0, 'rgba(124, 58, 237, 0.04)');
  grad.addColorStop(1, 'transparent');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

function frame() {
  if (!ctx) return;
  time += 0.016;
  ctx.clearRect(0, 0, w, h);
  drawGlow();
  drawWave();
  drawParticles();
  animId = requestAnimationFrame(frame);
}

export function startBgCanvas() {
  if (!canvas) return;
  resize();
  initParticles();
  window.addEventListener('resize', () => {
    resize();
    initParticles();
  });
  frame();
}

export function stopBgCanvas() {
  cancelAnimationFrame(animId);
}

export function animateCardCanvas(canvasEl, type) {
  const c = canvasEl.getContext('2d');
  if (!c) return;
  let t = Math.random() * 100;
  let running = true;

  function draw() {
    if (!running) return;
    t += 0.02;
    const parent = canvasEl.parentElement;
    const cw = (canvasEl.width = parent
      ? parent.clientWidth
      : canvasEl.offsetWidth);
    const ch = (canvasEl.height = parent
      ? parent.clientHeight
      : canvasEl.offsetHeight);
    c.clearRect(0, 0, cw, ch);

    if (type === 'wave') {
      for (let i = 0; i < 3; i++) {
        c.beginPath();
        const offset = i * 1.2;
        for (let x = 0; x < cw; x += 2) {
          const y =
            ch * 0.5 +
            Math.sin(x * 0.015 + t + offset) * (ch * 0.25) +
            Math.sin(x * 0.04 + t * 1.5 + offset) * (ch * 0.08);
          x === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
        }
        c.strokeStyle = `rgba(124, 58, 237, ${0.2 - i * 0.05})`;
        c.lineWidth = 1.5 - i * 0.3;
        c.stroke();
      }
    } else if (type === 'bars') {
      const barCount = 32;
      const barW = cw / barCount;
      for (let i = 0; i < barCount; i++) {
        const h2 =
          (Math.sin(i * 0.3 + t * 2) * 0.5 + 0.5) * ch * 0.7 + ch * 0.1;
        const alpha =
          0.15 + (Math.sin(i * 0.3 + t * 2) * 0.5 + 0.5) * 0.15;
        c.fillStyle = `rgba(124, 58, 237, ${alpha})`;
        c.fillRect(i * barW + 1, ch - h2, barW - 2, h2);
      }
    } else if (type === 'circular') {
      const cx2 = cw / 2,
        cy2 = ch / 2;
      const radius = Math.min(cw, ch) * 0.3;
      const segments = 48;
      for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * Math.PI * 2 - Math.PI / 2;
        const mag =
          (Math.sin(i * 0.4 + t * 2.5) * 0.5 + 0.5) * radius * 0.5 +
          radius * 0.3;
        const x1 = cx2 + Math.cos(angle) * radius * 0.4;
        const y1 = cy2 + Math.sin(angle) * radius * 0.4;
        const x2 = cx2 + Math.cos(angle) * mag;
        const y2 = cy2 + Math.sin(angle) * mag;
        c.beginPath();
        c.moveTo(x1, y1);
        c.lineTo(x2, y2);
        c.strokeStyle = `rgba(124, 58, 237, 0.2)`;
        c.lineWidth = 2;
        c.stroke();
      }
    }
    requestAnimationFrame(draw);
  }
  draw();
  return () => {
    running = false;
  };
}

export function animatePlayerVis(canvasEl) {
  const c = canvasEl.getContext('2d');
  if (!c) return;
  let t = Math.random() * 100;
  let running = true;
  let cw = 0,
    ch = 0;

  function syncSize() {
    const p = canvasEl.parentElement;
    if (!p) return;
    cw = canvasEl.width = p.clientWidth;
    ch = canvasEl.height = p.clientHeight;
  }
  syncSize();
  const ro = new ResizeObserver(syncSize);
  ro.observe(canvasEl.parentElement);

  const barCount = 64;
  const seeds = Array.from({ length: barCount }, (_, i) => ({
    phase: Math.random() * Math.PI * 2,
    speed: 1.8 + Math.random() * 2.4,
    amp: 0.25 + Math.random() * 0.45,
  }));

  function draw() {
    if (!running) return;
    t += 0.016;
    if (!cw || !ch) {
      requestAnimationFrame(draw);
      return;
    }
    c.clearRect(0, 0, cw, ch);

    const bg = c.createLinearGradient(0, 0, 0, ch);
    bg.addColorStop(0, 'rgba(8, 11, 20, 0.9)');
    bg.addColorStop(1, 'rgba(15, 19, 32, 0.9)');
    c.fillStyle = bg;
    c.fillRect(0, 0, cw, ch);

    const barW = cw / barCount;
    const cy = ch * 0.5;
    for (let i = 0; i < barCount; i++) {
      const s = seeds[i];
      const val = (Math.sin(t * s.speed + s.phase) * 0.5 + 0.5) * s.amp;
      const h = val * ch * 0.42;
      const ratio = i / barCount;
      const r = Math.round(90 + ratio * 34);
      const g = Math.round(30 + ratio * 100);
      const b = Math.round(200 + ratio * 37);
      c.fillStyle = `rgba(${r}, ${g}, ${b}, 0.55)`;
      c.fillRect(i * barW + 1, cy - h, barW - 2, h * 2);
      c.fillStyle = `rgba(${r + 40}, ${g + 40}, ${b + 20}, 0.8)`;
      c.fillRect(i * barW + 1, cy - h, barW - 2, 2);
      c.fillRect(i * barW + 1, cy + h - 2, barW - 2, 2);
    }

    const glow = c.createRadialGradient(
      cw * 0.5,
      cy,
      0,
      cw * 0.5,
      cy,
      cw * 0.4,
    );
    glow.addColorStop(0, 'rgba(124, 58, 237, 0.06)');
    glow.addColorStop(1, 'transparent');
    c.fillStyle = glow;
    c.fillRect(0, 0, cw, ch);
    requestAnimationFrame(draw);
  }
  draw();
  return () => {
    running = false;
    ro.disconnect();
  };
}

export function drawRuler(canvasEl) {
  const c = canvasEl.getContext('2d');
  if (!c) return;
  const cw = (canvasEl.width = canvasEl.offsetWidth);
  const ch = (canvasEl.height = canvasEl.offsetHeight);
  c.clearRect(0, 0, cw, ch);
  c.fillStyle = 'rgba(255,255,255,0.03)';
  c.fillRect(0, 0, cw, ch);
  const step = 80;
  let sec = 0;
  for (let x = 0; x < cw; x += step) {
    c.beginPath();
    c.moveTo(x, ch - 12);
    c.lineTo(x, ch);
    c.strokeStyle = 'rgba(255,255,255,0.15)';
    c.lineWidth = 1;
    c.stroke();
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    c.fillStyle = 'rgba(255,255,255,0.3)';
    c.font = '9px Inter';
    c.fillText(`${m}:${String(s).padStart(2, '0')}`, x + 3, ch - 14);
    for (let j = 1; j < 4; j++) {
      const mx = x + (step / 4) * j;
      c.beginPath();
      c.moveTo(mx, ch - 6);
      c.lineTo(mx, ch);
      c.strokeStyle = 'rgba(255,255,255,0.06)';
      c.stroke();
    }
    sec += 5;
  }
}
