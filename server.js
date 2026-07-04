const compression = require('compression');
const express = require('express');
const helmet = require('helmet');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const MAX_ROOM_CAPACITY = 6;
const ROOM_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_STUN_URLS = ['stun:stun.l.google.com:19302'];
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_EVENTS = 60;
const MAX_USERNAME_LENGTH = 32;
const MAX_PASSWORD_LENGTH = 128;

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseJsonArray(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function normalizeIceServers(rawServers) {
  if (!Array.isArray(rawServers)) return [];

  return rawServers
    .map((srv) => {
      if (!srv || typeof srv !== 'object' || !srv.urls) return null;
      const urls = Array.isArray(srv.urls) ? srv.urls : [srv.urls];
      const cleanedUrls = urls.map((url) => String(url || '').trim()).filter(Boolean);
      if (!cleanedUrls.length) return null;

      const entry = { urls: cleanedUrls.length === 1 ? cleanedUrls[0] : cleanedUrls };
      if (typeof srv.username === 'string' && srv.username.trim()) entry.username = srv.username.trim();
      if (typeof srv.credential === 'string' && srv.credential.trim()) entry.credential = srv.credential.trim();
      return entry;
    })
    .filter(Boolean);
}

function parseIceServersFromEnv() {
  const explicit = parseJsonArray(process.env.ICE_SERVERS_JSON);
  if (explicit) {
    const normalized = normalizeIceServers(explicit);
    if (normalized.length) return normalized;
  }

  const servers = splitList(process.env.STUN_URLS).map((url) => ({ urls: url }));
  const turnUrls = splitList(process.env.TURN_URLS);
  if (turnUrls.length) {
    const turnServer = { urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls };
    const username = String(process.env.TURN_USERNAME || '').trim();
    const credential = String(process.env.TURN_CREDENTIAL || process.env.TURN_CREDENTIALS || '').trim();
    if (username) turnServer.username = username;
    if (credential) turnServer.credential = credential;
    servers.push(turnServer);
  }

  if (!servers.length) {
    servers.push(...DEFAULT_STUN_URLS.map((url) => ({ urls: url })));
  }

  return normalizeIceServers(servers);
}

app.disable('x-powered-by');
app.use(compression());
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.get('/config.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`window.__VOIP_APP_CONFIG__ = ${JSON.stringify({ iceServers: parseIceServersFromEnv(), maxRoomCapacity: MAX_ROOM_CAPACITY })};`);
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const io = new Server(server, {
  cors: {
    origin: false,
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 1e5,
});

function normalizeRoomName(roomName) {
  return String(roomName ?? '').trim();
}

function isValidRoomName(roomName) {
  return ROOM_NAME_PATTERN.test(roomName);
}

function getRoomSockets(roomName) {
  const room = io.sockets.adapter.rooms.get(roomName);
  if (!room) return [];
  return [...room].map((socketId) => io.sockets.sockets.get(socketId)).filter(Boolean);
}

function getRoomPeerIds(roomName, excludeSocketId) {
  return getRoomSockets(roomName)
    .filter((socket) => socket.id !== excludeSocketId)
    .map((socket) => socket.id);
}

const roomMetadata = new Map();

function getRoomSnapshot(roomName) {
  const peers = getRoomPeerIds(roomName).sort((left, right) => left.localeCompare(right));
  const meta = roomMetadata.get(roomName);
  const usernames = {};
  if (meta) {
    peers.forEach(id => { usernames[id] = meta.users.get(id) || 'Anonymous'; });
  }
  return {
    room: roomName,
    peers,
    usernames,
    peerCount: peers.length,
  };
}

function emitRoomState(roomName) {
  if (!roomName) return;
  io.to(roomName).emit('room-state', getRoomSnapshot(roomName));
}

function forwardIfValid(roomName, targetId, eventName, payload) {
  const targetSocket = io.sockets.sockets.get(targetId);
  if (!targetSocket) return false;
  if (!targetSocket.rooms.has(roomName)) return false;
  targetSocket.emit(eventName, payload);
  return true;
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let eventTokens = RATE_LIMIT_MAX_EVENTS;
  let lastRefill = Date.now();

  function checkRateLimit() {
    const now = Date.now();
    const elapsed = now - lastRefill;
    if (elapsed >= RATE_LIMIT_WINDOW_MS) {
      eventTokens = RATE_LIMIT_MAX_EVENTS;
      lastRefill = now;
    }
    if (eventTokens > 0) {
      eventTokens--;
      return true;
    }
    return false;
  }

  const leaveCurrentRoom = (broadcast = true) => {
    if (!currentRoom) return false;

    const room = currentRoom;
    currentRoom = null;
    socket.leave(room);

    const meta = roomMetadata.get(room);
    if (meta) {
      meta.users.delete(socket.id);
      if (meta.users.size === 0) {
        roomMetadata.delete(room);
      }
    }

    if (broadcast) {
      socket.to(room).emit('peer-disconnected', {
        peerId: socket.id,
        room,
      });
    }

    emitRoomState(room);

    return true;
  };

  socket.on('join-room', async (payload, ack) => {
    if (!checkRateLimit()) {
      if (typeof ack === 'function') {
        ack({
          ok: false,
          code: 'rate-limited',
          message: 'Too many requests. Wait a moment and try again.',
        });
      }
      return;
    }

    const safePayload = payload && typeof payload === 'object' ? payload : {};
    const roomName = typeof payload === 'string' ? payload : safePayload.roomId;
    const rawUsername = typeof safePayload.username === 'string' ? safePayload.username.trim() : '';
    const username = (rawUsername || 'Anonymous').slice(0, MAX_USERNAME_LENGTH);
    const password = typeof safePayload.password === 'string' ? safePayload.password : '';
    const room = normalizeRoomName(roomName);

    if (!isValidRoomName(room)) {
      if (typeof ack === 'function') {
        ack({
          ok: false,
          code: 'invalid-room',
          message: 'Room IDs must be 1-64 characters using letters, numbers, _ or -.',
        });
      }
      return;
    }

    if (password.length > MAX_PASSWORD_LENGTH) {
      if (typeof ack === 'function') {
        ack({
          ok: false,
          code: 'invalid-password',
          message: `Room passwords must be ${MAX_PASSWORD_LENGTH} characters or fewer.`,
        });
      }
      return;
    }

    if (currentRoom && currentRoom !== room) {
      leaveCurrentRoom(true);
    }

    const occupancy = getRoomSockets(room).length;
    
    if (occupancy === 0) {
      // First person creates the room and sets the password
      roomMetadata.set(room, { password, users: new Map() });
    } else {
      // Subsequent joins must match password
      const meta = roomMetadata.get(room);
      if (meta && meta.password !== password) {
        if (typeof ack === 'function') {
          ack({
            ok: false,
            code: 'invalid-password',
            message: 'Incorrect room password.',
          });
        }
        return;
      }
    }

    if (occupancy >= MAX_ROOM_CAPACITY) {
      if (typeof ack === 'function') {
        ack({
          ok: false,
          code: 'room-full',
          message: 'This room already has 6 participants.',
          room,
          max: MAX_ROOM_CAPACITY,
        });
      }
      return;
    }

    const existingPeerIds = getRoomPeerIds(room, socket.id);
    currentRoom = room;
    await socket.join(room);

    const joinedOccupancy = getRoomSockets(room).length;
    if (joinedOccupancy > MAX_ROOM_CAPACITY) {
      socket.leave(room);
      currentRoom = null;
      const meta = roomMetadata.get(room);
      if (meta) {
        meta.users.delete(socket.id);
        if (meta.users.size === 0) {
          roomMetadata.delete(room);
        }
      }
      emitRoomState(room);
      if (typeof ack === 'function') {
        ack({
          ok: false,
          code: 'room-full',
          message: 'This room already has 6 participants.',
          room,
          max: MAX_ROOM_CAPACITY,
        });
      }
      return;
    }

    const meta = roomMetadata.get(room);
    if (meta) {
      meta.users.set(socket.id, username);
    }

    socket.to(room).emit('peer-joined', {
      peerId: socket.id,
      username,
      room,
    });
    emitRoomState(room);

    if (typeof ack === 'function') {
      const snapshot = getRoomSnapshot(room);
      ack({
        ok: true,
        room,
        peers: existingPeerIds,
        roomPeers: snapshot.peers,
        usernames: snapshot.usernames,
        peerCount: existingPeerIds.length + 1,
      });
    }
  });

  socket.on('webrtc-offer', (data = {}) => {
    if (!checkRateLimit()) return;
    if (!currentRoom || typeof data.target !== 'string' || !data.sdp) return;
    if (typeof data.sdp.type !== 'string' || typeof data.sdp.sdp !== 'string') return;
    forwardIfValid(currentRoom, data.target, 'webrtc-offer', {
      sender: socket.id,
      room: currentRoom,
      sdp: data.sdp,
    });
  });

  socket.on('webrtc-answer', (data = {}) => {
    if (!checkRateLimit()) return;
    if (!currentRoom || typeof data.target !== 'string' || !data.sdp) return;
    if (typeof data.sdp.type !== 'string' || typeof data.sdp.sdp !== 'string') return;
    forwardIfValid(currentRoom, data.target, 'webrtc-answer', {
      sender: socket.id,
      room: currentRoom,
      sdp: data.sdp,
    });
  });

  socket.on('ice-candidate', (data = {}) => {
    if (!checkRateLimit()) return;
    if (!currentRoom || typeof data.target !== 'string' || !data.candidate) return;
    forwardIfValid(currentRoom, data.target, 'ice-candidate', {
      sender: socket.id,
      room: currentRoom,
      candidate: data.candidate,
    });
  });

  socket.on('leave-room', () => {
    leaveCurrentRoom(true);
  });

  socket.on('disconnecting', () => {
    leaveCurrentRoom(true);
  });
});

server.listen(PORT, () => {
  console.log(`VoIP server listening on port ${PORT}`);
});

function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Closing server...`);
  io.close(() => {
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
