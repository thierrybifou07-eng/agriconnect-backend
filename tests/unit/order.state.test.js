import { describe, it, expect } from 'vitest';
import { assertTransition } from '../../src/services/order.state.js';

// Machine a etats de la commande (plan v2, P3.5) : test exhaustif de la
// table des transitions. Chaque transition valide est acceptee, chaque
// transition interdite leve 409 INVALID_STATE_TRANSITION.

const STATUTS = [
  'QUOTED',
  'CONFIRMED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'OUT_FOR_DELIVERY',
  'COMPLETED',
  'CANCELLED',
];

// Les transitions valides, par statut de depart.
const VALIDE = {
  QUOTED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'CANCELLED'],
  READY_FOR_PICKUP: ['COMPLETED'],
  OUT_FOR_DELIVERY: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

describe('order.state — transitions valides', () => {
  for (const de of STATUTS) {
    for (const vers of VALIDE[de]) {
      it(`${de} -> ${vers} est acceptee`, () => {
        expect(() => assertTransition(de, vers)).not.toThrow();
      });
    }
  }
});

describe('order.state — transitions interdites', () => {
  for (const de of STATUTS) {
    for (const vers of STATUTS) {
      if (VALIDE[de].includes(vers)) continue;
      it(`${de} -> ${vers} leve 409 INVALID_STATE_TRANSITION`, () => {
        try {
          assertTransition(de, vers);
          expect.unreachable(`Transition ${de} -> ${vers} aurait du être refusée`);
        } catch (err) {
          expect(err.statusCode).toBe(409);
          expect(err.code).toBe('INVALID_STATE_TRANSITION');
        }
      });
    }
  }
});

describe('order.state — statuts inconnus', () => {
  it('un statut de depart inconnu est refuse', () => {
    expect(() => assertTransition('DRAFT', 'CONFIRMED')).toThrowError(
      expect.objectContaining({ statusCode: 409, code: 'INVALID_STATE_TRANSITION' })
    );
  });

  it('un statut cible inconnu est refuse', () => {
    expect(() => assertTransition('QUOTED', 'SHIPPED')).toThrowError(
      expect.objectContaining({ statusCode: 409, code: 'INVALID_STATE_TRANSITION' })
    );
  });
});
