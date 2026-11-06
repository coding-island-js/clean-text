/**
 * stats.js — the private stats page.
 *
 * Reached with a token in the URL, checked HERE, on the server. A static page with
 * a JavaScript token check would not be private at all: the numbers would be in
 * the response before the check ever ran.
 *
 * A token in a URL is a bearer credential. It leaks through referrer headers,
 * browser history and screenshots, so this response sets Referrer-Policy:
 * no-referrer, tells robots to stay away, and is never cached. Rotate it with:
 *   netlify env:set STATS_TOKEN <new-value>
 *
 * A wrong or missing token gets a plain 404, not a 401. There is no reason to
 * confirm to a stranger that the page exists.
 */

import { getStore } from '@netlify/blobs';
// The one rule about page names, kept in one place: `/index.html` is `/`.
import { canonicalPath } from './count.js';

const env = name => {
  try { if (typeof Netlify !== 'undefined') return Netlify.env.get(name); } catch (e) {}
  try { if (typeof Deno !== 'undefined') return Deno.env.get(name); } catch (e) {}
  return undefined;
};

// Compare without leaking the answer through how long it took.
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* The refusal carries the same headers as the page itself. A 404 from this route
 * should no more be indexed, cached or referrer-leaked than a successful one, and
 * a cached 404 would also mean a correct token could be refused from a cache. */
const notFound = () =>
  new Response('Not found', {
    status: 404,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
    },
  });

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function row(label, value, total) {
  const share = total > 0 ? Math.round((value / total) * 100) : 0;
  return `<tr><td>${esc(label)}</td><td class="n">${value.toLocaleString()}</td><td class="n muted">${share}%</td></tr>`;
}

export default async (request) => {
  const expected = env('STATS_TOKEN');
  const given = new URL(request.url).searchParams.get('t');

  if (!expected || !given || !sameToken(given, expected)) return notFound();

  let days = [];
  let readError = null;

  try {
    const store = getStore({ name: 'analytics', consistency: 'strong' });
    const { blobs } = await store.list({ prefix: 'day/' });
    const keys = blobs.map(b => b.key).sort().reverse().slice(0, 60);
    days = await Promise.all(keys.map(async key => {
      const data = await store.get(key, { type: 'json' });
      return { date: key.slice(4), ...(data || {}) };
    }));
  } catch (e) {
    readError = e && e.message ? e.message : String(e);
  }

  const sum = field => days.reduce((n, d) => n + (d[field] || 0), 0);
  const humans = sum('human');
  const ai = sum('ai');
  const search = sum('search');
  const other = sum('bot');
  const total = humans + ai + search + other;

  const botTotals = {};
  days.forEach(d => Object.entries(d.bots || {}).forEach(([name, n]) => {
    botTotals[name] = (botTotals[name] || 0) + n;
  }));
  const bots = Object.entries(botTotals).sort((a, b) => b[1] - a[1]);

  const pathTotals = {};
  days.forEach(d => Object.entries(d.paths || {}).forEach(([p, n]) => {
    // Folded on the way out as well as on the way in, so rows written before
    // 2026-09-20 add up with the ones written after.
    const key = canonicalPath(p);
    pathTotals[key] = (pathTotals[key] || 0) + n;
  }));
  const paths = Object.entries(pathTotals).sort((a, b) => b[1] - a[1]);

  /* A machine-readable copy of exactly the same numbers, behind exactly the same
   * token and the same headers. It exists so the deploy suite can PROVE a page is
   * being counted instead of scraping this page's HTML for a number, and it means
   * a question about traffic never needs the table parsed by eye. */
  if (new URL(request.url).searchParams.get('json') === '1') {
    return new Response(JSON.stringify({ days, totals: { humans, ai, search, other, total } }, null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store, max-age=0',
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex, nofollow',
      },
    });
  }

  const recent = days.slice(0, 30);
  const busiest = Math.max(1, ...recent.map(d => (d.human || 0) + (d.ai || 0) + (d.search || 0) + (d.bot || 0)));

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Stats — Clean Text</title>
<meta name="robots" content="noindex, nofollow, noarchive">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="site"><div class="wrap bar">
  <a class="mark" href="/">clean<span>text</span></a>
  <nav aria-label="Page sections"><a href="/">Back to the tool</a></nav>
