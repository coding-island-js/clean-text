/**
 * app.js — the only file allowed to touch the DOM.
 *
 * All cleaning logic lives in clean.js, which knows nothing about a page.
 * See .claude/memory/law-clean-js-is-pure.md
 *
 * The flow (D46, docs/DESIGN-simple-flow.md): one box on the first screen. Paste,
 * and it cleans, shows the result, and tries to copy it. A bar pinned to the
 * bottom edge says whether the copy really happened and holds the one button.
 */

import { clean, LIMIT } from './clean.js';
import { htmlToText } from './richtext.js';

const $ = id => document.getElementById(id);

/* Attach a listener only if the element is actually there.
 *
 * Without this, one missing element throws on module load and the ENTIRE tool dies
 * silently: no error on screen, every button inert, and a visitor with no idea why.
 * That happened for real on 2026-09-17 when a cached app.js met newer HTML. The
 * cache headers are the fix; this is the blast radius, so the same shape of mismatch
 * degrades to "one control does nothing" instead of "nothing works". */
function on(el, type, fn) {
  if (el) el.addEventListener(type, fn);
}

const input     = $('input');
const output    = $('output');
const status    = $('status');
const btnRich   = $('copy-rich');
const btnPlain  = $('copy-plain');
const btnUndo   = $('undo');
const btnReset  = $('reset');
const chipBox   = $('chips');
const noteBox   = $('note');
const resultBox = $('result');
const changed   = $('changed');
const statsBox  = $('stats');
const bar       = $('copybar');
const copyState = $('copy-state');
const tool      = $('tool');

const OPTION_IDS = ['unwrap', 'headings', 'lists', 'labels', 'links', 'stripTracking', 'straightenQuotes'];

/* How long an automatic copy may take before the page stops waiting and says it
 * did not happen. A design value from docs/DESIGN-simple-flow.md, checked in UAT. */
const AUTO_COPY_WAIT = 1500;

let lastCleanHtml = '';   // what the cleaner produced, before any hand edits
let edited = false;
let richPaste = null;     // stats from the last paste that arrived with formatting
let movedToBox1 = false;  // the last paste landed in box 2 and was sent to box 1
let lastStats = null;     // what the cleaner counted, for the sentence read aloud
let lastPrefix = '';      // "Formatting kept..." and the like, for the same sentence
let landedValue = '';     // box 1 exactly as the last paste left it, to spot a second message

/* Bumped whenever what is in box 2 changes. A clipboard answer that arrives late
 * checks it, so a copy of an OLD result can never be reported as a copy of this one. */
let copyGen = 0;

/* ---------------------------------------------------------------- */

function options() {
  const o = {};
  OPTION_IDS.forEach(k => {
    const el = $('opt-' + k);
    if (el) o[k] = el.checked;
  });
  return o;
}

/* The live region carries the full sentence for screen readers. What is on screen
 * is short, because nobody reads it. Raj, 2026-09-28: "no one's going to really
 * read the instructions". */
function announce(message) {
  status.textContent = message;
}

function showChips(box, items) {
  if (!box) return;
  box.textContent = '';
  items.forEach(item => {
    const el = document.createElement('span');
    el.className = 'chip' + (item.tone ? ' ' + item.tone : '');
    el.textContent = item.label;
    box.appendChild(el);
  });
}

/* Something went wrong BEFORE there was a result: nothing arrived, nothing to copy,
 * the cleaner threw. It sits right under the box, where she is looking. */
function note(message, short) {
  announce(message);
  showChips(noteBox, short ? [{ label: short, tone: 'warn' }] : []);
}

// What actually changed, in numbers that are real. No number appears here or on a
// chip that was not counted by the cleaner.
function statBits(stats) {
  const bits = [];
  if (stats.mojibake)   bits.push('garbled characters repaired');
  if (stats.invisibles) bits.push(stats.invisibles + ' invisible character' + s(stats.invisibles) + ' removed');
  if (stats.oddSpaces)  bits.push(stats.oddSpaces + ' odd space' + s(stats.oddSpaces) + ' fixed');
  if (stats.junkLines)  bits.push(stats.junkLines + ' junk line' + s(stats.junkLines) + ' removed');
  if (stats.joins)      bits.push(stats.joins + ' line' + s(stats.joins) + ' rejoined');
  if (stats.headings)   bits.push(stats.headings + ' heading' + s(stats.headings));
  if (stats.listItems)  bits.push(stats.listItems + ' list item' + s(stats.listItems));
  if (stats.labels)     bits.push(stats.labels + ' label' + s(stats.labels) + ' bolded');
  if (stats.links)      bits.push(stats.links + ' link' + s(stats.links));
  return bits;
}

