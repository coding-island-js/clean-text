/**
 * markdown.js — wires /markdown-to-plain-text to demarkdown().
 *
 * Nothing here decides anything about text. It names the controls on the page
 * and turns the counts into words. All the behaviour is in clean.js.
 */

import { mount } from '/tool.js';
import { demarkdown } from '/clean.js';

const s = n => (n === 1 ? '' : 's');

mount({
  run: demarkdown,

  optionIds: ['links', 'bullets', 'tables', 'html'],

  readOption: (key, el) => (el.tagName === 'SELECT' ? el.value : el.checked),

  describe: stats => {
    const bits = [];
    if (stats.headings)   bits.push(stats.headings + ' heading' + s(stats.headings) + ' unwrapped');
    if (stats.emphasis)   bits.push(stats.emphasis + ' bold or italic mark' + s(stats.emphasis) + ' removed');
    if (stats.links)      bits.push(stats.links + ' link' + s(stats.links) + ' flattened');
    if (stats.images)     bits.push(stats.images + ' image' + s(stats.images) + ' reduced to its alt text');
    if (stats.listItems)  bits.push(stats.listItems + ' list item' + s(stats.listItems) + ' kept');
    if (stats.tableRows)  bits.push(stats.tableRows + ' table row' + s(stats.tableRows) + ' flattened');
    if (stats.quotes)     bits.push(stats.quotes + ' quote marker' + s(stats.quotes) + ' removed');
    if (stats.codeBlocks) bits.push(stats.codeBlocks + ' code block' + s(stats.codeBlocks) + ' left exactly as it was');
    return bits;
  },
});