</div></header>

<main class="wrap stats">
  <h1>Stats</h1>
  <p class="updated">Counted on the server. Nothing is measured in anyone's browser, and nothing anyone pastes is ever recorded.</p>

  ${readError ? `<div class="boot-error"><p><strong>Could not read the counters.</strong></p><p class="boot-error-detail">${esc(readError)}</p></div>` : ''}

  <div class="tiles">
    <div class="tile"><span class="tile-n">${humans.toLocaleString()}</span><span class="tile-l">probably human</span></div>
    <div class="tile"><span class="tile-n">${ai.toLocaleString()}</span><span class="tile-l">AI crawlers</span></div>
    <div class="tile"><span class="tile-n">${search.toLocaleString()}</span><span class="tile-l">search crawlers</span></div>
    <div class="tile"><span class="tile-n">${other.toLocaleString()}</span><span class="tile-l">other bots</span></div>
  </div>

  <h2>Last 30 days</h2>
  ${recent.length === 0 ? '<p>Nothing counted yet.</p>' : `
  <table class="stats-table">
    <thead><tr><th>Date</th><th class="n">Human</th><th class="n">AI</th><th class="n">Search</th><th class="n">Other</th><th></th></tr></thead>
    <tbody>
    ${recent.map(d => {
      const t = (d.human || 0) + (d.ai || 0) + (d.search || 0) + (d.bot || 0);
      return `<tr>
        <td class="mono">${esc(d.date)}</td>
        <td class="n">${(d.human || 0).toLocaleString()}</td>
        <td class="n">${(d.ai || 0).toLocaleString()}</td>
        <td class="n">${(d.search || 0).toLocaleString()}</td>
        <td class="n">${(d.bot || 0).toLocaleString()}</td>
        <td class="bar"><span style="width:${Math.round((t / busiest) * 100)}%"></span></td>
      </tr>`;
    }).join('')}
    </tbody>
  </table>`}

  <h2>Who is crawling</h2>
  ${bots.length === 0 ? '<p>No crawlers seen yet.</p>' : `
  <table class="stats-table">
    <thead><tr><th>Crawler</th><th class="n">Visits</th><th class="n">Share</th></tr></thead>
    <tbody>${bots.map(([name, n]) => row(name, n, total)).join('')}</tbody>
  </table>
  <p class="note">The AI crawlers are the ones worth watching. GPTBot, ClaudeBot and PerplexityBot
  showing up is what leads to being named by an assistant later.</p>`}

  <h2>Pages</h2>
  ${paths.length === 0 ? '<p>Nothing yet.</p>' : `
  <table class="stats-table">
    <thead><tr><th>Page</th><th class="n">Views</th><th class="n">Share</th></tr></thead>
    <tbody>${paths.map(([p, n]) => row(p, n, total)).join('')}</tbody>
  </table>`}

  <h2>What these numbers are, and are not</h2>
  <ul class="plain">
    <li><strong>"Probably human" means "did not say it was a bot".</strong> A scraper pretending to
    be Chrome is counted as a person, and nothing measured on the server can tell the difference.
    Treat it as a direction, not a headcount.</li>
    <li>A page view is counted per request. Someone who returns three times counts three times,
    and there is no way to know it was the same person, because nothing identifies anyone.</li>
    <li>Visits served from the browser's offline cache still reach the server, because the service
    worker asks the network first for pages. Offline visits genuinely are not counted.</li>
    <li>Under two simultaneous requests a count can be dropped rather than overwrite another.
    It undercounts rather than inventing traffic. At this traffic level it is effectively exact.</li>
    <li>No IP addresses, no user agent strings, no cookies, no identifiers, and nothing anyone pastes.</li>
    <li><strong>Everything before 20 September 2026 is inflated, and cannot be corrected.</strong>
    The service worker precaches every page on the site, and until that date those fetches were
    counted, so one arrival looked like four visits and later like nine. The tool pages were not
    counted at all until the same day. Nothing stored can separate any of it, because nothing
    identifying was ever stored. Read anything earlier as a direction and nothing more.</li>
  </ul>
</main>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
      'content-security-policy': "default-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
};

export const config = { path: '/stats' };
