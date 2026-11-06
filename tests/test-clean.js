/**
 * tests/test-clean.js
 *
 * Imports public/clean.js directly — the shipped file, not a copy of it.
 * No framework. `node tests/test-clean.js`. Exit 0 = all green.
 *
 * Every test names the scenario it covers (docs/SCENARIOS.md) or the guard it is
 * (docs/BUG-LEDGER.md). A guard is never deleted.
 */

import { clean, demojibake, normalise, strip, unwrap, parse, toHtml, toText, cleanUrl, squeeze, demarkdown, joinLines, titleCase, LIMIT } from '../public/clean.js';
import { htmlToText, decodeEntities } from '../public/richtext.js';

let passed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures.push({ name, message: e.message }); }
}

function ok(cond, msg) { if (!cond) throw new Error(msg || 'expected true'); }
function has(hay, needle) {
  if (!String(hay).includes(needle)) throw new Error('expected to find ' + JSON.stringify(needle) + '\n   in: ' + JSON.stringify(String(hay).slice(0, 400)));
}
function hasNot(hay, needle) {
  if (String(hay).includes(needle)) throw new Error('expected NOT to find ' + JSON.stringify(needle) + '\n   in: ' + JSON.stringify(String(hay).slice(0, 400)));
}
function eq(a, b) {
  if (a !== b) throw new Error('expected ' + JSON.stringify(b) + '\n     got ' + JSON.stringify(a));
}

/* ---------------------------------------------------------------- *
 * S16 — text that came through the wrong encoding (mojibake)
 *
 * Found the hard way on 2026-09-17: a sample handed over through the Windows
 * clipboard arrived as CP437 mojibake, and every one of these characters had
 * stopped being invisible, so nothing downstream could catch them.
 * ---------------------------------------------------------------- */

test('S16 repairs CP437 mojibake: curly apostrophe', () => {
  eq(demojibake('WeΓÇÖll be there'), 'We’ll be there');
});

test('S16 repairs CP437 mojibake: nbsp, zero-width space, soft hyphen', () => {
  // The first byte of a two-byte UTF-8 sequence is 0xC2, and CP437 renders 0xC2 as
  // the box-drawing character U+252C, not as the letter A-circumflex. That is why
  // Raj's paste read "fills┬áup" and "look┬¡ing".
  eq(demojibake('parking fills┬¡up'), 'parking fills­up');      // soft hyphen
  eq(demojibake('theΓÇï side'), 'the​ side');              // zero-width space
  eq(demojibake('fills┬áup'), 'fills up');                      // non-breaking space
});

test('S16 repairs CP437 mojibake: bullet characters', () => {
  eq(demojibake('ΓÇó bring a dish'), '• bring a dish');
});

test('S16 repairs Windows-1252 mojibake, the common web and email kind', () => {
  eq(demojibake('Weâ€™ll meet at the cafÃ©'), 'We’ll meet at the café');
  eq(demojibake('â€œquotedâ€'), '“quoted”');
});

// GUARD — the repair must never touch text that was correct to begin with
test('GUARD legitimate accented characters are left alone', () => {
  eq(demojibake('café naïve Zürich Ångström'), 'café naïve Zürich Ångström');
});

test('GUARD emoji and non-Latin scripts are left alone', () => {
  eq(demojibake('party 🎉 tonight'), 'party 🎉 tonight');
  eq(demojibake('नमस्ते everyone'), 'नमस्ते everyone');
});

test('GUARD correctly encoded curly quotes survive untouched', () => {
  eq(demojibake('“Bring a dish” — it’s potluck'), '“Bring a dish” — it’s potluck');
});

test('S16 mojibake repair can be turned off', () => {
  const broken = 'WeΓÇÖll';
  eq(demojibake(broken, { fixEncoding: false }), broken);
});

test('S16 end to end: mojibake repaired, then the invisible characters removed', () => {
  // A non-breaking space that arrived as mojibake has to survive BOTH stages:
  // repaired into a real NBSP, then normalised into a plain space.
  const { text, stats } = clean('Doors open at six and parking fills┬áup fast.');
  has(text, 'parking fills up fast.');
  ok(stats.mojibake > 0, 'expected mojibake counted');
  ok(stats.oddSpaces > 0, 'expected the repaired nbsp to then be normalised');
});

test('S16 a bullet list flattened onto one line splits back into items', () => {
  const { html } = clean('• bring your own sticks • wear traditional dress • bring cash');
  eq((html.match(/<li>/g) || []).length, 3);
  has(html, '<li>bring your own sticks</li>');
  has(html, '<li>bring cash</li>');
});

// GUARD — only real bullet glyphs split a line. A hyphen mid-sentence is punctuation.
test('GUARD a hyphen inside a list item does not split it', () => {
  const { html } = clean('- we meet at six - bring a dish');
  eq((html.match(/<li>/g) || []).length, 1);
  has(html, '<li>we meet at six - bring a dish</li>');
});

test('S16 mojibake bullets become a real list, not one run-on line', () => {
  const { html } = clean('ΓÇó bring your own sticks\nΓÇó wear traditional dress');
  has(html, '<ul>');
  has(html, '<li>bring your own sticks</li>');
  has(html, '<li>wear traditional dress</li>');
});

/* ---------------------------------------------------------------- *
 * S5 — Word / Docs paste damage
 * ---------------------------------------------------------------- */

test('S5 removes zero-width characters, BOM and soft hyphens', () => {
  const raw = 'Diw­ali​ din‌ner﻿ tonight';
  const out = normalise(raw);
  eq(out, 'Diwali dinner tonight');
});

test('S5 turns non-breaking and exotic spaces into plain spaces', () => {
  const out = normalise('RSVP by Friday　please');
  eq(out, 'RSVP by Friday please');
});

