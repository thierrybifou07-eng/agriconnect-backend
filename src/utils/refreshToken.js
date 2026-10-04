// Primitives communes aux jetons a usage unique : voir oneTimeToken.js.
// Ces alias sont conserves parce que le refresh token a une histoire propre —
// sa rotation, sa fenetre de tolerance, sa detection de reutilisation — et que
// le nommer "refreshToken" dit mieux que "oneTimeToken" lequel des trois il est.

export {
  generateOneTimeToken as generateRefreshTokenValue,
  hashOneTimeToken as hashToken,
} from './oneTimeToken.js';