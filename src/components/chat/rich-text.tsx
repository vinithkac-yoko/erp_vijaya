import { Fragment } from 'react';
import { inline as parseInline, parseRich, type Inline } from '@/lib/rich-text';
import { cn } from '@/lib/cn';

/**
 * The assistant's words, drawn as paragraphs, lists, tables and bold text instead of showing the stars, dashes and bars it
 * wrote them with. Everything is drawn as React elements from parsed data (src/lib/rich-text.ts): no HTML from the assistant
 * ever reaches the page, and no link it writes becomes clickable.
 */
function Inlines({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) => p.kind === 'bold' ? <strong key={i} className="font-semibold">{renderNested(p.text)}</strong>
        : p.kind === 'italic' ? <em key={i}>{p.text}</em>
        : p.kind === 'code' ? <code key={i} className="num rounded bg-sunk px-1 text-[0.95em]">{p.text}</code>
        : <Fragment key={i}>{p.text}</Fragment>)}
    </>
  );
}
/** Bold text may hold a bit of italic or code inside it; anything deeper is shown as written. */
const renderNested = (text: string) => <Inlines parts={parseInline(text).map((x) => (x.kind === 'bold' ? { kind: 'text', text: x.text } : x))} />;

export function RichText({ text, className }: { text: string; className?: string }) {
  const blocks = parseRich(text);
  return (
    <div className={cn('space-y-3', className)}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading':
            return <p key={i} className={cn('font-display font-bold', b.level === 1 ? 'text-xl' : b.level === 2 ? 'text-lg' : 'text-base')}><Inlines parts={b.inline} /></p>;
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul';
            return (
              <Tag key={i} className={cn('space-y-1 pl-6', b.ordered ? 'list-decimal' : 'list-disc')}>
                {b.items.map((it, j) => <li key={j} className="pl-1"><Inlines parts={it} /></li>)}
              </Tag>
            );
          }
          case 'table':
            return (
              <div key={i} className="overflow-x-auto rounded-md border border-line" role="region" aria-label="Table" tabIndex={0}>
                <table className="w-full border-collapse text-[15px]">
                  <thead>
                    <tr>{b.header.map((h, c) => <th key={c} scope="col" className={cn('bg-sunk px-3 py-2 font-semibold', b.align[c] === 'right' ? 'text-right' : 'text-left')}><Inlines parts={h} /></th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j} className="border-t border-line">
                        {r.map((cell, c) => <td key={c} className={cn('px-3 py-2', b.align[c] === 'right' ? 'num text-right' : 'text-left')}><Inlines parts={cell} /></td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'rule':
            return <hr key={i} className="border-line" />;
          case 'code':
            return <pre key={i} className="num overflow-x-auto whitespace-pre-wrap rounded-md bg-sunk p-3 text-[0.95em]">{b.text}</pre>;
          default:
            return (
              <p key={i}>
                {b.lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}<Inlines parts={l} /></Fragment>)}
              </p>
            );
        }
      })}
    </div>
  );
}
