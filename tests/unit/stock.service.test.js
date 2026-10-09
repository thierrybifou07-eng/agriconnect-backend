import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { assertInvariant, computeLotStatus } from '../../src/services/stock.service.js';

// Tests purs : aucune base, aucun serveur. Les lots sont des objets
// littéraires, comme ceux que recevrait une fonction transactionnelle.

const Decimal = Prisma.Decimal;

// Fabrique de lot minimaliste : seuls les cinq compteurs et le statut
// intéressent les fonctions pures.
function lot({ initial = 100, available = 100, reserved = 0, sold = 0, lost = 0, status = 'AVAILABLE', expiresAt = null } = {}) {
  return {
    id: 1,
    lotCode: 'LOT-000001',
    quantityInitial: new Decimal(initial),
    quantityAvailable: new Decimal(available),
    quantityReserved: new Decimal(reserved),
    quantitySold: new Decimal(sold),
    quantityLost: new Decimal(lost),
    status,
    expiresAt,
  };
}

describe('assertInvariant', () => {
  it('accepte un lot fraîchement reçu (tout au disponible)', () => {
    expect(() => assertInvariant(lot())).not.toThrow();
  });

  it('accepte un lot partiellement réservé, vendu et perdu', () => {
    // 100 = 40 + 30 + 20 + 10
    expect(() =>
      assertInvariant(lot({ available: 40, reserved: 30, sold: 20, lost: 10 }))
    ).not.toThrow();
  });

  it('accepte un lot entièrement vendu', () => {
    expect(() => assertInvariant(lot({ available: 0, reserved: 0, sold: 100, lost: 0 }))).not.toThrow();
  });

  it('accepte un lot entièrement perdu', () => {
    expect(() => assertInvariant(lot({ available: 0, reserved: 0, sold: 0, lost: 100 }))).not.toThrow();
  });

  // Les quantités sont des DECIMAL(12,3) : l'invariant doit tenir à la
  // précision du gramme, ce que le Float ne garantirait pas.
  it('tient compte des quantités décimales', () => {
    // 100.5 = 50.25 + 25.125 + 12.5 + 12.625
    expect(() =>
      assertInvariant(lot({ initial: '100.5', available: '50.25', reserved: '25.125', sold: '12.5', lost: '12.625' }))
    ).not.toThrow();
  });

  it('lève une erreur si la somme dépasse l initial', () => {
    expect(() => assertInvariant(lot({ available: 101 }))).toThrow(/Invariant de stock rompu/);
  });

  it('lève une erreur si la somme est inférieure à l initial', () => {
    expect(() => assertInvariant(lot({ available: 99 }))).toThrow(/Invariant de stock rompu/);
  });

  it('lève une erreur dès le premier écart, même minime', () => {
    expect(() => assertInvariant(lot({ available: '99.999' }))).toThrow(/Invariant de stock rompu/);
  });
});

describe('computeLotStatus', () => {
  // Instant de référence fixe : les dates relatives sont calculées depuis lui,
  // ce qui rend le tableau de cas déterministe.
  const MAINTENANT = new Date('2026-10-09T12:00:00Z');
  const FUTUR = new Date('2026-10-16T12:00:00Z');
  const PASSE = new Date('2026-10-02T12:00:00Z');

  const cas = [
    // [description, lot, statut attendu]
    ['disponible avec date future', lot({ available: 50, expiresAt: FUTUR }), 'AVAILABLE'],
    ['disponible sans date', lot({ available: 50 }), 'AVAILABLE'],
    ['disponible avec date future et réserves', lot({ available: 10, reserved: 40, expiresAt: FUTUR }), 'AVAILABLE'],
    ['tout réservé', lot({ available: 0, reserved: 50, expiresAt: FUTUR }), 'FULLY_RESERVED'],
    ['tout vendu', lot({ available: 0, reserved: 0, sold: 50, expiresAt: FUTUR }), 'SOLD_OUT'],
    ['vendu et perdu, plus rien', lot({ available: 0, reserved: 0, sold: 30, lost: 20, expiresAt: FUTUR }), 'SOLD_OUT'],
    ['expiré avec du disponible', lot({ available: 50, expiresAt: PASSE }), 'EXPIRED'],
    ['expiré et tout vendu', lot({ available: 0, reserved: 0, sold: 50, expiresAt: PASSE }), 'EXPIRED'],
    ['expiré et tout réservé', lot({ available: 0, reserved: 50, expiresAt: PASSE }), 'EXPIRED'],
    ['rejeté : jamais recalculé', lot({ available: 50, status: 'REJECTED', expiresAt: FUTUR }), 'REJECTED'],
    ['retourné : jamais recalculé', lot({ available: 0, reserved: 0, sold: 50, status: 'RETURNED', expiresAt: FUTUR }), 'RETURNED'],
    ['retiré : jamais recalculé', lot({ available: 50, status: 'WITHDRAWN', expiresAt: FUTUR }), 'WITHDRAWN'],
    ['rejeté même avec date passée', lot({ available: 50, status: 'REJECTED', expiresAt: PASSE }), 'REJECTED'],
  ];

  it.each(cas)('%s -> %s', (_description, lotTest, attendu) => {
    expect(computeLotStatus(lotTest, MAINTENANT)).toBe(attendu);
  });

  // La date d'expiration est incluse : un lot qui expire à l'instant exact
  // est déjà expiré, sinon il resterait vendable après sa date.
  it('considère un lot expiré à l instant présent', () => {
    expect(computeLotStatus(lot({ available: 50, expiresAt: MAINTENANT }), MAINTENANT)).toBe('EXPIRED');
  });

  // now est optionnel : sans argument, c'est l'horloge du système. Un lot
  // sans date d'expiration ne doit jamais être expiré.
  it('utilise l horloge courante quand now est omis', () => {
    expect(computeLotStatus(lot({ available: 50 }))).toBe('AVAILABLE');
  });
});
