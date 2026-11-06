/**
 * richtext.js — the rich paste path.
 *
 * Box 1 is a <textarea>, and a textarea can only hold plain text. So when
 * somebody copies a formatted page — a news article, an Outlook email, a Google
 * Doc — the browser hands the textarea the `text/plain` flavour of the clipboard
 * and throws the `text/html` flavour away. Bold, headings and bullets go with it,
 * and so does every link, because an anchor's URL lives in the href and never in
 * the words on screen. Reported by Raj on 2026-09-18 after copying from espn.com.
 * Not a Brave bug and not an Android bug: every browser does this.
 *
 * This module reads that discarded HTML flavour and writes it back out in the
 * plain-text dialect `clean.js` already understands:
 *
 *   <strong>Doors open</strong>      ->  **Doors open**
 *   <h2>Garba Night</h2>             ->  ## Garba Night
 *   <ul><li>bring sticks</li></ul>   ->  • bring sticks
 *   <a href="https://x.org">RSVP</a> ->  RSVP (https://x.org)
 *
 * clean.js then does what it has always done. Nothing here renders HTML, and
 * nothing here reaches the page: the output is text, and every character of it is
 * escaped by clean.js on the way back out.
 *
 * PURE ES MODULE, like clean.js. No DOM, no DOMParser, no globals, no side
 * effects — which is what lets `tests/test-clean.js` import the shipped file and
 * test it in Node. See .claude/memory/law-clean-js-is-pure.md and D39.
 */

export const RICH_DEFAULTS = {
  links: 'text-and-url',   // 'text-and-url' | 'text' | 'url'
  bold: true,              // <strong> and <b> -> **text**
  headings: true,          // <h1>..<h6> -> "## text"
  lists: true,             // <li> -> "• text" or "1. text"
};

// Bigger than any selection a person makes by hand. Past this, the caller falls
// back to the plain flavour rather than chewing through a whole scraped site.
const MAX_HTML = 4000000;

export function newRichStats() {
  return { links: 0, bold: 0, headings: 0, listItems: 0, charsIn: 0, charsOut: 0 };
}

/* ------------------------------------------------------------------ *
 * tag tables
 * ------------------------------------------------------------------ */

// Their contents are not prose. Dropped whole, tags and text together.
const DROPPED = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas',
                         'head', 'title', 'iframe', 'object', 'video', 'audio',
                         'select', 'datalist', 'map', 'math']);

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
                      'link', 'meta', 'param', 'source', 'track', 'wbr']);

/* Anything that starts a new line of its own. `td` and `tr` are here rather than
 * being stitched back into rows on purpose: a layout table — which is how Outlook
 * and every marketing email is built — becomes ordinary paragraphs, which is
 * right, and a data table loses its columns, which it was going to lose in
 * normalise() anyway. See the accepted limitations in docs/BUG-LEDGER.md. */
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main',
                       'aside', 'nav', 'figure', 'figcaption', 'blockquote', 'pre',
                       'address', 'form', 'fieldset', 'dl', 'dt', 'dd', 'ul', 'ol',
                       'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
                       'caption', 'details', 'summary', 'body', 'html']);

const HEADING = /^h([1-6])$/;

/* ------------------------------------------------------------------ *
 * entities
 * ------------------------------------------------------------------ */

/* The Latin-1 names, in code point order from U+00A0 to U+00FF. Written as a list
 * because that is the only way it stays checkable: every accented letter on an
 * English-language page comes from this block, and a missing one shows up as a
 * literal "&eacute;" in somebody's text. */
const LATIN1 = (
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr ' +
  'deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest ' +
  'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml ' +
  'Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times ' +
  'Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde ' +
  'auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml ' +
  'eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc ' +
  'uuml yacute thorn yuml'
).split(' ');

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '‌', zwj: '‍',
  ndash: '–', mdash: '—', horbar: '―', lsquo: '‘', rsquo: '’', sbquo: '‚',
  ldquo: '“', rdquo: '”', bdquo: '„', hellip: '…', prime: '′', Prime: '″',
  bull: '•', dagger: '†', Dagger: '‡', permil: '‰', trade: '™',
  euro: '€', larr: '←', rarr: '→', harr: '↔', ne: '≠', le: '≤', ge: '≥',
  OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ', fnof: 'ƒ',
  circ: 'ˆ', tilde: '˜', minus: '−', lowast: '∗', sdot: '⋅', hearts: '♥',
};

LATIN1.forEach((name, i) => { NAMED[name] = String.fromCharCode(0xa0 + i); });

const ENTITY = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

export function decodeEntities(s) {
  return String(s).replace(ENTITY, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      // Lone surrogates and out-of-range values would throw, and a thrown paste is
      // a dead paste. Anything unconvertible is left exactly as it arrived.
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      try { return String.fromCodePoint(code); } catch (e) { return whole; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : whole;
  });
}

