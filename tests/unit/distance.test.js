import { describe, it, expect } from 'vitest';
import { haversineDistanceKm, calculateDeliveryFee } from '../../src/utils/distance.js';

describe('haversineDistanceKm', () => {
  it('renvoie 0 pour deux points identiques', () => {
    expect(haversineDistanceKm(34.02, -6.84, 34.02, -6.84)).toBe(0);
  });

  it('calcule la distance Rabat -> Casablanca', () => {
    // ~87 km a vol d'oiseau, marge de 5 % pour absorbing la formule
    const d = haversineDistanceKm(34.02, -6.84, 33.57, -7.59);
    expect(d).toBeGreaterThan(83);
    expect(d).toBeLessThan(92);
  });

  it('est symétrique', () => {
    const a = haversineDistanceKm(34.02, -6.84, 33.57, -7.59);
    const b = haversineDistanceKm(33.57, -7.59, 34.02, -6.84);
    expect(a).toBe(b);
  });

  it('arrondit a deux decimales', () => {
    const d = haversineDistanceKm(34.0203, -6.8416, 33.5731, -7.5898);
    expect(d).toBe(Math.round(d * 100) / 100);
  });

  // Un calcul de distance sur des coordonnées absentes rendrait un nombre
  // sans signification, que le code presenterait ensuite comme un tarif.
  it('renvoie null si une coordonnee manque', () => {
    expect(haversineDistanceKm(null, -6.84, 33.57, -7.59)).toBeNull();
    expect(haversineDistanceKm(34.02, undefined, 33.57, -7.59)).toBeNull();
    expect(haversineDistanceKm(34.02, -6.84, null, -7.59)).toBeNull();
    expect(haversineDistanceKm(34.02, -6.84, 33.57, null)).toBeNull();
  });
});

describe('calculateDeliveryFee', () => {
  it('applique le forfait de base', () => {
    // BASE_FEE 500 + 0 km
    expect(calculateDeliveryFee(0)).toBe(500);
  });

  it('ajoute le tarif au kilometre', () => {
    // BASE_FEE 500 + 10 km * 150
    expect(calculateDeliveryFee(10)).toBe(2000);
  });

  it('renvoie un entier', () => {
    // 500 + 1.33 * 150 = 699.5
    expect(Number.isInteger(calculateDeliveryFee(1.33))).toBe(true);
    expect(calculateDeliveryFee(1.33)).toBe(700);
  });

  it('renvoie null sans distance exploitable', () => {
    expect(calculateDeliveryFee(null)).toBeNull();
    expect(calculateDeliveryFee(undefined)).toBeNull();
  });
});