const s = n => (n === 1 ? '' : 's');

function summary() {
  const bits = lastStats ? statBits(lastStats) : [];
  return bits.length ? bits.join(', ') + '.' : 'It was already tidy.';
}

const LIMIT_TEXT = LIMIT.toLocaleString('en-US');

/* ------------------------------------------------------------ the copy bar
 *
 * The one button lives here, pinned to the bottom edge, so it is on screen at
 * whatever height Safari leaves (D46). The line above it says what is true right
 * now. It says "Copied" ONLY when the browser confirmed the write: a copy that
 * failed and said nothing is the one failure a person cannot see (D7, CET-9).
 *
 * `done` means the job is finished: the button steps back to "Copy again" and
 * stops being blue, because blue points at the thing to do next (CET-5).
 */
function setBar(text, tone, done) {
  if (!bar) return;
  bar.hidden = false;
  document.body.classList.add('has-bar');
  copyState.textContent = text;
  copyState.className = 'copy-state' + (tone ? ' ' + tone : '');
  btnRich.textContent = done ? 'Copy again' : 'Copy cleaned text';
  btnRich.classList.toggle('primary', !done);
  sizeBar();
}

function hideBar() {
  if (!bar) return;
  bar.hidden = true;
  document.body.classList.remove('has-bar');
}

// The page gets padding the height of the bar, so the footer is never under it.
function sizeBar() {
  if (!bar || bar.hidden) return;
  document.body.style.setProperty('--bar-h', bar.offsetHeight + 'px');
}

function stateCopied(kind) {
  if (kind === 'plain') {
    setBar('✓ Copied as plain text only', 'warn', true);
    announce(lastPrefix + 'Cleaned and copied as plain text. This browser would not take the formatted version. ' + summary());
  } else {
    setBar('✓ Copied', 'good', true);
    announce(lastPrefix + 'Cleaned and copied. ' + summary() + ' Paste it wherever you need it.');
  }
}

function stateNotCopied() {
  setBar('Not copied yet', null, false);
  announce(lastPrefix + 'Cleaned. ' + summary() + ' Not copied yet. Press Copy cleaned text.');
}

function stateTooLong() {
  setBar('Too long. Only the first ' + LIMIT_TEXT + ' characters', 'warn', false);
  announce('Too long. Only the first ' + LIMIT_TEXT + ' characters were cleaned. Not copied.');
}

/* Start a clipboard write NOW, synchronously, while the paste or tap that caused it
 * is still the current user action. WebKit refuses a write outside one, and the
 * clean itself runs a tick later, by which point any permission the paste carried
 * may be gone. Layers 1 and 2 of D7 only: layer 3 needs a selection the person did
 * not make. Resolves to 'rich' or 'plain'. Null means there is no API at all. */
function startWrite(html, text) {
  try {
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      return navigator.clipboard.write([new ClipboardItem({
        'text/html':  new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })]).then(() => 'rich');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => 'plain');
    }
  } catch (e) { /* a synchronous throw is a refusal like any other */ }
  return null;
}

/* Wait for a write and report what actually happened. If it has not answered in
 * AUTO_COPY_WAIT, say it did not copy and hand her the button. If it answers after
 * that and box 2 still holds the same result, the bar is corrected to Copied. */
function watchCopy(pending) {
  const gen = copyGen;
  if (!pending) { stateNotCopied(); return; }
  setBar('Copying…', null, true);
  let settled = false;
  const timer = setTimeout(() => { if (!settled && gen === copyGen) stateNotCopied(); }, AUTO_COPY_WAIT);
  pending.then(
    kind => { settled = true; clearTimeout(timer); if (gen === copyGen) stateCopied(kind); },
    ()   => { settled = true; clearTimeout(timer); if (gen === copyGen) stateNotCopied(); });
}

// The plain text of a piece of cleaned HTML, without touching the page. A template
// is inert: nothing in it loads or runs.
function textOf(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  return domToText(t.content);
}

/* ---------------------------------------------------------------- */

/* A failure AFTER the module has started.
 *
 * boot.js covers the module never starting: it watches for `__cleantextReady` and
 * reveals the red box if the flag never appears. It cannot cover this one, because
 * by then the flag is set and its error listener has stood down. So a throw inside
 * the cleaner produced an empty box 2 and complete silence — which is the exact
 * thing a person cannot tell apart from "I pasted wrong". See BUG-011.
 *
 * The real message goes on screen. A person on a phone can screenshot a sentence;
 * they cannot screenshot a console. */