test('S5 keeps curly quotes and em dashes by default', () => {
  const out = normalise('“Bring a dish” — it’s potluck');
  has(out, '“Bring a dish”');
  has(out, '’');
  has(out, '—');
});

test('S5 straightens quotes only when asked', () => {
  const out = normalise('“Hello” it’s me', { straightenQuotes: true });
  eq(out, '"Hello" it\'s me');
});

test('S5 collapses runs of blank lines to one', () => {
  eq(normalise('a\n\n\n\n\nb'), 'a\n\nb');
});

test('S5 normalises CRLF and lone CR', () => {
  eq(normalise('a\r\nb\rc'), 'a\nb\nc');
});

/* ---------------------------------------------------------------- *
 * S2 — forwarded mail furniture
 * ---------------------------------------------------------------- */

test('S2 removes a forwarded header block but keeps the message', () => {
  const raw = [
    '---------- Forwarded message ---------',
    'From: Priya Shah <priya@example.org>',
    'Date: Mon, 8 Sep 2026 at 16:12',
    'Subject: Diwali dinner',
    'To: Board <board@example.org>',
    '',
    'Please send this out to everyone.',
  ].join('\n');
  const out = strip(normalise(raw));
  hasNot(out, 'Forwarded message');
  hasNot(out, 'priya@example.org');
  hasNot(out, 'Subject:');
  has(out, 'Please send this out to everyone.');
});

test('S2 removes quoted thread lines', () => {
  const out = strip(normalise('My reply here.\n\n> old message\n> more old message'));
  eq(out, 'My reply here.');
});

test('S2 removes a wrapped "On ... wrote:" attribution', () => {
  const raw = 'Sounds good.\n\nOn Mon, Sep 8, 2026 at 4:12 PM Priya Shah\n<priya@example.org> wrote:\n> yes';
  const out = strip(normalise(raw));
  has(out, 'Sounds good.');
  hasNot(out, 'wrote:');
  hasNot(out, 'priya@example.org');
});

test('S2 removes phone and client sign-offs', () => {
  const out = strip(normalise('See you there!\n\nSent from my iPhone'));
  eq(out, 'See you there!');
});

test('S2 cuts everything from the RFC signature delimiter', () => {
  const out = strip(normalise('The real message.\n\n-- \nPriya Shah\nBoard Member\n555-0100'));
  eq(out, 'The real message.');
});

test('S2 cuts a confidentiality notice and everything after it', () => {
  const out = strip(normalise('Come to the dinner.\n\nThis email and any attachments are confidential and intended solely for the addressee.'));
  eq(out, 'Come to the dinner.');
});

test('S2 removes unsubscribe boilerplate', () => {
  const out = strip(normalise('Newsletter body.\n\nTo unsubscribe click here\nYou are receiving this email because you subscribed'));
  eq(out, 'Newsletter body.');
});

test('S2 strips WhatsApp export timestamps and keeps what was said', () => {
  const raw = '[9/12/26, 3:04:21 PM] Priya Shah: Please send out the Diwali notice\n[9/12/26, 3:05:02 PM] Raj: will do\n<Media omitted>';
  const out = strip(normalise(raw));
  has(out, 'Please send out the Diwali notice');
  has(out, 'will do');
  hasNot(out, '3:04');
  hasNot(out, 'Media omitted');
});

// GUARD — a lone "Date:" is an event detail, not a mail header (S4 vs S2 collision)
test('GUARD a single Date: line survives, a pack of headers does not', () => {
  const lone = strip(normalise('Diwali Dinner\n\nDate: Saturday, November 7'));
  has(lone, 'Date: Saturday, November 7');

  const pack = strip(normalise('From: a@b.com\nDate: Mon, 8 Sep 2026\nSubject: hi\n\nbody'));
  hasNot(pack, 'Date: Mon');
  has(pack, 'body');
});

/* ---------------------------------------------------------------- *
 * S3 — hard-wrapped lines
 * ---------------------------------------------------------------- */

test('S3 rejoins email-width wrapped prose into one paragraph', () => {
  const raw = [
    'Our annual Diwali dinner is on Saturday November 7th and we would',
    'love for every family to join us for an evening of food, music and',
    'dancing at the Torrance Cultural Arts Center this year.',
  ].join('\n');
  const out = unwrap(normalise(raw));
  eq(out.split('\n').length, 1);
  has(out, 'we would love for every');
});

test('S3 rejoins narrow phone-width wrapping too', () => {
  const raw = 'Hi everyone please remember that\nthe potluck starts at six thirty\nand parking is behind the hall';
  const out = unwrap(normalise(raw));
  eq(out.split('\n').length, 1);
});

test('S3 keeps deliberate breaks in a bullet list', () => {
  const raw = '- bring a dish to share\n- bring a friend\n- bring cash for the raffle';
  eq(unwrap(normalise(raw)), raw);
});

test('S3 keeps short deliberate lines unjoined', () => {
  const raw = '6:00 pm\n7:00 pm\n8:00 pm';
  eq(unwrap(normalise(raw)), raw);
});

test('S3 does not join a label line into the line above', () => {
  const raw = 'Our annual Diwali dinner is on Saturday the seventh of November\nWhere: Torrance Cultural Arts Center';
  const out = unwrap(normalise(raw));
  eq(out.split('\n').length, 2);
});

/* ---------------------------------------------------------------- *
 * S4 — structure comes back
 * ---------------------------------------------------------------- */

test('S4 promotes the opening line to a heading', () => {
  const blocks = parse('Diwali Dinner 2026\n\nJoin us for an evening of food and music.');
  eq(blocks[0].type, 'heading');
  eq(blocks[0].text, 'Diwali Dinner 2026');
  eq(blocks[1].type, 'paragraph');
});

