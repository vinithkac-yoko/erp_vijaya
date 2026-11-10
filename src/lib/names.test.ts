import { describe, it, expect } from 'vitest';
import { materialNameKey, normalizeGstin, partyNameKey } from './names';

describe('name keys', () => {
  it('material: case, spaces and punctuation do not matter; word order does', () => {
    expect(materialNameKey('22 SWG Copper Wire')).toBe('22swgcopperwire');
    expect(materialNameKey('22 swg copper-wire')).toBe(materialNameKey('22 SWG Copper Wire'));
    expect(materialNameKey('Ferrite Core E-30')).toBe(materialNameKey('ferrite core e30'));
    expect(materialNameKey('Copper Wire 22 SWG')).not.toBe(materialNameKey('22 SWG Copper Wire'));
  });
  it('party: M/s and Pvt Ltd are ignored (ACCEPTANCE 1.20)', () => {
    expect(partyNameKey('M/s Sundaram Ferrites Pvt. Ltd.')).toBe('sundaramferrites');
    expect(partyNameKey('Sundaram Ferrites')).toBe('sundaramferrites');
    expect(partyNameKey('M/S SUNDARAM FERRITES PRIVATE LIMITED')).toBe('sundaramferrites');
    expect(partyNameKey('Sundaram Ferrite')).not.toBe('sundaramferrites'); // similar, not the same: a question for the user
  });
  it('party: a name made only of suffix words keeps itself', () => {
    expect(partyNameKey('Company')).toBe('company');
  });
  it('gstin is uppercase with no spaces', () => {
    expect(normalizeGstin(' 33aaacs1234k1z2 ')).toBe('33AAACS1234K1Z2');
  });
});
