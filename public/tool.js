/**
 * tool.js — DOM wiring for the single-transform tool pages.
 *
 * `/` has app.js, because it produces formatted HTML and has to copy two flavours
 * at once. The tools on the other paths are all the same shape: plain text in,
 * plain text out, one copy button. This is that shape, written once.
 *
 * Same law as app.js: clean.js knows nothing about a page, and this file does all
 * the touching. See .claude/memory/law-clean-js-is-pure.md
 *
 * A page uses it like this, from its own module (never inline — the CSP is
 * script-src 'self' and an inline script would simply not run):
 *
 *   import { mount } from '/tool.js';
 *   import { squeeze } from '/clean.js';
 *   mount({ run: squeeze, optionIds: ['collapseSpaces'], describe: s => [...] });
 */

const $ = id => document.getElementById(id);

/* Attach a listener only if the element is really there. One missing element
 * must never throw on module load and kill the whole page — that shipped once,
 * on 2026-09-17, and a visitor saw a tool where nothing at all worked and
 * nothing said why. See BUG-005. */
function on(el, type, fn) {
  if (el) el.addEventListener(type, fn);
}

export function mount({ run, optionIds = [], describe, readOption }) {
  const input   = $('input');
  const output  = $('output');
  const status  = $('status');
  const btnCopy = $('copy');
  const btnReset = $('reset');
  const chipBox = $('chips');

  let lastResult = '';

  function options() {
    const o = {};
    optionIds.forEach(key => {
      const el = $('opt-' + key);
      if (!el) return;
      o[key] = readOption ? readOption(key, el) : el.checked;
    });
    return o;
  }

  function showChips(items) {
    if (!chipBox) return;
    chipBox.textContent = '';
    items.forEach(item => {
      const el = document.createElement('span');
      el.className = 'chip' + (item.tone ? ' ' + item.tone : '');
      el.textContent = item.label;
      chipBox.appendChild(el);
    });
  }

  function say(message, tone, short) {
    if (status) status.textContent = message;
    const chipText = short === undefined ? message : short;
    showChips(chipText ? [{ label: chipText, tone: tone || null }] : []);
  }

  function go(reveal) {
    const raw = input.value;
    if (!raw.trim()) {
      output.value = '';
      lastResult = '';
      say('Paste something in the first box.', null, '');
      return;
    }

    const result = run(raw, options());
    output.value = result.text;
    lastResult = result.text;

    const bits = describe ? describe(result.stats) : [];
    const sentence = bits.length ? 'Done. ' + bits.join(' · ') + '.' : 'Done. It was already clean.';
    if (status) status.textContent = sentence + ' Now press Copy.';

    const chips = [{ label: 'Done', tone: 'good' }].concat(bits.map(b => ({ label: b })));
    if (result.stats && result.stats.truncated) {
      chips.unshift({ label: 'Cut at 200,000 characters', tone: 'warn' });
    }
    showChips(chips);

    if (reveal) scrollToResult();
  }

  /* On a phone the button sits below the fold, because the panes stack above it.
   * Land on the chips: that puts the result, the button and the confirmation of
   * what changed all on screen together. Same reasoning as CET-2 on the homepage. */
  function scrollToResult() {
    if (window.innerWidth > 860 || !chipBox) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    chipBox.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'end' });
  }

  /* Three layers, because a clipboard that fails silently is the one failure a
   * person cannot see and cannot work around. */
  async function copy() {
    const text = output.value;
    if (!text.trim()) {
      say('There is nothing to copy yet. Paste something in the first box.', 'warn', 'Nothing to copy yet');
      return;
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        say('Copied. Paste it wherever you need it.', 'good', 'Copied');
        return;
      } catch (e) { /* fall through */ }
    }

    try {
      output.focus();
      output.select();
      if (document.execCommand('copy')) { say('Copied.', 'good', 'Copied'); return; }
    } catch (e) { /* fall through */ }

    output.focus();
    output.select();
    say('This browser blocked the copy. The text is selected, so press Ctrl+C or Cmd+C.', 'warn');
  }

  on(btnCopy, 'click', copy);

  on(btnReset, 'click', () => {
    input.value = '';
    output.value = '';
    lastResult = '';
    say('');
    input.focus();
  });

  on(input, 'paste', () => setTimeout(() => go(true), 0));

  let typingTimer = null;
  on(input, 'input', e => {
    if (e.inputType === 'insertFromPaste') return;   // the paste handler has it
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => go(false), 350);
  });

  optionIds.forEach(key => {
    const el = $('opt-' + key);
    on(el, 'change', () => { if (input.value.trim()) go(false); });
    if (el && el.tagName === 'SELECT') on(el, 'input', () => { if (input.value.trim()) go(false); });
  });

  if (input) input.focus();

  /* The last thing that runs. boot.js watches for this flag and, if it never
   * appears, tells the person the tool did not start instead of leaving them
   * looking at a page that silently does nothing. */
  window.__cleantextReady = true;
}