test('S4 treats a SHOUTED line as a heading wherever it appears', () => {
  const blocks = parse('Some intro text here that is a real sentence.\n\nVOLUNTEERS NEEDED\n\nWe need six people.');
  ok(blocks.some(b => b.type === 'heading' && b.text === 'VOLUNTEERS NEEDED'), 'expected a heading block');
});

test('S4 bolds known labels', () => {
  const blocks = parse('When: Saturday, November 7\nWhere: Torrance Cultural Arts Center\nCost: $25 per family');
  eq(blocks.length, 3);
  blocks.forEach(b => eq(b.type, 'labelled'));
  eq(blocks[0].label, 'When');
  eq(blocks[0].value, 'Saturday, November 7');
  eq(blocks[2].value, '$25 per family');
});

test('S4 renders labels bold in html and flat in text', () => {
  const { html, text } = clean('When: Saturday\nWhere: The hall\nCost: $25');
  has(html, '<p><strong>When:</strong> Saturday</p>');
  has(text, 'When: Saturday');
  hasNot(text, '<strong>');
});

test('S4 detects bullet lists whatever the bullet character', () => {
  const blocks = parse('• first\n- second\n* third');
  eq(blocks.length, 1);
  eq(blocks[0].type, 'list');
  eq(blocks[0].ordered, false);
  eq(blocks[0].items.length, 3);
  eq(blocks[0].items[0], 'first');
});

test('S4 detects numbered lists and renders an ol', () => {
  const { html, text } = clean('1. arrive\n2. eat\n3. dance');
  has(html, '<ol>');
  has(html, '<li>arrive</li>');
  has(text, '1. arrive');
  has(text, '3. dance');
});

test('S4 makes urls and emails clickable', () => {
  const { html, text } = clean('RSVP: https://example.org/rsvp or email board@example.org');
  has(html, 'href="https://example.org/rsvp"');
  has(html, 'href="mailto:board@example.org"');
  has(html, 'rel="noopener noreferrer"');
  has(text, 'https://example.org/rsvp');
  hasNot(text, '<a ');
});

test('S4 links bare www addresses with an https href', () => {
  const { html } = clean('See www.example.org/diwali for details');
  has(html, 'href="https://www.example.org/diwali"');
  has(html, '>www.example.org/diwali</a>');
});

test('S4 preserves deliberate line breaks inside a paragraph as br', () => {
  const { html } = clean('Body text first.\n\n3330 Civic Center Dr\nTorrance, CA 90503');
  has(html, '<br>');
});

/* ---------------------------------------------------------------- *
 * tracking parameters
 * ---------------------------------------------------------------- */

test('strips utm and friends, keeps real query parameters', () => {
  eq(cleanUrl('https://example.org/e?utm_source=news&id=7&fbclid=abc'), 'https://example.org/e?id=7');
});

test('drops the question mark when nothing is left', () => {
  eq(cleanUrl('https://example.org/e?utm_source=news&utm_medium=email'), 'https://example.org/e');
});

test('leaves a clean url completely alone', () => {
  eq(cleanUrl('https://example.org/e?id=7'), 'https://example.org/e?id=7');
});

test('leaves urls alone when tracking removal is off', () => {
  eq(cleanUrl('https://example.org/e?utm_source=x', { stripTracking: false }), 'https://example.org/e?utm_source=x');
});

// GUARD — escaping before linkifying turned "&b=2" into a parameter named "amp;b",
// which came back re-encoded as "amp%3Bb". The href below is the correct one:
// "&amp;" is simply how "&" is spelled inside an HTML attribute.
test('GUARD an ampersand in a query string survives linkification', () => {
  const { html } = clean('Register at https://example.org/go?a=1&b=2 today');
  has(html, 'href="https://example.org/go?a=1&amp;b=2"');
  hasNot(html, 'amp%3B');          // the parameter-name corruption
  hasNot(html, '&amp;amp;');       // double-escaping
  eq(cleanUrl('https://example.org/go?a=1&b=2'), 'https://example.org/go?a=1&b=2');
});

/* ---------------------------------------------------------------- *
 * safety
 * ---------------------------------------------------------------- */

test('pasted html is inert, never markup', () => {
  const { html } = clean('<script>alert(1)</script>\n\nHello <b>there</b>');
  hasNot(html, '<script>');
  hasNot(html, '<b>there</b>');
  has(html, '&lt;script&gt;');
});

test('javascript: urls never become links', () => {
  const { html } = clean('click javascript:alert(1) now');
  hasNot(html, 'href="javascript:');
});

test('double asterisks become strong, and go away in plain text', () => {
  const { html, text } = clean('Please **bring a dish** to share');
  has(html, '<strong>bring a dish</strong>');
  has(text, 'bring a dish');
  hasNot(text, '**');
});

/* ---------------------------------------------------------------- *
 * guards — see docs/BUG-LEDGER.md. A guard is never deleted.
 * ---------------------------------------------------------------- */

// BUG-004 — loosening the signature rule made "--" as a divider eat the message
test('GUARD a -- divider keeps everything after it', () => {
  const { html, text } = clean('First part of the message.\n\n--\n\nSecond part of the message.');
  has(html, 'Second part of the message.');
  has(text, 'Second part of the message.');
});

test('GUARD a signature block immediately after -- is still cut', () => {
  const { text } = clean('The real message.\n\n-- \nPriya Shah\nBoard Member\n555-0100');
  eq(text, 'The real message.');
});

// BUG-003 — an address is not a heading
test('GUARD a multi-line address keeps all of its lines as content', () => {
  const { html } = clean('See you Saturday.\n\n3330 Civic Center Dr\nTorrance, CA 90503');
  hasNot(html, '<h2>3330');
  hasNot(html, '<h3>3330');
  has(html, '3330 Civic Center Dr');
  has(html, 'Torrance, CA 90503');
});

// A one-line message is a message, not a title
test('GUARD a single-line message does not become a heading', () => {
  const { html } = clean('Potluck moved to the 14th');
  has(html, '<p>');
  hasNot(html, '<h2>');
});

