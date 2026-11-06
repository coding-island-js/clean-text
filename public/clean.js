/**
 * clean.js — the product.
 *
 * Pure ES module. No DOM, no globals, no side effects. `app.js` is the only file
 * allowed to touch the page, and `tests/test-clean.js` imports THIS file, so the
 * tests run the shipped code rather than a copy of it. See
 * .claude/memory/law-clean-js-is-pure.md
 *
 * Pipeline:  demojibake -> normalise -> strip -> unwrap -> parse -> toHtml / toText
 * Each stage is exported and tested separately, so a failure names its own stage.
 */

export const DEFAULTS = {
  unwrap: true,            // rejoin hard-wrapped lines
  headings: true,          // promote short standalone lines to headings
  lists: true,             // detect bullet and numbered lists
  labels: true,            // bold "When:" / "Where:" / "RSVP:" style labels
  links: true,             // make URLs and emails clickable
  stripTracking: true,     // remove utm_*, fbclid and friends from links
  straightenQuotes: false, // curly -> straight. Off: curly quotes are not damage
  fixEncoding: true,       // repair text that came through the wrong encoding
};

const MAX_INPUT = 200000;

/* ------------------------------------------------------------------ *
 * 0. demojibake — text that has been through the wrong encoding
 *
 * "We’ll" becomes "WeΓÇÖll" when UTF-8 is read as CP437, or "Weâ€™ll" when it
 * is read as Windows-1252. Forwarded mail, CSV exports and old systems all do
 * this. The damage is worth undoing FIRST, because a non-breaking space that
 * has become "┬á" is no longer invisible, so nothing downstream would catch it.
 * ------------------------------------------------------------------ */

// The 0x80-0xFF range of each legacy encoding, in byte order.
const CP1252_HIGH =
  '€‚ƒ„…†‡ˆ‰Š‹ŒŽ' +
  '‘’“”•–—˜™š›œžŸ' +
  Array.from({ length: 96 }, (_, i) => String.fromCharCode(0xA0 + i)).join('');

const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅ' +
  'ÉæÆôöòûùÿÖÜ¢£¥₧ƒ' +
  'áíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧' +
  '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩' +
  '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function byteMap(high) {
  const map = new Map();
  for (let i = 0; i < 0x80; i++) map.set(String.fromCharCode(i), i);
  for (let i = 0; i < high.length; i++) map.set(high[i], 0x80 + i);
  return map;
}

const CODEPAGES = [byteMap(CP1252_HIGH), byteMap(CP437_HIGH)];

// Runs of non-ASCII. Mojibake always travels in one of these.
const NON_ASCII_RUN = /[^\x00-\x7F]+/g;

function repairRun(run) {
  for (const map of CODEPAGES) {
    const bytes = [];
    let ok = true;
    for (const ch of run) {
      const b = map.get(ch);
      if (b === undefined) { ok = false; break; }
      bytes.push(b);
    }
    if (!ok) continue;

    let decoded;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    } catch (e) { continue; }

    /* Accept only if the text got SHORTER. Mojibake always expands one character
     * into two or three, so a shrink is the signature. Correctly-encoded text
     * cannot shrink here, because it would not have decoded at all. This is what
     * keeps a legitimate "é" or "ü" from being mangled into something else. */
    if (decoded.length < run.length && !decoded.includes('�')) return decoded;
  }
  return null;
}

export function demojibake(text, opts = {}, stats = newStats()) {
  const o = { ...DEFAULTS, ...opts };
  if (!o.fixEncoding) return text;

  return String(text).replace(NON_ASCII_RUN, run => {
    const fixed = repairRun(run);
    if (fixed === null) return run;
    stats.mojibake += run.length - fixed.length;
    return fixed;
  });
}

/* ------------------------------------------------------------------ *
 * 1. normalise — kill the characters you cannot see
 * ------------------------------------------------------------------ */

// Zero-width and formatting characters. Invisible on screen, and the reason a
// paste "explodes" once another editor re-encodes it.
const INVISIBLE = /[​-‍⁠﻿­‎‏‪-‮￼�]/g;
// Every unicode space that is not a plain space.
const ODD_SPACE = /[   -   　]/g;

export function normalise(raw, opts = {}, stats = newStats()) {
  const o = { ...DEFAULTS, ...opts };
  let t = String(raw ?? '');

  t = t.replace(/\r\n?/g, '\n');

  const invisible = t.match(INVISIBLE);
  if (invisible) stats.invisibles += invisible.length;
  t = t.replace(INVISIBLE, '');

  const odd = t.match(ODD_SPACE);
  if (odd) stats.oddSpaces += odd.length;
  t = t.replace(ODD_SPACE, ' ');

  t = t.replace(/\t/g, ' ');

  if (o.straightenQuotes) {
    t = t.replace(/[‘’‚‛]/g, "'")
         .replace(/[“”„‟]/g, '"');
  }

  // Trailing whitespace per line, doubled spaces, then runs of blank lines.
  t = t.replace(/[ ]+$/gm, '')
       .replace(/ {2,}/g, ' ')
       .replace(/\n{3,}/g, '\n\n')
       .trim();

  return t;
}

/* ------------------------------------------------------------------ *
 * 2. strip — remove the furniture that came with the message
 * ------------------------------------------------------------------ */

