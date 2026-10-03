/* ============================================
   XSEC CHAT — SERVER v4
   ============================================ */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ limit: '60mb', extended: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 7e7,
  pingTimeout: 60000,
  pingInterval: 25000
});

let stories = [];

setInterval(() => {
  const now = Date.now();
  const before = stories.length;
  stories = stories.filter(s => (now - s.createdAt) < 24 * 3600 * 1000);
  if (stories.length !== before) io.emit('stories:update', stories);
}, 3600 * 1000);

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    connections: io.engine.clientsCount,
    stories: stories.length,
    uptime: Math.floor(process.uptime()) + 's',
    time: new Date().toISOString()
  });
});

app.post('/api/story', (req, res) => {
  try {
    const { userId, userName, userAvatar, media, mediaType, caption, music, text, textBg, textFont, textColor, musicStart, musicDuration } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    if (mediaType === 'text' && !text) return res.status(400).json({ error: 'Missing text' });
    if (mediaType !== 'text' && !media) return res.status(400).json({ error: 'Missing media' });

    const story = {
      id: 'story-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
      userId, userName: userName || 'User', userAvatar: userAvatar || '',
      media: media || '', mediaType: mediaType || 'image',
      caption: caption || '', music: music || null,
      musicStart: musicStart || 0,
      musicDuration: musicDuration || 15,
      text: text || '', textBg: textBg || '#E53935',
      textFont: textFont || 'Plus Jakarta Sans', textColor: textColor || '#FFFFFF',
      createdAt: Date.now(), viewers: []
    };
    stories.push(story);
    io.emit('story:new', story);
    console.log('Story disimpan:', story.id);
    res.json(story);
  } catch (e) {
    console.error('Error:', e);
    res.status(500).json({ error: e.message });
  }
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

const onlineUsers = new Map();
const lastSeenMap = new Map();

function broadcastUsers() {
  io.emit('users:online', Array.from(onlineUsers.keys()));
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('user:online', (payload) => {
    let userId, name, avatar;
    if (typeof payload === 'string') { userId = payload; name = payload; avatar = ''; }
    else { userId = payload.userId; name = payload.name || userId; avatar = payload.avatar || ''; }
    onlineUsers.set(userId, { socketId: socket.id, name, avatar, lastSeen: Date.now() });
    socket.userId = userId;
    broadcastUsers();
    socket.emit('stories:init', stories);
    const lastSeenData = {};
    lastSeenMap.forEach((val, key) => { lastSeenData[key] = val; });
    socket.emit('users:lastseen', lastSeenData);
    console.log('Online:', userId);
  });

  socket.on('user:getlastseen', (userId) => {
    const ts = lastSeenMap.get(userId) || null;
    socket.emit('user:lastseen', { userId, timestamp: ts });
  });

  /* CHAT */
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
    if (target) io.to(target.socketId).emit('chat:delivered', { from: socket.userId, messageId });
  });

  socket.on('chat:read', ({ to, messageId }) => {
    const target = onlineUsers.get(to);
    if (target) io.to(target.socketId).emit('chat:read', { from: socket.userId, messageId });
  });

  socket.on('chat:readall', ({ to }) => {
    const target = onlineUsers.get(to);
    if (target) io.to(target.socketId).emit('chat:readall', { from: socket.userId });
  });

  /* CALL */
  socket.on('call:initiate', ({ from, fromName, fromAvatar, to, type }) => {
    const target = onlineUsers.get(to);
    if (!target) { socket.emit('call:unavailable', { to }); return; }
    io.to(target.socketId).emit('call:incoming', {
      from, fromName, fromAvatar, type, callId: socket.id
    });
  });

  socket.on('call:accept', ({ callId }) => { io.to(callId).emit('call:accepted'); });
  socket.on('call:reject', ({ callId }) => { io.to(callId).emit('call:rejected'); });
  socket.on('call:cancel', ({ to }) => {
    const target = onlineUsers.get(to);
    if (target) io.to(target.socketId).emit('call:cancelled');
  });
  socket.on('call:upgrade-video', ({ to }) => {
    const target = onlineUsers.get(to);
    if (target) io.to(target.socketId).emit('call:upgrade-video');
  });
  socket.on('call:accept-upgrade', ({ to }) => {
    const target = onlineUsers.get(to);
    if (target) io.to(target.socketId).emit('call:accept-upgrade');
  });
  socket.on('call:reject-upgrade', ({ to }) => {
    const target = onlineUsers.get(to);
    if (target) io.to(target.socketId).emit('call:reject-upgrade');
  });

  socket.on('webrtc:offer', ({ to, offer }) => {
    const target = onlineUsers.get(to);
    if (target) io.to(target.socketId).emit('webrtc:offer', { from: socket.userId || socket.id, offer });
  });
  socket.on('webrtc:answer', ({ to, answer }) => {
    const target = onlineUsers.get(to);
    if (target) io.to(target.socketId).emit('webrtc:answer', { from: socket.userId || socket.id, answer });
  });
  socket.on('webrtc:ice', ({ to, candidate }) => {
    const target = onlineUsers.get(to);
    if (target) io.to(target.socketId).emit('webrtc:ice', { from: socket.userId || socket.id, candidate });
  });
  socket.on('call:end', ({ to }) => {
    const target = onlineUsers.get(to);
    if (target) io.to(target.socketId).emit('call:ended');
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      const now = Date.now();
      lastSeenMap.set(socket.userId, now);
      onlineUsers.delete(socket.userId);
      broadcastUsers();
      io.emit('user:lastseen', { userId: socket.userId, timestamp: now });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`XSEC Server running on port ${PORT}`);
});