// The generic "Label:" rule only fires when labels travel in a pack
test('GUARD a lone "Hi everyone:" is not bolded as a label', () => {
  const { html } = clean('Hi everyone: please read this note before Saturday.');
  hasNot(html, '<strong>Hi everyone:</strong>');
});

/* ---------------------------------------------------------------- *
 * S11, S12 — purity and size
 * ---------------------------------------------------------------- */

test('S11 clean() is pure: the same input twice gives the same output', () => {
  const input = 'Diwali Dinner\n\nWhen: Saturday\n\n- bring a dish\n- bring a friend';
  const a = clean(input);
  const b = clean(input);
  eq(a.html, b.html);
  eq(a.text, b.text);
  eq(JSON.stringify(a.stats), JSON.stringify(b.stats));
});

test('S11 no state leaks between calls', () => {
  clean('first message with https://example.org/a link');
  const second = clean('plain second message');
  eq(second.stats.links, 0);
  hasNot(second.html, 'example.org');
});

test('S12 a very large input completes quickly and flags truncation', () => {
  const big = ('The quick brown fox jumps over the lazy dog. ').repeat(6000);
  const started = Date.now();
  const out = clean(big);
  const ms = Date.now() - started;
  ok(big.length > LIMIT, 'test input should exceed the limit');
  ok(out.stats.truncated === true, 'expected truncated flag');
  ok(ms < 2000, 'took ' + ms + 'ms, expected under 2000ms');
  ok(out.text.length > 0, 'expected output');
});

test('empty and whitespace-only input does not throw', () => {
  eq(clean('').text, '');
  eq(clean('   \n\n  ').text, '');
  eq(clean(null).text, '');
  eq(clean(undefined).text, '');
});

/* ---------------------------------------------------------------- *
 * the whole pipeline, on a message shaped like a real one
 * ---------------------------------------------------------------- */

test('end to end: a forwarded, wrapped, messy event notice', () => {
  const raw = [
    '---------- Forwarded message ---------',
    'From: Priya Shah <priya@example.org>',
    'Subject: Diwali dinner',
    '',
    'DIWALI DINNER 2026',
    '',
    'Please join us for our annual Diwali celebration with food, music and',
    'dancing for the whole family. Everyone is welcome and we would love',
    'to see a big turnout this year.',
    '',
    'When: Saturday, November 7 at 6:30 pm',
    'Where: Torrance Cultural Arts Center',
    'Cost: $25 per family',
    'RSVP: https://example.org/rsvp?utm_source=email&id=99',
    '',
    '• bring a dish to share',
    '• bring cash for the raffle',
    '',
    'Sent from my iPhone',
  ].join('\n');

  const { html, text, stats } = clean(raw);

  hasNot(html, 'Forwarded');
  hasNot(html, 'Subject');
  hasNot(html, 'Sent from my iPhone');
  has(html, '<h2>DIWALI DINNER 2026</h2>');
  has(html, '<strong>When:</strong> Saturday, November 7 at 6:30 pm');
  has(html, '<strong>Cost:</strong> $25 per family');
  has(html, 'href="https://example.org/rsvp?id=99"');
  hasNot(html, 'utm_source');
  has(html, '<ul>');
  has(html, '<li>bring a dish to share</li>');
  has(html, 'food, music and dancing for the whole family');

  has(text, 'DIWALI DINNER 2026');
  has(text, 'When: Saturday, November 7 at 6:30 pm');
  has(text, '• bring a dish to share');
  hasNot(text, 'utm_source');
  hasNot(text, '<');

  ok(stats.junkLines > 0, 'expected junk lines counted');
  ok(stats.joins > 0, 'expected wrapped lines rejoined');
  ok(stats.labels === 4, 'expected 4 labels, got ' + stats.labels);
});
/* ---------------------------------------------------------------- *
 * TOOL TWO — squeeze(), behind /remove-extra-spaces
 *
 * The promise of that page is that it does what the checkboxes say and nothing
 * else. So most of these tests are about what it must NOT do.
 * ---------------------------------------------------------------- */

test('squeeze collapses runs of spaces to one', () => {
  eq(squeeze('Hello    world').text, 'Hello world');
});

test('squeeze turns tabs into single spaces', () => {
  eq(squeeze('a\t\tb').text, 'a b');
});

test('squeeze removes trailing whitespace on every line', () => {
  eq(squeeze('one   \ntwo\t\nthree').text, 'one\ntwo\nthree');
});

test('squeeze KEEPS leading indentation by default', () => {
  // Indentation is usually deliberate. Eating it is the kind of helpfulness
  // nobody asked for, so it is off unless the visitor ticks the box.
  eq(squeeze('top\n    indented').text, 'top\n    indented');
});

test('squeeze trims line starts when asked', () => {
  eq(squeeze('top\n    indented', { trimLineStarts: true }).text, 'top\nindented');
});

test('squeeze collapses a run of blank lines to one', () => {
  eq(squeeze('a\n\n\n\n\nb').text, 'a\n\nb');
});

test('squeeze removes every blank line when asked', () => {
  eq(squeeze('a\n\n\nb\n\nc', { blankLines: 'remove' }).text, 'a\nb\nc');
});

test('squeeze leaves blank lines completely alone when asked', () => {
  eq(squeeze('a\n\n\n\nb', { blankLines: 'keep' }).text, 'a\n\n\n\nb');
});

test('squeeze leaves spaces alone when collapsing is turned off', () => {
  // A checkbox that changes nothing is a lie told in the interface.
  eq(squeeze('Hello    world', { collapseSpaces: false }).text, 'Hello    world');
});

test('squeeze removes invisible characters', () => {
  const r = squeeze('a​b‍b');
  eq(r.text, 'abb');
  eq(r.stats.invisibles, 2);
});

