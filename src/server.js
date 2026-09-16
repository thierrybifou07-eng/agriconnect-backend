import 'dotenv/config';
import http from 'http';
import { Server } from 'socket.io';
import app from './app.js';
import initChatSocket from './sockets/chat.socket.js';

const PORT = process.env.PORT || 4000;

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: process.env.CORS_IO},
});

app.set('io', io);
initChatSocket(io);

server.listen(PORT, () => {
  console.log(`AgriConnect API démarrée sur le port http://localhost:${PORT}`);
});
