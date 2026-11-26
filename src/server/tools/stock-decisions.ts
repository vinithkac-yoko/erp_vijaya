import type { Decisions } from './stock-import';

/**
 * What the owner decided about this sheet's rows that cannot be settled from the sheet itself (Kasi for the owner, 2026-11-07).
 * Keys are item codes and names as the sheet has them; the planner normalises them the same way it does the sheet's own.
 */
export const STOCK_SHEET_DECISIONS: Decisions = {
  unitByCode: {
    // five kept-in-stock items with no unit on the sheet: "if you know these items give them a unit, if not put NOS"
    LER303: 'LTR', // Enamel remover (E-Sol): a liquid
    LER304: 'LTR', // Enamel remover (Arbital): a liquid
    LER305: 'KG', // Dross reducing powder: a powder
    LAD301: 'NOS', // "arbital": not known to us
    LHD302: 'NOS', // "vaculoy": not known to us
    // a core with no unit, quantity 0: every other PQ32/30 core on the sheet is in pieces
    FPC005: 'NOS',
  },
  unitByName: {
    // "make it kilos": laminations are weighed, as the sheet already does for TY-30 I and TY-19 I
    'TY-30 E': 'KG',
    'TY-19 E': 'KG',
  },
};