test('squeeze turns a non-breaking space into a plain space', () => {
  const r = squeeze('a b');
  eq(r.text, 'a b');
  eq(r.stats.oddSpaces, 1);
});

test('squeeze repairs mojibake FIRST, so the hidden space is then catchable', () => {
  // "parking fills┬áup" is a non-breaking space that came through CP437. Until it
  // is repaired it is two visible characters, and no whitespace rule can see it.
  const r = squeeze('parking fills┬áup fast');
  eq(r.text, 'parking fills up fast');
  ok(r.stats.mojibake > 0, 'expected the encoding damage to be counted');
});

test('squeeze does NOT do the other tool job: no headers stripped, no lines rejoined', () => {
  // The guard that keeps these two tools from quietly becoming the same tool.
  const input = 'Sent from my iPhone\nthis line is\nbroken in two';
  const r = squeeze(input);
  has(r.text, 'Sent from my iPhone');
  has(r.text, 'this line is\nbroken in two');
});

test('squeeze counts what it actually changed', () => {
  const r = squeeze('a    b  c\n\n\n\nd   \n');
  eq(r.stats.spaceRuns, 3);
  ok(r.stats.blankLines > 0, 'expected blank lines counted');
  ok(r.stats.charsOut < r.stats.charsIn, 'expected the text to get shorter');
});

/* ---------------------------------------------------------------- *
 * TOOL THREE — demarkdown(), behind /markdown-to-plain-text
 * ---------------------------------------------------------------- */

test('demarkdown strips heading hashes and keeps the words', () => {
  eq(demarkdown('## A Heading').text, 'A Heading');
});

test('demarkdown removes a setext underline and keeps the line above it', () => {
  eq(demarkdown('A Heading\n=========').text, 'A Heading');
});

test('demarkdown drops a horizontal rule but not a setext heading', () => {
  // Same three characters, different meaning, decided only by what came before.
  eq(demarkdown('text\n\n---\n\nmore').text, 'text\n\nmore');
  eq(demarkdown('text\n---\n\nmore').text, 'text\n\nmore');
});

test('demarkdown removes bold, italic and strikethrough', () => {
  eq(demarkdown('**bold** and *italic* and ~~gone~~').text, 'bold and italic and gone');
});

test('demarkdown removes inline code backticks and keeps the code', () => {
  eq(demarkdown('run `npm test` now').text, 'run npm test now');
});

test('demarkdown keeps fenced code EXACTLY, asterisks and all', () => {
  // Inside a fence everything is literal. Treating a shell glob as emphasis
  // would silently corrupt the one thing a developer pasted it to preserve.
  const r = demarkdown('```\nrm *.tmp\n```');
  has(r.text, 'rm *.tmp');
  eq(r.stats.codeBlocks, 1);
});

test('demarkdown leaves snake_case identifiers whole', () => {
  eq(demarkdown('a file called my_var_name here').text, 'a file called my_var_name here');
});

test('demarkdown turns a link into its text', () => {
  eq(demarkdown('see [the docs](https://example.com/x) now').text, 'see the docs now');
});

test('demarkdown can keep the URL alongside the text', () => {
  eq(demarkdown('see [the docs](https://example.com/x)', { links: 'text-and-url' }).text,
     'see the docs (https://example.com/x)');
});

test('demarkdown turns an image into its alt text', () => {
  const r = demarkdown('![a diagram](pic.png)');
  eq(r.text, 'a diagram');
  eq(r.stats.images, 1);
});

test('demarkdown removes blockquote markers', () => {
  eq(demarkdown('> quoted\n> again').text, 'quoted\nagain');
});

test('demarkdown normalises bullets and drops task checkboxes', () => {
  eq(demarkdown('- one\n* two\n+ three\n- [ ] four').text, '• one\n• two\n• three\n• four');
});

test('demarkdown keeps numbered lists numbered', () => {
  eq(demarkdown('1. first\n2. second').text, '1. first\n2. second');
});

test('demarkdown flattens a table and drops its rule row', () => {
  const r = demarkdown('| Name | Cost |\n|------|------|\n| Adult | $30 |');
  eq(r.text, 'Name  Cost\nAdult  $30');
  eq(r.stats.tableRows, 2);
});

test('demarkdown drops reference definitions and resolves reference links', () => {
  eq(demarkdown('see [the docs][d]\n\n[d]: https://example.com').text, 'see the docs');
});

test('demarkdown unescapes escaped markdown characters', () => {
  eq(demarkdown('a \\* literal asterisk').text, 'a * literal asterisk');
});

test('demarkdown strips raw HTML tags and keeps the words', () => {
  eq(demarkdown('a <strong>bold</strong> word').text, 'a bold word');
});

test('demarkdown does NOT do the other tool job: no forwarded furniture removed', () => {
  has(demarkdown('# Title\n\nSent from my iPhone').text, 'Sent from my iPhone');
});

/* ---------------------------------------------------------------- *
 * TOOL ONE — joinLines(), behind /remove-line-breaks
 *
 * The promise is literal: remove the line breaks. unwrap() guesses at wrap width
 * because a wrong guess inside the full cleaner is invisible damage; this one
 * does not guess, because the visitor asked for exactly this.
 * ---------------------------------------------------------------- */

test('joinLines rejoins a hard-wrapped paragraph', () => {
  eq(joinLines('This sentence was\nbroken across\nthree lines.').text,
     'This sentence was broken across three lines.');
});

test('joinLines keeps a blank line as a paragraph break', () => {
  eq(joinLines('One para\nwrapped.\n\nSecond para\nalso wrapped.').text,
     'One para wrapped.\n\nSecond para also wrapped.');
});

test('joinLines joins SHORT lines too, unlike unwrap()', () => {
  // unwrap() leaves these alone: they are under its wrap-width threshold, so it
  // cannot tell a wrapped line from a deliberate one. This page was asked.
  eq(joinLines('a\nb\nc').text, 'a b c');
  eq(unwrap('a\nb\nc'), 'a\nb\nc');
});

