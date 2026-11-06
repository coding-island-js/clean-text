/**
 * spaces.js — wires /remove-extra-spaces to squeeze().
 *
 * Nothing here decides anything about text. It names the checkboxes on the page
 * and turns the counts into words. All the behaviour is in clean.js.
 */

import { mount } from '/tool.js';
import { squeeze } from '/clean.js';

const s = n => (n === 1 ? '' : 's');

mount({
  run: squeeze,

  optionIds: ['collapseSpaces', 'trimLineEnds', 'trimLineStarts', 'tabs', 'invisibles', 'blankLines'],

  // Every control but one is a checkbox. "blankLines" is a three-way choice,
  // because "collapse them" and "delete them all" are genuinely different jobs.
  readOption: (key, el) => (el.tagName === 'SELECT' ? el.value : el.checked),

  // No number appears here that was not actually counted.
  describe: stats => {
    const bits = [];
    if (stats.mojibake)     bits.push('garbled characters repaired');
    if (stats.spaceRuns)    bits.push(stats.spaceRuns + ' run' + s(stats.spaceRuns) + ' of spaces squeezed');
    if (stats.tabs)         bits.push(stats.tabs + ' tab' + s(stats.tabs) + ' replaced');
    if (stats.trimmedLines) bits.push(stats.trimmedLines + ' line end' + s(stats.trimmedLines) + ' trimmed');
    if (stats.blankLines)   bits.push(stats.blankLines + ' blank line' + s(stats.blankLines) + ' removed');
    if (stats.invisibles)   bits.push(stats.invisibles + ' invisible character' + s(stats.invisibles) + ' removed');
    if (stats.oddSpaces)    bits.push(stats.oddSpaces + ' odd space' + s(stats.oddSpaces) + ' fixed');
    return bits;
  },
});