function showFailure(headline, detail) {
  const box = $('boot-error');
  if (box) {
    const first = box.querySelector('p');
    if (first) {
      first.textContent = '';
      const strong = document.createElement('strong');
      strong.textContent = headline;
      first.appendChild(strong);
      first.appendChild(document.createTextNode(
        ' Your text is safe, nothing was sent anywhere. Reload the page and try again.'));
    }
    const detailBox = $('boot-error-detail');
    if (detailBox) detailBox.textContent = detail ? String(detail).slice(0, 200) : '';
    box.hidden = false;
    box.scrollIntoView({ block: 'nearest' });
  }
  // No result means nothing to copy: no box 2 and no button (S7).
  copyGen++;
  if (resultBox) resultBox.hidden = true;
  hideBar();
  note('Something went wrong while cleaning that. Your text is safe and nothing was sent anywhere.',
       'Something went wrong');
}

// Back to the first screen: one box, nothing else.
function clearResult() {
  copyGen++;
  output.innerHTML = '';
  lastCleanHtml = '';
  lastStats = null;
  lastPrefix = '';
  landedValue = '';
  richPaste = null;
  movedToBox1 = false;
  setEdited(false);
  showChips(chipBox, []);
  showChips(statsBox, []);
  if (changed) changed.hidden = true;
  if (resultBox) resultBox.hidden = true;
  if (tool) tool.classList.remove('pasted');
  hideBar();
}

/* Clean box 1 into box 2 and show it. It says nothing about copying: the caller
 * knows whether this was a paste (copy it), typing (do not) or a click (copy it). */
function runClean() {
  const raw = input.value;
  showChips(noteBox, []);
  if (!raw.trim()) {
    clearResult();
    announce('');
    return null;
  }

  let result;
  try {
    result = clean(raw, options());
  } catch (e) {
    showFailure('The cleaner hit a problem with that text.', e && e.message);
    return null;
  }

  copyGen++;
  output.innerHTML = result.html;
  lastCleanHtml = result.html;
  lastStats = result.stats;
  setEdited(false);
  if (resultBox) resultBox.hidden = false;

  /* Say when the formatting survived. A person who pastes a formatted article has
   * every reason to expect it was all thrown away, because on every other tool of
   * this kind it is. One chip is enough to tell them it was not. */
  const kept = richPaste;
  const moved = movedToBox1;
  richPaste = null;
  movedToBox1 = false;
  lastPrefix = (moved ? 'That went into the paste box. ' : '') +
               (kept ? 'Formatting kept from the page. ' : '');

  showChips(chipBox, []
    .concat(moved ? [{ label: 'Moved to the paste box', tone: 'good' }] : [])
    .concat(kept ? [{ label: 'Formatting kept', tone: 'good' }] : []));

  // The counts are one tap away, not on screen. Nobody needs them to succeed.
  const bits = statBits(result.stats);
  showChips(statsBox, bits.map(b => ({ label: b })));
  if (changed) changed.hidden = !bits.length;

  return result;
}

/* Copy what was just cleaned, as part of the action that cleaned it. */
function copyResult(result, pending) {
  if (result.stats.truncated) { stateTooLong(); return; }
  watchCopy(pending === undefined ? startWrite(result.html, domToText(output)) : pending);
}

/* After a paste: close the keyboard, hand focus to the button, and bring box 2
 * into view. On an iPhone the keyboard stays up after a paste and covers the
 * bottom of the screen, which is the likely reason the button looked "below the
 * fold" (D46). Not yet confirmed on a real phone: UAT step 3. */
function land() {
  if (tool) tool.classList.add('pasted');
  input.blur();
  if (bar && !bar.hidden) btnRich.focus({ preventScroll: true });
  reveal();
}

/* Box 2 to the top of the view, at every width, unless it is already near there.
 * Measured at 393x659: left where it lands, only about 100px of the result showed
 * above the bar. CET-2. */
function reveal() {
  if (!resultBox || resultBox.hidden) return;
  const r = resultBox.getBoundingClientRect();
  if (r.top >= 0 && r.top < window.innerHeight * 0.25) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  resultBox.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
}

function setEdited(value) {
  edited = value;
  // Hidden, not disabled, until there is an edit to undo. A control you cannot use
  // reads as a label (CET-3), and nobody reads labels.
  btnUndo.hidden = !value;
}

