const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e7
});

// ===== STORY STORAGE (memory, hilang saat restart) =====
let stories = [];

setInterval(() => {
  const now = Date.now();
  const before = stories.length;
  stories = stories.filter(s => (now - s.createdAt) < 24 * 3600 * 1000);
  if (stories.length !== before) {
    io.emit('stories:update', stories);
    console.log('Story dibersihkan:', before - stories.length);
  }
}, 3600 * 1000);

// ===== HEALTH CHECK =====
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'XSEC Server is running',
    connections: io.engine.clientsCount,
    stories: stories.length,
    time: new Date().toISOString()
  });
});

// ===== STORY ENDPOINTS =====
app.post('/api/story', (req, res) => {
  const { userId, userName, media, mediaType, caption, music } = req.body;
  if (!userId || !media) return res.status(400).json({ error: 'Missing data' });

  const story = {
    id: 'story-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
    userId,
    userName: userName || 'User',
    media,
    mediaType: mediaType || 'image',
    caption: caption || '',
    music: music || null,
    createdAt: Date.now(),
    viewers: []
  };

  stories.push(story);
  io.emit('story:new', story);
  console.log('Story baru:', story.id, 'dari', userName);
  res.json(story);
});

app.get('/api/stories', (req, res) => {
  res.json(stories);
});

app.post('/api/story/:id/view', (req, res) => {
  const { userId } = req.body;
  const s = stories.find(x => x.id === req.params.id);
  if (s && userId && !s.viewers.includes(userId)) {
    s.viewers.push(userId);
    io.emit('story:viewed', { id: s.id, viewers: s.viewers });
  }
  res.json({ ok: true });
});

// ===== SOCKET.IO =====
const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('user:online', (userId) => {
    onlineUsers.set(userId, socket.id);
    console.log('User online:', userId);
    io.emit('users:online', Array.from(onlineUsers.keys()));
    // Kirim semua story ke user yang baru konek
    socket.emit('stories:init', stories);
  });

  socket.on('chat:send', (msg) => {
    const targetSocket = onlineUsers.get(msg.to);
    if (targetSocket) {
      io.to(targetSocket).emit('chat:receive', msg);
    }
    socket.emit('chat:sent', msg);
  });

  socket.on('chat:typing', ({ from, to, isTyping }) => {
    const targetSocket = onlineUsers.get(to);
    if (targetSocket) {
      io.to(targetSocket).emit('chat:typing', { from, isTyping });
    }
  });

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
