import { allFormsFor, launcherFor, type Launcher } from '@/lib/launcher/launcher';
import { conversations, registry } from '../tools';
import type { ToolSession } from '../tools/types';
import { chipAvailable } from './chips';

export interface LauncherState {
  launcher: Launcher;
  /** Which form buttons work yet. A button for a form that is not built stays switched off. */
  formEnabled: Record<string, boolean>;
  /** Which chips work: the assistant must be on and the tools they ask about must exist. */
  chipEnabled: Record<string, boolean>;
}

/**
 * The buttons above the input, for this person: their role, their own use (counted from the record), and what is built.
 * Read when the chat opens, so a button never moves under the finger during a conversation.
 */
export async function launcherState(session: ToolSession, assistantOn: boolean): Promise<LauncherState & { allForms: ReturnType<typeof allFormsFor> }> {
  const launcher = launcherFor(session.role, { usage: await conversations.launcherUsage(session.userId) });
  const has = (t: string) => registry.get(t) !== undefined;
  const forms = allFormsFor(session.role);
  const chips = [...launcher.chips, ...launcher.moreChips];
  return {
    launcher,
    allForms: forms,
    formEnabled: Object.fromEntries(forms.map((f) => [f.tool, has(f.tool)])),
    chipEnabled: Object.fromEntries(chips.map((c) => [c.label, assistantOn && chipAvailable(c.label, has)])),
  };
}
