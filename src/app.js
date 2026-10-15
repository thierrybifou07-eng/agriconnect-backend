import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import routes from './routes/index.js';
import { notFound, errorHandler } from './middlewares/error.middleware.js';
import { apiLimiter } from './middlewares/rateLimit.middleware.js';
import { decimalAsNumber } from './middlewares/decimal-json.middleware.js';
import { httpCorsOptions } from './utils/cors.js';
import { apiReference } from '@scalar/express-api-reference';
import { getOpenApiDocument } from '../config/openapi/openapi.config.js';

const app = express();

// En-têtes de sécurité HTTP (CSP, HSTS, X-Content-Type-Options, ...) :
// helmet pose par défaut un socle de protections sans casser les clients
// existants. La CSP par défaut est stricte mais n'interdit ni les scripts
// ni les styles inline du serveur de pages (renderPage sert du HTML fixe).
app.use(helmet());

// Avant toute route : les montants stockes en Decimal doivent partir en nombres.
app.use(decimalAsNumber);

// CORS : sans configuration, cors() autorise n'importe quelle origine.
// CORS_IO (liste d'origines separees par des virgules, ou '*') permet de
// restreindre l'API aux clients connus. Absente, on conserve le comportement
// ouvert afin de ne pas casser un client non configure, mais il faut la
// renseigner en production : l'API est alors interrogeable depuis n'importe
// quel site.
// La traduction de la valeur estdeleguee a utils/cors.js, partage avec
// Socket.io, pour que les deux serveurs ne puissent pas diverger.
app.use(cors(httpCorsOptions()));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/v2', apiLimiter, routes);

// Documentation interactive Scalar.
//
// Le document est calculé une seule fois au démarrage, depuis les validateurs
// Joi réels (config/openapi/modules/*.openapi.js) : les schémas de requête ne
// peuvent donc pas dériver des validateurs.
//
// Le bundle de l'interface est chargé depuis cdn.jsdelivr.net, ce que la CSP
// par défaut de helmet interdirait : la route republie sa propre CSP, moins
// stricque, sans toucher à celle de l'API.
app.use('/reference', (req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com",
      "style-src 'self' 'unsafe-inline' https:",
      "img-src 'self' data: https:",
      "font-src 'self' data: https:",
      "connect-src 'self' https://cdn.jsdelivr.net https://unpkg.com",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-src 'none'",
    ].join('; '),
  );
  next();
});
app.use('/reference', apiReference({ spec: { content: getOpenApiDocument() } }));

app.use(notFound);
app.use(errorHandler);

export default app;
