/**
 * tests/test-ui.mjs — the page, in a real browser.
 *
 *   node tests/test-ui.mjs            against a local server
 *   node tests/test-ui.mjs <url>      against a deployed site
 *
 * WHY THIS EXISTS. On 2026-09-17 the tool shipped completely dead: a cached app.js
 * met newer HTML, the module threw while loading, and every control was inert with
 * nothing on screen to explain it. `tests/test-clean.js` was fully green throughout,
 * because it tests clean.js, which has no DOM and was never the problem.
 *
 * Every bug that reached a person that day lived in this untested layer. So this
 * file tests the thing a person actually touches, and ops/deploy.mjs refuses to
 * deploy if it is red.
 *
 * It drives the gstack headless browser. If that is missing the tests FAIL rather
 * than skip: a suite that quietly skips itself is worse than no suite, because it
 * reports green.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = 8799;

const target = process.argv[2] || `http://localhost:${PORT}/`;
const useLocalServer = !process.argv[2];

const BROWSE = join(homedir(), '.claude', 'skills', 'gstack', 'browse', 'dist', 'browse');
if (!existsSync(BROWSE) && !existsSync(BROWSE + '.exe')) {
  console.error('FAIL: the gstack browse binary is missing at ' + BROWSE);
  console.error('The UI tests cannot run, so they are not passing.');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* MARK OUR OWN TRAFFIC. This suite runs against PRODUCTION on every deploy (D31),
 * so without this its navigations land in the analytics as visitors and the numbers
 * become mostly us. `count.js` skips any request carrying `uitest`.
 *
 * It is done inside `browse` rather than at the call sites because there are forty
 * of them and the next one has not been written yet. */
function mark(url) {
  // `countme=1` is the deliberate exception: the guard that proves a real browser
  // navigation reaches the counters has to make one request that is not marked.
  if (typeof url !== 'string' || url.includes('uitest=') || url.includes('countme=1')) return url;
  // A fresh value each time, so it also stops the browser answering a navigation
  // from its own HTTP cache and handing this suite a page two edits out of date.
  return url + (url.includes('?') ? '&' : '?') + 'uitest=' + Date.now();
}

function browse(...args) {
  if (args[0] === 'goto') args = [args[0], mark(args[1]), ...args.slice(2)];
  const out = execFileSync(BROWSE, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  return out
    .split('\n')
    .filter(line => !line.startsWith('--- BEGIN UNTRUSTED') && !line.startsWith('--- END UNTRUSTED'))
    .join('\n')
    .trim();
}

const js = expr => browse('js', expr);
const json = expr => JSON.parse(js(expr));

let passed = 0;
const failures = [];
/* Skips are LOUD. A suite that quietly skips itself reports green while testing
 * nothing, which is the failure this whole file exists to prevent. */
const skipped = [];

async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures.push({ name, message: e.message }); }
}

