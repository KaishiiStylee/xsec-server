/* ============================================
   XSEC CHAT — SERVER
   Node.js + Express + Socket.IO
   Deploy: Railway
   ============================================ */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 3e7,
  pingTimeout: 60000,
  pingInterval: 25000
});

/* ============ STORAGE (in-memory) ============ */
let stories = [];

/* Auto-hapus story setelah 24 jam */
setInterval(() => {
  const now = Date.now();
  const before = stories.length;
  stories = stories.filter(s => (now - s.createdAt) < 24 * 3600 * 1000);
  if (stories.length !== before) {
    io.emit('stories:update', stories);
    console.log('Story dibersihkan:', before - stories.length);
  }
}, 3600 * 1000);

/* ============ HEALTH CHECK ============ */
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'XSEC Server is running',
    connections: io.engine.clientsCount,
    stories: stories.length,
    uptime: Math.floor(process.uptime()) + 's',
    time: new Date().toISOString()
  });
});

/* ============================================
   STORY ENDPOINTS
   ============================================ */

/* Upload story (foto/video/teks) */
app.post('/api/story', (req, res) => {
  try {
    const {
      userId, userName, userAvatar,
      media, mediaType, caption, music,
      text, textBg, textFont, textColor
    } = req.body;

    /* Validasi */
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }
    if (mediaType === 'text' && !text) {
      return res.status(400).json({ error: 'Missing text' });
    }
    if (mediaType !== 'text' && !media) {
      return res.status(400).json({ error: 'Missing media' });
    }

    const sizeKB = media ? Math.round(media.length / 1024) : 0;
    console.log(`Story masuk dari ${userName || userId} (${mediaType}, ${sizeKB} KB)`);

    const story = {
      id: 'story-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
      userId,
      userName: userName || 'User',
      userAvatar: userAvatar || '',
      media: media || '',
      mediaType: mediaType || 'image',
      caption: caption || '',
      music: music || null,
      text: text || '',
      textBg: textBg || '#E53935',
      textFont: textFont || 'Plus Jakarta Sans',
      textColor: textColor || '#FFFFFF',
      createdAt: Date.now(),
      viewers: []
    };

    stories.push(story);
    io.emit('story:new', story);
    console.log('Story disimpan:', story.id, '- total:', stories.length);

    res.json(story);
  } catch (e) {
    console.error('Error upload story:', e);
    res.status(500).json({ error: e.message });
  }
});

/* Ambil semua story aktif */
app.get('/api/stories', (req, res) => {
  res.json(stories);
});

/* Hapus story */
app.delete('/api/story/:id', (req, res) => {
  const idx = stories.findIndex(s => s.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Not found' });
  }
  const removed = stories.splice(idx, 1)[0];
  io.emit('story:deleted', removed.id);
  console.log('Story dihapus:', removed.id);
  res.json({ ok: true });
});

/* Tandai sudah dilihat */
app.post('/api/story/:id/view', (req, res) => {
  const { userId } = req.body;
  const s = stories.find(x => x.id === req.params.id);
  if (s && userId && !s.viewers.includes(userId)) {
    s.viewers.push(userId);
    io.emit('story:viewed', { id: s.id, viewers: s.viewers });
  }
  res.json({ ok: true });
});

/* ============================================
   SOCKET.IO — REALTIME
   ============================================ */
const onlineUsers = new Map(); // userId -> { socketId, name, avatar }

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  /* User online */
  socket.on('user:online', (payload) => {
    let userId, name, avatar;
    if (typeof payload === 'string') {
      userId = payload; name = payload; avatar = '';
    } else {
      userId = payload.userId;
      name = payload.name || userId;
      avatar = payload.avatar || '';
    }
    onlineUsers.set(userId, { socketId: socket.id, name, avatar });
    io.emit('users:online', Array.from(onlineUsers.keys()));
    socket.emit('stories:init', stories);
    console.log('User online:', userId);
  });

  /* ===== CHAT ===== */
  socket.on('chat:send', (msg) => {
    const target = onlineUsers.get(msg.to);
    if (target) io.to(target.socketId).emit('chat:receive', msg);
    socket.emit('chat:sent', msg);
  });

  socket.on('chat:typing', ({ from, to, isTyping }) => {
    const target = onlineUsers.get(to);
    if (target) io.to(target.socketId).emit('chat:typing', { from, isTyping });
  });

  socket.on('chat:delivered', ({ to, messageId }) => {
    const target = onlineUsers.get(to);
    if (target) io.to(target.socketId).emit('chat:delivered', { from: to, messageId });
  });

  socket.on('chat:read', ({ to, messageId }) => {
    const target = onlineUsers.get(to);
    if (target) io.to(target.socketId).emit('chat:read', { from: to, messageId });
  });

  /* ===== CALL SIGNALING ===== */
  socket.on('call:initiate', ({ from, fromName, fromAvatar, to, type }) => {
    const target = onlineUsers.get(to);
    if (!target) {
      socket.emit('call:unavailable', { to });
      return;
    }
    io.to(target.socketId).emit('call:incoming', {
      from, fromName, fromAvatar, type, callId: socket.id
    });
    console.log(`Call ${from} -> ${to} (${type})`);
  });

  socket.on('call:accept', ({ callId }) => {
    io.to(callId).emit('call:accepted');
  });

  socket.on('call:reject', ({ callId }) => {
    io.to(callId).emit('call:rejected');
  });

  /* ===== WEBRTC ===== */
  socket.on('webrtc:offer', ({ to, offer }) => {
    const target = onlineUsers.get(to);
    if (target) io.to(target.socketId).emit('webrtc:offer', { from: socket.id, offer });
  });

  socket.on('webrtc:answer', ({ to, answer }) => {
    const target = onlineUsers.get(to);
    if (target) io.to(target.socketId).emit('webrtc:answer', { from: socket.id, answer });
  });

  socket.on('webrtc:ice', ({ to, candidate }) => {
    const target = onlineUsers.get(to);
    if (target) io.to(target.socketId).emit('webrtc:ice', { from: socket.id, candidate });
  });

  socket.on('call:end', ({ to }) => {
    const target = onlineUsers.get(to);
    if (target) io.to(target.socketId).emit('call:ended');
  });

  /* ===== DISCONNECT ===== */
  socket.on('disconnect', () => {
    for (const [userId, data] of onlineUsers) {
      if (data.socketId === socket.id) {
        onlineUsers.delete(userId);
        console.log('User offline:', userId);
      }
    }
    io.emit('users:online', Array.from(onlineUsers.keys()));
  });
});

/* ============ START ============ */
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`XSEC Server running on port ${PORT}`);
});
