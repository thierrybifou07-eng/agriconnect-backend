import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { roundMoney } from '../../src/utils/money.js';
import {
  computeLine,
  computeBuyerFee,
  computeDeliveryFee,
  computeOrderTotals,
} from '../../src/services/pricing.service.js';

const Decimal = Prisma.Decimal;

// Tests du moteur de prix purs : aucune base, aucune route. Chaque cas est
// un tableau [args, attendu] exécuté par le même it() pour garantir une
// couverture exhaustive et lisible.

describe('roundMoney — arrondi selon la devise', () => {
  it('cas XAF (0 décimale) et autre devise (2 décimales)', () => {
    const cas = [
      // [valeur, devise, attendu]
      ['1000', 'XAF', '1000'],
      ['1000.4', 'XAF', '1000'],
      ['1000.5', 'XAF', '1001'],       // half up
      ['1234.49', 'XAF', '1234'],
      ['1234.50', 'XAF', '1235'],       // half up
      ['0', 'XAF', '0'],
      ['1000', 'EUR', '1000.00'],
      ['1000.004', 'EUR', '1000.00'],
      ['1000.005', 'EUR', '1000.01'],   // half up
      ['1000.567', 'EUR', '1000.57'],
      ['1000.564', 'EUR', '1000.56'],
      ['0.005', 'USD', '0.01'],         // half up
      ['0', 'USD', '0.00'],
    ];

    for (const [valeur, devise, attendu] of cas) {
      const resultat = roundMoney(valeur, devise);
      expect(resultat, `roundMoney(${valeur}, ${devise})`).toBeInstanceOf(Decimal);
      expect(resultat.toFixed(devise === 'XAF' ? 0 : 2)).toBe(attendu);
    }
  });
});

describe('computeLine — ligne de commande', () => {
  it('cas commission 0 %, 10 %, 12,5 %', () => {
    const cas = [
      // [quantity, unitPrice, supplierUnitPrice, commissionRate, currency, attendu]
      ['2', '1000', '800', '0', 'XAF',     { lineTotal: '2000', commissionAmount: '0',    supplierNetAmount: '1600' }],
      ['2', '1000', '800', '0.1', 'XAF',   { lineTotal: '2000', commissionAmount: '160',  supplierNetAmount: '1440' }],
      ['2', '1000', '800', '0.125', 'XAF', { lineTotal: '2000', commissionAmount: '200',  supplierNetAmount: '1400' }],
      ['2', '1000', '800', '0.1', 'EUR',   { lineTotal: '2000.00', commissionAmount: '160.00', supplierNetAmount: '1440.00' }],
      ['2', '1000', '800', '0', 'EUR',     { lineTotal: '2000.00', commissionAmount: '0.00',    supplierNetAmount: '1600.00' }],
    ];

    for (const [q, up, sup, rate, cur, attendu] of cas) {
      const resultat = computeLine(
        { quantity: q, unitPrice: up, supplierUnitPrice: sup, commissionRate: rate },
        cur
      );
      const dec = cur === 'XAF' ? 0 : 2;
      expect(resultat.lineTotal.toFixed(dec)).toBe(attendu.lineTotal);
      expect(resultat.commissionAmount.toFixed(dec)).toBe(attendu.commissionAmount);
      expect(resultat.supplierNetAmount.toFixed(dec)).toBe(attendu.supplierNetAmount);
      expect(resultat.lineTotal).toBeInstanceOf(Decimal);
      expect(resultat.commissionAmount).toBeInstanceOf(Decimal);
      expect(resultat.supplierNetAmount).toBeInstanceOf(Decimal);
    }
  });

  it('cas quantités décimales (2,5 kg)', () => {
    const cas = [
      // [quantity, unitPrice, supplierUnitPrice, commissionRate, currency, attendu]
      ['2.5', '100', '80', '0', 'XAF',    { lineTotal: '250', commissionAmount: '0',   supplierNetAmount: '200' }],
      ['2.5', '100', '80', '0.1', 'XAF',  { lineTotal: '250', commissionAmount: '20',  supplierNetAmount: '180' }],
      ['2.5', '100', '80', '0.125', 'XAF',{ lineTotal: '250', commissionAmount: '25',  supplierNetAmount: '175' }],
      ['2.5', '33.33', '25', '0.1', 'EUR',{ lineTotal: '83.33', commissionAmount: '6.25', supplierNetAmount: '56.25' }],
    ];

    for (const [q, up, sup, rate, cur, attendu] of cas) {
      const resultat = computeLine(
        { quantity: q, unitPrice: up, supplierUnitPrice: sup, commissionRate: rate },
        cur
      );
      const dec = cur === 'XAF' ? 0 : 2;
      expect(resultat.lineTotal.toFixed(dec)).toBe(attendu.lineTotal);
      expect(resultat.commissionAmount.toFixed(dec)).toBe(attendu.commissionAmount);
      expect(resultat.supplierNetAmount.toFixed(dec)).toBe(attendu.supplierNetAmount);
      expect(resultat.lineTotal).toBeInstanceOf(Decimal);
    }
  });
});