test('joinLines mode "all" produces a single line', () => {
  eq(joinLines('One para\nwrapped.\n\nSecond para.', { mode: 'all' }).text,
     'One para wrapped. Second para.');
});

test('joinLines keeps bullets on their own lines', () => {
  // Joining a list into a sentence is the one thing this tool can destroy that
  // the visitor cannot get back.
  eq(joinLines('Bring these:\n- dandiya sticks\n- water\n- a dish to share').text,
     'Bring these:\n- dandiya sticks\n- water\n- a dish to share');
});

test('joinLines joins a wrapped continuation INTO its bullet', () => {
  eq(joinLines('- a bullet that was\n  wrapped across lines\n- second bullet').text,
     '- a bullet that was wrapped across lines\n- second bullet');
});

test('joinLines joins the bullets too when asked', () => {
  eq(joinLines('- one\n- two', { keepLists: false }).text, '- one - two');
});

test('joinLines keeps numbered items apart', () => {
  eq(joinLines('1. first\n2. second').text, '1. first\n2. second');
});

test('joinLines repairs a word split by a hyphen at the line end', () => {
  const r = joinLines('This is informa-\ntion from a PDF.');
  eq(r.text, 'This is information from a PDF.');
  eq(r.stats.hyphens, 1);
});

test('joinLines leaves a real hyphen before a capital alone', () => {
  eq(joinLines('He is self-\nEmployed now.').text, 'He is self- Employed now.');
});

test('joinLines can join with no separator at all', () => {
  eq(joinLines('abc\ndef', { separator: '' }).text, 'abcdef');
});

test('joinLines does not leave double spaces behind', () => {
  eq(joinLines('trailing space here \nand more').text, 'trailing space here and more');
});

test('joinLines counts what it did', () => {
  const r = joinLines('a\nb\nc\n\nd\ne');
  eq(r.stats.joins, 3);
  eq(r.stats.paragraphs, 2);
});

test('joinLines does NOT do the other tools job: no headers stripped', () => {
  has(joinLines('Sent from my iPhone').text, 'Sent from my iPhone');
});

/* ---------------------------------------------------------------- *
 * TOOL THREE — titleCase(), behind /title-case-converter
 *
 * The styles are the whole point of the page. Most converters capitalise every
 * word and call that title case, which is the one thing no style guide says to
 * do. These tests are the difference between the styles.
 * ---------------------------------------------------------------- */

test('titleCase AP capitalises a preposition of four letters or more', () => {
  // AP and APA decide by LENGTH: three letters or fewer stay down.
  eq(titleCase('a journey through the woods between two rivers', { style: 'ap' }).text,
     'A Journey Through the Woods Between Two Rivers');
});

test('titleCase Chicago lowercases a long preposition', () => {
  // Chicago and MLA decide by WORD CLASS, whatever the length.
  eq(titleCase('a journey through the woods between two rivers', { style: 'chicago' }).text,
     'A Journey through the Woods between Two Rivers');
});

test('titleCase APA matches AP, and MLA matches Chicago', () => {
  const src = 'a walk against the wind';
  eq(titleCase(src, { style: 'apa' }).text, titleCase(src, { style: 'ap' }).text);
  eq(titleCase(src, { style: 'mla' }).text, titleCase(src, { style: 'chicago' }).text);
});

test('titleCase always capitalises the first and the last word', () => {
  // "for" is a small word in every style, and it still gets a capital at the end.
  eq(titleCase('what are you waiting for').text, 'What Are You Waiting For');
  eq(titleCase('the end of it').text, 'The End of It');
});

test('titleCase capitalises the word after a colon', () => {
  eq(titleCase('a study: the second half of the story').text,
     'A Study: The Second Half of the Story');
});

test('titleCase lowercases A SHOUTED LINE first, or nothing could change', () => {
  const r = titleCase('NAVRATRI GARBA NIGHT 2026');
  eq(r.text, 'Navratri Garba Night 2026');
  eq(r.stats.shouty, 1);
});

test('titleCase leaves a shouted line alone when that is turned off', () => {
  eq(titleCase('NAVRATRI GARBA NIGHT', { fixAllCaps: false }).text, 'NAVRATRI GARBA NIGHT');
});

test('titleCase keeps acronyms and odd capitals exactly as typed', () => {
  // "Nasa" and "Iphone" are wrong, and no amount of style guide fixes them.
  const r = titleCase('the NASA report on iPhone sales');
  eq(r.text, 'The NASA Report on iPhone Sales');
  eq(r.stats.acronyms, 2);
});

test('titleCase keeps a Scottish or Irish capital in the middle of a name', () => {
  eq(titleCase('a talk by McDonald and OBrien').text, 'A Talk by McDonald and OBrien');
});

// GUARD — the odd-caps rule must not also swallow acronyms, or turning the
// acronym checkbox off would change nothing and the control would be decoration.
// Caught by the browser suite on 2026-09-18: the pattern was ^[A-Z][a-z]*[A-Z],
// and the star matched NASA.
test('GUARD turning keepAcronyms off really does lower an acronym', () => {
  eq(titleCase('the NASA report', { keepAcronyms: false }).text, 'The Nasa Report');
  // and McDonald is still protected, by the odd-caps rule, which is a different rule
  eq(titleCase('a talk by McDonald', { keepAcronyms: false }).text, 'A Talk by McDonald');
});

test('titleCase capitalises both halves of a hyphenated compound', () => {
  eq(titleCase('my mother-in-law and me').text, 'My Mother-In-Law and Me');
});

test('titleCase treats each line as its own title', () => {
  // A pasted list of headlines is several titles, not one sentence.
  eq(titleCase('first headline here\nsecond headline here').text,
     'First Headline Here\nSecond Headline Here');
});

