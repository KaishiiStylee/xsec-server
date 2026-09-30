const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Cek server hidup
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'XSEC Server is running',
    connections: io.engine.clientsCount,
    time: new Date().toISOString()
  });
});

// Simpan user online (userId -> socketId)
const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // User mendaftarkan diri sebagai online
  socket.on('user:online', (userId) => {
    onlineUsers.set(userId, socket.id);
    console.log('User online:', userId);
    io.emit('users:online', Array.from(onlineUsers.keys()));
  });

  // Kirim pesan chat
  socket.on('chat:send', (msg) => {
    console.log('Pesan:', msg);
    const targetSocket = onlineUsers.get(msg.to);
    if (targetSocket) {
      io.to(targetSocket).emit('chat:receive', msg);
    }
    socket.emit('chat:sent', msg);
  });

  // Typing indicator
  socket.on('chat:typing', ({ from, to, isTyping }) => {
    const targetSocket = onlineUsers.get(to);
    if (targetSocket) {
      io.to(targetSocket).emit('chat:typing', { from, isTyping });
    }
  });

  // Baca pesan
  socket.on('chat:read', ({ from, to, messageIds }) => {
    const targetSocket = onlineUsers.get(to);
    if (targetSocket) {
      io.to(targetSocket).emit('chat:read', { from, messageIds });
    }
  });

  // Signaling telepon / video call
  socket.on('call:initiate', ({ from, to, type }) => {
    const target = onlineUsers.get(to);
    if (target) {
      io.to(target).emit('call:incoming', { from, type, callId: socket.id });
    } else {
      socket.emit('call:unavailable', { to });
    }
  });

  socket.on('call:accept', ({ callId }) => {
    io.to(callId).emit('call:accepted');
  });

  socket.on('call:reject', ({ callId }) => {
    io.to(callId).emit('call:rejected');
  });

  socket.on('webrtc:offer', ({ to, offer }) => {
    io.to(to).emit('webrtc:offer', { from: socket.id, offer });
  });

  socket.on('webrtc:answer', ({ to, answer }) => {
    io.to(to).emit('webrtc:answer', { from: socket.id, answer });
  });

  socket.on('webrtc:ice', ({ to, candidate }) => {
    io.to(to).emit('webrtc:ice', { from: socket.id, candidate });
  });

  socket.on('call:end', ({ to }) => {
    io.to(to).emit('call:ended');
  });

  // Disconnect
  socket.on('disconnect', () => {
    for (const [userId, sid] of onlineUsers) {
      if (sid === socket.id) {
        onlineUsers.delete(userId);
        console.log('User offline:', userId);
      }
    }
    io.emit('users:online', Array.from(onlineUsers.keys()));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`XSEC Server running on port ${PORT}`);
});
