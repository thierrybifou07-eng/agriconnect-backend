import { Prisma } from '@prisma/client';
import { roundMoney, toDecimal } from '../utils/money.js';

// Moteur de prix pur : aucune route, aucune lecture directe de la base
// (hormis getSettings). Toutes les fonctions travaillent sur des valeurs
// deja chargees (Decimal) et renvoient des Decimal, garantissant qu'aucun
// calcul d'argent ne transite par un Number flottant.

const Decimal = Prisma.Decimal;

// Ligne de commande : l'acheteur paie le prix public, le promoteur est payé
// sur le prix convenu moins la commission. Les deux prix figés permettent
// de calculer l'écart (revenu AgriLink) sans ambiguity.
export function computeLine({ quantity, unitPrice, supplierUnitPrice, commissionRate }, currency) {
  const qty = toDecimal(quantity);
  const unit = toDecimal(unitPrice);
  const supplierUnit = toDecimal(supplierUnitPrice);
  const rate = toDecimal(commissionRate);

  const lineTotal = roundMoney(qty.mul(unit), currency);
  const supplierBase = qty.mul(supplierUnit);
  const commissionAmount = roundMoney(supplierBase.mul(rate), currency);
  const supplierNetAmount = roundMoney(supplierBase.sub(commissionAmount), currency);

  return { lineTotal, commissionAmount, supplierNetAmount };
}

// Frais facturés à l'acheteur : aucun, forfaitaire ou proportionnel au
// sous-total. Le type NONE est valide (pas de frais) et distinct d'une
// valeur de 0 dans les autres modes.
export function computeBuyerFee(subtotal, { type, value }, currency) {
  const sub = toDecimal(subtotal);
  const val = toDecimal(value);

  if (type === 'NONE') return roundMoney(0, currency);
  if (type === 'FIXED') return roundMoney(val, currency);
  if (type === 'PERCENT') return roundMoney(sub.mul(val), currency);
  throw new Error(`Type de frais acheteur inconnu : ${type}`);
}

// Livraison : l'agence perçoit le coût réel (base + km), l'acheteur paie ce
// coût majoré du taux de marge de la plateforme.
export function computeDeliveryFee({ baseFee, perKmFee, distanceKm, markupRate }, currency) {
  const base = toDecimal(baseFee);
  const perKm = toDecimal(perKmFee);
  const km = toDecimal(distanceKm);
  const markup = toDecimal(markupRate);

  const agencyCost = roundMoney(base.add(perKm.mul(km)), currency);
  const deliveryFee = roundMoney(agencyCost.mul(new Decimal(1).add(markup)), currency);

  return { agencyCost, deliveryFee };
}

// Totaux d'une commande : le sous-total est la somme des lignes, le total
// ajoute frais acheteur et livraison. commissionTotal somme les commissions
// de chaque ligne (revenu de la plateforme).
export function computeOrderTotals({ lines, buyerFee, deliveryFee }) {
  const fee = toDecimal(buyerFee);
  const shipping = toDecimal(deliveryFee);

  const subtotal = lines.reduce((acc, l) => acc.add(l.lineTotal), Decimal(0));
  const commissionTotal = lines.reduce((acc, l) => acc.add(l.commissionAmount), Decimal(0));
  const total = subtotal.add(fee).add(shipping);

  return {
    subtotal,
    buyerFee: fee,
    deliveryFee: shipping,
    total,
    commissionTotal,
  };
}

// Lit la configuration unique de la plateforme (id = 1). Une absence de
// parametre rend tout calcul impossible : on renvoie 500 plutot que de
// silencieusement appliquer des valeurs par defaut.
export async function getSettings(tx) {
  const settings = await tx.platformSetting.findUnique({ where: { id: 1 } });
  if (!settings) {
    throw Object.assign(new Error('Paramètres de la plateforme manquants'), { statusCode: 500 });
  }
  return settings;
}
