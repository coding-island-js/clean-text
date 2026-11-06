/**
 * linebreaks.js — wires /remove-line-breaks to joinLines().
 *
 * Nothing here decides anything about text. It names the controls on the page
 * and turns the counts into words. All the behaviour is in clean.js.
 */

import { mount } from '/tool.js';
import { joinLines } from '/clean.js';

const s = n => (n === 1 ? '' : 's');

mount({
  run: joinLines,

  optionIds: ['mode', 'keepLists', 'dehyphenate', 'separator'],

  readOption: (key, el) => (el.tagName === 'SELECT' ? el.value : el.checked),

  describe: stats => {
    const bits = [];
    if (stats.joins)      bits.push(stats.joins + ' line break' + s(stats.joins) + ' removed');
    if (stats.paragraphs) bits.push(stats.paragraphs + ' paragraph' + s(stats.paragraphs) + ' kept');
    if (stats.hyphens)    bits.push(stats.hyphens + ' split word' + s(stats.hyphens) + ' rejoined');
    if (stats.kept)       bits.push(stats.kept + ' list item' + s(stats.kept) + ' left on its own line');
    return bits;
  },
});