test('titleCase keeps blank lines and the spacing between words', () => {
  eq(titleCase('one two\n\nthree four').text, 'One Two\n\nThree Four');
});

test('titleCase every-word capitalises the small words too', () => {
  eq(titleCase('the lord of the rings', { style: 'every-word' }).text, 'The Lord Of The Rings');
});

test('titleCase sentence style capitalises sentences, and the word I', () => {
  eq(titleCase('THIS IS SHOUTED. and i said no.', { style: 'sentence' }).text,
     'This is shouted. And I said no.');
});

test('titleCase counts what it did', () => {
  const r = titleCase('the lord of the rings');
  eq(r.stats.lines, 1);
  eq(r.stats.words, 5);
  eq(r.stats.lowered, 2);          // "of" and the middle "the"
});

test('titleCase does NOT do the other tools job: line breaks and spacing survive', () => {
  const r = titleCase('one    two\nthree');
  has(r.text, 'One    Two');
  has(r.text, '\nThree');
});


/* ---------------------------------------------------------------- */


/* ================================================================== *
 * S17 — a paste that arrived WITH ITS FORMATTING
 *
 * BUG-009. Box 1 is a textarea, so the browser hands it the text/plain flavour
 * of the clipboard and drops the text/html one, taking every link with it —
 * an anchor's URL lives in the href and never in the words on screen. Raj found
 * it on 2026-09-18 copying an article from espn.com in Brave on Android; it is
 * not a Brave bug and not an Android bug, every browser does exactly this.
 *
 * richtext.js reads the discarded flavour and writes it back out in the dialect
 * clean.js already understands. These tests run the shipped module directly.
 * The guard that the PAGE actually wires it up is in tests/test-ui.mjs, because
 * that is the layer every bug in this project has lived in.
 * ================================================================== */

test('S17 a heading survives the paste as a heading', () => {
  const r = htmlToText('<h2>Garba Night 2026</h2><p>Details below.</p>');
  has(r.text, '## Garba Night 2026');
  eq(r.stats.headings, 1);
  // and clean.js has to honour it, not re-guess it
  has(clean(r.text).html, '<h2>Garba Night 2026</h2>');
});

test('S17 bold survives as bold', () => {
  const r = htmlToText('<p>Doors open at <strong>six</strong> sharp</p>');
  eq(r.text, 'Doors open at **six** sharp');
  has(clean(r.text).html, '<strong>six</strong>');
});

test('S17 <b> counts as bold too, and nesting does not double the markers', () => {
  eq(htmlToText('<p><b>All <strong>of</strong> it</b></p>').text, '**All of it**');
});

test('S17 a link keeps the URL that only ever lived in the href', () => {
  const r = htmlToText('<p><a href="https://example.org/rsvp">RSVP here</a></p>');
  eq(r.text, 'RSVP here (https://example.org/rsvp)');
  eq(r.stats.links, 1);
  // and the whole point: clean.js can now make it clickable
  has(clean(r.text).html, 'href="https://example.org/rsvp"');
});

test('S17 tracking on a pasted link is still stripped, because clean.js sees it', () => {
  const r = htmlToText('<a href="https://example.org/x?utm_source=news&amp;id=4417">Tickets</a>');
  has(r.text, 'https://example.org/x?utm_source=news&id=4417');
  const html = clean(r.text).html;
  hasNot(html, 'utm_source');
  has(html, 'id=4417');
});

test('S17 bullets and numbered lists survive', () => {
  const ul = htmlToText('<ul><li>dandiya sticks</li><li>traditional dress</li></ul>');
  eq(ul.text, '• dandiya sticks\n• traditional dress');
  eq(ul.stats.listItems, 2);
  const ol = htmlToText('<ol><li>first</li><li>second</li><li>third</li></ol>');
  eq(ol.text, '1. first\n2. second\n3. third');
});

test('S17 <br> is a line break and <hr> is a rule', () => {
  eq(htmlToText('<p>one<br>two</p>').text, 'one\ntwo');
  has(htmlToText('<p>a</p><hr><p>b</p>').text, '\n---\n');
});

test('S17 entities are decoded, numeric and named', () => {
  eq(htmlToText('<p>Tom &amp; Jerry &#8217;s caf&eacute; &#x2014; 5 &lt; 6</p>').text,
     'Tom & Jerry ’s café — 5 < 6');
});

test('S17 a non-breaking space arrives as one, so normalise() can count it', () => {
  const r = htmlToText('<p>parking fills&nbsp;up</p>');
  eq(r.text, 'parking fills up');
  const c = clean(r.text);
  ok(c.stats.oddSpaces >= 1, 'the nbsp was not counted as an odd space');
  has(c.html, 'fills up');
});

/* GUARDS — the junk a real page brings with it */

test('GUARD script and style contents never become text', () => {
  const r = htmlToText('<style>p{color:red}</style><script>var a = "<p>no</p>";</script><p>kept</p>');
  eq(r.text, 'kept');
});

test('GUARD an element the page was hiding stays hidden', () => {
  // This is where "Sponsored" and "Skip to main content" come from on a news site.
  eq(htmlToText('<p><span style="display:none">Sponsored</span>Real words</p>').text, 'Real words');
  eq(htmlToText('<p><span aria-hidden="true">•</span>Real words</p>').text, 'Real words');
  eq(htmlToText('<div hidden><p>gone</p></div><p>Real words</p>').text, 'Real words');
});

test('GUARD a relative or javascript href is dropped, not emitted', () => {
  // There is no base to resolve it against once the text is on the clipboard.
  eq(htmlToText('<a href="/nfl/story/_/id/4417">Read more</a>').text, 'Read more');
  eq(htmlToText('<a href="#top">Top</a>').text, 'Top');
  eq(htmlToText('<a href="javascript:alert(1)">Click</a>').text, 'Click');
});

