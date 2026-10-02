import { rateLimit } from 'express-rate-limit';

const isTest = process.env.NODE_ENV === 'test';

// L'anti-brute-force reste actif en production. En test il est neutralise par
// defaut : une suite enchaîne naturellement bien plus de 10 appels / 15 min sur
// /api/auth, ce qui rendrait chaque exécution instable et dependante de
// l'ordre des cas.
//
// Il reste neanmoins verifiable : un test peut le reactiver explicitement avec
// AUTH_RATE_LIMIT_ACTIVE=1, auquel cas la limite reelle s'applique (voir
// tests/integration/rate-limit.test.js). Fixer AUTH_RATE_LIMIT permet aussi de
// la rendre configurable sans redemarrer, ce qui vaut mieux qu'une valeur
// codee en dur.
const limiterEnabled = () => !(isTest && process.env.AUTH_RATE_LIMIT_ACTIVE !== '1');

const resolveLimit = (fallback) => {
  const fromEnv = Number.parseInt(process.env.AUTH_RATE_LIMIT, 10);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : fallback;
};

// Limite stricte sur les routes d'authentification (protection brute-force).
// Elle ne couvre que /register et /login : ce sont les seules routes par
// lesquelles on devine un mot de passe.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: resolveLimit(10),
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !limiterEnabled(),
  message: { error: 'Trop de tentatives, réessayez dans quelques minutes' },
});

// Limite distincte pour /refresh. Elle partageait auparavant le meme seau que
// la connexion : express-rate-limit compte par IP et par instance de middleware,
// donc deux connexions plus huit rafraîchissements verrouillaient un
// utilisateur parfaitement legitime pendant quinze minutes.
//
// Le risque est faible ici (le jeton fait 64 caracteres aleatoires, il est
// rotations et un jeton revoque est rejete), mais une limite reste necessaire
// pour absorber un client en boucle.
export const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: resolveLimit(60),
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !limiterEnabled(),
  message: { error: 'Trop de rafraîchissements, réessayez dans quelques minutes' },
});

// Limite générale sur le reste de l'API
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: resolveLimit(300),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, réessayez plus tard' },
});
