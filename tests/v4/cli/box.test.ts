import { describe, it, expect } from 'vitest';

import { boxTop, boxBottom, boxLine, boxTopTitled } from '../../../cli/v4/box';

describe('cli/v4/box helpers', () => {
  it('boxTop renders rounded corners and exact width fill', () => {
    const top = boxTop(5);
    expect(top).toBe('╭─────╮');
  });

  it('boxBottom renders rounded corners and exact width fill', () => {
    expect(boxBottom(5)).toBe('╰─────╯');
  });

  it('boxLine pads short content with a leading gutter space', () => {
    const line = boxLine('hi', 6);
    // 1 gutter space + "hi" + 3 trailing spaces = 6 inner chars
    expect(line).toBe('│ hi   │');
  });

  it('boxLine truncates content that overflows the cell width', () => {
    const line = boxLine('thiswillnotfit', 6);
    expect(line.length).toBe(8); // 6 inner + 2 verticals
    expect(line.startsWith('│')).toBe(true);
    expect(line.endsWith('│')).toBe(true);
  });

  it('boxTopTitled embeds the title between dashes after the corner', () => {
    const top = boxTopTitled('Setup Complete', 50);
    expect(top.startsWith('╭── Setup Complete ')).toBe(true);
    expect(top.endsWith('╮')).toBe(true);
    // Width budget honoured: total visible width = 50 inner + 2 corners.
    expect(top.length).toBe(52);
  });
});