function ok(cond, msg) { if (!cond) throw new Error(msg || 'expected true'); }
function eq(a, b, what) {
  if (a !== b) throw new Error((what ? what + ': ' : '') + 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
}
function has(hay, needle) {
  if (!String(hay).includes(needle)) {
    throw new Error('expected to find ' + JSON.stringify(needle) + ' in ' + JSON.stringify(String(hay).slice(0, 300)));
  }
}

/* The text Raj actually pasted on 2026-09-17, CP437-mangled by a clipboard hand-off.
 * It is the single best input this tool has: forwarded furniture, a WhatsApp line,
 * hard wrapping, mojibake standing in for three different invisible characters,
 * bullets flattened onto one line, and tracking on the link. */
const MESSY = [
  'Hi! Can you send this out tonight please',
  '',
  'NAVRATRI GARBA NIGHT 2026',
  '',
  'Please join us for our biggest event of the year. WeΓÇÖll have live music and',
  'dinner catered by Surati Farsan. Doors open at six and the garba starts at seven',
  'sharp, so please arrive early because parking fills┬áup fast on theΓÇï north side.',
  '',
  'When: Saturday, October 10 at 6:00 pm',
  'Where: Torrance Cultural Arts Center, 3330 Civic Center Dr',
  'Cost: $30 per adult, $15 per child',
  'RSVP: https://example.org/garba-2026?utm_source=news&id=4417',
  '',
  'ΓÇó bring your own dandiya sticks ΓÇó wear traditional dress',
  '',
  'Sent from my iPhone',
].join('\n');

let server;

try {
  if (useLocalServer) {
    /* The static server runs in a CHILD PROCESS, and that detail is load-bearing.
     *
     * It was briefly an in-process http.createServer, which could never work: this
     * file drives the browser with execFileSync, which BLOCKS THE EVENT LOOP, so a
     * server in this process cannot answer a request while a navigation is in
     * flight. Every goto timed out and the error pointed at the browser, which was
     * innocent. The original python child process worked for exactly this reason.
     *
     * It serves `no-store` so the browser cannot answer from its own HTTP cache and
     * hand this suite a stylesheet two edits out of date. */
    const code = `
      const { createServer } = require('http');
      const { readFileSync, existsSync, statSync } = require('fs');
      const { join, extname } = require('path');
      const root = ${JSON.stringify(join(root, 'public'))};
      const TYPES = { '.html':'text/html','.js':'text/javascript','.css':'text/css',
                      '.svg':'image/svg+xml','.png':'image/png','.xml':'application/xml',
                      '.txt':'text/plain','.json':'application/json' };
      createServer((req, res) => {
        const p = decodeURIComponent(req.url.split('?')[0]);
        let rel = p;
        while (rel.startsWith('/')) rel = rel.slice(1);
        let f = join(root, rel === '' ? 'index.html' : rel);
        // The tool pages live at /<name>/ as a directory with its own index.html,
        // which is how they get a clean URL with no redirect and no build step.
        // Netlify serves a directory index; this server has to do the same or the
        // suite tests a 404 and says the page is broken.
        if (f.startsWith(root) && existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
        if (!f.startsWith(root) || !existsSync(f)) {
          res.writeHead(404, { 'Cache-Control': 'no-store' });
          return res.end('not found');
        }
        res.writeHead(200, {
          'Content-Type': TYPES[extname(f)] || 'application/octet-stream',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        });
        res.end(readFileSync(f));
      }).listen(${PORT});
    `;
    server = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });

    /* Prove the server answers before driving a browser at it, so a failure names
     * the real cause instead of blaming the browser. */
    let live = false;
    for (let attempt = 1; attempt <= 20 && !live; attempt++) {
      try {
        const res = await fetch(`http://localhost:${PORT}/`);
        live = res.ok;
      } catch (e) { await sleep(250); }
    }
    if (!live) throw new Error(`the test server never answered on port ${PORT}`);
  }

  const url = mark(target);

  // The browse server may be cold, and starting it takes longer than one navigation
  // timeout. Retry before calling it a real failure.
  let navigated = false;
  for (let attempt = 1; attempt <= 4 && !navigated; attempt++) {
    try { browse('goto', url); navigated = true; }
    catch (e) { await sleep(3000); }
  }
  if (!navigated) throw new Error('could not open ' + url);

  /* Clear any service worker and cache left by an earlier run.
   *
   * This suite once spent a while measuring a stylesheet two edits out of date and
   * reporting a failure that had already been fixed. The first cause was a test
   * server with no cache headers; that one serves `no-store` now. The second is the
   * service worker, which caches assets on purpose and would happily serve a
   * previous run's JavaScript back to this one.
   *
   * Killing the whole browser also worked, but a cold start races the navigation
   * timeout and made the suite flaky. Clearing the two things that actually hold
   * state is faster and deterministic. The real service worker is still exercised,
   * against the deployed site, which is the only place it matters. */
  js('navigator.serviceWorker.getRegistrations()' +
     '.then(rs => Promise.all(rs.map(r => r.unregister())))' +
     '.then(() => caches.keys())' +
     '.then(ks => Promise.all(ks.map(k => caches.delete(k))))' +
     '.then(() => { window.__cleared = true; }); "clearing"');
  await sleep(1500);

  browse('viewport', '1280x900');
  browse('console', '--clear');
  browse('network', '--clear');   // or requests from an earlier session count as this page's
  browse('goto', url);
  await sleep(1400);

  /* ---------------------------------------------------------- it is alive */

  await test('the module boots', () => {
    ok(json('JSON.stringify(!!window.__cleantextReady)') === true,
      'window.__cleantextReady was never set, so app.js did not finish loading');
  });

  await test('the failure box stays hidden when things are fine', () => {
    eq(json('JSON.stringify(document.getElementById("boot-error").hidden)'), true);
  });

  await test('no console errors on load', () => {
    const log = browse('console');
    ok(!/error/i.test(log) || /no console messages/i.test(log), 'console said: ' + log.slice(0, 300));
  });

  await test('the elements app.js reaches for all exist', () => {
    const found = json(`JSON.stringify(['input','output','status','chips','copy-rich','copy-plain','undo','reset','boot-error',
      'note','result','changed','stats','copybar','copy-state']
      .reduce((a,id)=>{a[id]=!!document.getElementById(id);return a;},{}))`);
    Object.entries(found).forEach(([id, present]) => ok(present, 'missing element #' + id));
  });

  /* ---------------------------------------------------------- the job */

  await test('pasting cleans on its own, with no button pressed', async () => {
    js(`(()=>{const el=document.getElementById('input');el.value=${JSON.stringify(MESSY)};` +
       `el.dispatchEvent(new Event('input',{bubbles:true}));return 'ok';})()`);
    await sleep(900);
    const len = json('JSON.stringify(document.getElementById("output").innerHTML.length)');
    ok(len > 200, 'the output pane is empty, so nothing cleaned');
  });

  await test('mojibake is repaired', () => {
    const t = json('JSON.stringify(document.getElementById("output").innerText)');
    has(t, 'We’ll have live music');
    ok(!t.includes('Γ') && !t.includes('┬'), 'mojibake characters survived into the output');
    has(t, 'parking fills up fast');
  });

  await test('forwarded furniture and sign-offs are gone', () => {
    const t = json('JSON.stringify(document.getElementById("output").innerText)');
    ok(!/Sent from my iPhone/.test(t), 'the phone sign-off survived');
  });

  await test('structure comes back: heading, labels, list, link', () => {
    const shape = json(`JSON.stringify({
      headings: document.querySelectorAll('#output h2, #output h3').length,
      labels: document.querySelectorAll('#output strong').length,
      items: document.querySelectorAll('#output li').length,
      links: document.querySelectorAll('#output a').length
    })`);
    ok(shape.headings >= 1, 'no heading');
    ok(shape.labels >= 4, 'expected at least 4 bold labels, got ' + shape.labels);
    ok(shape.items === 2, 'expected the flattened bullets to split into 2, got ' + shape.items);
    ok(shape.links >= 1, 'no link');
  });

  await test('tracking parameters are stripped from the link', () => {
    const href = json('JSON.stringify(document.querySelector("#output a").href)');
    ok(!href.includes('utm_source'), 'utm_source survived in ' + href);
    has(href, 'id=4417');
  });

  await test('what changed is counted, one tap away and not on screen (D46)', () => {
    const state = json(`JSON.stringify({
      stats: [...document.querySelectorAll('#stats .chip')].map(c=>c.textContent),
      changedHidden: document.getElementById('changed').hidden,
      changedOpen: document.getElementById('changed').open,
      visible: [...document.querySelectorAll('#chips .chip')].map(c=>c.textContent)
    })`);
    ok(state.stats.length >= 3, 'expected several counts, got ' + JSON.stringify(state.stats));
    eq(state.changedHidden, false, 'the What changed disclosure is hidden with counts in it');
    eq(state.changedOpen, false, 'What changed should start collapsed');
    ok(state.visible.every(c => c === 'Formatting kept' || c === 'Moved to the paste box'),
      'only the rule chips belong on screen, got ' + JSON.stringify(state.visible));
  });


  /* --------------------------------------------- a paste with its formatting
   *
   * BUG-009. Box 1 is a textarea, so the browser hands it the text/plain flavour
   * of the clipboard and drops the text/html one — along with every link, whose
   * URL lives in the href and never in the words on screen. Raj hit it on
   * 2026-09-18 copying an article from espn.com in Brave on Android.
   *
   * The conversion itself is unit-tested against the shipped module in
   * tests/test-clean.js. What can only be tested HERE is whether the page is
   * wired to it at all, which is the half that has broken every other time.
   */

  const RICH = [
    '<h2>Lakers rally past the Celtics</h2>',
    '<p>The <strong>fourth quarter</strong> was the difference.</p>',
    '<ul><li>LeBron: 31 points</li><li>Davis: 18 rebounds</li></ul>',
    '<p>Box score at <a href="https://example.com/box?utm_medium=social">ESPN</a>.</p>',
  ].join('');

  const pasteRich = (html, plain) => js(
    `(()=>{const el=document.getElementById('input');el.value='';` +
    `const dt=new DataTransfer();` +
    (html ? `dt.setData('text/html', ${JSON.stringify(html)});` : '') +
    `dt.setData('text/plain', ${JSON.stringify(plain)});` +
    `el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));` +
    `return 'ok';})()`);

  await test('a formatted paste keeps its heading, bold, bullets and link', async () => {
    js('document.getElementById("reset").click()');
    await sleep(250);
    pasteRich(RICH, 'Lakers rally past the Celtics');
    await sleep(900);

    const raw = json('JSON.stringify(document.getElementById("input").value)');
    ok(raw.length > 40, 'the textarea took the plain flavour, or nothing at all: ' + JSON.stringify(raw));
    has(raw, '## Lakers rally past the Celtics');
    has(raw, '**fourth quarter**');
    has(raw, 'https://example.com/box');

    const shape = json(`JSON.stringify({
      headings: document.querySelectorAll('#output h2, #output h3').length,
      bold: document.querySelectorAll('#output strong').length,
      items: document.querySelectorAll('#output li').length,
      href: (document.querySelector('#output a')||{}).href || ''
    })`);
    ok(shape.headings >= 1, 'the heading did not survive');
    ok(shape.bold >= 1, 'the bold did not survive');
    eq(shape.items, 2, 'list items');
    has(shape.href, 'https://example.com/box');
    ok(!shape.href.includes('utm_medium'), 'tracking survived: ' + shape.href);
  });

  await test('the page says the formatting was kept', () => {
    const chips = json('JSON.stringify([...document.querySelectorAll("#chips .chip")].map(c=>c.textContent))');
    ok(chips.includes('Formatting kept'), 'no chip said so: ' + JSON.stringify(chips));
  });

  await test('GUARD a plain paste is left entirely to the browser', async () => {
    // No text/html flavour means nothing to convert, so the handler must not call
    // preventDefault — or an ordinary paste would put nothing in the box at all.
    js('document.getElementById("reset").click()');
    await sleep(250);
    browse('console', '--clear');
    const prevented = json(
      `(()=>{const el=document.getElementById('input');` +
      `const dt=new DataTransfer();dt.setData('text/plain','just some words');` +
      `const ev=new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true});` +
      `el.dispatchEvent(ev);return JSON.stringify(ev.defaultPrevented);})()`);
    eq(prevented, false, 'the default paste was cancelled with nothing to replace it');
    await sleep(400);
    const log = browse('console');
    ok(!/error/i.test(log) || /no console messages/i.test(log), 'the paste threw: ' + log.slice(0, 300));
  });

  await test('GUARD markup with no words in it never cancels the paste either', async () => {
    js('document.getElementById("reset").click()');
    await sleep(250);
    const prevented = json(
      `(()=>{const el=document.getElementById('input');` +
      `const dt=new DataTransfer();dt.setData('text/html','<div><img src="x.png"></div>');` +
      `dt.setData('text/plain','fallback words');` +
      `const ev=new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true});` +
      `el.dispatchEvent(ev);return JSON.stringify(ev.defaultPrevented);})()`);
    eq(prevented, false, 'an empty conversion cancelled the real paste');
  });

  await test('GUARD the words a page was hiding do not come through', async () => {
    js('document.getElementById("reset").click()');
    await sleep(250);
    pasteRich('<p><span style="display:none">Sponsored Content</span>Real words here</p>', 'Real words here');
    await sleep(900);
    const raw = json('JSON.stringify(document.getElementById("input").value)');
    ok(!/Sponsored/.test(raw), 'hidden page furniture arrived in the box: ' + JSON.stringify(raw));
    has(raw, 'Real words here');
  });

  await test('the rich paste path is reached over a same-origin module, nothing external', () => {
    const net = browse('network');
    const foreign = net.split('\n').filter(l => /https?:\/\//.test(l) && !l.includes(new URL(target).host));
    eq(foreign.length, 0, 'third-party requests after the rich paste: ' + foreign.join(' | '));
  });

  // Put the page back the way the tests below it expect to find it.
  js('document.getElementById("reset").click()');
  await sleep(250);
  js(`(()=>{const el=document.getElementById('input');el.value=${JSON.stringify(MESSY)};` +
     `el.dispatchEvent(new Event('input',{bubbles:true}));return 'ok';})()`);
  await sleep(900);


  /* ------------------------------------------------ a paste into the WRONG box
   *
   * BUG-010. Box 2 is contenteditable so she can fix a word before copying (S6),
   * which also means it takes a paste — and nothing was listening for one. a tester,
   * on an iPhone, pasted into one box and then the other. The second paste
   * did nothing, said nothing, and left the source's own `font-size:18pt;
   * color:#c00` sitting in the result on its way to Club Express.
   *
   * On a phone both boxes are on screen together and both offer Paste on a long
   * press. The label and the hint are not enough to tell them apart.
   */

  const MESSY_RICH = '<span style="font-size:18pt;color:#c00">NAVRATRI GARBA NIGHT</span><br>When: Saturday<br>Sent from my iPhone';

  const pasteIntoOutput = (html, plain) => js(
    `(()=>{const o=document.getElementById('output');o.focus();` +
    `const r=document.createRange();r.selectNodeContents(o);r.collapse(false);` +
    `const s=window.getSelection();s.removeAllRanges();s.addRange(r);` +
    `const dt=new DataTransfer();` +
    (html ? `dt.setData('text/html', ${JSON.stringify(html)});` : '') +
    `dt.setData('text/plain', ${JSON.stringify(plain)});` +
    `o.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));` +
    `return 'ok';})()`);

  await test('a paste into the EMPTY box 2 goes to box 1 and is cleaned', async () => {
    js('document.getElementById("reset").click()');
    await sleep(300);
    pasteIntoOutput(MESSY_RICH, 'NAVRATRI GARBA NIGHT\nWhen: Saturday\nSent from my iPhone');
    await sleep(900);

    const state = json(`JSON.stringify({
      input: document.getElementById('input').value,
      outputText: document.getElementById('output').innerText,
      headings: document.querySelectorAll('#output h2, #output h3').length,
      labels: document.querySelectorAll('#output strong').length,
      chips: [...document.querySelectorAll('#chips .chip')].map(c=>c.textContent)
    })`);
    ok(state.input.length > 10, 'box 1 is still empty, so the paste went nowhere');
    has(state.input, 'NAVRATRI GARBA NIGHT');
    ok(state.headings >= 1, 'it was not cleaned: no heading');
    ok(state.labels >= 1, 'it was not cleaned: the When label is not bold');
    ok(!/Sent from my iPhone/.test(state.outputText), 'the phone sign-off survived, so strip() never ran');
    ok(state.chips.includes('Moved to the paste box'), 'nothing told her where it went: ' + JSON.stringify(state.chips));
    const shown = json(`JSON.stringify({ result: !document.getElementById('result').hidden,
      bar: !document.getElementById('copybar').hidden })`);
    ok(shown.result && shown.bar, 'box 2 and the bar were not revealed: ' + JSON.stringify(shown));
  });

  await test('the source fonts and colours never enter box 2', () => {
    const html = json('JSON.stringify(document.getElementById("output").innerHTML)');
    ok(!/font-size|color:#c00|18pt/.test(html), 'the source styling rode in: ' + html.slice(0, 200));
  });

  await test('a paste into box 2 that ALREADY has her text stays there, as plain text', async () => {
    js('document.getElementById("reset").click()');
    await sleep(300);
    // Clean something first, so box 2 holds a real result she might be editing.
    js(`(()=>{const el=document.getElementById('input');el.value='Diwali Dinner is on Saturday at six';` +
       `el.dispatchEvent(new Event('input',{bubbles:true}));return 'ok';})()`);
    await sleep(800);
    const before = json('JSON.stringify(document.getElementById("input").value)');

    pasteIntoOutput('<b style="color:#c00">and bring a dish</b>', 'and bring a dish');
    await sleep(600);

    const after = json(`JSON.stringify({
      input: document.getElementById('input').value,
      outputText: document.getElementById('output').innerText,
      outputHtml: document.getElementById('output').innerHTML,
      status: document.getElementById('status').textContent,
      bar: document.getElementById('copy-state').textContent,
      undoHidden: document.getElementById('undo').hidden
    })`);
    eq(after.input, before, 'her cleaned result was thrown back into box 1 and re-cleaned');
    has(after.outputText, 'and bring a dish');
    ok(!/color:#c00|<b\b/i.test(after.outputHtml), 'the source styling rode in: ' + after.outputHtml.slice(0, 200));
    has(after.status, 'not cleaned');
    eq(after.bar, 'Added as-is. Not copied yet', 'the bar');
    eq(after.undoHidden, false, 'undo is not offered after an edit she may want back');
  });

  await test('GUARD an empty clipboard leaves box 2 to the browser', async () => {
    const prevented = json(
      `(()=>{const o=document.getElementById('output');o.focus();` +
      `const dt=new DataTransfer();dt.setData('text/plain','');` +
      `const ev=new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true});` +
      `o.dispatchEvent(ev);return JSON.stringify(ev.defaultPrevented);})()`);
    eq(prevented, false, 'the default paste was cancelled with nothing to replace it');
  });

  // Put the page back the way the tests below it expect to find it.
  js('document.getElementById("reset").click()');
  await sleep(250);
  js(`(()=>{const el=document.getElementById('input');el.value=${JSON.stringify(MESSY)};` +
     `el.dispatchEvent(new Event('input',{bubbles:true}));return 'ok';})()`);
  await sleep(900);


  /* --------------------------------------------------- it never fails silently
   *
   * BUG-011. A tester, on an iPhone: they pasted and it never reached box 2. No
   * screenshot, no steps, and she had gone to bed, so the cause is still unknown.
   * What IS known is that several of the ways it could fail said nothing at all,
   * and a person cannot tell "it is broken" apart from "I did it wrong" when the
   * page is silent. Every branch below now puts a sentence on the screen, because
   * a sentence can be screenshotted and a console cannot.
   */

  await test('a paste that lands nowhere says so, on screen', async () => {
    js('document.getElementById("reset").click()');
    await sleep(300);
    // An empty clipboard on an empty box: exactly what a long press that caught the
    // page instead of the box produces.
    js(`(()=>{const el=document.getElementById('input');` +
       `const dt=new DataTransfer();dt.setData('text/plain','');` +
       `el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));` +
       `return 'ok';})()`);
    await sleep(500);
    const state = json(`JSON.stringify({
      chips: [...document.querySelectorAll('#note .chip')].map(c=>c.textContent),
      status: document.getElementById('status').textContent,
      barHidden: document.getElementById('copybar').hidden
    })`);
    ok(state.chips.length > 0, 'the page said nothing a person could see');
    has(state.chips.join(' '), 'Nothing arrived');
    has(state.status, 'paste box');
    eq(state.barHidden, true, 'a copy button with nothing to copy');
  });

  await test('a failure after the module started is shown, not swallowed', async () => {
    /* boot.js only watches until __cleantextReady is set; after that its error
     * listener has stood down. So the cleaner has to report its own failures. This
     * one is checked in the source, the way the private-mode and service-worker
     * tests are: there is no way to make clean() throw from out here without
     * shipping a hook that exists only for the test. */
    const app = await (await fetch(new URL('/app.js', target).href)).text();
    ok(/try\s*\{[\s\S]{0,120}clean\(raw/.test(app),
      'the clean() call is not wrapped, so a throw leaves an empty box and silence');
    ok(/function showFailure\(/.test(app), 'there is no visible failure path in app.js');
    ok(/boot-error/.test(app), 'the failure path does not reveal the alert box');
  });

  await test('the alert box is a real alert, and starts hidden', () => {
    const box = json(`JSON.stringify({
      role: document.getElementById('boot-error').getAttribute('role'),
      hidden: document.getElementById('boot-error').hidden
    })`);
    eq(box.role, 'alert');
    eq(box.hidden, true, 'the failure box is showing when nothing has failed');
  });

  js('document.getElementById("reset").click()');
  await sleep(250);
  js(`(()=>{const el=document.getElementById('input');el.value=${JSON.stringify(MESSY)};` +
     `el.dispatchEvent(new Event('input',{bubbles:true}));return 'ok';})()`);
  await sleep(900);

  /* ---------------------------------------------------------- the controls */

  await test('there is exactly one button in the copy bar', () => {
    const labels = json('JSON.stringify([...document.querySelectorAll("#copybar button")].map(b=>b.textContent.trim()))');
    eq(labels.length, 1, 'button count');
    ok(labels[0] === 'Copy cleaned text' || labels[0] === 'Copy again', 'label: ' + labels[0]);
  });

  await test('undo is hidden until the result is actually edited', async () => {
    eq(json('JSON.stringify(document.getElementById("undo").hidden)'), true);
    js(`(()=>{const o=document.getElementById('output');o.innerHTML+='<p>edited</p>';` +
       `o.dispatchEvent(new Event('input',{bubbles:true}));return 'ok';})()`);
    await sleep(200);
    eq(json('JSON.stringify(document.getElementById("undo").hidden)'), false, 'after an edit');
    js('document.getElementById("undo").click()');
    await sleep(200);
    const t = json('JSON.stringify(document.getElementById("output").innerText)');
    ok(!t.includes('edited'), 'undo did not restore the cleaned version');
  });

  await test('start over clears both panes', async () => {
    js('document.getElementById("reset").click()');
    await sleep(300);
    const state = json(`JSON.stringify({
      input: document.getElementById('input').value.length,
      output: document.getElementById('output').innerHTML.length,
      chips: document.querySelectorAll('#chips .chip').length,
      resultHidden: document.getElementById('result').hidden,
      barHidden: document.getElementById('copybar').hidden,
      focus: document.activeElement && document.activeElement.id
    })`);
    eq(state.input, 0, 'input');
    eq(state.output, 0, 'output');
    eq(state.chips, 0, 'chips');
    eq(state.resultHidden, true, 'box 2 is still showing');
    eq(state.barHidden, true, 'the copy bar is still showing');
    eq(state.focus, 'input', 'focus');
  });

  await test('pressing copy with nothing to copy says so, and does not throw', async () => {
    js('document.getElementById("copy-rich").click()');
    await sleep(400);
    const status = json('JSON.stringify(document.getElementById("status").textContent)');
    has(status, 'nothing to copy');
  });

  /* ----------------------------------------------- the simple flow (D46)
   *
   * Raj, 2026-09-28: it should copy on its own AND have a button, the button was
   * below the fold on an iPhone 16, and a first tester had to be told what to do. So:
   * one box on the first screen, a paste cleans AND copies, and a bar pinned to
   * the bottom says whether the copy really happened. docs/DESIGN-simple-flow.md.
   *
   * A real clipboard write cannot be granted to a headless page, so the API is
   * replaced with a recorder. What is tested is the page's side of the bargain:
   * that it starts the write INSIDE the paste, and never says Copied unless the
   * write resolved. Whether iOS Safari honours it is UAT, on a real iPhone.
   */

  // mode: 'ok' resolves, 'no' rejects, 'hang' never answers.
  const stubClipboard = mode => js(
    `(()=>{window.__writes=[];window.__texts=[];` +
    `navigator.clipboard.write=items=>{window.__writes.push(items.map(i=>i.types.join(',')).join('|'));` +
    `return ${mode === 'ok' ? 'Promise.resolve()' : mode === 'no' ? 'Promise.reject(new Error("denied"))' : 'new Promise(()=>{})'};};` +
    `navigator.clipboard.writeText=t=>{window.__texts.push(t);return Promise.resolve();};return 'stubbed';})()`);

  // A real paste: the event, then the browser's own insert in the same task.
  const realPaste = text => json(
    `(()=>{const el=document.getElementById('input');el.focus();` +
    `const dt=new DataTransfer();dt.setData('text/plain', ${JSON.stringify(text)});` +
    `el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));` +
    `const during=window.__writes.length;el.value=${JSON.stringify(text)};return JSON.stringify(during);})()`);

  const barNow = () => json(`JSON.stringify({
    state: document.getElementById('copy-state').textContent,
    button: document.getElementById('copy-rich').textContent,
    primary: document.getElementById('copy-rich').classList.contains('primary'),
    status: document.getElementById('status').textContent,
    writes: window.__writes, texts: window.__texts })`);

  const fresh = async () => { js('document.getElementById("reset").click()'); await sleep(250); };

  await test('FIRST SCREEN at 393x659 is one box and nothing to press', async () => {
    browse('viewport', '393x659');
    await fresh();
    js('window.scrollTo(0,0); "top"');
    await sleep(200);
    const s = json(`JSON.stringify({
      box: document.getElementById('input').getBoundingClientRect().bottom, vh: innerHeight,
      result: document.getElementById('result').hidden,
      bar: document.getElementById('copybar').hidden,
      blue: [...document.querySelectorAll('.btn.primary')].filter(b => b.offsetParent &&
        b.getBoundingClientRect().top < innerHeight).length })`);
    ok(s.box <= s.vh, 'box 1 is not fully on the first screen: bottom ' + s.box + ' of ' + s.vh);
    eq(s.result, true, 'box 2 is showing before a paste');
    eq(s.bar, true, 'the copy bar is showing before a paste');
    eq(s.blue, 0, 'a blue button is on the first screen with nothing to copy');
  });

  await test('AUTO-COPY starts inside the paste, and only then says Copied', async () => {
    stubClipboard('ok');
    const during = realPaste(MESSY);
    await sleep(600);
    const b = barNow();
    eq(during, 1, 'the write did not start inside the paste handler');
    has(b.writes[0], 'text/html');
    has(b.writes[0], 'text/plain');
    eq(b.state, '✓ Copied', 'bar');
    eq(b.button, 'Copy again', 'button');
    eq(b.primary, false, 'the button is still blue after the job is done');
    has(b.status, 'copied');
  });

  await test('after a paste, focus is on the button and box 1 has let go', () => {
    eq(json('JSON.stringify(document.activeElement && document.activeElement.id)'), 'copy-rich');
  });

  await test('the button is on screen after a paste at 393x659, 390x844 and 1440x900', async () => {
    for (const size of ['393x659', '390x844', '1440x900']) {
      browse('viewport', size);
      await fresh();
      stubClipboard('ok');
      realPaste(MESSY);
      await sleep(700);
      const r = json(`JSON.stringify((()=>{const r=document.getElementById('copy-rich').getBoundingClientRect();
        return {top:r.top,bottom:r.bottom,vh:innerHeight};})())`);
      ok(r.top >= 0 && r.bottom <= r.vh, size + ': the button is off screen ' + JSON.stringify(r));
    }
  });

  await test('one column at 1440: box 2 sits under box 1, not beside it', () => {
    const r = json(`JSON.stringify({ b1: document.getElementById('input').getBoundingClientRect().bottom,
      b2: document.getElementById('output').getBoundingClientRect().top })`);
    ok(r.b2 > r.b1, 'box 2 is beside box 1: ' + JSON.stringify(r));
    browse('viewport', '393x659');
  });

  await test('REFUSED: it never says Copied, and the button is blue', async () => {
    await fresh();
    stubClipboard('no');
    realPaste(MESSY);
    await sleep(600);
    const b = barNow();
    eq(b.state, 'Not copied yet', 'bar');
    eq(b.button, 'Copy cleaned text', 'button');
    eq(b.primary, true, 'the button is not the dominant thing');
    ok(!/Copied/.test(b.state) && !/copied\./i.test(b.status.replace('Not copied yet', '')),
      'claimed a copy that was refused: ' + b.status);
  });

  await test('HANGS: after the wait it says Not copied yet', async () => {
    await fresh();
    stubClipboard('hang');
    realPaste(MESSY);
    await sleep(2000);
    eq(barNow().state, 'Not copied yet');
  });

  await test('no ClipboardItem: the automatic copy falls back to plain text, and says so', async () => {
    await fresh();
    stubClipboard('ok');
    js('window.__savedCI = window.ClipboardItem; delete window.ClipboardItem; "removed"');
    realPaste(MESSY);
    await sleep(600);
    const b = barNow();
    js('window.ClipboardItem = window.__savedCI; "restored"');
    eq(b.state, '✓ Copied as plain text only', 'bar');
    ok(b.texts.length === 1 && b.texts[0].includes('NAVRATRI'), 'writeText was not given the cleaned text');
  });

  await test('EDIT after a copy: out of date, and no keystroke writes the clipboard', async () => {
    await fresh();
    stubClipboard('ok');
    realPaste(MESSY);
    await sleep(600);
    js(`(()=>{const o=document.getElementById('output');o.innerHTML+='<p>one more line</p>';` +
       `o.dispatchEvent(new Event('input',{bubbles:true}));return 'ok';})()`);
    await sleep(200);
    const b = barNow();
    eq(b.state, 'Edited. Not copied yet', 'bar');
    eq(b.primary, true, 'the button should be the thing to press now');
    eq(b.writes.length, 1, 'an edit wrote to the clipboard');
  });

  await test('TYPING in box 1 cleans but never writes the clipboard', async () => {
    await fresh();
    stubClipboard('ok');
    js(`(()=>{const el=document.getElementById('input');el.value='Diwali Dinner is on Saturday at six';` +
       `el.dispatchEvent(new Event('input',{bubbles:true}));return 'ok';})()`);
    await sleep(800);
    const b = barNow();
    eq(b.writes.length + b.texts.length, 0, 'typing wrote to the clipboard');
    eq(b.state, 'Not copied yet', 'bar');
  });

  await test('TOO LONG: cut, not copied, and the button is blue', async () => {
    await fresh();
    stubClipboard('ok');
    // Built inside the page: 200,001 characters is too long for a command line.
    js(`(()=>{const T='x '.repeat(100001)+'y';const el=document.getElementById('input');el.focus();` +
       `const dt=new DataTransfer();dt.setData('text/plain',T);` +
       `el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));` +
       `el.value=T;return 'ok';})()`);
    await sleep(1200);
    const b = barNow();
    eq(b.writes.length + b.texts.length, 0, 'a cut message was copied without her seeing the warning');
    has(b.state, 'Too long');
    eq(b.primary, true, 'button');
  });

  await test('an OPTION click cleans again and copies again', async () => {
    await fresh();
    stubClipboard('ok');
    realPaste(MESSY);
    await sleep(600);
    js('document.getElementById("opt-straightenQuotes").click(); "clicked"');
    await sleep(600);
    const b = barNow();
    js('document.getElementById("opt-straightenQuotes").click(); "restored"');
    eq(b.writes.length, 2, 'the option change did not copy the new version');
    eq(b.state, '✓ Copied');
  });

  await test('a SECOND message replaces the first instead of joining it', async () => {
    await fresh();
    stubClipboard('ok');
    realPaste('First message about Diwali dinner');
    await sleep(600);
    // A plain paste is inserted by the browser, at the selection. So what matters
    // is that the whole box is selected by the time the browser acts.
    const sel = json(
      `(()=>{const el=document.getElementById('input');el.focus();el.setSelectionRange(el.value.length,el.value.length);` +
      `const dt=new DataTransfer();dt.setData('text/plain','Second message');` +
      `el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));` +
      `const r={start:el.selectionStart,end:el.selectionEnd,len:el.value.length};` +
      `el.setRangeText('Second message',el.selectionStart,el.selectionEnd,'end');return JSON.stringify(r);})()`);
    eq(sel.start, 0, 'selection start');
    eq(sel.end, sel.len, 'selection end');
    await sleep(600);
    const after = json('JSON.stringify({input:document.getElementById("input").value,out:document.getElementById("output").innerText})');
    eq(after.input, 'Second message', 'box 1');
    ok(!/Diwali/.test(after.out), 'the first message rode along into the copy: ' + after.out);
    eq(barNow().state, '✓ Copied', 'the second message was not copied');

    // A rich paste is inserted by the page itself. Same rule.
    // Not pasteRich(), which empties the box first and would prove nothing here.
    js(`(()=>{const el=document.getElementById('input');el.focus();el.setSelectionRange(el.value.length,el.value.length);` +
       `const dt=new DataTransfer();dt.setData('text/html','<p>Third <b>message</b></p>');dt.setData('text/plain','Third message');` +
       `el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));return 'ok';})()`);
    await sleep(600);
    has(json('JSON.stringify(document.getElementById("input").value)'), 'Third');
    ok(!/Second/.test(json('JSON.stringify(document.getElementById("input").value)')), 'the rich paste joined the old one');
  });

  await test('once she has typed in box 1, a paste goes where she put it', async () => {
    js(`(()=>{const el=document.getElementById('input');el.value=el.value+' and a note';` +
       `el.setSelectionRange(el.value.length,el.value.length);return 'typed';})()`);
    const sel = json(
      `(()=>{const el=document.getElementById('input');el.focus();` +
      `const dt=new DataTransfer();dt.setData('text/plain','!');` +
      `el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));` +
      `return JSON.stringify({start:el.selectionStart,len:el.value.length});})()`);
    eq(sel.start, sel.len, 'her own text was selected for replacing');
    await sleep(300);
  });

  await test('the footer is never under the bar', async () => {
    js('window.scrollTo(0, document.documentElement.scrollHeight); "bottom"');
    await sleep(300);
    const r = json(`JSON.stringify({ fine: document.querySelector('footer .fine').getBoundingClientRect().bottom,
      bar: document.getElementById('copybar').getBoundingClientRect().top })`);
    ok(r.fine <= r.bar, 'the bar covers the footer: ' + JSON.stringify(r));
    js('window.scrollTo(0,0); "top"');
  });

  await test('the KEYBOARD hides the bar, and it comes back when it closes', async () => {
    js(`(()=>{Object.defineProperty(visualViewport,'height',{get:()=>250,configurable:true});` +
       `visualViewport.dispatchEvent(new Event('resize'));return 'open';})()`);
    await sleep(100);
    const open = json('JSON.stringify(getComputedStyle(document.getElementById("copybar")).display)');
    js(`(()=>{delete visualViewport.height;visualViewport.dispatchEvent(new Event('resize'));return 'closed';})()`);
    await sleep(100);
    const closed = json('JSON.stringify(getComputedStyle(document.getElementById("copybar")).display)');
    eq(open, 'none', 'the bar floats over the keyboard');
    ok(closed !== 'none', 'the bar did not come back');
  });

  await test('GUARD box 2 and the bar are hidden in the served HTML, so a dead module leaves no dead button', async () => {
    const html = await (await fetch(new URL('/', target).href)).text();
    ok(/id="result"[^>]*\shidden/.test(html), 'box 2 is not hidden in the HTML');
    ok(/id="copybar"[^>]*\shidden/.test(html), 'the copy bar is not hidden in the HTML');
  });

  browse('viewport', '1280x900');
  await fresh();

  /* ------------------------------------------- it degrades instead of dying
   * Raj, 2026-09-18: "this needs to work on all browsers, apple, Android, and
   * everything desktop, iPad, incognito mode."
   *
   * Real Safari and real iOS cannot be driven from here. What CAN be tested is the
   * thing that actually breaks on them: an API that is missing or refuses. So each
   * one is removed and the page is required to cope. */

  await test('INCOGNITO: nothing the tool needs is blocked in private mode', async () => {
    // Private windows disable or throw on all of these. The tool must not touch them.
    const sources = await Promise.all(['/app.js', '/clean.js'].map(async f => {
      const res = await fetch(new URL(f, target).href);
      return { f, text: await res.text() };
    }));
    for (const { f, text } of sources) {
      for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'serviceWorker', 'caches.']) {
        ok(!text.includes(api), `${f} uses ${api}, which private mode can block or throw on`);
      }
    }
  });

  await test('the service worker is optional, never required', async () => {
    const boot = await (await fetch(new URL('/boot.js', target).href)).text();
    ok(/catch\s*\(/.test(boot) || /\.catch\(/.test(boot),
      'service worker registration is not guarded, so a private window would throw on load');
  });

  await test('COPY still works when ClipboardItem is missing (older Safari)', async () => {
    js(`(()=>{const el=document.getElementById('input');el.value='Diwali Dinner is on Saturday at six';` +
       `el.dispatchEvent(new Event('input',{bubbles:true}));return 'ok';})()`);
    await sleep(700);
    js('window.__savedCI = window.ClipboardItem; delete window.ClipboardItem; "removed"');
    js('document.getElementById("copy-rich").click()');
    await sleep(700);
    const status = json('JSON.stringify(document.getElementById("status").textContent)');
    ok(status.length > 0, 'the person was told nothing at all');
    ok(!/undefined|\[object/.test(status), 'the message is broken: ' + status);
    js('window.ClipboardItem = window.__savedCI; "restored"');
  });

  await test('COPY still says something when the clipboard API is refused entirely', async () => {
    js(`(()=>{window.__savedClip = navigator.clipboard;` +
       `Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true});return 'removed';})()`);
    js('document.getElementById("copy-rich").click()');
    await sleep(700);
    const status = json('JSON.stringify(document.getElementById("status").textContent)');
    ok(status.length > 0, 'silent failure: the person is left with nothing');
    ok(/Copied|Copy blocked/i.test(status), 'expected either success or an instruction, got: ' + status);
    js(`Object.defineProperty(navigator,'clipboard',{value:window.__savedClip,configurable:true}); 'restored'`);
  });

  await test('the whole job works at 390px, the way a phone would do it', async () => {
    browse('viewport', '390x844');
    await sleep(300);
    js('document.getElementById("reset").click()');
    await sleep(300);
    js(`(()=>{const el=document.getElementById('input');el.value=${JSON.stringify(MESSY)};` +
       `el.dispatchEvent(new Event('input',{bubbles:true}));return 'ok';})()`);
    await sleep(1200);
    const state = json(`JSON.stringify((()=>{const r=document.getElementById('copy-rich').getBoundingClientRect();
      return { output: document.getElementById('output').innerText.length,
        width: r.width, top: r.top, bottom: r.bottom, vh: innerHeight };})())`);
    ok(state.output > 100, 'nothing cleaned at phone width');
    ok(state.width > 300, 'the copy button is not full width on a phone: ' + state.width);
    ok(state.top >= 0 && state.bottom <= state.vh, 'the copy button is off screen: ' + JSON.stringify(state));
    browse('viewport', '1280x900');
  });

  /* ---------------------------------------------------------- shape */

  await test('no sideways scrolling at 390, 768 or 1280', async () => {
    for (const width of [390, 768, 1280]) {
      browse('viewport', width + 'x844');
      await sleep(250);
      const m = json('JSON.stringify({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth})');
      ok(m.sw <= m.cw, `horizontal overflow at ${width}px: content ${m.sw} vs viewport ${m.cw}`);
    }
    browse('viewport', '1280x900');
  });

  await test('every touch target is at least 44px tall', () => {
    // A checkbox wrapped in a label is not the target: the label is, so measure that.
    /* Controls belonging to the SITE. Links inside #output are part of whatever the
       person pasted: they are body text in their document, and forcing them to 44px
       would wreck the layout of the thing they are about to send. */
    const small = json(`JSON.stringify([...document.querySelectorAll('button, a[href], summary, label.opt, input[type=checkbox]')]
      .filter(el => !el.closest('#output'))
      .filter(el => !(el.tagName === 'INPUT' && el.closest('label')))
      .filter(el => el.offsetParent !== null && el.getBoundingClientRect().height < 44)
      .map(el => (el.textContent||el.id||el.tagName).trim().slice(0,30)))`);
    eq(small.length, 0, 'controls under 44px: ' + JSON.stringify(small));
  });

  await test('the page loads nothing from anywhere else', () => {
    const net = browse('network');
    const foreign = net.split('\n').filter(l => /https?:\/\//.test(l) && !l.includes(new URL(target).host));
    eq(foreign.length, 0, 'third-party requests: ' + foreign.join(' | '));
  });

  /* ---------------------------------------------------------- the other pages */

  /* ------------------------------------------------------- the other tools
   *
   * Same lesson as BUG-005: every bug that has reached a person in this project
   * lived in the page, not in clean.js. These pages share tool.js, so one broken
   * element id would kill both of them at once and test-clean.js would stay green
   * through it. They are driven here for real.
   */

  const TOOL_PAGES = [
    {
      path: 'title-case-converter/',
      heading: 'Title case converter',
      paste: 'the NASA report on iPhone sales',
      expect: 'The NASA Report on iPhone Sales',
      script: '/titlecase.js',
      // Toggling this off turns NASA into Nasa, so the checkbox has something to act on.
      option: { id: 'opt-keepAcronyms', kind: 'checkbox' },
    },
    {
      path: 'remove-line-breaks/',
      heading: 'Remove line breaks from text',
      // The hyphen split is deliberate: the options test toggles dehyphenate, and
      // a toggle with nothing to act on would pass while proving nothing.
      paste: 'This sentence was\nbroken across\nthree lines.\n\nAnd a hyphen-\nated word here.',
      expect: 'This sentence was broken across three lines.\n\nAnd a hyphenated word here.',
      script: '/linebreaks.js',
      option: { id: 'opt-dehyphenate', kind: 'checkbox' },
    },
    {
      path: 'remove-extra-spaces/',
      heading: 'Remove extra spaces from text',
      paste: 'Hello    world  \n\n\n\nsecond\t\tline   ',
      expect: 'Hello world\n\nsecond line',
      script: '/spaces.js',
      option: { id: 'opt-collapseSpaces', kind: 'checkbox' },
    },
    {
      path: 'markdown-to-plain-text/',
      heading: 'Markdown to plain text',
      paste: '## A Heading\n\nSome **bold** text and a [link](https://example.com).\n\n- one\n- two',
      expect: 'A Heading\n\nSome bold text and a link.\n\n• one\n• two',
      script: '/markdown.js',
      option: { id: 'opt-bullets', kind: 'checkbox' },
    },
  ];

  for (const page of TOOL_PAGES) {
    const pageUrl = new URL(page.path, target).href;

    await test(page.path + ' loads and the module starts', async () => {
      browse('goto', pageUrl);
      await sleep(1200);
      ok(json('JSON.stringify(!!window.__cleantextReady)') === true,
        'window.__cleantextReady was never set, so the module did not finish loading');
      eq(json('JSON.stringify(document.getElementById("boot-error").hidden)'), true);
      has(json('JSON.stringify((document.querySelector("h1")||{}).textContent)'), page.heading);
    });

    await test(page.path + ' has every element tool.js reaches for', () => {
      const found = json(`JSON.stringify(['input','output','status','chips','copy','reset','boot-error']
        .reduce((a,id)=>{a[id]=!!document.getElementById(id);return a;},{}))`);
      Object.entries(found).forEach(([id, present]) => ok(present, 'missing element #' + id));
    });

    await test(page.path + ' transforms the text on paste, with no button pressed', async () => {
      js(`(()=>{const el=document.getElementById('input');el.value=${JSON.stringify(page.paste)};` +
         `el.dispatchEvent(new Event('input',{bubbles:true}));return 'ok';})()`);
      await sleep(900);
      eq(json('JSON.stringify(document.getElementById("output").value)'), page.expect);
    });

    await test(page.path + ' reports what it did', () => {
      const chips = json('JSON.stringify([...document.querySelectorAll("#chips .chip")].map(c=>c.textContent))');
      ok(chips.length >= 2, 'expected several chips, got ' + JSON.stringify(chips));
      eq(chips[0], 'Done');
    });

    await test(page.path + ' options actually change the result', async () => {
      const before = json('JSON.stringify(document.getElementById("output").value)');
      js(`(()=>{const el=document.getElementById(${JSON.stringify(page.option.id)});` +
         `el.checked=!el.checked;el.dispatchEvent(new Event('change',{bubbles:true}));return 'ok';})()`);
      await sleep(700);
      const after = json('JSON.stringify(document.getElementById("output").value)');
      ok(before !== after, 'turning ' + page.option.id + ' off changed nothing, so the checkbox is decoration');
    });

    await test(page.path + ' makes no network requests of its own', () => {
      const net = browse('network');
      ok(!/cdn|googleapis|gstatic|analytics|fonts\./i.test(net),
        'a third-party request appeared: ' + net.slice(0, 300));
    });

    await test(page.path + ' links back to the tool and carries the byline', () => {
      const shape = json(`JSON.stringify({
        home: !!document.querySelector('a[href="/"]'),
        byline: (document.querySelector('.fine')||{}).textContent || '',
        canonical: (document.querySelector('link[rel=canonical]')||{}).href || ''
      })`);
      ok(shape.home, 'no link back to the tool');
      has(shape.byline, 'Coding Raj');
      has(shape.canonical, page.path);
    });
  }

  const ALL_TOOLS = ['/', '/tools/', '/remove-line-breaks/', '/remove-extra-spaces/',
                     '/title-case-converter/', '/markdown-to-plain-text/'];

  await test('the homepage links out to every tool', async () => {
    browse('goto', target);
    await sleep(900);
    const links = json('JSON.stringify([...document.querySelectorAll("footer a")].map(a=>a.getAttribute("href")))');
    for (const p of ALL_TOOLS) ok(links.includes(p), 'the homepage does not link to ' + p);
  });

  /* The hub is the only page here with no tool on it, so it gets its own test
   * rather than joining the loop: no module, no #boot-error, nothing to drive.
   * What it has to do is link to everything, or it is just another page. */
  await test('the tools hub lists and links every tool', async () => {
    browse('goto', new URL('tools/', target).href);
    await sleep(900);
    const shape = json(`JSON.stringify({
      h1: (document.querySelector('h1')||{}).textContent,
      links: [...document.querySelectorAll('main a')].map(a=>a.getAttribute('href')),
      headings: document.querySelectorAll('.tool-list h3').length,
      canonical: (document.querySelector('link[rel=canonical]')||{}).href || ''
    })`);
    has(shape.h1, 'All the tools');
    has(shape.canonical, '/tools/');
    for (const p of ALL_TOOLS.filter(x => x !== '/tools/')) {
      ok(shape.links.includes(p), 'the hub does not link to ' + p);
    }
    ok(shape.headings === 5, 'expected 5 tools listed, got ' + shape.headings);
  });

  await test('every tool page links back to the hub', async () => {
    for (const p of ['remove-line-breaks/', 'title-case-converter/']) {
      browse('goto', new URL(p, target).href);
      await sleep(700);
      const links = json('JSON.stringify([...document.querySelectorAll("a")].map(a=>a.getAttribute("href")))');
      ok(links.includes('/tools/'), p + ' does not link to the hub');
    }
  });

  for (const page of ['privacy.html', 'terms.html']) {
    await test(page + ' loads and links back to the tool', async () => {
      browse('goto', new URL(page, target).href);
      await sleep(600);
      const shape = json(`JSON.stringify({
        h1: (document.querySelector('h1')||{}).textContent,
        backLink: !!document.querySelector('a[href="/"]')
      })`);
      ok(shape.h1 && shape.h1.length > 0, 'no h1');
      ok(shape.backLink, 'no link back to the tool');
    });
  }

  /* --------------------------------------------- everything on the site is counted
   * GUARD for BUG-012 — a page that ships without the counter knowing about it.
   *
   * The four tool pages and the hub shipped the day after analytics did, and
   * nothing connected the two: they were routed nowhere, and the page predicate
   * asked for `.html` while a tool page's URL is a directory. For two days the
   * growth bet of the project was the only part of the site with no numbers, and
   * the stats page showed four pages as though that were all of it.
   *
   * The class: a list of pages, written once, in a site that keeps growing. So the
   * guard is against the SITEMAP, which is the one list that has to be right for
   * other reasons, and it fails the moment a new page is added to it. */
  await test('every page in the sitemap is counted (BUG-012)', async () => {
    const { countsAsPageView, config } = await import('../netlify/edge-functions/count.js');
    const sitemap = readFileSync(join(root, 'public', 'sitemap.xml'), 'utf8');
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(m[1]).pathname);

    ok(locs.length >= 8, 'the sitemap looks empty, found ' + locs.length + ' urls');

    // excludedPath wins over path, so a page caught by it is never counted.
    const excluded = (Array.isArray(config.excludedPath) ? config.excludedPath : [config.excludedPath])
      .map(pat => new RegExp('^' + pat.split('*').map(x => x.replace(/\./g, '\.')).join('.*') + '$'));

    for (const path of locs) {
      ok(countsAsPageView(path), path + ' is in the sitemap and would NOT be counted as a page view');
      const hit = excluded.find(re => re.test(path));
      ok(!hit, path + ' is in the sitemap and is excluded from the counter by ' + hit);
    }
  });

  await test('one page has one name in the counters', async () => {
    const { canonicalPath, countsAsPageView } = await import('../netlify/edge-functions/count.js');
    eq(canonicalPath('/index.html'), '/', 'the home page under two names');
    eq(canonicalPath('/tools/index.html'), '/tools/', 'the hub under two names');
    eq(canonicalPath('/'), '/', 'left alone');
    eq(canonicalPath('/privacy.html'), '/privacy.html', 'a real .html page is not a directory index');
    ok(countsAsPageView(canonicalPath('/index.html')), 'the folded home page stopped counting');
  });

  /* THE BLAST RADIUS of BUG-012, closed rather than noted.
   *
   * The counter was not the only hand-written list of the pages. `sw.js` has an
   * ASSETS array, `sitemap.xml` has a urlset, and the hub has a set of links. Each
   * one is written once by a person and each one silently goes stale the next time
   * a tool ships. Three of the four happened to be right the day this was written,
   * and "happened to be right" is not a property worth relying on.
   *
   * So the filesystem is the list, and every other list has to agree with it. */
  await test('a tool page that exists is in the sitemap, the worker and the hub', async () => {
    const publicDir = join(root, 'public');
    const pages = readdirSync(publicDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && existsSync(join(publicDir, e.name, 'index.html')))
      .map(e => '/' + e.name + '/');

    ok(pages.length >= 5, 'expected the four tool pages and the hub, found ' + pages.join(', '));

    const sitemap = readFileSync(join(publicDir, 'sitemap.xml'), 'utf8');
    const worker = readFileSync(join(publicDir, 'sw.js'), 'utf8');
    const hub = readFileSync(join(publicDir, 'tools', 'index.html'), 'utf8');

    for (const page of pages) {
      ok(sitemap.includes(page + '</loc>'), page + ' exists but is not in sitemap.xml, so nothing will crawl it');
      ok(worker.includes("'" + page + "'"), page + ' exists but is not precached in sw.js, so it breaks offline');
      if (page !== '/tools/') {
        ok(hub.includes('href="' + page + '"'), page + ' exists but the hub does not link to it');
      }
    }
  });

  await test('assets and the stats page are not counted as pages', async () => {
    const { countsAsPageView } = await import('../netlify/edge-functions/count.js');
    for (const path of ['/app.js', '/style.css', '/og.png', '/favicon.svg', '/sitemap.xml', '/robots.txt']) {
      ok(!countsAsPageView(path), path + ' would be counted as a page view');
    }
    ok(!countsAsPageView('/stats'), '/stats would be counted');
    ok(!countsAsPageView('/stats/'), '/stats/ would be counted');
  });

  /* ---------------------------------------------------------- the private page
   * Only meaningful against a deployed URL: the edge function that guards it does
   * not run in front of a local static server. */
  if (!useLocalServer) {
    await test('the stats page is a 404 without a token', async () => {
      const res = await fetch(new URL('/stats', target).href, { redirect: 'manual' });
      eq(res.status, 404, 'no token');
    });

    await test('the stats page is a 404 with a wrong token', async () => {
      const res = await fetch(new URL('/stats?t=definitely-not-the-token', target).href, { redirect: 'manual' });
      eq(res.status, 404, 'wrong token');
    });

    await test('the stats page is never indexed and never cached', async () => {
      const res = await fetch(new URL('/stats', target).href, { redirect: 'manual' });
      has((res.headers.get('x-robots-tag') || ''), 'noindex');
      has((res.headers.get('cache-control') || ''), 'no-store');
    });

    /* GUARD for BUG-008 — a stale script in the service worker cache must not be
     * able to kill the page.
     *
     * The failure this reproduces: a returning visitor arrives just after a
     * deploy, the OLD worker is still controlling the page, the navigation is
     * network-first so they get the NEW html, and the html asks for an export the
     * cached clean.js does not have. Module throws, page dead.
     *
     * So this poisons the worker's own cache with exactly that — a clean.js
     * missing the export the page needs — and then reloads. The page has to boot
     * anyway. It only runs against a deployed site, because that is the only
     * place a real service worker is in front of the page. */
    await test('a stale script in the worker cache cannot kill the page (BUG-008)', async () => {
      const toolUrl = new URL('remove-line-breaks/', target).href;
      browse('goto', toolUrl);
      await sleep(1800);

      js(`(() => { window.__poison = 'running';
        (async () => {
          await navigator.serviceWorker.ready;
          const names = await caches.keys();
          if (!names.length) { window.__poison = 'no cache'; return; }
          const c = await caches.open(names[0]);
          await c.put('/clean.js', new Response('export const nothing = 1;',
            { headers: { 'content-type': 'text/javascript' } }));
          window.__poison = 'done';
        })();
        return 'ok'; })()`);
      await sleep(2000);

      const state = json('JSON.stringify(window.__poison)');
      ok(state === 'done', 'could not poison the cache to run the test, state was ' + state);

      browse('goto', toolUrl);
      await sleep(2000);

      ok(json('JSON.stringify(!!window.__cleantextReady)') === true,
        'the page did not boot with a stale clean.js in the worker cache — BUG-008 is back');
      eq(json('JSON.stringify(document.getElementById("boot-error").hidden)'), true,
        'the failure box is showing');
      eq(json('JSON.stringify(typeof document.getElementById("input"))'), 'object');
    });

    /* GUARD for BUG-012, the other half — routing that only LOOKS right.
     *
     * The predicate guard above is offline reasoning about a config object. This
     * one asks the deployed edge whether a real request on a real tool page
     * actually lands in the counters, because the thing that failed was Netlify's
     * routing, not anyone's reasoning about it. Both halves are needed: the config
     * can be right and the platform still not route it.
     *
     * It needs the token, which lives only in Netlify. ops/deploy.mjs fetches it
     * and passes it in, so the deploy path never skips. A manual run without it
     * says so LOUDLY rather than quietly reporting green.
     *
     * The two requests it makes are honest ones: they are unmarked, they say they
     * are a bot in the user agent, and they land in the "other bots" bucket. */
    const statsToken = process.env.STATS_TOKEN;
    if (!statsToken) {
      console.log('  !  SKIPPED: "a real hit on a page is counted" needs STATS_TOKEN in the environment');
      skipped.push('a real hit on a page is counted (no STATS_TOKEN)');
    } else {
      await test('a real navigation is counted, a precache and a test hit are not (BUG-012)', async () => {
        const statsUrl = new URL('/stats?json=1&t=' + encodeURIComponent(statsToken), target).href;
        const readCounts = async () => {
          const res = await fetch(statsUrl, { headers: { 'user-agent': 'cleantext-deploy-guard/1.0 (bot)' } });
          eq(res.status, 200, 'the stats token was refused');
          const data = await res.json();
          const paths = {};
          (data.days || []).forEach(d => Object.entries(d.paths || {}).forEach(([k, n]) => {
            paths[k] = (paths[k] || 0) + n;
          }));
          return paths;
        };
        const settle = async (check) => {
          let counts = await readCounts();
          for (let attempt = 0; attempt < 12 && !check(counts); attempt++) {
            await sleep(1200);
            counts = await readCounts();
          }
          return counts;
        };

        const page = '/remove-extra-spaces/';
        const before = await readCounts();

        /* Clear the worker first, so navigating REINSTALLS it and the precache runs.
         * That is the point: the precache fetches every page on the site with the
         * visitor's own user agent, and only the page actually navigated to may be
         * counted. One person landing here is one view, not nine. */
        js('navigator.serviceWorker.getRegistrations()' +
           '.then(rs => Promise.all(rs.map(r => r.unregister())))' +
           '.then(() => caches.keys())' +
           '.then(ks => Promise.all(ks.map(k => caches.delete(k)))); "clearing"');
        await sleep(1200);

        browse('goto', new URL(page + '?countme=1', target).href);
        await sleep(3500);   // let the worker install and precache the whole set

        const after = await settle(c => (c[page] || 0) > (before[page] || 0));
        ok((after[page] || 0) > (before[page] || 0),
          page + ' was opened in a real browser and never appeared in the counters');

        /* /terms.html was fetched by the precache during that navigation and was
         * never visited. If it moved, every visitor is counting themselves as a
         * reader of every page on the site. */
        eq(after['/terms.html'] || 0, before['/terms.html'] || 0,
          'the service worker precache is being counted as page views');

        /* NOW THE WORKER IS INSTALLED, and this is the half that BUG-014 lived in.
         *
         * A service worker re-issues the navigation with `fetch(event.request)`,
         * and `Sec-Fetch-Dest` does not survive that: it arrives as `empty`, the
         * same value the precache sends. Filtering on it made every returning
         * visitor invisible — everyone after their first visit — while the numbers
         * carried on looking plausible. The first half of this test passed
         * throughout, because it clears the worker before it navigates.
         *
         * So: navigate again, controlled this time, and it must still count. */
        eq(json('JSON.stringify(!!navigator.serviceWorker.controller)'), true,
          'the worker never took control, so the returning-visitor case was not tested');

        const second = '/remove-line-breaks/';
        const beforeSecond = await readCounts();
        browse('goto', new URL(second + '?countme=1', target).href);
        await sleep(2500);
        const afterSecond = await settle(c => (c[second] || 0) > (beforeSecond[second] || 0));
        ok((afterSecond[second] || 0) > (beforeSecond[second] || 0),
          second + ' was navigated to with the service worker controlling and was NOT counted: '
          + 'every returning visitor is invisible (BUG-014)');

        /* And one page keeps one name. `/index.html` is the same page as `/`, and
         * the table listed them as two rows, so the busiest page on the site was
         * split in half and neither number was the real one. */
        const beforeIndex = await readCounts();
        browse('goto', new URL('/index.html?countme=1', target).href);
        await sleep(2500);
        const afterIndex = await settle(c => (c['/'] || 0) > (beforeIndex['/'] || 0));
        ok((afterIndex['/'] || 0) > (beforeIndex['/'] || 0), '/index.html was not folded into /');
        eq(afterIndex['/index.html'] || 0, beforeIndex['/index.html'] || 0,
          '/index.html is still being counted as a page of its own');

        // And the marker still works, or this suite inflates its own numbers.
        const beforeMarked = await readCounts();
        browse('goto', new URL(page, target).href);   // marked by browse()
        await sleep(3000);
        const afterMarked = await readCounts();
        eq(afterMarked[page] || 0, beforeMarked[page] || 0,
          'a request marked uitest was counted, so this suite is inventing visitors');
      });
    }

    await test('counting does not change the page that is served', async () => {
      const res = await fetch(new URL('/', target).href);
      const html = await res.text();
      ok(html.includes('id="input"') && html.includes('id="output"'), 'the tool markup survived the edge function');
      ok(!html.includes('STATS_TOKEN'), 'no secret leaked into the page');
    });
  }

} finally {
  if (server) server.kill();
}

const total = passed + failures.length;
if (failures.length) {
  console.log('\nUI FAIL  ' + failures.length + ' of ' + total + '\n');
  failures.forEach(f => console.log('  x ' + f.name + '\n    ' + f.message + '\n'));
  process.exit(1);
} else {
  console.log('UI PASS  ' + passed + '/' + total + ' browser tests green');
}
if (skipped.length) {
  console.log('\nUI SKIPPED  ' + skipped.length + ' test(s) did not run:');
  skipped.forEach(name => console.log('  ! ' + name));
}
