import 'dotenv/config';
import http from 'http';
import { Server } from 'socket.io';
import app from './app.js';
import initChatSocket from './sockets/chat.socket.js';
import { socketCorsOptions } from './utils/cors.js';
import { startJobs } from './jobs/index.js';

const PORT = process.env.PORT || 4000;

const server = http.createServer(app);

const io = new Server(server, {
  cors: socketCorsOptions(),
});

app.set('io', io);
initChatSocket(io);

server.listen(PORT, () => {
  console.log(`🍀 AgriConnect API démarrée sur le port http://localhost:${PORT}`);
  console.log(`📄 UI de documentation accessible sur http://localhost:${PORT}/reference`);
  // Tâches planifiées (P6.3) : la suite de tests ne les démarre jamais
  // (NODE_ENV=test), et DISABLE_JOBS=true permet à un deuxième serveur sur
  // la même base de ne pas doubler le travail (voir .env.example).
  if (process.env.NODE_ENV !== 'test' && process.env.DISABLE_JOBS !== 'true') {
    startJobs(io);
  }
});
