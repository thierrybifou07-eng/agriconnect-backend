import 'dotenv/config';
import http from 'http';
import { Server } from 'socket.io';
import app from './app.js';
import initChatSocket from './sockets/chat.socket.js';
import { socketCorsOptions } from './utils/cors.js';

const PORT = process.env.PORT || 4000;

const server = http.createServer(app);

const io = new Server(server, {
  cors: socketCorsOptions(),
});

app.set('io', io);
initChatSocket(io);

server.listen(PORT, () => {
  console.log(`AgriConnect API démarrée sur le port http://localhost:${PORT}`);
});
