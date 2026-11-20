import { describe, expect, it } from 'vitest';
import { inline, parseRich } from './rich-text';

const text = (parts: ReturnType<typeof inline>) => parts.map((p) => p.text).join('');

describe('inline', () => {
  it('turns **bold**, __bold__, *italic*, _italic_ and `code` into parts, with no marks left', () => {
    expect(inline('**Open jobs:** There are none.')).toEqual([{ kind: 'bold', text: 'Open jobs:' }, { kind: 'text', text: ' There are none.' }]);
    expect(inline('a __b__ c *d* e _f_ g `h`')).toEqual([
      { kind: 'text', text: 'a ' }, { kind: 'bold', text: 'b' }, { kind: 'text', text: ' c ' }, { kind: 'italic', text: 'd' }, { kind: 'text', text: ' e ' }, { kind: 'italic', text: 'f' }, { kind: 'text', text: ' g ' }, { kind: 'code', text: 'h' },
    ]);
  });
  it('leaves a star or underscore alone when it is not marking anything', () => {
    expect(text(inline('5 * 3 = 15'))).toBe('5 * 3 = 15');
    expect(text(inline('a*b and c*d'))).toBe('a*b and c*d');
    expect(text(inline('part_no and snake_case_name'))).toBe('part_no and snake_case_name');
    expect(inline('**not closed yet')).toEqual([{ kind: 'text', text: '**not closed yet' }]); // a half-streamed answer
    expect(inline('22 SWG * 2')).toEqual([{ kind: 'text', text: '22 SWG * 2' }]);
  });
  it('never makes markup of what looks like markup', () => {
    const parts = inline('<script>alert(1)</script> [click](http://x.example) <b>hi</b>');
    expect(parts.every((p) => p.kind === 'text')).toBe(true);
    expect(text(parts)).toBe('<script>alert(1)</script> [click](http://x.example) <b>hi</b>'); // shown as the words they are, drawn by React as text
  });
});

describe('parseRich', () => {
  it('reads the answer from the screen: bold lead-ins, a table, in separate blocks', () => {
    const src = `**Open jobs:** There are none.

**Below minimum level:** 17 materials are at 0 on hand.

| Material | Unit | On hand | Minimum | Short by |
|---|---|---|---|---|
| 10'' FILM | ROLL | 0 | 5 | 5 |
| AGNI ROD | KG | 0 | 5 | 5 |
| Flux RLS45 | LTR | 0 | 5 | 5 |`;
    const blocks = parseRich(src);
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'paragraph', 'table']);
    const t = blocks[2]!;
    if (t.kind !== 'table') throw new Error('table');
    expect(t.header.map(text)).toEqual(['Material', 'Unit', 'On hand', 'Minimum', 'Short by']);
    expect(t.rows).toHaveLength(3);
    expect(t.rows[0]!.map(text)).toEqual(["10'' FILM", 'ROLL', '0', '5', '5']);
    expect(t.align).toEqual(['left', 'left', 'right', 'right', 'right']);
  });

  it('a table straight after a sentence (no blank line) is still a table; short rows are padded', () => {
    const blocks = parseRich('Here is the stock:\n| A | B |\n|:--|--:|\n| x | 1 |\n| y |');
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'table']);
    const t = blocks[1]!;
    if (t.kind !== 'table') throw new Error('table');
    expect(t.rows[1]!.map(text)).toEqual(['y', '']);
    expect(t.align).toEqual(['left', 'right']);
  });

  it('bullets (-, *, •), numbered lists and their carry-on lines', () => {
    expect(parseRich('- one\n- two\n* three\n• four').map((b) => b.kind === 'list' && b.items.map(text))).toEqual([['one', 'two', 'three', 'four']]);
    const n = parseRich('1. first\n2) second\n   carries on\n3. third')[0]!;
    expect(n).toMatchObject({ kind: 'list', ordered: true });
    if (n.kind !== 'list') throw new Error('list');
    expect(n.items.map(text)).toEqual(['first', 'second carries on', 'third']);
  });

  it('a list that follows a sentence, a heading, a rule and a code block', () => {
    const blocks = parseRich('Do this:\n- a\n- b\n\n## Then\n\n---\n\n```\nx = 1\n```');
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'list', 'heading', 'rule', 'code']);
    expect(blocks[4]).toEqual({ kind: 'code', text: 'x = 1' });
    expect(blocks[2]).toMatchObject({ kind: 'heading', level: 2 });
  });

  it('a dash line is a rule only when it is just dashes; "- item" is a list item', () => {
    expect(parseRich('---')[0]!.kind).toBe('rule');
    expect(parseRich('- item')[0]!.kind).toBe('list');
    expect(parseRich('-- not a rule, just words')[0]!.kind).toBe('paragraph');
  });

  it('single new lines in a paragraph are kept as line breaks; blank lines start a new paragraph', () => {
    const blocks = parseRich('line one\nline two\n\nnext');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: 'paragraph' });
    if (blocks[0]!.kind === 'paragraph') expect(blocks[0]!.lines.map(text)).toEqual(['line one', 'line two']);
  });

  it('survives anything: empty text, only symbols, a half-written table, and a very long answer', () => {
    expect(parseRich('')).toEqual([]);
    expect(parseRich('   \n\n  ')).toEqual([]);
    expect(() => parseRich('| | |\n|---')).not.toThrow();
    expect(() => parseRich('*'.repeat(5000) + '\n' + '|'.repeat(5000) + '\n' + '_'.repeat(5000))).not.toThrow();
    const long = Array.from({ length: 800 }, (_, i) => `- item ${i}`).join('\n');
    expect((parseRich(long)[0] as { items: unknown[] }).items).toHaveLength(800);
  });

  it('Tamil text and rupee amounts pass through', () => {
    const blocks = parseRich('**மொத்தம்:** ₹1,250.50\n\n| பொருள் | அளவு |\n|---|---|\n| செம்பு கம்பி | 18.4 kg |');
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'table']);
    const t = blocks[1]!;
    if (t.kind === 'table') expect(t.align).toEqual(['left', 'right']);
  });
});
