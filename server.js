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

/* STORY */
let stories = [];
setInterval(() => {
  const now = Date.now();
  const before = stories.length;
  stories = stories.filter(s => (now - s.createdAt) < 24 * 3600 * 1000);
  if (stories.length !== before) io.emit('stories:update', stories);
}, 3600 * 1000);

app.get('/', (req, res) => {
  res.json({ status: 'ok', connections: io.engine.clientsCount, stories: stories.length, time: new Date().toISOString() });
});

app.post('/api/story', (req, res) => {
  const { userId, userName, userAvatar, media, mediaType, caption, music } = req.body;
  if (!userId || !media) return res.status(400).json({ error: 'Missing data' });
  const story = {
    id: 'story-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
    userId, userName: userName || 'User', userAvatar: userAvatar || '',
    media, mediaType: mediaType || 'image',
    caption: caption || '', music: music || null,
    createdAt: Date.now(), viewers: []
  };
  stories.push(story);
  io.emit('story:new', story);
  res.json(story);
});

app.get('/api/stories', (req, res) => res.json(stories));

app.delete('/api/story/:id', (req, res) => {
  const idx = stories.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const removed = stories.splice(idx, 1)[0];
  io.emit('story:deleted', removed.id);
  res.json({ ok: true });
});

app.post('/api/story/:id/view', (req, res) => {
  const { userId } = req.body;
  const s = stories.find(x => x.id === req.params.id);
  if (s && userId && !s.viewers.includes(userId)) s.viewers.push(userId);
  res.json({ ok: true });
});

/* USER & SIGNALING */
const onlineUsers = new Map(); // userId -> { socketId, name, avatar }

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('user:online', (payload) => {
    // Support payload lama (string) dan baru (object)
    let userId, name, avatar;
    if (typeof payload === 'string') {
      userId = payload;
      name = payload;
      avatar = '';
    } else {
      userId = payload.userId;
      name = payload.name || userId;
      avatar = payload.avatar || '';
    }
    onlineUsers.set(userId, { socketId: socket.id, name, avatar });
    io.emit('users:online', Array.from(onlineUsers.keys()));
    socket.emit('stories:init', stories);
  });

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

  /* WEBRTC SIGNALING */
  socket.on('call:initiate', ({ from, fromName, fromAvatar, to, type }) => {
    const target = onlineUsers.get(to);
    if (!target) { socket.emit('call:unavailable', { to }); return; }
    io.to(target.socketId).emit('call:incoming', { from, fromName, fromAvatar, type, callId: socket.id });
    console.log(`📞 Call dari ${from} ke ${to} (${type})`);
  });

  socket.on('call:accept', ({ callId }) => {
    io.to(callId).emit('call:accepted');
  });

  socket.on('call:reject', ({ callId }) => {
    io.to(callId).emit('call:rejected');
  });

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

  socket.on('disconnect', () => {
    for (const [userId, data] of onlineUsers) {
      if (data.socketId === socket.id) onlineUsers.delete(userId);
    }
    io.emit('users:online', Array.from(onlineUsers.keys()));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('Server on port', PORT));
