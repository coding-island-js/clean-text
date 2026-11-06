/**
 * titlecase.js — wires /title-case-converter to titleCase().
 *
 * Nothing here decides anything about text. It names the controls on the page
 * and turns the counts into words. All the behaviour is in clean.js.
 */

import { mount } from '/tool.js';
import { titleCase } from '/clean.js';

const s = n => (n === 1 ? '' : 's');

const STYLE_NAME = {
  ap: 'AP',
  apa: 'APA',
  chicago: 'Chicago',
  mla: 'MLA',
  'every-word': 'every word',
  sentence: 'sentence case',
};

mount({
  run: titleCase,

  optionIds: ['style', 'keepAcronyms', 'keepOddCaps', 'fixAllCaps'],

  readOption: (key, el) => (el.tagName === 'SELECT' ? el.value : el.checked),

  describe: stats => {
    const bits = [];
    const style = document.getElementById('opt-style');
    if (style && STYLE_NAME[style.value]) bits.push(STYLE_NAME[style.value] + ' style');
    if (stats.lines > 1) bits.push(stats.lines + ' line' + s(stats.lines) + ' done separately');
    if (stats.shouty)    bits.push(stats.shouty + ' shouted line' + s(stats.shouty) + ' brought back down');
    if (stats.lowered)   bits.push(stats.lowered + ' small word' + s(stats.lowered) + ' left lowercase');
    if (stats.acronyms)  bits.push(stats.acronyms + ' acronym' + s(stats.acronyms) + ' kept as typed');
    return bits;
  },
});