/* ------------------------------------------------- plain text from the DOM
 * Copying has to take her edits, not the version the cleaner produced (S6),
 * so the plain text is serialised from what is on screen right now.
 */
function domToText(root) {
  const out = [];

  root.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent.trim();
      if (t) out.push(t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName.toLowerCase();

    if (tag === 'ul' || tag === 'ol') {
      const items = [...node.querySelectorAll(':scope > li')];
      out.push(items.map((li, i) => (tag === 'ol' ? (i + 1) + '. ' : '• ') + blockText(li)).join('\n'));
      return;
    }
    if (tag === 'hr') { out.push('---'); return; }
    if (tag === 'br') { return; }

    const text = blockText(node);
    if (text) out.push(text);
  });

  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

// A block's own text, with <br> kept as a real line break.
function blockText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  return clone.textContent.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
}

/* ------------------------------------------------------------- clipboard
 * The button. Three layers, because a clipboard that fails silently is the one
 * failure a person cannot see and cannot work around. A tap is a real user action,
 * so all three are allowed here (D7).
 */
async function copy(asRich) {
  copyGen++;              // anything still pending from the automatic copy is now stale
  const html = output.innerHTML.trim();
  const text = domToText(output);

  if (!text) { note('There is nothing to copy yet. Paste something in the box.', 'Nothing to copy yet'); return; }

  // 1. Both flavours in one write. The target app takes whichever it accepts.
  if (asRich && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html':  new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })]);
      setBar('✓ Copied', 'good', true);
      announce('Copied with formatting. Paste it wherever you need it.');
      return;
    } catch (e) { /* fall through */ }
  }

  // 2. Plain text through the async API.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      setBar(asRich ? '✓ Copied as plain text only' : '✓ Copied as plain text', asRich ? 'warn' : 'good', true);
      announce(asRich ? 'Copied as plain text. This browser would not take the formatted version.' : 'Copied as plain text.');
      return;
    } catch (e) { /* fall through */ }
  }

  // 3. The old way, then telling her plainly if even that failed.
  if (legacyCopy(asRich ? output : text)) {
    setBar('✓ Copied', 'good', true);
    announce('Copied.');
    return;
  }

  selectOutput();
  setBar('Copy blocked. Text is selected', 'warn', false);
  announce('Copy blocked. The text is selected, so you can copy it yourself.');
}

function legacyCopy(target) {
  try {
    if (typeof target === 'string') {
      const scratch = document.createElement('textarea');
      scratch.value = target;
      scratch.setAttribute('readonly', '');
      scratch.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(scratch);
      scratch.select();
      const done = document.execCommand('copy');
      scratch.remove();
      return done;
    }
    selectOutput();
    return document.execCommand('copy');
  } catch (e) { return false; }
}