const FORWARD_MARKER = /^\s*(-{2,}\s*)?(original message|forwarded message|begin forwarded message)\s*(-{2,})?\s*:?\s*$/i;
const HEADER_LINE    = /^\s*(from|to|cc|bcc|sent|date|subject|reply-to|importance)\s*:\s*/i;
const QUOTE_LINE     = /^\s*>+\s?/;
// RFC 3676 writes the signature delimiter as "dash dash space", but normalise()
// has already eaten trailing spaces by the time strip() runs, so match the
// two-dash line instead. Three or more dashes is a horizontal rule (RULE_LINE)
// and is handled as content. See BUG-001.
const SIGNATURE      = /^\s*--\s*$/;
const SENT_FROM      = /^\s*(sent from my .{0,30}|sent via .{0,30}|get outlook for (ios|android))\s*$/i;
const WHATSAPP       = /^\s*\[?\d{1,2}\/\d{1,2}\/\d{2,4},? \d{1,2}:\d{2}(:\d{2})?\s?([AaPp]\.?[Mm]\.?)?\]?\s*[-–]?\s*([^:\n]{1,40}):\s?/;
const WHATSAPP_NOISE = /^\s*(<media omitted>|image omitted|video omitted|this message was deleted|messages and calls are end-to-end encrypted.*)\s*$/i;
const UNSUBSCRIBE    = /^\s*(to unsubscribe.*|unsubscribe.*|you (are )?receiv(ed|ing) this (email|message) because.*|click here to unsubscribe.*|view this email in your browser.*)\s*$/i;
// Legal boilerplate runs to the end of the message, so it truncates rather than filters.
const CONFIDENTIAL   = /^\s*(this (e-?mail|message)( and any attachments)? (is|are|may be) (confidential|privileged|intended)|confidentiality notice|disclaimer\s*:)/i;

