import express from 'express';
import cors from 'cors';
import routes from './routes/index.js';
import { notFound, errorHandler } from './middlewares/error.middleware.js';
import { apiLimiter } from './middlewares/rateLimit.middleware.js';
import { decimalAsNumber } from './middlewares/decimal-json.middleware.js';
import { httpCorsOptions } from './utils/cors.js';

const app = express();

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

app.use(notFound);
app.use(errorHandler);

export default app;
