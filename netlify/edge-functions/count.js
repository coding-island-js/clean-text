/**
 * count.js — analytics, counted on the server, so the page stays honest.
 *
 * THE CONSTRAINT THIS IS BUILT AROUND: the site tells every visitor "open your
 * network tab and watch while you paste, nothing goes out", and the CSP
 * (connect-src 'none') enforces that rather than merely claiming it. Any normal
 * analytics script, beacon or pixel would make that a lie.
 *
 * So nothing is measured in the browser. This runs at the edge on a request the
 * visitor was making anyway, counts it, and passes the request through untouched.
 * No client JavaScript, no extra request, no cookie, no consent banner, and not a
 * single byte of what anyone pastes.
 *
 * WHAT IS STORED: a date, a path, and whether the request looked like a bot.
 * WHAT IS NOT STORED: IP addresses, user agent strings, identifiers of any kind,
 * anything that could single out a person, and obviously nothing from the textarea.
 *
 * FAILS OPEN, ALWAYS. Every path through this file ends in `return;` so the page
 * serves whatever happens. A visitor counter may never be the reason the site is
 * down. `onError: "bypass"` is the same promise at the platform level, for the
 * failures that happen before this code runs at all.
 */

import { getStore } from '@netlify/blobs';

/* Declared crawlers. This does not catch a scraper pretending to be Chrome, and
 * nothing server-side can. It reliably separates the bots that say who they are,
 * which is the honest limit of this approach and is labelled as such on /stats.
 *
 * The AI crawlers are listed separately and on purpose: whether GPTBot and
 * ClaudeBot are visiting is the leading indicator for being cited by an assistant,
 * and that is the number actually worth watching. */
const AI_BOTS = [
  ['gptbot', /GPTBot/i],
  ['oai-searchbot', /OAI-SearchBot/i],
  ['chatgpt-user', /ChatGPT-User/i],
  ['claudebot', /ClaudeBot/i],
  ['claude-user', /Claude-User|Claude-SearchBot/i],
  ['perplexitybot', /PerplexityBot|Perplexity-User/i],
  ['google-extended', /Google-Extended/i],
  ['applebot-extended', /Applebot-Extended/i],
  ['bytespider', /Bytespider/i],
  ['ccbot', /CCBot/i],
  ['meta-ai', /meta-externalagent|FacebookBot/i],
];

const SEARCH_BOTS = [
  ['googlebot', /Googlebot/i],
  ['bingbot', /bingbot|adidxbot/i],
  ['duckduckbot', /DuckDuckBot/i],
  ['yandexbot', /YandexBot/i],
  ['baiduspider', /Baiduspider/i],
  ['applebot', /Applebot/i],
];

// Everything else that admits to being automated.
const GENERIC_BOT = /bot\b|crawler|spider|crawling|slurp|curl\/|wget\/|python-requests|headlesschrome|phantomjs|scrapy|facebookexternalhit|whatsapp|telegrambot|slackbot|discordbot|twitterbot|linkedinbot|preview|monitor|uptime|pingdom|lighthouse|netlify/i;