test('GUARD an icon link with no words contributes nothing', () => {
  eq(htmlToText('<p>Score <a href="https://espn.com/x"><img src="i.png"></a></p>').text, 'Score');
});

test('GUARD a link whose words already are the address is not said twice', () => {
  eq(htmlToText('<a href="https://example.org/x">https://example.org/x</a>').text, 'https://example.org/x');
  eq(htmlToText('<a href="mailto:p@x.org">p@x.org</a>').text, 'p@x.org');
});

test('GUARD an attribute containing > does not end the tag early', () => {
  eq(htmlToText('<a href="https://example.org/a" title="a > b">Link</a>').text,
     'Link (https://example.org/a)');
});

test('GUARD the browser fragment markers select the selection, not the page', () => {
  const r = htmlToText('<html><body><p>page furniture</p><!--StartFragment--><p>what they chose</p><!--EndFragment--><p>more furniture</p></body></html>');
  eq(r.text, 'what they chose');
});

test('GUARD markup carrying no prose reports empty, so the caller pastes normally', () => {
  eq(htmlToText('<div><span></span><img src="x.png"></div>').text, '');
  eq(htmlToText('').text, '');
  eq(htmlToText(null).text, '');
});

test('GUARD a bold run crossing a line break is closed on both lines', () => {
  // An unclosed ** is not bold to clean.js, it is two asterisks in somebody's text.
  const r = htmlToText('<p><strong>one<br>two</strong></p>');
  eq(r.text, '**one**\n**two**');
  hasNot(clean(r.text).html, '**');
});

test('GUARD bold around nothing leaves no stray asterisks', () => {
  hasNot(htmlToText('<p>a<strong> </strong>b</p>').text, '*');
});

test('GUARD an Outlook layout table becomes paragraphs, not pipes', () => {
  const r = htmlToText('<table><tr><td><p>Hello there</p></td></tr><tr><td>Second block</td></tr></table>');
  has(r.text, 'Hello there');
  has(r.text, 'Second block');
  hasNot(r.text, '|');
});

test('GUARD an unknown inline tag keeps its words', () => {
  eq(htmlToText('<p>a <o:p>b</o:p> <custom-thing>c</custom-thing></p>').text, 'a b c');
});

/* The whole path, end to end: a formatted article in, structure out. */
test('S17 a formatted article keeps heading, bold, bullets and links together', () => {
  const article = [
    '<h1>Lakers rally past the Celtics</h1>',
    '<p>The <b>fourth quarter</b> was the difference.</p>',
    '<ul><li>LeBron: 31 points</li><li>Davis: 18 rebounds</li></ul>',
    '<p>Full box score at <a href="https://example.com/box?utm_medium=social">ESPN</a>.</p>',
  ].join('');
  const result = clean(htmlToText(article).text);
  has(result.html, '<h2>Lakers rally past the Celtics</h2>');
  has(result.html, '<strong>fourth quarter</strong>');
  has(result.html, '<li>LeBron: 31 points</li>');
  has(result.html, 'href="https://example.com/box"');
  hasNot(result.html, 'utm_medium');
});

/* ---------------------------------------------------------------- *
 * ATX headings in clean.js itself
 *
 * richtext.js writes "## " for an <h2>, but the same syntax arrives on its own
 * from anyone pasting markdown out of an assistant. isHeading() can only GUESS
 * from the shape of a line; this says it outright.
 * ---------------------------------------------------------------- */

test('S17 a markdown heading is a heading, whatever its shape', () => {
  // Every one of these fails isHeading()'s guesswork: too long, ends in a full
  // stop, or too few capitals to look like a title.
  has(clean('## lakers rally past the celtics in overtime.\n\nBody text here.').html,
      '<h2>lakers rally past the celtics in overtime.</h2>');
});

test('S17 heading levels map onto the two the renderer has', () => {
  has(clean('# One').html, '<h2>One</h2>');
  has(clean('## Two').html, '<h2>Two</h2>');
  has(clean('### Three').html, '<h3>Three</h3>');
  has(clean('###### Six').html, '<h3>Six</h3>');
});

test('S17 a heading is never swallowed by the line below it', () => {
  const html = clean('## The heading here\nA sentence that is long enough to look like a wrapped line.').html;
  has(html, '<h2>The heading here</h2>');
});

test('GUARD a hashtag and a house number are not headings', () => {
  hasNot(clean('#Lakers are back').html, '<h2>');
  hasNot(clean('Meet at #4 Civic Center').html, '<h2>');
});

test('GUARD with headings off the marker is removed, not left on screen', () => {
  const html = clean('## Garba Night', { headings: false }).html;
  hasNot(html, '#');
  has(html, 'Garba Night');
});

test('GUARD a trailing run of hashes is closing syntax, not content', () => {
  has(clean('## Garba Night ##').html, '<h2>Garba Night</h2>');
});


test('S17 a bold title line is a heading once, not a heading wrapped round a bold run', () => {
  const r = htmlToText('<p><b>Navratri Garba Night 2026</b></p><p>Body text follows here.</p>');
  const html = clean(r.text).html;
  has(html, '<h2>Navratri Garba Night 2026</h2>');
  hasNot(html, '<h2><strong>');
});

test('GUARD two bold runs in one heading line both survive', () => {
  has(clean(['**When** and **Where** are both on the flyer', '', 'More text.'].join('\n')).html,
      '<h2><strong>When</strong> and <strong>Where</strong> are both on the flyer</h2>');
});

const total = passed + failures.length;
if (failures.length) {
  console.log('\nFAIL  ' + failures.length + ' of ' + total + '\n');
  failures.forEach(f => console.log('  x ' + f.name + '\n    ' + f.message + '\n'));
  process.exit(1);
} else {
  console.log('PASS  ' + passed + '/' + total + ' tests green');
}