/* ------------------------------------------------------------------ *
 * the scanner
 *
 * Deliberately not a spec-complete HTML parser. It reads tags, attributes and
 * text, and it never has to be right about anything a browser would have to be
 * right about, because the output is plain text: there is no tree to corrupt and
 * no markup to inject.
 * ------------------------------------------------------------------ */

// The end of a tag, respecting quoted attribute values so that
// <a title="a > b"> does not end at the first angle bracket inside the quotes.
function tagEnd(html, start) {
  let quote = '';
  for (let i = start + 1; i < html.length; i++) {
    const ch = html[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === '\'') { quote = ch; continue; }
    if (ch === '>') return i;
  }
  return -1;
}

const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;

function attrs(raw) {
  const found = {};
  ATTR.lastIndex = 0;
  let m;
  while ((m = ATTR.exec(raw)) !== null) {
    let value = m[2] === undefined ? '' : m[2];
    if (/^["']/.test(value)) value = value.slice(1, -1);
    found[m[1].toLowerCase()] = decodeEntities(value);
  }
  return found;
}

// Skip past the matching close tag of an element, counting nested copies of it.
function skipElement(html, name, from) {
  let depth = 1;
  let i = from;
  const open = new RegExp('^<' + name + '(?=[\\s/>])', 'i');
  const close = new RegExp('^</' + name + '\\s*>', 'i');
  while (i < html.length && depth > 0) {
    const next = html.indexOf('<', i);
    if (next < 0) return html.length;
    const end = tagEnd(html, next);
    if (end < 0) return html.length;
    const tag = html.slice(next, end + 1);
    if (close.test(tag)) depth--;
    else if (open.test(tag) && !/\/>$/.test(tag)) depth++;
    i = end + 1;
  }
  return i;
}

/* An element the page was not showing. It still travels on the clipboard, which
 * is where "Sponsored", "Skip to main content" and a screen-reader-only date come
 * from when a paste from a news site arrives full of words nobody saw. */
function isHidden(a) {
  if (Object.prototype.hasOwnProperty.call(a, 'hidden')) return true;
  if (a['aria-hidden'] === 'true') return true;
  const style = (a.style || '').replace(/\s+/g, '').toLowerCase();
  return style.includes('display:none') || style.includes('visibility:hidden');
}

function usableHref(raw) {
  const href = String(raw || '').trim();
  if (!href) return '';
  // Relative and in-page hrefs are useless once the text leaves the site: there is
  // no base to resolve them against on the clipboard. Better absent than wrong.
  if (!/^(https?:\/\/|mailto:)/i.test(href)) return '';
  if (/\s/.test(href)) return '';
  return href;
}

/* ------------------------------------------------------------------ *
 * htmlToText
 * ------------------------------------------------------------------ */

export function htmlToText(rawHtml, opts = {}) {
  const o = { ...RICH_DEFAULTS, ...opts };
  const stats = newRichStats();

  let html = String(rawHtml ?? '');
  stats.charsIn = html.length;
  if (!html || html.length > MAX_HTML) return { text: '', stats };

  /* Chromium, Safari and Firefox all wrap the copied selection in these markers
   * and put the surrounding page furniture outside them. Taking the fragment is
   * the difference between the paragraph somebody selected and the whole page. */
  const startMark = html.indexOf('<!--StartFragment-->');
  const endMark = html.lastIndexOf('<!--EndFragment-->');
  if (startMark >= 0 && endMark > startMark) {
    html = html.slice(startMark + '<!--StartFragment-->'.length, endMark);
  }

  const lines = [];
  let buf = '';
  let prefix = '';
  let preDepth = 0;
  let boldDepth = 0;
  let boldAt = -1;
  const listStack = [];
  const linkStack = [];

  function endLine() {
    // A bold run that reaches the end of a line is closed here and reopened on the
    // next one. An unclosed "**" is not bold to clean.js, it is two asterisks in
    // somebody's text.
    if (boldAt >= 0) { buf += '**'; boldAt = -1; }

    /* Collapse only the whitespace HTML actually collapses: space, tab and the
     * line breaks in the source markup. A non-breaking space is NOT one of them,
     * and it has to survive intact — normalise() in clean.js is what turns it into
     * a plain space, and turning it into one here would mean the tool silently
     * fixed something without ever telling the person it did. */
    const text = preDepth > 0
      ? buf.replace(/[ \t]+$/, '')
      : buf.replace(/[ \t\r\n\f\v]+/g, ' ').replace(/^[ \t]+|[ \t]+$/g, '');
    buf = '';
    if (text) lines.push(prefix + text);
    prefix = '';
    linkStack.length = 0;
    if (boldDepth > 0 && o.bold) { buf = '**'; boldAt = 0; }
  }

  function endBlock() {
    endLine();
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
  }

  function openBold() {
    if (o.bold && boldDepth === 0) { boldAt = buf.length; buf += '**'; }
    boldDepth++;
  }

  function closeBold() {
    if (boldDepth > 0) boldDepth--;
    if (!o.bold || boldDepth !== 0 || boldAt < 0) return;
    const inner = buf.slice(boldAt + 2);
    if (!inner.trim()) {
      buf = buf.slice(0, boldAt) + inner;                  // nothing worth bolding
    } else {
      // "**Doors open **" is not bold to anything. The trailing space goes outside.
      const kept = inner.replace(/\s+$/, '');
      buf = buf.slice(0, boldAt) + '**' + kept + '**' + inner.slice(kept.length);
      stats.bold++;
    }
    boldAt = -1;
  }

  function openLink(href) {
    linkStack.push({ href: usableHref(href), at: buf.length });
  }

  function closeLink() {
    const link = linkStack.pop();
    if (!link || !link.href) return;
    const text = buf.slice(link.at).trim();
    // An anchor with no words is an icon or an image. There is nothing to tell the
    // reader about it, so it contributes nothing rather than a bare URL.
    if (!text) return;
    stats.links++;
    if (o.links === 'text') return;
    if (o.links === 'url') { buf = buf.slice(0, link.at) + link.href.replace(/^mailto:/i, ''); return; }
    const bare = link.href.replace(/^mailto:/i, '');
    if (text.includes(bare) || bare.includes(text)) {
      // The words already are the address. Saying it twice helps nobody.
      if (/^mailto:/i.test(link.href)) buf = buf.slice(0, link.at) + bare;
      return;
    }
    buf += ' (' + bare + ')';
  }

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);

    if (lt < 0) { buf += decodeEntities(html.slice(i)); break; }
    if (lt > i) buf += decodeEntities(html.slice(i, lt));

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }

    const end = tagEnd(html, lt);
    if (end < 0) { buf += decodeEntities(html.slice(lt)); break; }

    const raw = html.slice(lt + 1, end);
    i = end + 1;

    const closing = raw[0] === '/';
    const nameMatch = (closing ? raw.slice(1) : raw).match(/^[a-zA-Z][^\s/>]*/);
    if (!nameMatch) { if (!closing) buf += decodeEntities(html.slice(lt, end + 1)); continue; }
    const name = nameMatch[0].toLowerCase();

    if (DROPPED.has(name)) {
      if (!closing && !/\/$/.test(raw)) i = skipElement(html, name, i);
      continue;
    }

    if (!closing) {
      const a = attrs(raw.slice(nameMatch[0].length));
      if (isHidden(a) && !VOID.has(name) && !/\/$/.test(raw)) { i = skipElement(html, name, i); continue; }

      if (name === 'br') { endLine(); continue; }
      if (name === 'hr') { endBlock(); lines.push('---'); lines.push(''); continue; }
      if (VOID.has(name)) continue;                 // images and the rest carry no prose

      const h = name.match(HEADING);
      if (h) {
        endBlock();
        if (o.headings) { prefix = '#'.repeat(Math.min(3, Number(h[1]))) + ' '; stats.headings++; }
        continue;
      }

      if (name === 'li') {
        endLine();
        const list = listStack[listStack.length - 1];
        if (o.lists) {
          prefix = list && list.ordered ? (++list.n) + '. ' : '• ';
          stats.listItems++;
        }
        continue;
      }

      if (name === 'ul' || name === 'ol') { endBlock(); listStack.push({ ordered: name === 'ol', n: 0 }); continue; }
      if (name === 'pre') { endBlock(); preDepth++; continue; }
      if (BLOCK.has(name)) { endBlock(); continue; }
      if (name === 'strong' || name === 'b') { openBold(); continue; }
      if (name === 'a') { openLink(a.href); continue; }
      continue;                                      // every other inline tag: keep the words
    }

    // closing
    if (name === 'a') { closeLink(); continue; }
    if (name === 'strong' || name === 'b') { closeBold(); continue; }
    if (name === 'li') { endLine(); continue; }
    if (name === 'ul' || name === 'ol') { endBlock(); listStack.pop(); continue; }
    if (name === 'pre') { endBlock(); if (preDepth > 0) preDepth--; continue; }
    if (HEADING.test(name)) { endBlock(); continue; }
    if (BLOCK.has(name)) { endBlock(); continue; }
  }

  endLine();

  let text = lines.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

  // Markup with no prose in it is not an improvement on the plain flavour. Saying
  // so lets the caller paste normally instead of pasting nothing.
  if (!/[\p{L}\p{N}]/u.test(text)) text = '';

  stats.charsOut = text.length;
  return { text, stats };
}