function selectOutput() {
  const range = document.createRange();
  range.selectNodeContents(output);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/* ---------------------------------------------------------------- wiring */

on(btnRich,  'click', () => copy(true));
on(btnPlain, 'click', () => copy(false));

// A tap, so a real user action: put the cleaned version back AND copy it (S5).
on(btnUndo, 'click', () => {
  output.innerHTML = lastCleanHtml;
  setEdited(false);
  copyGen++;
  const gen = copyGen;
  const pending = startWrite(lastCleanHtml, domToText(output));
  if (!pending) { setBar('Edits undone. Not copied yet', null, false); announce('Your edits are undone. Not copied yet.'); return; }
  setBar('Copying…', null, true);
  pending.then(
    () => { if (gen === copyGen) { setBar('✓ Copied. Edits undone', 'good', true); announce('Your edits are undone, and the cleaned version is copied.'); } },
    () => { if (gen === copyGen) { setBar('Edits undone. Not copied yet', null, false); announce('Your edits are undone. Not copied yet.'); } });
});

on(btnReset, 'click', () => {
  input.value = '';
  clearResult();
  showChips(noteBox, []);
  announce('');
  if (input) input.focus();
});

/* ------------------------------------------------------------- rich paste
 *
 * Box 1 is a textarea, so the browser hands it the text/plain flavour of the
 * clipboard and drops the text/html one on the floor — with every link in it,
 * because an anchor's URL lives in the href and never in the words on screen.
 * Raj found this on 2026-09-18 copying from espn.com. Every browser does it.
 *
 * So the HTML flavour is read here, before the default paste happens, and
 * richtext.js turns it into the plain-text dialect clean.js already understands.
 * Nothing about it reaches the page as markup: what goes into the textarea is
 * text, and clean.js escapes every character of it on the way back out.
 *
 * It degrades in the only direction that is safe. No clipboardData, no HTML
 * flavour, or nothing worth keeping in it, and the browser's ordinary paste runs
 * exactly as it did before. See BUG-009.
 */
function htmlFlavour(event) {
  try {
    const data = event.clipboardData || window.clipboardData;
    if (!data || typeof data.getData !== 'function') return '';
    return data.getData('text/html') || '';
  } catch (e) { return ''; }
}

function plainFlavour(event) {
  try {
    const data = event.clipboardData || window.clipboardData;
    return (data && typeof data.getData === 'function' && data.getData('text/plain')) || '';
  } catch (e) { return ''; }
}

function insertAtCursor(el, text) {
  if (typeof el.setRangeText === 'function') {
    const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
    const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
    el.setRangeText(text, start, end, 'end');
    return;
  }
  el.value += text;
}

// What box 1 WILL hold once the browser's own paste lands, worked out before it does.
function afterPlainPaste(el, text) {
  const v = el.value;
  const start = typeof el.selectionStart === 'number' ? el.selectionStart : v.length;
  const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : v.length;
  return v.slice(0, start) + text + v.slice(end);
}

/* There is no Clean button, so the input cleans itself. A paste is the whole job
 * in one action: it cleans, copies, and moves to the result. Typing and editing
 * are debounced, and never copy, because nobody wants the clipboard overwritten
 * mid-sentence. */
on(input, 'paste', e => {
  richPaste = null;
  let predicted = null;

  /* A SECOND message replaces the first. Box 1 still holds the last paste, and a
   * person who does not read taps the box and pastes the next one, which used to
   * land beside the first, so both were cleaned and copied as one. So if box 1 is
   * exactly as the last paste left it, the whole of it is selected and the paste
   * replaces it. Once she has typed in it herself, the paste goes where she put it. */
  if (landedValue && input.value === landedValue && typeof input.setSelectionRange === 'function') {
    input.setSelectionRange(0, input.value.length);
  }

  const html = htmlFlavour(e);
  if (html) {
    let rich = null;
    try { rich = htmlToText(html); } catch (err) { rich = null; }
    if (rich && rich.text) {
      e.preventDefault();
      try { insertAtCursor(input, rich.text); }
      catch (err) { input.value += rich.text; }
      richPaste = rich.stats;
      predicted = input.value;
    }
  }

  /* The copy has to START here, inside the paste, not a tick later (D46). So the
   * text box 1 is about to hold is cleaned now, and the write begins with that.
   * The page then cleans for real, and if the two ever disagree the write is not
   * trusted and the bar says "Not copied yet". A plain paste is still left to the
   * browser: nothing is cancelled that there is nothing to replace (BUG-009). */
  if (predicted === null) {
    const plain = plainFlavour(e);
    // A textarea stores every line ending as \n, so the prediction has to as well.
    if (plain) predicted = afterPlainPaste(input, plain.replace(/\r\n?/g, '\n'));
  }
  let expected = null;
  let pending = null;
  if (predicted && predicted.trim()) {
    try {
      expected = clean(predicted, options());
      if (!expected.stats.truncated) pending = startWrite(expected.html, textOf(expected.html));
    } catch (err) { expected = null; pending = null; }
  }

  /* setRangeText fires no input event, so this is the only thing that runs the
   * clean after a rich paste. It is also what runs it after an ordinary one.
   *
   * And if the box is STILL empty afterwards, the paste never landed here — a long
   * press that caught the page instead of the box, or a clipboard the browser
   * refused to hand over. That has to be said out loud, where she is looking.
   * BUG-011. */
  const before = input.value;
  setTimeout(() => {
    if (!input.value.trim() && !before.trim()) {
      note('Nothing arrived from the clipboard. Tap inside the paste box, then paste again.',
           'Nothing arrived. Tap the box, then Paste.');
      return;
    }
    const result = runClean();
    if (!result) return;
    const matches = expected && pending && expected.html === result.html;
    copyResult(result, matches ? pending : null);
    landedValue = input.value;
    land();
  }, 0);
});

let typingTimer = null;
on(input, 'input', e => {
  if (e.inputType === 'insertFromPaste') return;      // the paste handler has it
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    const result = runClean();
    if (!result) return;
    if (result.stats.truncated) stateTooLong(); else stateNotCopied();
  }, 350);
});

