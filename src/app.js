import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import routes from './routes/router.js';
import { notFound, errorHandler } from './middlewares/error.middleware.js';
import { apiLimiter } from './middlewares/rateLimit.middleware.js';
import { decimalAsNumber } from './middlewares/decimal-json.middleware.js';
import { httpCorsOptions } from './utils/cors.js';

const app = express();
export const docsCsp = helmet.contentSecurityPolicy({
    directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "data:", "https://fonts.gstatic.com", "https://fonts.scalar.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https://proxy.scalar.com"],
        workerSrc: ["'self'", "blob:"],
    },
});

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

// Dossier racine uploads/ : fichiers uploaderés en local (remplace Cloudinary).
// Seuls les dossiers PUBLICS sont servis statiquement.
// Les documents de vérification (ID_CARD, BUSINESS_REGISTRATION, FARM_PROOF,
// OTHER) ne sont PAS montés ici : l'accès passe par
// GET /api/v2/admin/files/:token (token JWT signé, exp. 10 min).
const __dirname = dirname(fileURLToPath(import.meta.url));
const uploadsRoot = join(__dirname, '..', 'uploads');

for (const publicFolder of ['AVATAR', 'LOT_PHOTO', 'LISTING_PHOTO']) {
  app.use(
    `/uploads/${publicFolder}`,
    express.static(join(uploadsRoot, publicFolder), {
      // maxAge 1 an pour les assets statiques (images de lots/annonces).
      // Les avatars bénéficient également du cache : un changement d'avatar
      // génère un nouveau nom de fichier (horodatage + rand8), l'ancien est
      // simplement oublié par le client après invalidation.
      maxAge: '1y',
      immutable: true,
    })
  );
}

app.use('/api/v2', apiLimiter, routes);

app.use(notFound);
app.use(errorHandler);

export default app;