describe('computeBuyerFee — frais acheteur', () => {
  it('cas NONE, FIXED, PERCENT', () => {
    const cas = [
      // [subtotal, type, value, currency, attendu]
      ['1000', 'NONE', '0', 'XAF',    '0'],
      ['1000', 'NONE', '500', 'XAF',  '0'],
      ['1000', 'FIXED', '500', 'XAF', '500'],
      ['1000', 'FIXED', '0', 'XAF',   '0'],
      ['1000', 'FIXED', '99.995', 'EUR', '100.00'],  // half up
      ['1000', 'PERCENT', '0.1', 'XAF',  '100'],
      ['1000', 'PERCENT', '0.125', 'XAF','125'],
      ['1000', 'PERCENT', '0', 'XAF',    '0'],
      ['1000', 'PERCENT', '0.1', 'EUR',  '100.00'],
      ['333.33', 'PERCENT', '0.1', 'EUR','33.33'],   // 33.333 arrondi
    ];

    for (const [sub, type, value, cur, attendu] of cas) {
      const resultat = computeBuyerFee(sub, { type, value }, cur);
      const dec = cur === 'XAF' ? 0 : 2;
      expect(resultat.toFixed(dec), `computeBuyerFee(${sub}, ${type}, ${value}, ${cur})`).toBe(attendu);
      expect(resultat).toBeInstanceOf(Decimal);
    }
  });
});

describe('computeDeliveryFee — livraison avec marge', () => {
  it('cas marge 0 % et 15 %', () => {
    const cas = [
      // [baseFee, perKmFee, distanceKm, markupRate, currency, attendu]
      ['500', '100', '0', '0', 'XAF',      { agencyCost: '500', deliveryFee: '500' }],
      ['500', '100', '10', '0', 'XAF',     { agencyCost: '1500', deliveryFee: '1500' }],
      ['500', '100', '10', '0.15', 'XAF',  { agencyCost: '1500', deliveryFee: '1725' }],
      ['500', '100', '5.5', '0.15', 'XAF',  { agencyCost: '1050', deliveryFee: '1208' }],
      ['500', '100', '10', '0', 'EUR',     { agencyCost: '1500.00', deliveryFee: '1500.00' }],
      ['500', '100', '10', '0.15', 'EUR',  { agencyCost: '1500.00', deliveryFee: '1725.00' }],
      ['0', '150', '20', '0.15', 'XAF',    { agencyCost: '3000', deliveryFee: '3450' }],
    ];

    for (const [base, perKm, km, markup, cur, attendu] of cas) {
      const resultat = computeDeliveryFee(
        { baseFee: base, perKmFee: perKm, distanceKm: km, markupRate: markup },
        cur
      );
      const dec = cur === 'XAF' ? 0 : 2;
      expect(resultat.agencyCost.toFixed(dec)).toBe(attendu.agencyCost);
      expect(resultat.deliveryFee.toFixed(dec)).toBe(attendu.deliveryFee);
      expect(resultat.agencyCost).toBeInstanceOf(Decimal);
      expect(resultat.deliveryFee).toBeInstanceOf(Decimal);
    }
  });
});

describe('computeOrderTotals — totaux et retrait', () => {
  it('cas multi-lignes et retrait sans livraison', () => {
    const ligneA = { lineTotal: new Decimal('2000'), commissionAmount: new Decimal('160') };
    const ligneB = { lineTotal: new Decimal('5000'), commissionAmount: new Decimal('500') };
    const ligneC = { lineTotal: new Decimal('250'), commissionAmount: new Decimal('0') };

    const cas = [
      // [lines, buyerFee, deliveryFee, attendu]
      [[ligneA], '0', '0',                { subtotal: '2000', buyerFee: '0', deliveryFee: '0', total: '2000', commissionTotal: '160' }],
      [[ligneA, ligneB], '0', '0',        { subtotal: '7000', buyerFee: '0', deliveryFee: '0', total: '7000', commissionTotal: '660' }],
      [[ligneA, ligneB], '100', '1725',   { subtotal: '7000', buyerFee: '100', deliveryFee: '1725', total: '8825', commissionTotal: '660' }],
      [[ligneA, ligneB, ligneC], '0', '0',{ subtotal: '7250', buyerFee: '0', deliveryFee: '0', total: '7250', commissionTotal: '660' }],
      [[ligneC], '0', '0',                { subtotal: '250', buyerFee: '0', deliveryFee: '0', total: '250', commissionTotal: '0' }],
    ];

    for (const [lines, buyerFee, deliveryFee, attendu] of cas) {
      const resultat = computeOrderTotals({ lines, buyerFee, deliveryFee });
      expect(resultat.subtotal.toString()).toBe(attendu.subtotal);
      expect(resultat.buyerFee.toString()).toBe(attendu.buyerFee);
      expect(resultat.deliveryFee.toString()).toBe(attendu.deliveryFee);
      expect(resultat.total.toString()).toBe(attendu.total);
      expect(resultat.commissionTotal.toString()).toBe(attendu.commissionTotal);
      expect(resultat.total).toBeInstanceOf(Decimal);
    }
  });
});
