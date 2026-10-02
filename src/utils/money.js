import { Prisma } from '@prisma/client';

// Les colonnes monetaires (price, unitPrice, totalPrice, deliveryFee) et les
// quantites sont stockees en DECIMAL en base, pas en Float : un Float ne peut
// pas representer 0.1 exactement et MySQL y stockerait une approximation.
//
// Ce module Concentre les trois conversions necessaires :
//   - lire une valeur Prisma (Decimal) pour faire une comparaison ou un calcul
//   - arrondir explicitement avant ecriture, plutot que de laisser MySQL
//     tronquer en silence
//   - repasser en nombre pour l'API, qui expose des nombres et non des
//     chaines

const Decimal = Prisma.Decimal;

// Un montant se raisonne au centime.
export const MONEY_DECIMALS = 2;
// Une quantite se raisonne au gramme : 2,5 tonnes, 12,345 kg.
export const QUANTITY_DECIMALS = 3;

// Accepte un nombre, une chaine ("12.30") ou un Decimal deja construit, et
// renvoie toujours un Decimal. null/undefined sont preserves tels quels pour
// ne pas transformer une colonne nullable en zero.
export function toDecimal(value) {
  if (value === null || value === undefined) return value;
  return value instanceof Decimal ? value : new Decimal(value);
}

// Sortie d'API : un Decimal devient un nombre. Les valeurs des colonnes
// monétaires tenant en 2 decimales, la conversion en nombre JavaScript est
// sans perte sur la plage des montants realistes.
export function toNumber(value) {
  if (value === null || value === undefined) return value;
  return value instanceof Decimal ? value.toNumber() : value;
}

// Arrondi monetaire avant ecriture, au plus proche centime.
// null/undefined sont renormalises tels quels : sans ce garde-fou, l operateur
// optionnel renverrait undefined pour une valeur null, transformant une colonne
// nullable en "absente" plutot qu'en "vide".
export function asMoney(value) {
  const decimal = toDecimal(value);
  if (decimal === null || decimal === undefined) return decimal;
  return decimal.toDecimalPlaces(MONEY_DECIMALS, Decimal.ROUND_HALF_UP);
}

// Arrondi de quantite avant ecriture, au plus proche gramme.
export function asQuantity(value) {
  const decimal = toDecimal(value);
  if (decimal === null || decimal === undefined) return decimal;
  return decimal.toDecimalPlaces(QUANTITY_DECIMALS, Decimal.ROUND_HALF_UP);
}