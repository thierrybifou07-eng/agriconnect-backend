require('dotenv').config();
const http = require('http');
const { Server } = require('socket.io');
const app = require('./app');
const initChatSocket = require('./sockets/chat.socket');

const PORT = process.env.PORT || 4000;

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
});

app.set('io', io);
initChatSocket(io);

server.listen(PORT, () => {
  console.log(`AgriConnect API démarrée sur le port http://localhost:${PORT}`);
});
