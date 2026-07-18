require('dotenv').config();
const compression = require('compression');
const express = require('express');
const helmet = require('helmet');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const MAX_ROOM_CAPACITY = 8;
const ROOM_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp'
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_EVENTS = 100;
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`https://${project}.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!response.ok) return null;
    const data = await response.json();
    return normalizeIceServers(data);
  } catch (error) {
    clearTimeout(timeoutId);
    const msg = error.name === 'AbortError' ? 'Request timed out (exceeded 5 seconds)' : error.message;
    console.warn(`Failed to fetch Metered TURN API: ${msg}`);
    return null;
  }
}

async function fetchTwilioIceServers(accountSid, authToken) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Tokens.json`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}` },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!response.ok) return null;
    const data = await response.json();
    return normalizeIceServers(data.ice_servers);
  } catch (error) {
    clearTimeout(timeoutId);
    const msg = error.name === 'AbortError' ? 'Request timed out (exceeded 5 seconds)' : error.message;
    console.warn(`Failed to fetch Twilio NTS API: ${msg}`);
    return null;
  }
}

let cachedIceServers = null;
let iceServersCacheExpiry = 0;
let iceServersPromise = null;

async function getIceServers() {
  const now = Date.now();
  if (cachedIceServers && now < iceServersCacheExpiry) {
    return cachedIceServers;
  }

  if (iceServersPromise) {
    return iceServersPromise;
  }

  iceServersPromise = (async () => {
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
    const hasTurn = servers.some(s => s.urls && (Array.isArray(s.urls) ? s.urls.some(u => u.includes('turn:')) : s.urls.includes('turn:')));
    const isFallback = !hasTurn && (process.env.TWILIO_ACCOUNT_SID || process.env.METERED_PROJECT);
    iceServersCacheExpiry = Date.now() + (isFallback ? 30 * 1000 : 15 * 60 * 1000);
    iceServersPromise = null;
    return cachedIceServers;
  })();

  return iceServersPromise;
}

app.disable('x-powered-by');
app.use(compression());
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://webrtc.github.io", "https://cdnjs.cloudflare.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", "stun:", "turn:", "wss:", "ws:", "https://*.metered.live", "https://api.twilio.com", "https://ce.judge0.com"],
        mediaSrc: ["'self'", 'blob:'],
        workerSrc: ["'self'", 'blob:'],
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

app.use(express.json());

const compileLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 20,             // limit each IP to 20 compilations per minute
  message: { error: 'Too many compilation requests. Please try again in a minute.' },
  validate: false,
  keyGenerator: (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    return forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
  }
});

// Code execution compiler routing
app.post('/api/compile', compileLimiter, async (req, res) => {
  const { code, language, stdin } = req.body;
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Code is required and must be a string' });
  }
  if (!language || typeof language !== 'string') {
    return res.status(400).json({ error: 'Language is required and must be a string' });
  }

  const url = process.env.JUDGE0_API_URL || 'https://ce.judge0.com';
  const apiKey = process.env.JUDGE0_API_KEY;

  const judge0LanguageMap = {
    javascript: 93,
    python: 92,
    c: 103,
    cpp: 105,
    rust: 108,
    java: 91,
    bash: 46
  };

  const languageId = judge0LanguageMap[language.toLowerCase()];
  if (!languageId) {
    return res.status(400).json({ error: `Language '${language}' is not supported` });
  }

  try {
    const headers = {
      'Content-Type': 'application/json'
    };

    if (apiKey) {
      if (url.includes('rapidapi.com')) {
        headers['X-RapidAPI-Key'] = apiKey;
        headers['X-RapidAPI-Host'] = url.replace('https://', '').replace('http://', '').split('/')[0];
      } else {
        headers['X-Auth-Token'] = apiKey;
      }
    }

    let compileRes = null;
    let lastError = null;
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      try {
        compileRes = await fetch(`${url}/submissions?wait=true`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            source_code: code,
            language_id: languageId,
            stdin: stdin || ''
          }),
          signal: controller.signal
        });
        // Break early on success or client-side errors (4xx)
        if (compileRes.ok || compileRes.status < 500) {
          break;
        }

        lastError = new Error(`HTTP ${compileRes.status}`);
      } catch (err) {
        lastError = err;
      } finally {
        clearTimeout(timeoutId);
      }

      if (attempt < maxAttempts) {
        const delay = attempt * 800; // backoff: 800ms, 1600ms
        console.warn(`Proxy warning: Compiler fetch attempt ${attempt} failed. Retrying in ${delay}ms... Cause:`, lastError ? lastError.message : 'Unknown');
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    if (!compileRes) {
      throw lastError || new Error('Connection failed after retry limit');
    }

    if (!compileRes.ok) {
      const errorText = await compileRes.text();
      console.error('Compiler execution failure status:', compileRes.status, errorText);
      return res.status(500).json({ error: 'Compiler execution engine returned an error' });
    }

    const data = await compileRes.json();
    const stdout = data.stdout || '';
    const stderr = data.stderr || data.compile_output || '';
    const exitCode = data.status && data.status.id === 3 ? 0 : 1;
    const statusDescription = data.status ? data.status.description : 'Unknown';

    let finalStderr = stderr;
    if (exitCode !== 0 && !stderr && data.status) {
      finalStderr = `Execution failed: ${statusDescription}`;
    }

    return res.json({ stdout, stderr: finalStderr, exitCode });
  } catch (err) {
    console.error('Compiler request error:', err);
    return res.status(500).json({ error: 'Failed to contact compiler execution endpoint' });
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

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: 'Too many connections',
  validate: false,
  keyGenerator: (req) => req.ip || req.socket.remoteAddress,
});

io.engine.use((req, res, next) => {
  const forwarded = req.headers['x-forwarded-for'];
  req.ip = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
  if (typeof res.status !== 'function') {
    res.status = function (statusCode) {
      res.statusCode = statusCode;
      return res;
    };
  }
  if (typeof res.send !== 'function') {
    res.send = function (body) {
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'text/plain');
      }
      res.end(String(body));
    };
  }
  if (typeof res.json !== 'function') {
    res.json = function (body) {
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/json');
      }
      res.end(JSON.stringify(body));
    };
  }
  limiter(req, res, next);
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
  const peers = getRoomPeerIds(roomName);
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

function checkRateLimit(socket) {
  const now = Date.now();
  const tokensPerMs = RATE_LIMIT_MAX_EVENTS / RATE_LIMIT_WINDOW_MS;
  
  if (socket.lastRefill === undefined) {
    socket.lastRefill = now;
  }
  if (socket.eventTokens === undefined) {
    socket.eventTokens = RATE_LIMIT_MAX_EVENTS;
  }
  
  const elapsed = now - socket.lastRefill;
  if (elapsed > 0) {
    socket.eventTokens = Math.min(RATE_LIMIT_MAX_EVENTS, socket.eventTokens + elapsed * tokensPerMs);
    socket.lastRefill = now;
  }

  if (socket.eventTokens >= 1) {
    socket.eventTokens -= 1;
    return true;
  }
  return false;
}

function leaveCurrentRoom(socket, broadcast = true) {
  const room = socket.currentRoom;
  if (!room) return false;

  socket.currentRoom = null;
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
}

io.on('connection', (socket) => {
  socket.currentRoom = null;
  socket.eventTokens = RATE_LIMIT_MAX_EVENTS;
  socket.lastRefill = Date.now();

  socket.on('join-room', async (payload, ack) => {
    try {
      if (!checkRateLimit(socket)) {
        if (typeof ack === 'function') {
          ack({
            ok: false,
            code: 'rate-limited',
            message: 'Too many requests. Wait a moment and try again.',
          });
        }
        return;
      }

      const safePayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
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

      if (socket.currentRoom && socket.currentRoom !== room) {
        leaveCurrentRoom(socket, true);
      }

      const existingMeta = roomMetadata.get(room);
      const occupancy = existingMeta ? existingMeta.users.size : 0;

      if (occupancy >= MAX_ROOM_CAPACITY) {
        if (typeof ack === 'function') {
          ack({
            ok: false,
            code: 'room-full',
            message: `This room already has ${MAX_ROOM_CAPACITY} participants.`,
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
      socket.currentRoom = room;
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
    } catch (error) {
      console.error('Unhandled error in join-room:', error);
      if (typeof ack === 'function') {
        ack({
          ok: false,
          code: 'internal-error',
          message: 'An internal server error occurred.',
        });
      }
    }
  });

  socket.on('webrtc-offer', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!checkRateLimit(socket)) return;
    if (!socket.currentRoom || typeof data.target !== 'string' || !data.sdp) return;
    if (typeof data.sdp.type !== 'string' || typeof data.sdp.sdp !== 'string' || data.sdp.sdp.length > 65536) return;
    forwardIfValid(socket.currentRoom, data.target, 'webrtc-offer', {
      sender: socket.id,
      room: socket.currentRoom,
      sdp: data.sdp,
    });
  });

  socket.on('webrtc-answer', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!checkRateLimit(socket)) return;
    if (!socket.currentRoom || typeof data.target !== 'string' || !data.sdp) return;
    if (typeof data.sdp.type !== 'string' || typeof data.sdp.sdp !== 'string' || data.sdp.sdp.length > 65536) return;
    forwardIfValid(socket.currentRoom, data.target, 'webrtc-answer', {
      sender: socket.id,
      room: socket.currentRoom,
      sdp: data.sdp,
    });
  });

  socket.on('ice-candidate', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!checkRateLimit(socket)) return;
    if (!socket.currentRoom || typeof data.target !== 'string' || !data.candidate) return;
    forwardIfValid(socket.currentRoom, data.target, 'ice-candidate', {
      sender: socket.id,
      room: socket.currentRoom,
      candidate: data.candidate,
    });
  });

  socket.on('room-chat-message', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!checkRateLimit(socket)) return;
    if (!socket.currentRoom) return;

    if (data.encrypted) {
      if (typeof data.payload !== 'string' || data.payload.length > 50000) return;
      if (typeof data.iv !== 'string' || data.iv.length > 100) return;
      socket.to(socket.currentRoom).emit('room-chat-message', {
        senderId: socket.id,
        encrypted: true,
        payload: data.payload,
        iv: data.iv,
      });
    } else {
      if (typeof data.text !== 'string' || data.text.length > 4000) return;
      socket.to(socket.currentRoom).emit('room-chat-message', {
        senderId: socket.id,
        text: data.text,
        username: data.username || 'Anonymous',
      });
    }
  });

  socket.on('media-state-change', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!checkRateLimit(socket)) return;
    if (!socket.currentRoom || typeof data.type !== 'string' || typeof data.enabled !== 'boolean') return;
    socket.to(socket.currentRoom).emit('media-state-change', {
      senderId: socket.id,
      type: data.type,
      enabled: data.enabled,
    });
  });

  socket.on('typing', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!checkRateLimit(socket)) return;
    if (!socket.currentRoom) return;
    socket.to(socket.currentRoom).emit('typing', {
      senderId: socket.id,
      username: data.username || 'Anonymous',
    });
  });

  socket.on('leave-room', () => {
    leaveCurrentRoom(socket, true);
  });

  socket.on('disconnecting', () => {
    leaveCurrentRoom(socket, true);
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
