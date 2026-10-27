import { z } from 'zod';

/** A required piece of text, with a plain message when it is missing. */
export const req = (what: string, max = 200) =>
  z.string({ required_error: `Type the ${what}.`, invalid_type_error: `Type the ${what}.` })
    .trim().min(1, `Type the ${what}.`).max(max, `The ${what} is too long.`);

/** An optional piece of text. An empty box counts as "not given". */
export const opt = (max = 200) =>
  z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().max(max, 'That is too long.').optional());

/** An optional number. An empty box counts as "not given"; a typed "12.5" is accepted. */
export const optNum = (what: string, min = 0, max = 1e9) =>
  z.preprocess(
    (v) => (v === '' || v === null ? undefined : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/,/g, '')) : v),
    z.number({ invalid_type_error: `Type a number for the ${what}.` })
      .min(min, `The ${what} can't be less than ${min}.`).max(max, `The ${what} is too big.`).optional(),
  );

export const pick = <T extends readonly [string, ...string[]]>(values: T, message: string) =>
  z.enum(values, { errorMap: () => ({ message }) });

/** A checkbox: true, "true" and "on" are yes; anything else is no. */
export const flag = z.preprocess((v) => v === true || v === 'true' || v === 'on', z.boolean());

/** An id the model or a picker passed. Never shown to anyone. */
export const id = (what: string) => z.string({ required_error: `Choose the ${what}.` }).min(1, `Choose the ${what}.`).max(64);

export const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
