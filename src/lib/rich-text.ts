/**
 * The assistant writes in a light markdown ("**bold**", "- lists", "| tables |", "# headings"). This turns that text into a few
 * plain blocks that the screen draws as real paragraphs, lists and tables, so nobody ever reads the stars, dashes and bars.
 * It only ever produces data (never HTML): the screen draws it with React elements, so nothing the assistant writes can add
 * markup, a link or a script to the page.
 */
export type Inline = { kind: 'text'; text: string } | { kind: 'bold'; text: string } | { kind: 'italic'; text: string } | { kind: 'code'; text: string };

export type Block =
  | { kind: 'paragraph'; lines: Inline[][] }
  | { kind: 'heading'; level: 1 | 2 | 3; inline: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'table'; header: Inline[][]; rows: Inline[][][]; align: ('left' | 'right')[] }
  | { kind: 'rule' }
  | { kind: 'code'; text: string };

const BULLET = /^\s{0,3}(?:[-*•–])\s+(.*)$/;
const NUMBERED = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s{0,3}```/;
const ROW = /^\s*\|.*\|\s*$/;
const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Bold, italic and code inside one line. An unmatched star or underscore is left as it was typed. */
export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  const push = (i: Inline) => { if (i.text !== '') out.push(i); };
  // the earliest of: `code`, **bold**, __bold__, *italic*, _italic_ (italic only when it hugs its words: "5 * 3" is not italic)
  const pattern = /`([^`\n]+)`|\*\*(?=\S)([^\n]*?\S)\*\*|__(?=\S)([^\n]*?\S)__|(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/;
  while (rest.length > 0) {
    const m = pattern.exec(rest);
    if (!m) { push({ kind: 'text', text: rest }); break; }
    push({ kind: 'text', text: rest.slice(0, m.index) });
    if (m[1] !== undefined) push({ kind: 'code', text: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) push({ kind: 'bold', text: (m[2] ?? m[3])! });
    else push({ kind: 'italic', text: (m[4] ?? m[5])! });
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const cells = (line: string): string[] => {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
};

/** A cell that is a number with an optional rupee sign and unit ("0 kg", "₹1,250.50", "5 L") is set to the right, like the app's own tables. */
const numeric = (c: string) => /^[₹+\-−]?\s?[\d,]+(?:\.\d+)?\s?[%A-Za-z]{0,5}\.?$/.test(c.replace(/\*\*/g, '').trim());

export function parseRich(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') { i++; continue; }

    if (FENCE.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i++]!);
      i++; // the closing fence (a missing one just ends the block)
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    if (RULE.test(line) && !BULLET.test(line)) { blocks.push({ kind: 'rule' }); i++; continue; }
    const h = HEADING.exec(line);
    if (h) { blocks.push({ kind: 'heading', level: Math.min(h[1]!.length, 3) as 1 | 2 | 3, inline: inline(h[2]!) }); i++; continue; }

    // a table: a row, a separator row, then rows
    if (ROW.test(line) && i + 1 < lines.length && SEPARATOR.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const header = cells(line);
      const seps = cells(lines[i + 1]!);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && ROW.test(lines[i]!)) body.push(cells(lines[i++]!));
      const width = header.length;
      const align = header.map((_, c): 'left' | 'right' => (body.length > 0 && body.every((r) => (r[c] ?? '') === '' || numeric(r[c]!)) && body.some((r) => numeric(r[c] ?? '')) ? 'right' : seps[c]?.endsWith(':') && !seps[c]?.startsWith(':') ? 'right' : 'left'));
      blocks.push({ kind: 'table', header: header.map(inline), rows: body.map((r) => Array.from({ length: width }, (_, c) => inline(r[c] ?? ''))), align });
      continue;
    }

    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = !BULLET.test(line);
      const re = ordered ? NUMBERED : BULLET;
      const items: Inline[][] = [];
      while (i < lines.length && re.test(lines[i]!)) {
        let text = re.exec(lines[i]!)![1]!;
        i++;
        // a line that is indented under an item carries on that item
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !re.test(lines[i]!) && !BULLET.test(lines[i]!) && !NUMBERED.test(lines[i]!)) text += ` ${lines[i++]!.trim()}`;
        items.push(inline(text));
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    // a paragraph runs to the next blank line or the start of another kind of block
    const para: Inline[][] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !FENCE.test(lines[i]!) && !HEADING.test(lines[i]!) && !(RULE.test(lines[i]!) && !BULLET.test(lines[i]!))
      && !(para.length > 0 && (BULLET.test(lines[i]!) || NUMBERED.test(lines[i]!)))
      && !(ROW.test(lines[i]!) && i + 1 < lines.length && SEPARATOR.test(lines[i + 1]!) && lines[i + 1]!.includes('-'))) {
      para.push(inline(lines[i++]!.trim()));
    }
    if (para.length === 0) { para.push(inline(line.trim())); i++; }
    blocks.push({ kind: 'paragraph', lines: para });
  }
  return blocks;
}
