import { describe, it, expect } from 'vitest';
import { distance, distanceWithin, isSimilar, materialProfile, matchRank, PARTY, partyProfile, search } from './similar';
import { materialNameKey } from './names';
import { groupIndian, inr, qty, dateText, timeText } from './format';

const NAMES = ['22 SWG Copper Wire', 'Ferrite Core E-30', 'Bobbin type-B', 'Insulation Tape', 'Varnish', 'Copper Scrap'];
const find = (q: string) => search(q, NAMES, materialNameKey, (n) => n);

describe('distance', () => {
  it('counts slips, and a swapped pair of letters is one slip', () => {
    expect(distance('wire', 'wire')).toBe(0);
    expect(distance('wier', 'wire')).toBe(1);
    expect(distance('ferite', 'ferrite')).toBe(1);
    expect(distance('', 'abc')).toBe(3);
  });
  it('finds a short query inside a long name', () => {
    expect(distanceWithin('copper', '22swgcopperwire')).toBe(0);
    expect(distanceWithin('coper', '22swgcopperwire')).toBe(1);
    expect(distanceWithin('xyz', '22swgcopperwire')).toBeGreaterThan(1);
  });
});

describe('searching (the way the storekeeper types)', () => {
  it('ignores case, spaces and hyphens', () => {
    expect(find('ferrite core e30')).toEqual(['Ferrite Core E-30']);
    expect(find('FERRITE-CORE E 30')).toEqual(['Ferrite Core E-30']);
    expect(find('22swg wire')).toEqual(['22 SWG Copper Wire']);
  });
  it('forgives a typo (ACCEPTANCE 21.21: "ferite core e30")', () => {
    expect(find('ferite core e30')).toEqual(['Ferrite Core E-30']);
    expect(find('isue wier')).toEqual([]); // two different words, nothing like a material
    expect(find('coper wire')).toEqual(['22 SWG Copper Wire']);
    expect(find('varnsh')).toEqual(['Varnish']);
  });
  it('finds words in any order', () => {
    expect(find('wire 22 swg')).toEqual(['22 SWG Copper Wire']);
    expect(find('copper')).toEqual(['22 SWG Copper Wire', 'Copper Scrap']);
  });
  it('does not match nonsense, and very short queries must be exact', () => {
    expect(find('zzzz')).toEqual([]);
    expect(find('xq')).toEqual([]);
    expect(find('ta')).toEqual(['Insulation Tape']); // two letters: exact only, no guessing
    expect(find('')).toHaveLength(NAMES.length);
  });
  it('puts the best match first', () => {
    expect(matchRank('tape', materialNameKey('Insulation Tape'))).toBe(0);
    expect(matchRank('tpae', materialNameKey('Insulation Tape'))).toBe(1);
  });
});

describe('searching businesses', () => {
  const PARTIES = ['Sundaram Ferrites', 'Chennai Copper Wires', 'Ravi Insulation Traders'];
  const findP = (q: string) => search(q, PARTIES, (n) => partyProfile(n).key, (n) => n, PARTY);
  it('ignores M/s and Pvt Ltd in what he types (ACCEPTANCE 1.20)', () => {
    expect(findP('M/s Sundaram Ferrites Pvt Ltd')).toEqual(['Sundaram Ferrites']);
    expect(findP('sundaram ferites')).toEqual(['Sundaram Ferrites']);
    expect(findP('ravi')).toEqual(['Ravi Insulation Traders']);
    expect(findP('traders insulation')).toEqual(['Ravi Insulation Traders']);
  });
});

describe('"is this the same one?"', () => {
  const sim = (a: string, b: string) => isSimilar(materialProfile(a), materialProfile(b));
  it('same words in another order (ACCEPTANCE 1.7)', () => {
    expect(sim('Copper Wire 22 SWG', '22 SWG Copper Wire')).toBe(true);
  });
  it('a slip or a missing letter (ACCEPTANCE 1.21)', () => {
    expect(isSimilar(partyProfile('Sundaram Ferrite'), partyProfile('Sundaram Ferrites'))).toBe(true);
    expect(isSimilar(partyProfile('Sundaram Ferrites'), partyProfile('M/s Sundaram Ferrites Pvt Ltd'))).toBe(false); // identical key: that is "already exists"
  });
  it('different numbers are different materials — never asked about', () => {
    expect(sim('22 SWG Copper Wire', '24 SWG Copper Wire')).toBe(false);
    expect(sim('Ferrite Core E-30', 'Ferrite Core E-35')).toBe(false);
  });
  it('unrelated things are not similar', () => {
    expect(sim('Varnish', 'Paint')).toBe(false);
    expect(sim('Bobbin type-B', 'Insulation Tape')).toBe(false);
  });
  it('identical keys are not "similar" (that is a different answer: it already exists)', () => {
    expect(sim('22 SWG Copper Wire', '22 swg copper-wire')).toBe(false);
  });
});

describe('how numbers read (BUSINESS_FLOW §18)', () => {
  it('Indian grouping', () => {
    expect(groupIndian(115791)).toBe('1,15,791');
    expect(groupIndian(1234567.5, 2)).toBe('12,34,567.50');
    expect(groupIndian(999)).toBe('999');
    expect(groupIndian(1000)).toBe('1,000');
    expect(groupIndian(-3)).toBe('-3');
  });
  it('rupees', () => {
    expect(inr(115791)).toBe('₹1,15,791');
    expect(inr('115791.2')).toBe('₹1,15,791.20');
    expect(inr(0)).toBe('₹0');
    expect(inr(50000)).toBe('₹50,000');
  });
  it('quantities always carry their unit', () => {
    expect(qty(142.6, 'KG')).toBe('142.6 kg');
    expect(qty('1000.0000', 'NOS')).toBe('1,000 pcs');
    expect(qty(18, 'NOS', true)).toBe('18 pieces');
    expect(qty(0.0184, 'KG')).toBe('0.0184 kg');
    expect(qty(-3, 'KG')).toBe('-3 kg');
  });
  it('dates and times in India time', () => {
    expect(dateText(new Date('2026-09-12T20:00:00Z'))).toBe('13 Sep 2026');
    expect(timeText(new Date('2026-10-02T05:12:00Z'))).toBe('10:42');
  });
});
