import type { FormButton } from '@/lib/launcher/launcher';

const GENERAL: [string, string][] = [
  ['/', 'Go to the chat box'],
  ['Enter', 'Next field'],
  ['Ctrl+Enter', 'Save the form'],
  ['Esc', 'Close the form or panel'],
  ['?', 'Show this list'],
];

/** The "?" sheet. The same shortcut always opens the same form, even when its button is under More. */
export function Shortcuts({ forms }: { forms: FormButton[] }) {
  const row = (k: string, what: string) => (
    <tr key={k} className="border-b border-line last:border-0">
      <th scope="row" className="num w-32 py-2 pr-3 text-left align-top font-medium">{k}</th>
      <td className="py-2 text-ink-soft">{what}</td>
    </tr>
  );
  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-1 font-semibold">Open a form</h3>
        <table className="w-full text-base"><tbody>{forms.map((f) => row(f.shortcut, f.label))}</tbody></table>
      </section>
      <section>
        <h3 className="mb-1 font-semibold">Anywhere</h3>
        <table className="w-full text-base"><tbody>{GENERAL.map(([k, v]) => row(k, v))}</tbody></table>
      </section>
      <p className="text-sm text-ink-soft">The form buttons switch on in a later step. The keys will work the same way.</p>
    </div>
  );
}
