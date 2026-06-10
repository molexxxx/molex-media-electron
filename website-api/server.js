/**
 * Molex Media API - media-api.molex.cloud
 *
 * Standalone GitHub cache proxy. Polls the GitHub API on a
 * configurable interval and serves cached responses at /releases,
 * /repo, /workflows, and /status.
 *
 * Deploy separately from the frontend. The frontend at
 * media.molex.cloud points its API base URL here.
 *
 * Usage:
 *   node server.js                      # default port 3610
 *   PORT=8080 node server.js            # custom port
 *
 * Environment (.env):
 *   GITHUB_TOKEN   - optional, raises rate limit
 *   PORT           - listen port (default 3610)
 *   ALLOWED_ORIGINS - comma-separated origins for CORS
 *                     (default: http://localhost:3100,https://media.molex.cloud)
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// -- Load .env ---------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

// -- Config ------------------------------------------------------
const PORT  = parseInt(process.env.PORT || '3610', 10);
const OWNER = 'tonywied17';
const REPO  = 'molex-media-electron';
const GH    = 'https://api.github.com';
const POLL  = 5 * 60 * 1000; // 5 min
const TOKEN = process.env.GITHUB_TOKEN || '';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3100,https://media.molex.cloud')
  .split(',').map(s => s.trim()).filter(Boolean);

// -- In-memory cache ---------------------------------------------
const cache = {
  releases:  { data: null, ts: 0 },
  repo:      { data: null, ts: 0 },
  workflows: { data: null, ts: 0 },
};

// -- GitHub helpers ----------------------------------------------
function ghHeaders() {
  const h = { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'molex-media-api' };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

async function ghFetch(path) {
  const res = await fetch(`${GH}${path}`, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`GitHub ${res.status} ${res.statusText} - ${path}`);
  return res.json();
}

async function refreshCache() {
  const now = Date.now();
  console.log('[cache] refreshing…');
  try {
    const [releases, repo, wfData] = await Promise.all([
      ghFetch(`/repos/${OWNER}/${REPO}/releases`),
      ghFetch(`/repos/${OWNER}/${REPO}`),
      ghFetch(`/repos/${OWNER}/${REPO}/actions/workflows`),
    ]);

    // Sort releases by semver descending so the highest version is first,
    // regardless of GitHub creation/publish order.
    releases.sort((a, b) => {
      const pa = (a.tag_name || '').replace(/^v/, '').split('.').map(Number);
      const pb = (b.tag_name || '').replace(/^v/, '').split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
      }
      return 0;
    });

    cache.releases.data = releases;
    cache.releases.ts   = now;
    cache.repo.data     = repo;
    cache.repo.ts       = now;

    const workflows = [];
    for (const wf of (wfData.workflows || [])) {
      try {
        const runs = await ghFetch(`/repos/${OWNER}/${REPO}/actions/workflows/${wf.id}/runs?per_page=1`);
        const run  = runs.workflow_runs?.[0];
        const conclusion = run?.conclusion || 'unknown';
        // Hide conditional workflows whose latest run was skipped
        if (conclusion === 'skipped') continue;
        workflows.push({
          name:       wf.name,
          conclusion,
          status:     run?.status     || 'unknown',
          url:        run?.html_url   || wf.html_url,
        });
      } catch {
        workflows.push({ name: wf.name, conclusion: 'unknown', status: 'unknown', url: wf.html_url });
      }
    }
    cache.workflows.data = workflows;
    cache.workflows.ts   = now;

    console.log(`[cache] OK - ${releases.length} releases, ${workflows.length} workflows`);
  } catch (err) {
    console.error('[cache] refresh failed:', err.message);
  }
}

// -- HTTP helpers ------------------------------------------------
function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin':  allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
    'Vary':                         'Origin',
  };
}

function json(res, data, status = 200, origin = '') {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type':   'application/json',
    'Content-Length':  Buffer.byteLength(body),
    'Cache-Control':  'public, max-age=60',
    ...corsHeaders(origin),
  });
  res.end(body);
}

// -- Routes ------------------------------------------------------
const routes = {
  '/releases':  () => cache.releases.data  || [],
  '/repo':      () => cache.repo.data      || {},
  '/workflows': () => cache.workflows.data || [],
  '/status':    () => ({
    cached: {
      releases:  { items: cache.releases.data?.length  ?? 0, age: cache.releases.ts  ? Date.now() - cache.releases.ts  : null },
      repo:      { has: !!cache.repo.data,                    age: cache.repo.ts      ? Date.now() - cache.repo.ts      : null },
      workflows: { items: cache.workflows.data?.length ?? 0,  age: cache.workflows.ts ? Date.now() - cache.workflows.ts : null },
    },
    pollInterval: POLL,
  }),
};

// -- Server ------------------------------------------------------
const server = createServer((req, res) => {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const path   = url.pathname.replace(/\/+$/, '') || '/';
  const origin = req.headers.origin || '';

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    return res.end();
  }

  // Only GET
  if (req.method !== 'GET') {
    return json(res, { error: 'Method not allowed' }, 405, origin);
  }

  const handler = routes[path];
  if (handler) return json(res, handler(), 200, origin);

  // Health check at root
  if (path === '/') {
    return json(res, { status: 'ok', service: 'molex-media-api' }, 200, origin);
  }

  return json(res, { error: 'Not found' }, 404, origin);
});

// -- Start -------------------------------------------------------
await refreshCache();
setInterval(refreshCache, POLL);

server.listen(PORT, () => {
  console.log(`\n  Molex Media API`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Routes:`);
  console.log(`    /releases    - cached GitHub releases`);
  console.log(`    /repo        - cached repo info`);
  console.log(`    /workflows   - workflow statuses`);
  console.log(`    /status      - cache health\n`);
  console.log(`  CORS: ${ALLOWED_ORIGINS.join(', ')}\n`);
});