export function strip(text, opts = {}, stats = newStats()) {
  const lines = String(text).split('\n');
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (CONFIDENTIAL.test(line)) { stats.junkLines += lines.length - i; break; }

    // A signature block follows its delimiter immediately. A "--" with a blank
    // line after it is somebody's divider, and cutting there silently ate the
    // rest of the message. See BUG-004 — this is the guard.
    if (SIGNATURE.test(line) && (lines[i + 1] || '').trim() !== '') {
      stats.junkLines += lines.length - i;
      break;
    }

    if (FORWARD_MARKER.test(line)) { stats.junkLines++; continue; }
    if (SENT_FROM.test(line))      { stats.junkLines++; continue; }
    if (UNSUBSCRIBE.test(line))    { stats.junkLines++; continue; }
    if (WHATSAPP_NOISE.test(line)) { stats.junkLines++; continue; }

    // Quoted thread. Drop the line; the reply above it is the message.
    if (QUOTE_LINE.test(line)) { stats.junkLines++; continue; }

    // "On Mon, 8 Sep 2026 at 16:12, Priya Shah <p@x.com> wrote:" — often wrapped
    // across two or three lines, so look ahead for the "wrote:" that closes it.
    if (/^\s*On\b/.test(line)) {
      const span = attributionSpan(lines, i);
      if (span > 0) { stats.junkLines += span; i += span - 1; continue; }
    }

    // A mail header only counts as a header when it travels in a pack. A lone
    // "Date: Saturday, Nov 7" is an event detail, and S4 wants it kept and bolded.
    if (HEADER_LINE.test(line)) {
      const run = headerRun(lines, i);
      if (run >= 2) { stats.junkLines += run; i += run - 1; continue; }
    }

    // "[9/12/26, 3:04 PM] Priya Shah: the actual message" -> the actual message
    const wa = line.match(WHATSAPP);
    if (wa) { stats.junkLines++; out.push(line.slice(wa[0].length)); continue; }

    out.push(line);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function attributionSpan(lines, i) {
  for (let j = i; j < Math.min(i + 3, lines.length); j++) {
    if (/wrote:\s*$/i.test(lines[j])) return j - i + 1;
    if (lines[j].trim() === '') break;
  }
  return 0;
}

function headerRun(lines, i) {
  let n = 0;
  while (i + n < lines.length && HEADER_LINE.test(lines[i + n])) n++;
  return n;
}

/* ------------------------------------------------------------------ *
 * 3. unwrap — rejoin lines an email client broke, keep the ones a person meant
 * ------------------------------------------------------------------ */

export function unwrap(text, opts = {}, stats = newStats()) {
  const o = { ...DEFAULTS, ...opts };
  if (!o.unwrap) return text;

  return String(text).split(/\n{2,}/).map(run => {
    const lines = run.split('\n');
    if (lines.length < 2) return run;

    // Estimate this run's wrap width rather than assuming one. Email wraps near
    // 72, a phone near 40, and a fixed threshold gets one of them wrong.
    const widths = lines.slice(0, -1).map(l => l.length);
    const maxWidth = Math.max(...widths);
    if (maxWidth > 140) return run;              // long lines: nothing was wrapped
    // Floor of 24, not 34: a phone wraps near 40 and a threshold of 34 left
    // three-line phone messages unjoined. See BUG-002.
    const threshold = Math.max(24, Math.floor(maxWidth * 0.75));

    const merged = [];
    for (const line of lines) {
      const prev = merged[merged.length - 1];
      const joinable =
        prev !== undefined &&
        prev.length >= threshold &&
        !isStructural(prev) && !isStructural(line) &&
        !/[:;]$/.test(prev) &&
        line.trim() !== '';

      if (joinable) {
        merged[merged.length - 1] = prev.replace(/\s+$/, '') + ' ' + line.trim();
        stats.joins++;
      } else {
        merged.push(line);
      }
    }
    return merged.join('\n');
  }).join('\n\n');
}

// A line a person shaped on purpose: a bullet, a numbered item, a label, a rule,
// a heading. Joining any of these into the line above destroys the shape.
function isStructural(line) {
  return LIST_ITEM.test(line) || RULE_LINE.test(line) || ATX_HEADING.test(line) ||
         KNOWN_LABEL.test(line) || GENERIC_LABEL.test(line);
}

/* ------------------------------------------------------------------ *
 * 4. parse — text to blocks
 * ------------------------------------------------------------------ */

const LIST_ITEM     = /^\s*([-*+•●▪◦‣·–—]|\(?\d{1,2}[.)]|\(?[a-z][.)])\s+(?=\S)/;
const ORDERED_ITEM  = /^\s*\(?\d{1,2}[.)]\s+/;
const RULE_LINE     = /^\s*([-_*=~•·—–]\s*){2,}$/;
/* An explicit heading, written the markdown way. isHeading() below GUESSES from
 * the shape of a line, which is all it can do with text somebody typed. This says
 * so outright, and that matters for two inputs it was always guessing wrong on:
 * a page pasted with its formatting (richtext.js writes <h2> out as "## "), and
 * markdown pasted straight from an assistant. A hash with no space after it is a
 * hashtag or a house number, and is not this. */
const ATX_HEADING   = /^\s{0,3}(#{1,6})[ \t]+(\S.*?)[ \t]*#*\s*$/;
const KNOWN_LABEL   = /^\s*(when|where|what|who|why|how|date|day|time|venue|location|address|cost|price|fee|tickets?|rsvp|contact|deadline|dress code|attire|parking|food|menu|agenda|theme|host|hosts|sponsor|note|notes|age|ages|register|registration|questions?)\s*:\s*(?=\S)/i;
// A generic "Label: value" line — only trusted when several appear together.
const GENERIC_LABEL = /^\s*([A-Z][A-Za-z]*(?: [A-Za-z]+){0,2})\s*:\s+(?=\S)/;

export function parse(text, opts = {}, stats = newStats()) {
  const o = { ...DEFAULTS, ...opts };
  const blocks = [];
  const runs = String(text).split(/\n{2,}/);
  let seenContent = false;

  runs.forEach(run => {
    const lines = run.split('\n').filter(l => l.trim() !== '');
    if (!lines.length) return;

    const genericCount = lines.filter(l => !KNOWN_LABEL.test(l) && GENERIC_LABEL.test(l)).length;
    const trustGeneric = genericCount >= 2;

    let pending = null;                          // an open paragraph or list
    const flush = () => { if (pending) { blocks.push(pending); pending = null; } };

    lines.forEach((line, idx) => {
      let trimmed = line.trim();

      if (RULE_LINE.test(trimmed)) { flush(); blocks.push({ type: 'rule' }); return; }

      /* An explicit heading beats every guess isHeading() could make. With the
       * headings switch OFF the marker is still removed rather than left on
       * screen: the visitor asked for no headings, not for a row of hashes. */
      const atx = trimmed.match(ATX_HEADING);
      if (atx) {
        if (o.headings) {
          flush();
          blocks.push({ type: 'heading', level: Math.min(3, Math.max(2, atx[1].length)), text: unbold(atx[2]) });
          stats.headings++;
          seenContent = true;
          return;
        }
        trimmed = atx[2].trim();
      }

      if (o.lists && LIST_ITEM.test(line)) {
        const ordered = ORDERED_ITEM.test(line);
        /* A bullet list that has been flattened onto one line still has its bullet
           glyphs sitting mid-sentence, so split there and give each part its own
           item. Only real bullet characters count: a hyphen or an asterisk in the
           middle of a sentence is punctuation, not a list. */
        const parts = line.replace(LIST_ITEM, '')
          .split(/\s+[•●▪◦‣]\s+/)
          .map(part => part.trim())
          .filter(Boolean);
        if (!(pending && pending.type === 'list' && pending.ordered === ordered)) {
          flush();
          pending = { type: 'list', ordered, items: [] };
        }
        parts.forEach(part => { pending.items.push(part); stats.listItems++; });
        return;
      }

      if (o.labels) {
        const known = trimmed.match(KNOWN_LABEL);
        const generic = trustGeneric ? trimmed.match(GENERIC_LABEL) : null;
        const hit = known || generic;
        if (hit && !looksLikeUrl(trimmed)) {
          flush();
          const label = (known ? hit[1] : hit[1]).trim();
          blocks.push({ type: 'labelled', label, value: trimmed.slice(hit[0].length).trim() });
          stats.labels++;
          seenContent = true;
          return;
        }
      }

      if (o.headings && isHeading(trimmed, { first: !seenContent, only: lines.length === 1, idx, hasMore: runs.length > 1 })) {
        flush();
        blocks.push({ type: 'heading', level: seenContent ? 3 : 2, text: unbold(trimmed) });
        stats.headings++;
        seenContent = true;
        return;
      }

      seenContent = true;
      if (pending && pending.type === 'paragraph') pending.lines.push(trimmed);
      else { flush(); pending = { type: 'paragraph', lines: [trimmed] }; }
    });

    flush();
  });

  return blocks;
}

/* A title line that was bold in the source arrives as "**Title**", and a heading is
 * already bold — so the markers would render a <strong> inside an <h2> and say the
 * same thing twice. Only stripped when they wrap the WHOLE line: "**When** and
 * **Where**" is two bold runs in one line and must survive intact. */
function unbold(text) {
  return String(text).replace(/^\*\*((?:(?!\*\*)[\s\S])+)\*\*$/, '$1').trim();
}

function isHeading(line, ctx) {
  if (line.length === 0 || line.length > 70) return false;
  if (/[.!?,;]$/.test(line)) return false;
  if (!/[A-Za-z]/.test(line)) return false;
  if (looksLikeUrl(line)) return false;
  if (/https?:\/\/|@/.test(line)) return false;  // a line with a link in it is content

  const words = line.split(/\s+/);
  if (words.length > 12) return false;

  const upper = line === line.toUpperCase() && /[A-Z]{2,}/.test(line);
  if (upper) return true;                        // SHOUTED lines are headings in flyers

  // Everything below here needs the line to stand alone in its own run. The first
  // line of a multi-line run reads as a heading far less often than it reads as the
  // first line of an address, and an address losing its shape is worse. See BUG-003.
  if (!ctx.only) return false;
  if (ctx.first && ctx.hasMore) return true;     // the opening line is the title
  if (/:$/.test(line)) return true;              // "Agenda:" style section opener

  const capitalised = words.filter(w => /^[A-Z0-9]/.test(w)).length;
  return words.length >= 3 && capitalised / words.length >= 0.8;
}

function looksLikeUrl(s) { return /^(https?:|www\.|mailto:)/i.test(String(s).trim()); }

/* ------------------------------------------------------------------ *
 * 5. render
 * ------------------------------------------------------------------ */

const TRACKING = /^(utm_[a-z_]+|fbclid|gclid|gbraid|wbraid|mc_cid|mc_eid|igshid|ref_src|ref_url|_hsenc|_hsmi|vero_id|mkt_tok|yclid|msclkid)$/i;

export function cleanUrl(url, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!o.stripTracking) return url;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return url;
    let touched = false;
    [...u.searchParams.keys()].forEach(k => {
      if (TRACKING.test(k)) { u.searchParams.delete(k); touched = true; }
    });
    if (!touched) return url;
    let out = u.toString();
    if ([...u.searchParams.keys()].length === 0) out = out.replace(/\?$/, '');
    return out;
  } catch (e) { return url; }
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const URL_RE = /\bhttps?:\/\/[^\s<>()[\]{}"']+[^\s<>()[\]{}"'.,;:!?]/gi;
// One pass, ordered alternation: a full URL wins before www., which wins before an
// email. Matching them separately would let the second pass chew through the href
// the first pass just wrote.
const LINKY = /(?:https?:\/\/[^\s<>()[\]{}"']+[^\s<>()[\]{}"'.,;:!?]|\bwww\.[^\s<>()[\]{}"']+[^\s<>()[\]{}"'.,;:!?]|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b)/gi;

function bold(s) { return s.replace(/\*\*([^*\n]{1,200})\*\*/g, '<strong>$1</strong>'); }

function anchor(raw, o) {
  const isWww = /^www\./i.test(raw);
  const isUrl = isWww || /^https?:\/\//i.test(raw);
  if (!isUrl) return link('mailto:' + raw, raw);
  const href = cleanUrl(isWww ? 'https://' + raw : raw, o);
  return link(href, isWww ? href.replace(/^https?:\/\//i, '') : href);
}

// Inline formatting.
//
// Links are found on the RAW text and the gaps between them are escaped, never the
// other way round: escaping first turns "?a=1&b=2" into "?a=1&amp;b=2", and the URL
// parser then reads a query parameter called "amp;b". Order matters here.
function inline(text, opts, stats) {
  const o = { ...DEFAULTS, ...opts };
  const src = String(text);
  if (!o.links) return bold(escapeHtml(src));

  let out = '';
  let last = 0;
  let m;
  LINKY.lastIndex = 0;
  while ((m = LINKY.exec(src)) !== null) {
    out += bold(escapeHtml(src.slice(last, m.index)));
    out += anchor(m[0], o);
    if (stats) stats.links++;
    last = m.index + m[0].length;
  }
  out += bold(escapeHtml(src.slice(last)));
  return out;
}

function link(href, label) {
  if (!/^(https?:|mailto:)/i.test(href)) return escapeHtml(label);
  return '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(label) + '</a>';
}

export function toHtml(blocks, opts = {}, stats = null) {
  return blocks.map(function (b) {
    switch (b.type) {
      case 'heading':
        return '<h' + b.level + '>' + inline(b.text, opts, stats) + '</h' + b.level + '>';
      case 'rule':
        return '<hr>';
      case 'labelled':
        return '<p><strong>' + escapeHtml(b.label) + ':</strong> ' + inline(b.value, opts, stats) + '</p>';
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        return '<' + tag + '>\n' +
          b.items.map(i => '  <li>' + inline(i, opts, stats) + '</li>').join('\n') +
          '\n</' + tag + '>';
      }
      default:
        return '<p>' + b.lines.map(l => inline(l, opts, stats)).join('<br>\n') + '</p>';
    }
  }).join('\n');
}

export function toText(blocks, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const plain = s => (o.stripTracking ? String(s).replace(URL_RE, m => cleanUrl(m, o)) : String(s));

  return blocks.map(function (b) {
    switch (b.type) {
      case 'heading':  return plain(b.text);
      case 'rule':     return '---';
      case 'labelled': return plain(b.label + ': ' + b.value);
      case 'list':     return b.items.map((i, n) => (b.ordered ? (n + 1) + '. ' : '• ') + plain(i)).join('\n');
      default:         return b.lines.map(plain).join('\n');
    }
  }).join('\n\n').replace(/\*\*([^*\n]{1,200})\*\*/g, '$1');
}

/* ------------------------------------------------------------------ *
 * the one call app.js makes
 * ------------------------------------------------------------------ */

export function newStats() {
  return { invisibles: 0, oddSpaces: 0, junkLines: 0, joins: 0, links: 0, mojibake: 0,
           headings: 0, listItems: 0, labels: 0, charsIn: 0, charsOut: 0, truncated: false };
}

export function clean(raw, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const stats = newStats();
  let input = String(raw ?? '');
  stats.charsIn = input.length;

  if (input.length > MAX_INPUT) { input = input.slice(0, MAX_INPUT); stats.truncated = true; }

  const blocks = parse(unwrap(strip(normalise(demojibake(input, o, stats), o, stats), o, stats), o, stats), o, stats);
  const html = toHtml(blocks, o, stats);
  const text = toText(blocks, o);
  stats.charsOut = text.length;

  return { html, text, blocks, stats };
}

export const LIMIT = MAX_INPUT;

/* ================================================================== *
 * TOOL TWO AND TOOL THREE
 *
 * Two more tools on this same engine — see docs/TOOLS-ROADMAP.md for why these
 * two and not the obvious ones.
 *
 * They are SEPARATE EXPORTED FUNCTIONS, not options on clean(). A visitor who
 * searched for "remove extra spaces" did not ask for their forwarded headers to
 * be deleted, their lines rejoined or their bullets rebuilt. Each page must do
 * exactly what its title promises and nothing else, or it is a different tool
 * wearing the title as bait.
 *
 * Still pure. Still no DOM. tests/test-clean.js imports these directly.
 * ================================================================== */

/* ------------------------------------------------------------------ *
 * squeeze — /remove-extra-spaces
 *
 * Deliberately NOT built on normalise(). normalise() always collapses runs of
 * blank lines and always trims, which is correct for the main cleaner and wrong
 * here: every behaviour on this page is a checkbox the visitor can see, and a
 * checkbox that is secretly always on is a lie. Sharing the CONSTANTS keeps the
 * two in step. Sharing the function would not.
 * ------------------------------------------------------------------ */

export const SQUEEZE_DEFAULTS = {
  fixEncoding: true,     // repair text that came through the wrong encoding
  invisibles: true,      // zero-width and formatting characters
  oddSpaces: true,       // every unicode space that is not a plain space
  tabs: true,            // tab -> single space
  collapseSpaces: true,  // runs of spaces -> one space
  trimLineEnds: true,    // trailing whitespace per line
  trimLineStarts: false, // leading whitespace is often deliberate indentation
  blankLines: 'collapse',// 'collapse' | 'keep' | 'remove'
  trim: true,            // leading and trailing whitespace of the whole text
};

export function newSqueezeStats() {
  return { mojibake: 0, invisibles: 0, oddSpaces: 0, tabs: 0, spaceRuns: 0,
           trimmedLines: 0, blankLines: 0, charsIn: 0, charsOut: 0, truncated: false };
}

export function squeeze(raw, opts = {}) {
  const o = { ...SQUEEZE_DEFAULTS, ...opts };
  const stats = newSqueezeStats();

  let t = String(raw ?? '');
  stats.charsIn = t.length;
  if (t.length > MAX_INPUT) { t = t.slice(0, MAX_INPUT); stats.truncated = true; }

  t = t.replace(/\r\n?/g, '\n');

  // First, for the same reason the main cleaner does it first: a non-breaking
  // space that arrived as "AS" mojibake is not a space any more, so no later
  // whitespace rule can see it.
  if (o.fixEncoding) t = demojibake(t, { fixEncoding: true }, stats);

  if (o.invisibles) {
    const found = t.match(INVISIBLE);
    if (found) stats.invisibles += found.length;
    t = t.replace(INVISIBLE, '');
  }

  if (o.oddSpaces) {
    const found = t.match(ODD_SPACE);
    if (found) stats.oddSpaces += found.length;
    t = t.replace(ODD_SPACE, ' ');
  }

  if (o.tabs) {
    const found = t.match(/\t/g);
    if (found) stats.tabs += found.length;
    t = t.replace(/\t/g, ' ');
  }

  /* Collapse runs of spaces INSIDE a line, never the indentation at the start of
   * one. A double space between two words is the damage this page exists to fix.
   * Four spaces at the start of a line are usually somebody's deliberate
   * structure, and eating them is the kind of helpfulness nobody asked for —
   * which is what `trimLineStarts` is for, if they do want it gone. */
  if (o.collapseSpaces) {
    t = t.split('\n').map(line => {
      const indent = line.match(/^[ \t]*/)[0];
      const body = line.slice(indent.length);
      const found = body.match(/ {2,}/g);
      if (found) stats.spaceRuns += found.length;
      return indent + body.replace(/ {2,}/g, ' ');
    }).join('\n');
  }

  if (o.trimLineEnds || o.trimLineStarts) {
    t = t.split('\n').map(line => {
      let result = line;
      if (o.trimLineEnds) result = result.replace(/[ \t]+$/, '');
      if (o.trimLineStarts) result = result.replace(/^[ \t]+/, '');
      if (result !== line) stats.trimmedLines++;
      return result;
    }).join('\n');
  }

  if (o.blankLines === 'remove') {
    const all = t.split('\n');
    const kept = all.filter(line => line.trim() !== '');
    stats.blankLines += all.length - kept.length;
    t = kept.join('\n');
  } else if (o.blankLines === 'collapse') {
    t = t.replace(/\n{3,}/g, run => { stats.blankLines += run.length - 2; return '\n\n'; });
  }

  if (o.trim) t = t.trim();

  stats.charsOut = t.length;
  return { text: t, stats };
}

/* ------------------------------------------------------------------ *
 * demarkdown — /markdown-to-plain-text
 *
 * Markdown in, readable prose out. NOT a renderer: the job is text a person can
 * paste into an email, so structure that survives as plain text is KEPT (list
 * items, paragraphs, table rows) and syntax that only means something to a
 * renderer is removed.
 *
 * The order below is load-bearing. Fenced code is parked FIRST, because
 * everything inside it is meant literally — an asterisk in a shell command is
 * not emphasis — and it is restored last, untouched.
 * ------------------------------------------------------------------ */

export const MARKDOWN_DEFAULTS = {
  links: 'text',          // 'text' | 'text-and-url' | 'url'
  bullets: true,          // keep list items marked, as bullet lines
  html: true,             // strip raw HTML tags, keep the words inside them
  tables: true,           // flatten table rows into readable lines
  blankLines: 'collapse',
};

export function newMarkdownStats() {
  return { headings: 0, links: 0, images: 0, listItems: 0, codeBlocks: 0,
           emphasis: 0, quotes: 0, tableRows: 0, charsIn: 0, charsOut: 0, truncated: false };
}

// A private-use character, so a sentinel can never collide with real text. Any
// that somehow arrive in the input are dropped before the sentinels are placed.
const PARK = '';

export function demarkdown(raw, opts = {}) {
  const o = { ...MARKDOWN_DEFAULTS, ...opts };
  const stats = newMarkdownStats();

  let t = String(raw ?? '');
  stats.charsIn = t.length;
  if (t.length > MAX_INPUT) { t = t.slice(0, MAX_INPUT); stats.truncated = true; }

  t = t.replace(/\r\n?/g, '\n').split(PARK).join('');

  // 1. Park fenced code, contents untouched.
  const parked = [];
  t = t.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm, (m, fence, body) => {
    stats.codeBlocks++;
    parked.push(body.replace(/\n$/, ''));
    return PARK + (parked.length - 1) + PARK;
  });

  // 2. Link reference definitions are plumbing. They carry no prose.
  t = t.replace(/^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S+[^\n]*$/gm, '');

  // 3. Images before links: an image is a link with a bang in front, and the alt
  //    text is the only part of it a reader can use.
  t = t.replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, (m, alt) => { stats.images++; return alt; });

  t = t.replace(/\[([^\]\n]*)\]\(([^)\s]*)(?:[ \t]+"[^"\n]*")?\)/g, (m, text, url) => {
    stats.links++;
    if (o.links === 'url') return url;
    if (o.links === 'text-and-url') return text ? text + ' (' + url + ')' : url;
    return text || url;
  });

  t = t.replace(/\[([^\]\n]+)\]\[[^\]\n]*\]/g, (m, text) => { stats.links++; return text; });
  t = t.replace(/<((?:https?|mailto):[^>\s]+)>/g, (m, url) => { stats.links++; return url; });

  // 4. Line shapes.
  const lines = t.split('\n');
  const out = [];

  for (const original of lines) {
    let line = original;

    /* A run of = or - directly under text is a setext heading underline and
     * belongs to the line above it. The same characters after a blank line are a
     * horizontal rule. Order is what tells them apart, so this test runs first. */
    if (/^[ \t]{0,3}(=+|-+)[ \t]*$/.test(line) && out.length && out[out.length - 1].trim() !== '') {
      stats.headings++;
      continue;
    }

    const atx = line.match(/^[ \t]{0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/);
    if (atx) { stats.headings++; out.push(atx[2]); continue; }

    if (/^[ \t]{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/.test(line)) continue;   // horizontal rule

    const unquoted = line.replace(/^[ \t]{0,3}(>[ \t]?)+/, '');
    if (unquoted !== line) { stats.quotes++; line = unquoted; }

    if (o.tables && /^[ \t]*\|.*\|[ \t]*$/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      if (cells.every(c => c === '' || /^:?-{2,}:?$/.test(c))) continue;    // the |---|---| rule row
      stats.tableRows++;
      out.push(cells.filter(c => c !== '').join('  '));
      continue;
    }

    const ul = line.match(/^([ \t]*)[-*+][ \t]+(.*)$/);
    if (ul) {
      stats.listItems++;
      const body = ul[2].replace(/^\[[ xX]\][ \t]+/, '');                   // task list checkbox
      out.push(ul[1] + (o.bullets ? '• ' : '') + body);
      continue;
    }

    const ol = line.match(/^([ \t]*)(\d+)[.)][ \t]+(.*)$/);
    if (ol) { stats.listItems++; out.push(ol[1] + ol[2] + '. ' + ol[3]); continue; }

    out.push(line);
  }

  t = out.join('\n');

  // 5. Inline syntax. Underscores are treated conservatively, because
  //    snake_case identifiers are text that people really do paste.
  t = t.replace(/`([^`\n]+)`/g, '$1');

  const drop = re => { t = t.replace(re, (m, body) => { stats.emphasis++; return body; }); };
  drop(/\*\*\*([^*\n]+)\*\*\*/g);
  drop(/\*\*([^*\n]+)\*\*/g);
  drop(/\*([^*\n]+)\*/g);
  drop(/~~([^~\n]+)~~/g);
  t = t.replace(/(^|[\s(])__([^_\n]+)__(?=[\s).,;:!?]|$)/g, (m, pre, body) => { stats.emphasis++; return pre + body; });
  t = t.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, (m, pre, body) => { stats.emphasis++; return pre + body; });

  if (o.html) t = t.replace(/<\/?[a-zA-Z][^>\n]*>/g, '');

  t = t.replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, '$1');

  // 6. Code comes back exactly as it went in.
  t = t.replace(new RegExp(PARK + '(\\d+)' + PARK, 'g'), (m, i) => parked[Number(i)]);

  if (o.blankLines === 'collapse') t = t.replace(/\n{3,}/g, '\n\n');
  t = t.replace(/[ \t]+$/gm, '').trim();

  stats.charsOut = t.length;
  return { text: t, stats };
}

/* ------------------------------------------------------------------ *
 * joinLines — /remove-line-breaks
 *
 * Text arrives hard-wrapped: an email client broke it at 72 characters, a PDF
 * broke it at the column edge, a phone broke it at 40. The reader wants their
 * paragraphs back.
 *
 * NOT unwrap(). unwrap() guesses: it measures the run's own wrap width and only
 * joins lines long enough to have been wrapped, because inside the full cleaner a
 * wrong guess is invisible damage in the middle of somebody's message. This page
 * promises to remove line breaks, so it removes line breaks — every one in the
 * paragraph, whatever length the line is. Two different promises, two functions.
 * D32.
 * ------------------------------------------------------------------ */

export const JOIN_DEFAULTS = {
  mode: 'paragraphs',    // 'paragraphs' keeps blank lines as breaks; 'all' makes one line
  separator: ' ',        // what goes in at the join. '' for languages that need none
  keepLists: true,       // a bullet or a numbered item is structure, not a wrap
  dehyphenate: true,     // "informa-" + newline + "tion" -> "information"
  blankLines: 'collapse',
  trim: true,
};

export function newJoinStats() {
  return { joins: 0, paragraphs: 0, hyphens: 0, kept: 0,
           charsIn: 0, charsOut: 0, truncated: false };
}

export function joinLines(raw, opts = {}) {
  const o = { ...JOIN_DEFAULTS, ...opts };
  const stats = newJoinStats();

  let t = String(raw ?? '');
  stats.charsIn = t.length;
  if (t.length > MAX_INPUT) { t = t.slice(0, MAX_INPUT); stats.truncated = true; }

  t = t.replace(/\r\n?/g, '\n');

  /* A word split across a line end by a PDF or a typesetter. The two halves are
   * rejoined with NO separator, which is why this runs before anything else: once
   * the line break has become a space, the word cannot be put back together.
   * Only before a lowercase letter, so "self-" + newline + "Employed" is left
   * alone — that hyphen is probably part of the word. */
  if (o.dehyphenate) {
    t = t.replace(/([A-Za-z])[-‐‑]\n[ \t]*(?=[a-z])/g, (m, ch) => { stats.hyphens++; return ch; });
  }

  const sep = o.separator;

  if (o.mode === 'all') {
    const breaks = (t.match(/\n+/g) || []).length;
    stats.joins += breaks;
    stats.paragraphs = breaks ? 1 : 0;
    t = t.replace(/[ \t]*\n+[ \t]*/g, sep);
  } else {
    const blocks = t.split(/\n{2,}/);
    stats.paragraphs = blocks.filter(b => b.trim() !== '').length;

    t = blocks.map(block => {
      const lines = block.split('\n').map(l => l.trim()).filter((l, i, a) => l !== '' || a.length === 1);
      if (lines.length < 2) return lines.join('');

      const segments = [];
      for (const line of lines) {
        // A bullet or a rule was shaped by a person. Joining it into the line
        // above turns a list into a sentence, which is the one way this tool can
        // destroy something the visitor cannot get back by pressing undo.
        const structural = o.keepLists && (LIST_ITEM.test(line) || RULE_LINE.test(line));
        if (structural || segments.length === 0) {
          if (structural && segments.length) stats.kept++;
          segments.push(line);
        } else {
          segments[segments.length - 1] += sep + line;
          stats.joins++;
        }
      }
      return segments.join('\n');
    }).join('\n\n');
  }

  if (sep === ' ') t = t.replace(/ {2,}/g, ' ');
  if (o.blankLines === 'collapse') t = t.replace(/\n{3,}/g, '\n\n');
  t = t.replace(/[ \t]+$/gm, '');
  if (o.trim) t = t.trim();

  stats.charsOut = t.length;
  return { text: t, stats };
}

/* ------------------------------------------------------------------ *
 * titleCase — /title-case-converter
 *
 * The reason this page exists rather than a generic case converter: the
 * autocomplete demand is for STYLES. `title case converter ap style`, `uk`,
 * `spanish`. Most converters capitalise every word and call it title case, which
 * is the one thing no style guide actually says to do.
 *
 * The four real ones split into two families:
 *
 *   AP and APA    — decided by LENGTH. Lowercase articles, conjunctions and
 *                   prepositions of three letters or fewer. Capitalise anything
 *                   four letters or longer, including "With", "From", "Into".
 *   Chicago, MLA  — decided by WORD CLASS. Lowercase articles, coordinating
 *                   conjunctions and prepositions however long they are, so
 *                   "Between", "Through" and "Against" stay lowercase.
 *
 * Both always capitalise the first and last word, and the word after a colon.
 * That last rule is why a single "capitalise every word" pass is not a shortcut
 * to any of them.
 *
 * Case is per line, because a pasted list of headlines is several titles, not
 * one. D32: this page does title case, and does not quietly reflow, unwrap or
 * strip anything else.
 * ------------------------------------------------------------------ */

// Articles and coordinating conjunctions. Lowercase in every style.
const TC_ARTICLES = ['a', 'an', 'the'];
const TC_CONJUNCTIONS = ['and', 'but', 'or', 'nor', 'for', 'yet', 'so'];

// Prepositions. Chicago and MLA lowercase all of these whatever the length;
// AP and APA only lowercase the ones of three letters or fewer.
const TC_PREPOSITIONS = [
  'about', 'above', 'across', 'after', 'against', 'along', 'among', 'around', 'as', 'at',
  'before', 'behind', 'below', 'beneath', 'beside', 'between', 'beyond', 'by', 'down',
  'during', 'except', 'for', 'from', 'in', 'inside', 'into', 'like', 'near', 'of', 'off',
  'on', 'onto', 'out', 'outside', 'over', 'past', 'per', 'since', 'than', 'through',
  'throughout', 'till', 'to', 'toward', 'towards', 'under', 'underneath', 'until', 'up',
  'upon', 'via', 'with', 'within', 'without',
];

// Chicago and MLA: every article, coordinating conjunction and preposition,
// however long. AP and APA: the same list, but only the short ones qualify, and
// the length test is applied where it is used.
const TC_SMALL_BY_CLASS = new Set(TC_ARTICLES.concat(TC_CONJUNCTIONS, TC_PREPOSITIONS));
const TC_SMALL_BY_LENGTH = TC_SMALL_BY_CLASS;

export const TITLE_DEFAULTS = {
  style: 'ap',          // 'ap' | 'apa' | 'chicago' | 'mla' | 'every-word' | 'sentence'
  keepAcronyms: true,   // NASA and RSVP are not "Nasa" and "Rsvp"
  keepOddCaps: true,    // iPhone, McDonald, eBay keep the shape somebody typed
  fixAllCaps: true,     // A SHOUTED LINE is lowercased first, or nothing can change
};

export function newTitleStats() {
  return { lines: 0, words: 0, lowered: 0, acronyms: 0, shouty: 0,
           charsIn: 0, charsOut: 0, truncated: false };
}

const TC_LENGTH_STYLES = new Set(['ap', 'apa']);
const TC_CLASS_STYLES = new Set(['chicago', 'mla']);

/* Lowercase the whole word FIRST, then put the capital on. Only uppercasing the
 * first letter would leave "NASA" as "NASA" even with the acronym rule turned
 * off, which made that checkbox do nothing. Words somebody shaped deliberately
 * never reach here — tcHasDeliberateCaps sends them straight through. */
function tcCapitalise(word) {
  // The capital goes after any leading punctuation, so ("hello and (world work.
  return word.toLowerCase().replace(/^([^a-z0-9]*)([a-z])/, (m, lead, ch) => lead + ch.toUpperCase());
}

function tcLower(word) {
  return word.toLowerCase();
}

// A word somebody shaped on purpose: NASA, RSVP, iPhone, McDonald, eBay.
function tcHasDeliberateCaps(word, o) {
  const letters = word.replace(/[^A-Za-z]/g, '');
  if (letters.length < 2) return false;
  if (o.keepAcronyms && letters === letters.toUpperCase()) return true;
  /* A capital somewhere after the first letter, AND a lowercase letter
   * somewhere. That is iPhone, eBay, McDonald, MacLeod, O'Brien and DeSoto, and
   * it is NOT NASA, which has no lowercase at all.
   *
   * Two narrower patterns were tried first and both were wrong. `[a-z][A-Z]`
   * missed O'Brien. `^[A-Z][a-z]*[A-Z]` caught O'Brien and also caught NASA,
   * which meant the keepAcronyms checkbox could be switched off and change
   * nothing — the browser suite found that one. */
  const innerCap = /[A-Z]/.test(letters.slice(1));
  const anyLower = /[a-z]/.test(letters);
  if (o.keepOddCaps && innerCap && anyLower) return true;
  return false;
}

export function titleCase(raw, opts = {}) {
  const o = { ...TITLE_DEFAULTS, ...opts };
  const stats = newTitleStats();

  let t = String(raw ?? '');
  stats.charsIn = t.length;
  if (t.length > MAX_INPUT) { t = t.slice(0, MAX_INPUT); stats.truncated = true; }
  t = t.replace(/\r\n?/g, '\n');

  const lines = t.split('\n');

  const out = lines.map(line => {
    if (line.trim() === '') return line;
    stats.lines++;

    let working = line;

    /* A LINE TYPED ENTIRELY IN CAPITALS carries no case information at all, so
     * every rule below would look at it and find nothing to change. Lowercasing
     * it first is what makes the page do anything useful with a shouted heading,
     * which is exactly the kind of line people paste in. */
    const letters = working.replace(/[^A-Za-z]/g, '');
    const shouty = letters.length > 3 && letters === letters.toUpperCase();
    if (shouty && o.fixAllCaps) { working = working.toLowerCase(); stats.shouty++; }

    if (o.style === 'sentence') {
      let result = working.toLowerCase();
      // First letter of the line, and the first letter after . ! or ?
      result = result.replace(/(^\s*|[.!?]\s+)([a-z])/g, (m, pre, ch) => pre + ch.toUpperCase());
      result = result.replace(/\bi\b/g, 'I');
      return result;
    }

    const parts = working.split(/(\s+)/);          // keep the spacing exactly
    const words = [];
    for (let i = 0; i < parts.length; i++) if (!/^\s*$/.test(parts[i])) words.push(i);

    const firstIndex = words[0];
    const lastIndex = words[words.length - 1];
    let afterColon = false;

    const done = parts.map((part, i) => {
      if (/^\s*$/.test(part)) return part;
      stats.words++;

      if (tcHasDeliberateCaps(part, o)) { stats.acronyms++; return part; }

      const bare = part.replace(/[^A-Za-z'-]/g, '').toLowerCase();
      const isFirst = i === firstIndex;
      const isLast = i === lastIndex;
      const forced = isFirst || isLast || afterColon;

      // "Style: The Second Half" — the word after a colon starts a new title.
      afterColon = /[:—–?!.]$/.test(part);

      let small = false;
      if (!forced) {
        if (o.style === 'every-word') small = false;
        else if (TC_LENGTH_STYLES.has(o.style)) small = bare.length <= 3 && TC_SMALL_BY_LENGTH.has(bare);
        else if (TC_CLASS_STYLES.has(o.style)) small = TC_SMALL_BY_CLASS.has(bare);
      }

      if (small) { stats.lowered++; return tcLower(part); }

      // Hyphenated compounds take a capital on each part: "Mother-In-Law".
      return tcCapitalise(part).replace(/-([a-z])/g, (m, ch) => '-' + ch.toUpperCase());
    });

    return done.join('');
  });

  const result = out.join('\n');
  stats.charsOut = result.length;
  return { text: result, stats };
}
