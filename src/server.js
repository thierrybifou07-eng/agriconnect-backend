import 'dotenv/config';
import http from 'http';
import { Server } from 'socket.io';
import { apiReference } from '@scalar/express-api-reference';
import app from './app.js';
import { notFound } from './middlewares/error.middleware.js';
import initChatSocket from './sockets/chat.socket.js';
import { socketCorsOptions } from './utils/cors.js';
import { startJobs } from './jobs/index.js';
import openapiDocument from '../openapi/openapi.config.js';

const PORT = process.env.PORT || 4000;

const server = http.createServer(app);

const io = new Server(server, {
  cors: socketCorsOptions(),
});

app.set('io', io);
initChatSocket(io);

server.listen(PORT, () => {
  console.log(`AgriConnect API démarrée sur le port http://localhost:${PORT}`);
  // Documentation interactive Scalar : le document OpenAPI est généré depuis
  // les fragments du dossier openapi/ (schémas Joi réels des validateurs).
  app.get('/agriconnect-openapi', apiReference({
    spec: { content: openapiDocument },
    title: 'AgriConnect API',
    hideClientButton: false,
    theme: 'default',
  }));
  // Express exécute les couches dans l'ordre de déclaration : le 404 catch-all
  // (app.use(notFound) dans src/app.js) a été monté avant cette route et
  // répondrait le premier. On déplace donc la couche de la route juste devant
  // lui dans la pile du routeur, sans toucher à app.js.
  const routerStack = app.router.stack;
  const docsLayer = routerStack.pop();
  routerStack.splice(routerStack.findIndex((layer) => layer.handle === notFound), 0, docsLayer);
  console.log(`Documentation API : http://localhost:${PORT}/agriconnect-openapi`);
  // Tâches planifiées (P6.3) : la suite de tests ne les démarre jamais
  // (NODE_ENV=test), et DISABLE_JOBS=true permet à un deuxième serveur sur
  // la même base de ne pas doubler le travail (voir .env.example).
  if (process.env.NODE_ENV !== 'test' && process.env.DISABLE_JOBS !== 'true') {
    startJobs(io);
  }
});
