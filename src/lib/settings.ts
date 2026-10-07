import { groupIndian } from './format';

/**
 * The settings the owner can change. Known keys only: anything else is refused. (BUSINESS_FLOW: "Never hardcode a
 * business rule the owner might want to move.") The value is stored as text and checked by its type.
 */
export type SettingType = 'inr' | 'onoff' | 'email';
export interface SettingDef {
  key: string;
  label: string;
  type: SettingType;
  help: string;
  /** Written when the system is first set up. Never applied silently later: a missing value is an error, not a default. */
  initial: string;
  /** The storekeeper may read this one (the PO form shows it anyway). */
  storekeeperCanRead?: boolean;
}

export const SETTINGS: SettingDef[] = [
  { key: 'po.approval_limit', label: 'Purchase approval limit', type: 'inr', initial: '50000', storekeeperCanRead: true,
    help: 'A purchase order above this amount waits for the owner. Type the amount in rupees, e.g. 50000.' },
  { key: 'agent.enabled', label: 'Assistant', type: 'onoff', initial: 'on',
    help: 'Type off to switch the assistant off. The buttons, forms and approvals keep working. Type on to switch it back on.' },
  { key: 'notify.owner_email', label: 'Owner notification email', type: 'email', initial: '',
    help: 'Where the owner gets an email about approvals and alerts. Leave empty for no email.' },
];

export const settingDef = (key: string) => SETTINGS.find((s) => s.key === key);

export type Parsed = { ok: true; stored: string } | { ok: false; message: string };

/** Turns what the owner typed into what is stored, or says what is wrong in plain words. */
export function parseSetting(def: SettingDef, raw: unknown): Parsed {
  const text = String(raw ?? '').trim();
  if (def.type === 'inr') {
    const n = Number(text.replace(/[₹,\s]/g, ''));
    if (!text || !Number.isFinite(n) || n < 0) return { ok: false, message: 'Type the amount in rupees, like 50000.' };
    if (n > 100_000_000_000) return { ok: false, message: 'That amount is too big.' };
    return { ok: true, stored: String(n) };
  }
  if (def.type === 'onoff') {
    const t = text.toLowerCase();
    if (['on', 'true', 'yes', '1'].includes(t)) return { ok: true, stored: 'on' };
    if (['off', 'false', 'no', '0'].includes(t)) return { ok: true, stored: 'off' };
    return { ok: false, message: 'Type on or off.' };
  }
  if (text === '') return { ok: true, stored: '' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) || text.length > 200) return { ok: false, message: 'That does not look like an email address.' };
  return { ok: true, stored: text.toLowerCase() };
}

export function displaySetting(def: SettingDef, stored: string): string {
  if (def.type === 'inr') return '₹' + groupIndian(Number(stored));
  if (def.type === 'onoff') return stored === 'off' ? 'Off' : 'On';
  return stored || 'None';
}
