import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { toDecimal, toNumber, asMoney, asQuantity, MONEY_DECIMALS, QUANTITY_DECIMALS } from '../../src/utils/money.js';

// Le but de la bascule en DECIMAL est que l'arithmetique monetaire soit exacte.
// Ces tests reproduisent les cas ou un Float se trompe, et verrouillent les
// arrondis et les conversions.

describe('Exactitude des montants', () => {
  // Le cas qui a motive la migration : en Float, 0.1 + 0.2 vaut
  // 0.30000000000000004, ce qu'aucun montant ne doit jamais afficher.
  it('additionne 0.1 + 0.2 sans derive', () => {
    const total = toDecimal('0.1').plus('0.2');
    expect(total.equals('0.3')).toBe(true);
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('multiplie un prix unitaire par une quantite decimale', () => {
    // 0.1 * 3 = 0.30000000000000004 en Float
    expect(toDecimal('0.1').mul(3).equals('0.3')).toBe(true);
  });

  it('ne derive pas sur une longue serie de produits', () => {
    let total = toDecimal(0);
    for (let i = 0; i < 10; i += 1) total = total.plus('0.1');
    // toFixed sert ici de comparaison : Decimal normalise l'ecriture ("1.0"
    // devient "1"), alors que la valeur reste exactement 1.
    expect(total.toFixed(1)).toBe('1.0');

    let flottant = 0;
    for (let i = 0; i < 10; i += 1) flottant += 0.1;
    expect(flottant).not.toBe(1);
  });
});

describe('Arrondis explicites', () => {
  it('arrondit un montant au centime', () => {
    // toFixed(2) est la forme d'affichage d'un montant : c'est elle qu'un
    // client verrait, et elle garde les zeros significatifs.
    expect(asMoney('10.005').toFixed(2)).toBe('10.01');
    expect(asMoney('10.004').toFixed(2)).toBe('10.00');
    expect(asMoney('10.567').toFixed(2)).toBe('10.57');
  });

  // Un montant ne peut pas avoir plus de 2 decimales : le surplus est coupe,
  // jamais conserve en cascade dans les totals.
  it('ne garde jamais plus de deux decimales', () => {
    for (const valeur of ['1.999', '99.999999', '0.005']) {
      const arrondi = asMoney(valeur);
      expect(arrondi.decimalPlaces()).toBeLessThanOrEqual(MONEY_DECIMALS);
    }
  });

  it('arrondit une quantite au gramme', () => {
    expect(asQuantity('2.5005').toFixed(3)).toBe('2.501');
    expect(asQuantity('2.5').toFixed(3)).toBe('2.500');
    expect(QUANTITY_DECIMALS).toBe(3);
  });

  // 0.1 + 0.2 doit rester 0.3 une fois passe dans une colonne DECIMAL(10,2) :
  // c'est ce qui evite qu'un total affiche 0.30 pour une commande de 30 centimes.
  it('reste stable sur un aller-retour d ecriture', () => {
    const total = asMoney(toDecimal('0.1').plus('0.2'));
    expect(total.toFixed(MONEY_DECIMALS)).toBe('0.30');
  });
});

describe('Conversion vers les nombres', () => {
  it('convertit un Decimal en nombre', () => {
    expect(toNumber(toDecimal('1000.50'))).toBe(1000.5);
  });

  // Les valeurs Null d une colonne nullable doivent rester null : les
  // transformer en 0 afficherait un prix inexistant.
  it('laisse null et undefined intacts', () => {
    expect(toNumber(null)).toBeNull();
    expect(toNumber(undefined)).toBeUndefined();
    expect(toDecimal(null)).toBeNull();
    // Sans garde-fou, l operateur optionnel transformait null en undefined.
    expect(asMoney(null)).toBeNull();
    expect(asQuantity(null)).toBeNull();
    expect(asMoney(undefined)).toBeUndefined();
  });

  it('laisse passer un nombre sans le modifier', () => {
    expect(toNumber(42)).toBe(42);
    expect(toDecimal(42).equals(42)).toBe(true);
  });
});

describe('Compatibilite avec le type Prisma', () => {
  it('reconnait un vrai Decimal Prisma', () => {
    const reel = new Prisma.Decimal('12.34');
    expect(toNumber(reel)).toBe(12.34);
    expect(toDecimal(reel)).toBe(reel);
  });
});