function classify(userAgent) {
  const ua = userAgent || '';
  if (!ua) return { kind: 'bot', name: 'no-user-agent' };

  for (const [name, re] of AI_BOTS) if (re.test(ua)) return { kind: 'ai', name };
  for (const [name, re] of SEARCH_BOTS) if (re.test(ua)) return { kind: 'search', name };
  if (GENERIC_BOT.test(ua)) return { kind: 'bot', name: 'other' };

  return { kind: 'human', name: 'probably-human' };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/* WHICH REQUESTS ARE PAGE VIEWS. Exported so the suite can prove that every page
 * in the sitemap is one.
 *
 * The bug this is written against (BUG-012): the four tool pages and the hub
 * shipped on 2026-09-18, the day AFTER counting did, and nothing connected the
 * two. They were routed nowhere, and they would have failed this check anyway,
 * because a tool page's URL is a directory (`/remove-extra-spaces/`) and this
 * asked for `.html`. The growth bet of the whole project was the one part of the
 * site that was invisible.
 *
 * So it is written as "a page, in any of the three shapes this site serves"
 * rather than as a list of the pages that existed on the day it was written. A
 * new tool page is counted the moment it ships, with nothing to remember. */
/* ONE PAGE, ONE NAME.
 *
 * `/` and `/index.html` are the same page served at two URLs, and the stats table
 * listed them as two entries — 223 and 15 — so the busiest page on the site was
 * split across two rows and neither was the real figure. The same split waits for
 * every tool page, since `/tools/` and `/tools/index.html` both resolve.
 *
 * Folded at the point of writing, so it is canonical from here on, and folded
 * again when the stats page adds up the history, so the old rows read correctly
 * too. Nothing is lost: the only thing discarded is which spelling was used. */
export function canonicalPath(pathname) {
  const path = String(pathname || '');
  return path.endsWith('/index.html') ? path.slice(0, -'index.html'.length) : path;
}

export function countsAsPageView(pathname) {
  const path = String(pathname || '');
  if (path.startsWith('/stats')) return false;
  return path === '/' || path.endsWith('/') || path.endsWith('.html');
}

/* The browser suite runs against PRODUCTION on every deploy (D31), and every
 * navigation it makes carries `uitest`. A visit that says it is a test is not a
 * visitor. Without this the numbers would be mostly us, which is a worse failure
 * than no numbers: it is numbers that feel real. */
function isTestTraffic(url) {
  return url.searchParams.has('uitest');
}

/* A PERSON ARRIVING, not a browser filling a cache.
 *
 * `sw.js` precaches the whole asset set on install, and five of those entries are
 * pages. Those are real HTTP requests with the visitor's own user agent, so every
 * first visit was counting itself as a view of every page on the site — one person
 * landing on `/` looked like nine. It is why `/privacy.html` and `/terms.html` had
 * two dozen views each and nobody had read them.
 *
 * THE HEADER TO READ IS `Sec-Fetch-Mode`, AND THE OBVIOUS ONE IS WRONG. Measured
 * against this site's own worker on 2026-09-20:
 *
 *   real navigation, no worker      dest: document   mode: navigate
 *   the worker's precache           dest: empty      mode: cors
 *   real navigation THROUGH the worker   dest: empty      mode: navigate
 *
 * A service worker re-issues the navigation with `fetch(event.request)`, and the
 * destination does not survive that. So filtering on `Sec-Fetch-Dest: document`
 * excluded every returning visitor on the site — anyone whose worker was already
 * installed became invisible (BUG-014). The mode survives, and it is the thing
 * actually being asked: is this a page being navigated to, or a file being pulled?
 *
 * A MISSING HEADER COUNTS: crawlers and older browsers do not send `Sec-Fetch-*`
 * at all, and they are exactly who the AI-crawler numbers are for. */
function isNavigation(request) {
  const mode = request.headers.get('sec-fetch-mode');
  if (mode && mode !== 'navigate') return false;
  const purpose = request.headers.get('sec-purpose') || '';
  return !purpose.includes('prefetch');
}

const EMPTY_DAY = () => ({ human: 0, search: 0, ai: 0, bot: 0, bots: {}, paths: {} });

/* Blobs has no atomic increment and no locking: "last write wins". So the read,
 * the change and the write are done against an ETag, and a lost race is retried.
 * After the retries a count is dropped rather than overwriting somebody else's.
 *
 * On a site at this traffic level a collision is close to impossible. At high
 * traffic this would undercount slightly, and undercounting is the right way to
 * be wrong: it never invents a visitor that did not exist. Written down on the
 * stats page rather than hidden. */
async function record(store, key, path, verdict) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let day = EMPTY_DAY();
    let etag;

    try {
      const existing = await store.getWithMetadata(key, { type: 'json' });
      if (existing && existing.data) { day = existing.data; etag = existing.etag; }
    } catch (e) {
      // No object yet, or it is unreadable. Either way, start a fresh day.
    }

    day.human = day.human || 0;
    day.search = day.search || 0;
    day.ai = day.ai || 0;
    day.bot = day.bot || 0;
    day.bots = day.bots || {};
    day.paths = day.paths || {};

    day[verdict.kind] = (day[verdict.kind] || 0) + 1;
    if (verdict.kind !== 'human') day.bots[verdict.name] = (day.bots[verdict.name] || 0) + 1;
    day.paths[path] = (day.paths[path] || 0) + 1;

    try {
      await store.setJSON(key, day, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
      return true;
    } catch (e) {
      // Somebody else wrote first. Read again and reapply.
    }
  }
  return false;
}

export default async (request, context) => {
  try {
    const url = new URL(request.url);

    // Only real page views. Assets, the stats page and our own tests are skipped.
    const path = canonicalPath(url.pathname);
    if (!countsAsPageView(path) || isTestTraffic(url) || !isNavigation(request)) return;

    const verdict = classify(request.headers.get('user-agent'));
    const store = getStore({ name: 'analytics', consistency: 'strong' });

    // Do not make the visitor wait for a statistic.
    const write = record(store, 'day/' + today(), path, verdict);
    if (context && typeof context.waitUntil === 'function') context.waitUntil(write);
    else await write;
  } catch (e) {
    // Counting is never worth a failed page view.
  }

  return; // pass the request through, untouched, always
};

export const config = {
  /* EVERYTHING, filtered in code, on purpose.
   *
   * A hand-written list of the pages is exactly how the tool pages went uncounted:
   * the list gets written once and the site keeps growing. Routing is now the
   * question "is this the site?" and `countsAsPageView` is the question "is this a
   * page?", which is the one that changes. Assets are named here so they never
   * reach the function at all. */
  path: '/*',
  onError: 'bypass',
  excludedPath: [
    '/stats', '/stats/*',
    '/*.js', '/*.css', '/*.png', '/*.jpg', '/*.svg', '/*.ico',
    '/*.txt', '/*.xml', '/*.json', '/*.webmanifest',
  ],
};
