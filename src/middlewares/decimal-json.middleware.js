import { Prisma } from '@prisma/client';

// Prisma renvoie un Decimal sur les colonnes monétaires, et Decimal.toJSON()
// renvoie une chaine : JSON.stringify produirait donc "totalPrice": "1000.5".
// Or l'API expose des nombres, et les clients existants attendent des nombres.
//
// Un replacer JSON ne peut pas corriger ca : la specification appelle toJSON()
// AVANT le replacer, donc le replacer ne voit jamais l'objet Decimal, seulement
// la chaine qu'il a deja produite. On convertit donc la charge utile avant
// serialisation, en un seul point, plutot qu'a chaque res.json() du projet.

const isDecimal = (value) => value instanceof Prisma.Decimal;

// On ne parcourt que les tableaux et les objets simples : traverser un Date, un
// Buffer ou une classe exotique le detruirait ou le rendrait illisible.
const isTraversable = (value) =>
  value !== null &&
  typeof value === 'object' &&
  (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype);

function toPlainNumbers(value) {
  if (isDecimal(value)) return value.toNumber();
  if (!isTraversable(value)) return value;

  if (Array.isArray(value)) return value.map(toPlainNumbers);

  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = toPlainNumbers(item);
  return out;
}

export function decimalAsNumber(req, res, next) {
  const sendJson = res.json.bind(res);
  res.json = (body) => sendJson(toPlainNumbers(body));
  next();
}