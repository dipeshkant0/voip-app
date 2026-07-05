require('dotenv').config();
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
const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:global.stun.twilio.com:3478' }
];
const RATE_LIMIT_WINDOW_MS = 1500;
const RATE_LIMIT_MAX_EVENTS = 1500;
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

async function fetchMeteredIceServers(project, apiKey) {
  try {
    const response = await fetch(`https://${project}.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`);
    if (!response.ok) return null;
    const data = await response.json();
    return normalizeIceServers(data);
  } catch (error) {
    console.error('Failed to fetch Metered TURN API:', error);
    return null;
  }
}

async function fetchTwilioIceServers(accountSid, authToken) {
  try {
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Tokens.json`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}` },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return normalizeIceServers(data.ice_servers);
  } catch (error) {
    console.error('Failed to fetch Twilio NTS API:', error);
    return null;
  }
}

let cachedIceServers = null;
let iceServersCacheExpiry = 0;

async function getIceServers() {
  const now = Date.now();
  if (cachedIceServers && now < iceServersCacheExpiry) {
    return cachedIceServers;
  }

  let servers = [];
  const explicit = parseJsonArray(process.env.ICE_SERVERS_JSON);
  
  if (explicit) {
    const normalized = normalizeIceServers(explicit);
    if (normalized.length) servers = normalized;
  }

  if (!servers.length && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    const twilioServers = await fetchTwilioIceServers(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    if (twilioServers && twilioServers.length) servers = twilioServers;
  }

  if (!servers.length && process.env.METERED_PROJECT && process.env.METERED_API_KEY) {
    const meteredServers = await fetchMeteredIceServers(process.env.METERED_PROJECT, process.env.METERED_API_KEY);
    if (meteredServers && meteredServers.length) servers = meteredServers;
  }

  if (!servers.length) {
    const envServers = splitList(process.env.STUN_URLS).map((url) => ({ urls: url }));
    const turnUrls = splitList(process.env.TURN_URLS);
    if (turnUrls.length) {
      const turnServer = { urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls };
      const username = String(process.env.TURN_USERNAME || '').trim();
      const credential = String(process.env.TURN_CREDENTIAL || process.env.TURN_CREDENTIALS || '').trim();
      if (username) turnServer.username = username;
      if (credential) turnServer.credential = credential;
      envServers.push(turnServer);
    }

    if (!envServers.length) {
      envServers.push(...DEFAULT_ICE_SERVERS);
    }
    servers = normalizeIceServers(envServers);
  }

  cachedIceServers = servers;
  iceServersCacheExpiry = now + 15 * 60 * 1000;
  return cachedIceServers;
}

app.disable('x-powered-by');
app.use(compression());
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
        fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", "stun:", "turn:", "*", "wss:", "ws:"],
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.get('/config.js', async (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const iceServers = await getIceServers();
    res.send(`window.__VOIP_APP_CONFIG__ = ${JSON.stringify({ iceServers, maxRoomCapacity: MAX_ROOM_CAPACITY })};`);
  } catch (error) {
    console.error('Config route error:', error);
    res.status(500).send('/* Config generation failed */');
  }
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

    const existingMeta = roomMetadata.get(room);
    const occupancy = existingMeta ? existingMeta.users.size : 0;

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

    if (occupancy === 0) {
      const users = new Map();
      users.set(socket.id, username);
      roomMetadata.set(room, { password, users });
    } else {
      if (existingMeta.password !== password) {
        if (typeof ack === 'function') {
          ack({
            ok: false,
            code: 'invalid-password',
            message: 'Incorrect room password.',
          });
        }
        return;
      }
      existingMeta.users.set(socket.id, username);
    }

    const existingPeerIds = getRoomPeerIds(room, socket.id);
    currentRoom = room;
    await socket.join(room);

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
  getIceServers().catch(err => console.warn('Background ICE cache pre-warming failed:', err));
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