// An edit to box 2 makes any earlier copy out of date. Say so, and let the button
// copy the new version: a keystroke must never overwrite the clipboard (S4).
on(output, 'input', () => {
  copyGen++;
  const first = !edited;
  setEdited(true);
  setBar('Edited. Not copied yet', 'warn', false);
  if (first) announce('Edited. Not copied yet.');
});

/* ------------------------------------------------- a paste into the WRONG box
 *
 * Box 2 is contenteditable, because the user has to be able to fix a word before
 * copying (S6). That also means it takes a paste. A tester pasted into one box
 * and then the other on an iPhone, and the second paste did nothing, said nothing,
 * and left the source's own markup sitting in the result — `font-size:18pt;
 * color:#c00` on its way into Club Express. See BUG-010.
 *
 * Box 2 is now hidden until there is a result (D46), which removes the cause at
 * the layout level. The handler stays, because a guard is never deleted, and
 * because she can still empty box 2 by hand and paste into it.
 *
 *   box 2 EMPTY      -> she meant the paste box. Put it there, clean it and copy
 *                       it. Nothing is lost, because there was nothing in the box.
 *   box 2 HAS HER TEXT -> she is editing. Leave it where she put it, but insert
 *                       PLAIN TEXT so the source's fonts and colours cannot ride
 *                       in, and say plainly that this part was not cleaned.
 */
function clipboardText(event) {
  const html = htmlFlavour(event);
  if (html) {
    try {
      const rich = htmlToText(html);
      if (rich.text) return rich.text;
    } catch (e) { /* fall through to the plain flavour */ }
  }
  return plainFlavour(event);
}

// Insert at the caret in a contenteditable, keeping the browser's own undo stack.
// execCommand is deprecated and is still the only thing that does this everywhere,
// iOS Safari included. The Selection fallback is for whenever that stops being true.
function insertPlainAtCaret(text) {
  try {
    if (document.execCommand && document.execCommand('insertText', false, text)) return true;
  } catch (e) { /* fall through */ }
  try {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    output.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  } catch (e) { return false; }
}

on(output, 'paste', e => {
  const text = clipboardText(e);
  if (!text) return;                      // nothing usable: let the browser do it

  e.preventDefault();

  if (!output.textContent.trim()) {
    insertAtCursor(input, text);
    richPaste = null;
    movedToBox1 = true;
    const result = runClean();            // synchronous, so the copy starts inside the paste
    if (!result) return;
    copyResult(result);
    landedValue = input.value;
    land();
    return;
  }

  if (!insertPlainAtCaret(text)) { output.appendChild(document.createTextNode(text)); setEdited(true); }
  copyGen++;
  setBar('Added as-is. Not copied yet', 'warn', false);
  announce('Added to your cleaned text as plain text. That part was not cleaned. Paste into the paste box if you want it cleaned too. Not copied yet.');
});

// A click on an option is a real user action, so the new version is copied too (S5).
OPTION_IDS.forEach(k => {
  const el = $('opt-' + k);
  on(el, 'change', () => {
    if (!input.value.trim()) return;
    const result = runClean();
    if (result) copyResult(result);
  });
});

/* ------------------------------------------------------ the keyboard (iPhone)
 *
 * iOS shrinks the VISUAL viewport for the keyboard and leaves the layout one
 * alone, so a bar pinned to the bottom ends up floating behind or above the
 * keyboard. While the keyboard is up the bar is hidden; it comes back when it
 * closes. A focused box on a touch screen counts too, because that is the moment
 * the keyboard is up, and it does not depend on how a given iOS version reports
 * its viewport. The 100px margin is a design value, checked in UAT (D46). */
const vv = window.visualViewport;
const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

function keyboardCheck() {
  const shrunk = !!vv && vv.height * (vv.scale || 1) < document.documentElement.clientHeight - 100;
  const typing = touch && (document.activeElement === input || document.activeElement === output);
  document.body.classList.toggle('kb-open', shrunk || typing);
}

if (vv) on(vv, 'resize', keyboardCheck);
on(input, 'focus', keyboardCheck);
on(input, 'blur', keyboardCheck);
on(output, 'focus', keyboardCheck);
on(output, 'blur', keyboardCheck);
on(window, 'resize', sizeBar);

if (input) input.focus();

/* The last line that runs. boot.js watches for this flag and, if it never appears,
 * tells the person the tool did not start instead of leaving them with a dead page. */
window.__cleantextReady = true;
