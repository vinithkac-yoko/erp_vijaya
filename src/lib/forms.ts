/**
 * A form is data. Each write tool owns its definition, so the same task always looks the same, wherever the form opens
 * from and whoever asked for it (INTERFACE §1: "it comes from the tool's form definition, not from the model").
 */
export type FieldType = 'text' | 'textarea' | 'number' | 'select' | 'checkbox' | 'password' | 'email' | 'material' | 'party' | 'user';

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** Shown inside the field, after the number: kg, ₹, %. */
  unit?: string;
  options?: { value: string; label: string }[];
  /** Grey text under the field. */
  hint?: string;
  placeholder?: string;
  /** Show this field only when another field has one of these values (e.g. minimum level for STANDING). */
  showWhen?: { field: string; in: string[] };
  /** Pickers: only parties of this kind. */
  partyRole?: 'SUPPLIER' | 'CUSTOMER';
  autoComplete?: string;
}

export interface FormDef {
  title: string;
  /** The button says what it does, never "Submit": "Add material", "Give out material". */
  verb: string;
  intro?: string;
  fields: FieldDef[];
}

/** What a picker offers: a name to read and a small second line. The id is the value, never shown. */
export interface PickerOption { id: string; label: string; secondary?: string }
