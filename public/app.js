import * as filters from './modules/filters.js';
import * as whiteboard from './modules/whiteboard.js';
import * as captions from './modules/captions.js';
import * as stats from './modules/stats.js';

const socket = io();

const ROOM_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const runtimeConfig = window.__VOIP_APP_CONFIG__ || {};
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

function normalizeIceServers(servers) {
  if (!Array.isArray(servers)) return DEFAULT_ICE_SERVERS;

  const normalized = servers
    .map((server) => {
      if (!server || typeof server !== 'object' || !server.urls) return null;
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      const cleanedUrls = urls.map((url) => String(url || '').trim()).filter(Boolean);
      if (!cleanedUrls.length) return null;

      const entry = { urls: cleanedUrls.length === 1 ? cleanedUrls[0] : cleanedUrls };
      if (typeof server.username === 'string' && server.username.trim()) entry.username = server.username.trim();
      if (typeof server.credential === 'string' && server.credential.trim()) entry.credential = server.credential.trim();
      return entry;
    })
    .filter(Boolean);

  return normalized.length ? normalized : DEFAULT_ICE_SERVERS;
}

function hasTurnRelayServer(servers) {
  return Array.isArray(servers) && servers.some((server) => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    return urls.some((url) => String(url || '').toLowerCase().startsWith('turn:'));
  });
}

const rtcConfig = {
  iceServers: normalizeIceServers(runtimeConfig.iceServers),
};

// --- Crypto Utilities for Zero-Knowledge E2EE ---
async function hashPassword(password) {
  if (!password) return '';
  const data = textEncoder.encode(password);
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function deriveChatKey(password, roomId) {
  if (!password) return null;
  const keyMaterial = await window.crypto.subtle.importKey(
    'raw', textEncoder.encode(password), { name: 'PBKDF2' }, false, ['deriveBits', 'deriveKey']
  );
  const salt = textEncoder.encode(roomId || 'default_salt');
  return window.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

function bufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function base64ToBuffer(base64) {
  const binary = window.atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function encryptMessage(key, text) {
  if (!key) return null;
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    textEncoder.encode(text)
  );
  return {
    payload: bufferToBase64(encrypted),
    iv: bufferToBase64(iv)
  };
}

async function decryptMessage(key, encryptedBase64, ivBase64) {
  if (!key) throw new Error('No decryption key available');
  const encrypted = base64ToBuffer(encryptedBase64);
  const iv = base64ToBuffer(ivBase64);
  const decrypted = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    encrypted
  );
  return textDecoder.decode(decrypted);
}
// ------------------------------------------------

const typingUsers = new Set();

function updateTypingIndicator() {
  const typingIndicator = document.getElementById('typingIndicator');
  if (!typingIndicator) return;
  
  if (typingUsers.size === 0) {
    typingIndicator.style.display = 'none';
    typingIndicator.textContent = '';
  } else {
    typingIndicator.style.display = 'block';
    if (typingUsers.size === 1) {
      typingIndicator.textContent = `${Array.from(typingUsers)[0]} is typing...`;
    } else if (typingUsers.size === 2) {
      typingIndicator.textContent = `${Array.from(typingUsers).join(' and ')} are typing...`;
    } else {
      typingIndicator.textContent = 'Multiple people are typing...';
    }
  }
}

const state = {
  e2eeKey: null,
  roomId: '',
  localStream: null,
  rawStream: null,
  audioContext: null,
  audioGraph: null,
  selectedDeviceId: '',
  joining: false,
  leaving: false,
  reconnecting: false,
  peers: new Map(), // peerId -> peerState
  existingPeers: new Set(), // peers already in room when we joined
  username: '',
  audioAnalysers: new Map(), // peerId -> analyser
  videoEnabled: false,
  rawCameraTrack: null,
  screenSharing: false,
  screenAudioContext: null,
  mixedAudioTrack: null,
  tabAudioSource: null,
  micAudioSource: null,
  incomingFiles: new Map(), // fileId -> { fileId, peerId, metadata, chunks, receivedSize }
  recording: false,
  roomPassword: '',
  focusedPeerId: null,
  autoDirectorEnabled: false
};

let mediaRecorder;
let recordedChunks = [];
let recordingAudioContext = null;
let recordingAudioDestination = null;
let recordingAudioSources = new Map();
let speakerPollIntervalId = null;
let activeBlobUrls = [];

const MAX_CHAT_MESSAGES = 200;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const FILE_CHUNK_SIZE = 16 * 1024;
const DATA_CHANNEL_HIGH_WATER = 1024 * 1024;

function getRecordingMimeType() {
  const types = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4'
  ];
  for (const t of types) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) {
      return t;
    }
  }
  return '';
}

function addPeerToRecordingAudio(id, stream) {
  if (!state.recording || !recordingAudioContext || !recordingAudioDestination) return;
  if (recordingAudioContext.state === 'closed') return;
  if (recordingAudioSources.has(id)) return;

  try {
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack && audioTrack.readyState === 'live') {
      const source = recordingAudioContext.createMediaStreamSource(new MediaStream([audioTrack]));
      source.connect(recordingAudioDestination);
      recordingAudioSources.set(id, source);
    }
  } catch (e) {
    console.debug(`Failed to attach audio stream for ${id} to session recording:`, e);
  }
}

async function startRecording() {
  if (state.recording) return;

  try {
    let displayStream = null;
    let videoTrack = null;

    if (state.screenSharing && state.localVideoTrack && state.localVideoTrack.readyState === 'live') {
      videoTrack = state.localVideoTrack;
    } else {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' },
        audio: true
      });
      videoTrack = displayStream.getVideoTracks()[0] || null;
      if (!videoTrack || videoTrack.readyState !== 'live') {
        if (displayStream) displayStream.getTracks().forEach(t => t.stop());
        throw new Error('No live video track selected for recording.');
      }
    }

    // Initialize AudioContext & Destination for full meeting audio mixing
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    recordingAudioContext = new AudioContextCtor();
    if (recordingAudioContext.state === 'suspended') {
      await recordingAudioContext.resume().catch(() => {});
    }
    recordingAudioDestination = recordingAudioContext.createMediaStreamDestination();
    recordingAudioSources.clear();

    // 1. Connect Local Microphone
    const localMic = currentTrack();
    if (localMic && localMic.readyState === 'live') {
      try {
        const micSource = recordingAudioContext.createMediaStreamSource(new MediaStream([localMic]));
        micSource.connect(recordingAudioDestination);
        recordingAudioSources.set('local', micSource);
      } catch (e) {
        console.debug('Failed to connect local mic to recorder:', e);
      }
    }

    // 2. Connect Display/Tab Audio (if provided by getDisplayMedia)
    if (displayStream && displayStream.getAudioTracks().length > 0) {
      try {
        const tabAudioSource = recordingAudioContext.createMediaStreamSource(displayStream);
        tabAudioSource.connect(recordingAudioDestination);
        recordingAudioSources.set('displayTab', tabAudioSource);
      } catch (e) {
        console.debug('Failed to connect display tab audio to recorder:', e);
      }
    }

    // 3. Connect All Remote Peers' Audio Tracks
    state.peers.forEach((peer, peerId) => {
      const audioEl = document.getElementById(`audio-${peerId}`);
      if (audioEl && audioEl.srcObject) {
        addPeerToRecordingAudio(peerId, audioEl.srcObject);
      }
    });

    // Assemble final mixed stream (Video + Mixed Room Audio)
    const mixedAudioTracks = recordingAudioDestination.stream.getAudioTracks();
    const tracksToRecord = [videoTrack];
    if (mixedAudioTracks.length > 0) {
      tracksToRecord.push(mixedAudioTracks[0]);
    }

    const mixedStream = new MediaStream(tracksToRecord);
    state.recording = true;
    recordedChunks = [];

    const mimeType = getRecordingMimeType();
    mediaRecorder = new MediaRecorder(mixedStream, mimeType ? { mimeType } : undefined);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        recordedChunks.push(e.data);
      }
    };

    mediaRecorder.onstop = () => {
      const recordedBlob = new Blob(recordedChunks, { type: mimeType || 'video/webm' });
      if (recordedBlob.size > 0) {
        const url = URL.createObjectURL(recordedBlob);
        const a = document.createElement('a');
        a.href = url;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        a.download = `Session-Recording-${timestamp}.webm`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 1000);
        showToast('Session recording saved and downloaded.', 'success');
      } else {
        showToast('Recording ended (no video/audio captured).', 'warning');
      }

      recordedChunks = [];

      // Disconnect audio sources
      recordingAudioSources.forEach(src => {
        try { src.disconnect(); } catch (e) {}
      });
      recordingAudioSources.clear();

      if (recordingAudioContext && recordingAudioContext.state !== 'closed') {
        recordingAudioContext.close().catch(() => {});
        recordingAudioContext = null;
      }
      recordingAudioDestination = null;

      if (displayStream) {
        displayStream.getTracks().forEach(t => t.stop());
      }
    };

    // Auto-stop recording if user ends display capture via browser bar
    if (displayStream && videoTrack) {
      videoTrack.onended = () => {
        if (state.recording) stopRecording();
      };
    }

    mediaRecorder.start(1000);

    ui.recordBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>`;
    ui.recordBtn.classList.add('danger', 'active');
    showToast('Session recording started. Capturing full room audio & video.', 'info');

  } catch (error) {
    state.recording = false;
    console.warn('Session recording failed or was cancelled:', error);
    if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') {
      showToast('Could not start recording. Check permissions.', 'error');
    } else {
      showToast('Recording cancelled.', 'info');
    }
  }
}

function stopRecording() {
  if (!state.recording) return;
  state.recording = false;

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch (e) {}
  }

  ui.recordBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle></svg>`;
  ui.recordBtn.classList.remove('danger', 'active');
}

async function toggleRecording() {
  if (state.recording) {
    stopRecording();
  } else {
    startRecording();
  }
}

const ui = {
  roomView: document.getElementById('roomView'),
  callView: document.getElementById('callView'),
  usernameInput: document.getElementById('usernameInput'),
  roomInput: document.getElementById('roomInput'),
  passwordInput: document.getElementById('passwordInput'),
  generateLinkBtn: document.getElementById('generateLinkBtn'),
  joinBtn: document.getElementById('joinBtn'),
  hangupBtn: document.getElementById('hangupBtn'),
  muteBtn: document.getElementById('muteBtn'),
  videoBtn: document.getElementById('videoBtn'),
  screenShareBtn: document.getElementById('screenShareBtn'),
  retryMicBtn: document.getElementById('retryMicBtn'),
  copyLinkBtn: document.getElementById('copyLinkBtn'),
  deviceSelect: document.getElementById('deviceSelect'),
  statusText: document.getElementById('statusText'),
  statusDot: document.getElementById('statusDot'),
  micWarningBadge: document.getElementById('micWarningBadge'),
  participantList: document.getElementById('participantList'),
  chatBox: document.getElementById('chatBox'),
  chatInput: document.getElementById('chatInput'),
  sendBtn: document.getElementById('sendBtn'),
  fileInput: document.getElementById('fileInput'),
  attachFileBtn: document.getElementById('attachFileBtn'),
  recordBtn: document.getElementById('recordBtn'),
  toastContainer: document.getElementById('toastContainer'),
  videoContainer: document.getElementById('video-grid'),
  roomChipValue: document.getElementById('roomChipValue'),
  peerCount: document.getElementById('peerCount'),
  socketState: document.getElementById('socketState'),
  midCallDeviceSelect: document.getElementById('midCallDeviceSelect'),
  midCallCameraSelect: document.getElementById('midCallCameraSelect'),
  videoFilterBtn: document.getElementById('videoFilterBtn'),
  whiteboardBtn: document.getElementById('whiteboardBtn'),
  statsBtn: document.getElementById('statsBtn'),
  reactionsToggleBtn: document.getElementById('reactionsToggleBtn'),
  reactionMenu: document.getElementById('reactionMenu'),
  directorBtn: document.getElementById('directorBtn'),
};

function supportsRequiredApis() {
  return Boolean(
    navigator.mediaDevices &&
    navigator.mediaDevices.getUserMedia &&
    navigator.mediaDevices.enumerateDevices &&
    window.RTCPeerConnection
  );
}

function showToast(message, type = 'info', ttl = 4000) {
  window.showToast = showToast;
  const MAX_TOASTS = 8;
  while (ui.toastContainer.children.length >= MAX_TOASTS) {
    ui.toastContainer.firstElementChild.remove();
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  ui.toastContainer.appendChild(toast);

  window.setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    window.setTimeout(() => toast.remove(), 240);
  }, ttl);
}

function setStatus(message, tone = 'info') {
  ui.statusText.textContent = message;
  const toneMap = {
    info: { color: 'var(--accent)', shadow: '0 0 0 4px rgba(59, 130, 246, 0.15)' },
    success: { color: 'var(--success)', shadow: '0 0 0 4px rgba(39, 211, 155, 0.15)' },
    warning: { color: 'var(--warning)', shadow: '0 0 0 4px rgba(247, 201, 72, 0.15)' },
    danger: { color: 'var(--danger)', shadow: '0 0 0 4px rgba(255, 107, 129, 0.16)' },
  };
  const style = toneMap[tone] || toneMap.info;
  ui.statusDot.style.background = style.color;
  ui.statusDot.style.boxShadow = style.shadow;
}

function setSocketStateLabel(value) {
  ui.socketState.textContent = `Socket: ${value}`;
}

function setRoomChip(value) {
  ui.roomChipValue.textContent = value || 'Not joined';
}

function setMode(mode) {
  const isCall = mode === 'call';
  ui.roomView.style.display = isCall ? 'none' : 'flex';
  ui.callView.style.display = isCall ? 'flex' : 'none';
}

function setChatEnabled(enabled) {
  ui.chatInput.disabled = !enabled;
  ui.sendBtn.disabled = !enabled;
}

function setCallControlsEnabled(enabled) {
  ui.videoBtn.disabled = !enabled;
  ui.screenShareBtn.disabled = !enabled;
  ui.recordBtn.disabled = !enabled;
  ui.attachFileBtn.disabled = !enabled || openDataChannelCount() === 0;
  if (ui.videoFilterBtn) ui.videoFilterBtn.disabled = !enabled;
  // whiteboardBtn is always enabled — users can use the whiteboard before peers join
  // if (ui.whiteboardBtn) ui.whiteboardBtn.disabled = !enabled;
  if (ui.ccBtn) ui.ccBtn.disabled = !enabled;
}

function isUsableAudioTrack(track) {
  return Boolean(track && track.kind === 'audio' && track.readyState === 'live');
}

function currentTrack() {
  if (state.screenSharing && state.mixedAudioTrack) {
    return state.mixedAudioTrack;
  }
  const track = state.localStream ? state.localStream.getAudioTracks()[0] : null;
  return isUsableAudioTrack(track) ? track : null;
}

function currentVideoTrack() {
  const track = state.rawStream ? state.rawStream.getVideoTracks()[0] : null;
  return track && track.readyState === 'live' ? track : null;
}

function stopStream(stream) {
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
}

function clearLocalAudioAnalyser() {
  if (!state.audioAnalysers.has('local')) return;
  const analyserData = state.audioAnalysers.get('local');
  if (analyserData) {
    try { analyserData.source.disconnect(); } catch (e) {}
    const participantEl = analyserData.participantEl || document.getElementById('participant-local');
    const videoWrapperEl = analyserData.videoWrapperEl || document.getElementById('video-wrapper-local');
    if (participantEl) participantEl.classList.remove('active-speaker');
    if (videoWrapperEl) videoWrapperEl.classList.remove('active-speaker');
  }
  state.audioAnalysers.delete('local');

  if (speakerPollIntervalId && state.audioAnalysers.size === 0) {
    clearInterval(speakerPollIntervalId);
    speakerPollIntervalId = null;
  }
}


function peerEntries() {
  return [...state.peers.entries()];
}

function openDataChannelCount() {
  return peerEntries().filter(([, peer]) => peer.dataChannel && peer.dataChannel.readyState === 'open').length;
}

function updatePeerCount() {
  const count = state.peers.size;
  ui.peerCount.textContent = count === 1 ? 'Peers: 1' : `Peers: ${count}`;
}

function describePeerConnection(peer) {
  const pcState = peer?.pc?.connectionState || 'new';
  const dcState = peer?.dataChannel?.readyState || 'closed';
  if (pcState === 'connected' && dcState === 'open') return 'Audio and chat ready';
  if (pcState === 'connected') return 'Connected, waiting for chat';
  if (pcState === 'connecting' || pcState === 'new') return 'Connecting...';
  if (pcState === 'failed') return 'Connection failed';
  if (pcState === 'disconnected') return 'Disconnected';
  return 'Negotiating';
}

function describePeerBadge(peer) {
  const pcState = peer?.pc?.connectionState || 'new';
  const dcState = peer?.dataChannel?.readyState || 'closed';
  if (pcState === 'connected' && dcState === 'open') return { label: 'Ready', className: 'audio' };
  if (pcState === 'failed') return { label: 'Error', className: 'error' };
  if (pcState === 'disconnected') return { label: 'Offline', className: 'offline' };
  if (dcState === 'open') return { label: 'Chat', className: 'connecting' };
  return { label: 'Connecting', className: 'connecting' };
}

function updateMuteButton() {
  const track = currentTrack();
  ui.muteBtn.disabled = !track;
  const isEnabled = track && track.enabled;

  if (isEnabled) {
    ui.muteBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
    ui.muteBtn.classList.add('active');
    ui.muteBtn.classList.remove('danger');
  } else {
    ui.muteBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
    ui.muteBtn.classList.remove('active');
    ui.muteBtn.classList.add('danger');
  }

  const localMuteIcon = document.getElementById('mute-icon-local');
  if (localMuteIcon) {
    if (isEnabled) localMuteIcon.classList.add('hidden');
    else localMuteIcon.classList.remove('hidden');
  }
}

function updateMicWarningBadge() {
  const show = Boolean(state.roomId) && !currentTrack();
  ui.micWarningBadge.classList.toggle('is-hidden', !show);
  ui.micWarningBadge.textContent = 'Mic unavailable';
}

function updateRetryButton() {
  if (!state.roomId) {
    ui.retryMicBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`;
    ui.retryMicBtn.disabled = true;
    return;
  }

  ui.retryMicBtn.disabled = false;
  ui.retryMicBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`;
}

function setChatStateFromPeers() {
  const hasOpenDataChannel = openDataChannelCount() > 0;
  setChatEnabled(Boolean(state.roomId));
  ui.attachFileBtn.disabled = !state.roomId || !hasOpenDataChannel;
}

function buildParticipantItem(nameText, statusText, badgeLabel, badgeClass, peerId = 'local', isMuted = false) {
  const item = document.createElement('div');
  item.className = 'participant-item';
  const meta = document.createElement('div');
  meta.className = 'participant-meta';
  const nameEl = document.createElement('div');
  nameEl.className = 'participant-name';
  nameEl.textContent = nameText;
  const statusEl = document.createElement('div');
  statusEl.className = 'participant-status';
  statusEl.textContent = statusText;
  meta.appendChild(nameEl);
  meta.appendChild(statusEl);
  const badgeEl = document.createElement('span');
  badgeEl.className = 'participant-badge ' + badgeClass;
  badgeEl.textContent = badgeLabel;
  item.appendChild(meta);

  const micEl = document.createElement('div');
  micEl.className = 'mic-icon';
  if (isMuted) micEl.classList.add('muted');
  micEl.id = `participant-mic-${peerId}`;

  micEl.innerHTML = `
    <svg class="mic-on" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
    <svg class="mic-off" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
  `;

  item.appendChild(micEl);
  item.appendChild(badgeEl);
  return item;
}

function renderParticipants() {
  const peerIds = [...state.peers.keys()].sort((a, b) => a.localeCompare(b));
  ui.participantList.innerHTML = '';

  const track = currentTrack();
  const isLocalMuted = track ? !track.enabled : true;
  const hasMic = Boolean(track);
  const youItem = buildParticipantItem(state.username || 'You', hasMic ? (isLocalMuted ? 'Muted' : 'Microphone active') : 'Microphone unavailable', hasMic ? 'Ready' : 'No Mic', hasMic ? 'audio' : 'connecting', 'local', isLocalMuted);
  youItem.id = `participant-local`;
  ui.participantList.appendChild(youItem);

  if (!state.roomId) {
    const empty = document.createElement('div');
    empty.className = 'participant-empty';
    empty.textContent = 'Join a room to see participants appear here.';
    ui.participantList.appendChild(empty);
    return;
  }

  if (!peerIds.length) {
    const empty = document.createElement('div');
    empty.className = 'participant-empty';
    empty.textContent = 'Waiting for other participants to join.';
    ui.participantList.appendChild(empty);
    return;
  }

  peerIds.forEach((peerId) => {
    const peer = state.peers.get(peerId);
    const badge = describePeerBadge(peer);

    const isMuted = peer.isAudioMuted || false;
    const item = buildParticipantItem(peer.username || 'Anonymous', describePeerConnection(peer), badge.label, badge.className, peerId, isMuted);
    item.id = `participant-${peerId}`;
    ui.participantList.appendChild(item);
  });
}

function refreshMicUi() {
  updateMuteButton();
  updateMicWarningBadge();
  updateRetryButton();
  refreshRoomStatus();
}

function bindLocalAudioTrackEvents(track) {
  if (!track) return;

  track.onended = () => {
    if (state.localStream?.getAudioTracks()[0] === track) {
      clearLocalAudioAnalyser();
      applyLocalTracksToAllPeers();
      refreshMicUi();
      showToast('Microphone disconnected. You are still in the room without audio.', 'warning');
    }
  };

  track.onmute = () => {
    if (state.localStream?.getAudioTracks()[0] === track) {
      refreshMicUi();
    }
  };

  track.onunmute = () => {
    if (state.localStream?.getAudioTracks()[0] === track) {
      refreshMicUi();
    }
  };
}

function setupAudioAnalyser(stream, id) {
  try {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;

    if (!state.audioContext) {
      state.audioContext = new AudioContextCtor();
    }

    if (state.audioContext.state === 'suspended') {
      state.audioContext.resume().catch(e => console.warn('Could not resume audio context:', e));
    }

    if (state.audioAnalysers.has(id)) {
      try {
        state.audioAnalysers.get(id).source.disconnect();
      } catch (e) {
        console.debug(`Audio source disconnect failed or missing for peer ${id}:`, e);
      }
    }

    const source = state.audioContext.createMediaStreamSource(stream);
    const analyser = state.audioContext.createAnalyser();
    analyser.fftSize = 256; // 128 frequency bins for precise acoustic spectrum resolution
    analyser.smoothingTimeConstant = 0.6; // Smooth spectral decay to prevent stutter between words
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const timeData = new Float32Array(analyser.fftSize);
    const participantEl = document.getElementById(`participant-${id}`);
    const videoWrapperEl = document.getElementById(`video-wrapper-${id}`);

    // Clean initial DOM state (prevent starting marked)
    if (participantEl) participantEl.classList.remove('active-speaker');
    if (videoWrapperEl) videoWrapperEl.classList.remove('active-speaker');

    state.audioAnalysers.set(id, {
      analyser,
      source,
      stream,
      dataArray,
      timeData,
      participantEl,
      videoWrapperEl,
      initTime: Date.now(),
      lastSpeakingTime: 0,
      firstSpeakStart: 0,
      canvasEl: null,
      speakingState: false
    });

    if (!speakerPollIntervalId) {
      speakerPollIntervalId = setInterval(pollActiveSpeakers, 100);
    }
  } catch (error) {
    console.warn('Could not setup audio analyser:', error);
  }
}

function pollActiveSpeakers() {
  if (state.audioAnalysers.size === 0) {
    if (speakerPollIntervalId) {
      clearInterval(speakerPollIntervalId);
      speakerPollIntervalId = null;
    }
    return;
  }

  const now = Date.now();

  state.audioAnalysers.forEach((analyserData, id) => {
    // 1. Verify track availability and mute/enabled status
    let isTrackLiveAndEnabled = false;
    let track = null;

    if (id === 'local') {
      track = currentTrack();
    } else {
      track = analyserData.stream ? analyserData.stream.getAudioTracks()[0] : null;
    }

    isTrackLiveAndEnabled = Boolean(track && track.enabled && !track.muted && track.readyState === 'live');

    let rawSpeaking = false;
    // Skip the first 400ms after connecting to discard initial WebAudio buffer pop / click transient
    const isWarmedUp = (now - analyserData.initTime) > 400;

    if (isTrackLiveAndEnabled && isWarmedUp) {
      const { analyser, dataArray, timeData } = analyserData;

      // Step 1: Compute lightweight Time-Domain RMS volume (Noise Gate)
      let rms = 0;
      if (timeData) {
        analyser.getFloatTimeDomainData(timeData);
        let sumSquares = 0;
        const len = timeData.length;
        for (let i = 0; i < len; i++) {
          sumSquares += timeData[i] * timeData[i];
        }
        rms = Math.sqrt(sumSquares / len);
      }

      // Step 2: Early CPU Optimization - Only compute intensive FFT spectrum if RMS passes the conversational noise gate
      if (!timeData || rms > 0.0025) {
        analyser.getByteFrequencyData(dataArray);
        let voiceSum = 0;
        let voiceBinsCount = 0;
        let peak = 0;
        const binLen = dataArray.length;

        // Filter out Bins 0-1 (low-frequency electrical rumble & DC offset)
        for (let i = 2; i < binLen; i++) {
          const val = dataArray[i];
          voiceSum += val;
          voiceBinsCount++;
          if (val > peak) peak = val;
        }

        const voiceAvg = voiceBinsCount > 0 ? (voiceSum / voiceBinsCount) : 0;
        // Natural speech threshold: gentle enough for normal & quiet talking, rigid enough against room silence
        rawSpeaking = (rms > 0.0025 || !timeData) && peak > 60 && voiceAvg > 22;
      } else {
        rawSpeaking = false; // Silenced by RMS noise gate, saved 100% of FFT computation
      }
    }

    if (rawSpeaking) {
      analyserData.lastSpeakingTime = now;
      if (!analyserData.firstSpeakStart) {
        analyserData.firstSpeakStart = now;
      } else if (state.autoDirectorEnabled && id !== 'local' && (now - analyserData.firstSpeakStart >= 1500)) {
        // AI Auto-Director: automatically transition focus to the active speaker after 1.5s continuous speech
        if (state.focusedPeerId !== id && !state.screenSharing) {
          focusVideo(id);
          showToast(`🤖 AI Director: Focused on active speaker`, 'info', 2000);
        }
      }
    } else {
      analyserData.firstSpeakStart = 0;
    }

    if (!isTrackLiveAndEnabled) {
      analyserData.lastSpeakingTime = 0;
      analyserData.firstSpeakStart = 0;
    }

    // 650ms hangover guarantees smooth continuous glow across natural speaking pauses between words
    const shouldBeMarkedSpeaking = isTrackLiveAndEnabled && isWarmedUp && (rawSpeaking || (now - analyserData.lastSpeakingTime < 650));

    if (analyserData.speakingState !== shouldBeMarkedSpeaking) {
      analyserData.speakingState = shouldBeMarkedSpeaking;

      if (!analyserData.participantEl || !analyserData.participantEl.isConnected) {
        analyserData.participantEl = document.getElementById(`participant-${id}`);
      }
      if (!analyserData.videoWrapperEl || !analyserData.videoWrapperEl.isConnected) {
        analyserData.videoWrapperEl = document.getElementById(id === 'local' ? 'video-wrapper-local' : `video-wrapper-${id}`);
      }

      if (analyserData.participantEl) {
        analyserData.participantEl.classList.toggle('active-speaker', shouldBeMarkedSpeaking);
      }
      if (analyserData.videoWrapperEl) {
        analyserData.videoWrapperEl.classList.toggle('active-speaker', shouldBeMarkedSpeaking);
      }
    }

    renderAudioVisiBar(id, analyserData, shouldBeMarkedSpeaking);
  });
}

const VISI_BAR_TABLE = Array.from({ length: 24 }, (_, i) => {
  const angle = (i * 2 * Math.PI) / 24 - Math.PI / 2;
  return { cos: Math.cos(angle), sin: Math.sin(angle), color: i % 2 === 0 ? '#00f0ff' : '#a3e635' };
});

function renderAudioVisiBar(id, analyserData, shouldBeMarkedSpeaking) {
  if (!analyserData.videoWrapperEl || !analyserData.videoWrapperEl.isConnected) {
    analyserData.videoWrapperEl = document.getElementById(id === 'local' ? 'video-wrapper-local' : `video-wrapper-${id}`);
  }
  const wrapper = analyserData.videoWrapperEl;
  if (!wrapper) return;

  if (!analyserData.canvasEl || !analyserData.canvasEl.isConnected || !analyserData.ctx) {
    analyserData.canvasEl = wrapper.querySelector('.audio-visi-canvas');
    analyserData.ctx = analyserData.canvasEl ? analyserData.canvasEl.getContext('2d') : null;
  }
  const canvas = analyserData.canvasEl;
  const ctx = analyserData.ctx;
  if (!canvas || !ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;

  if (!shouldBeMarkedSpeaking) {
    if (!canvas.dataset.cleared) {
      ctx.clearRect(0, 0, w, h);
      canvas.dataset.cleared = "true";
    }
    return;
  }

  delete canvas.dataset.cleared;
  ctx.clearRect(0, 0, w, h);

  const dataArray = analyserData.dataArray;
  if (!dataArray) return;

  const step = Math.floor((dataArray.length - 2) / 24) || 1;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';

  for (let i = 0; i < 24; i++) {
    const val = dataArray[i * step + 2] || 0;
    const barHeight = Math.max(3, (val / 255) * 20);
    const t = VISI_BAR_TABLE[i];

    ctx.strokeStyle = t.color;
    ctx.beginPath();
    ctx.moveTo(cx + t.cos * 46, cy + t.sin * 46);
    ctx.lineTo(cx + t.cos * (46 + barHeight), cy + t.sin * (46 + barHeight));
    ctx.stroke();
  }
}

function getAudioConstraints(deviceId = '', exactDevice = false) {
  return {
    deviceId: deviceId ? { [exactDevice ? 'exact' : 'ideal']: deviceId } : undefined,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    sampleRate: { ideal: 48000 },
    channelCount: { ideal: 1 },
  };
}

function getVideoConstraints() {
  return {
    width: { ideal: 960 },
    height: { ideal: 540 },
    frameRate: { ideal: 25, max: 25 },
  };
}

function rebuildLocalStream(audioTrack = currentTrack(), videoTrack = state.videoEnabled ? currentVideoTrack() : null) {
  const tracks = [];
  if (isUsableAudioTrack(audioTrack)) tracks.push(audioTrack);
  if (videoTrack && videoTrack.readyState === 'live') tracks.push(videoTrack);
  const nextStream = new MediaStream(tracks);
  state.localStream = nextStream;
  state.rawStream = nextStream;
  return nextStream;
}

// ==========================================
// Threshold-Based Scrollable Overflow Reactive Grid Layout Engine
// ==========================================
function calculateOptimalGrid(n, boxWidth, boxHeight, aspectRatio = 16 / 9, gap = 12, minTileWidth = 0) {
  if (n === 0) return { cols: 1, rows: 1, tileWidth: boxWidth, tileHeight: boxHeight, overflow: false };
  
  let bestCols = 1;
  let bestRows = 1;
  let maxArea = -1;
  let bestWidth = 0;
  let bestHeight = 0;

  // Stage 1: Try to fit entirely inside visible container volume without scrollbars
  for (let c = 1; c <= n; c++) {
    const r = Math.ceil(n / c);
    const totalGapW = (c - 1) * gap;
    const totalGapH = (r - 1) * gap;
    const maxTileW = Math.max(10, (boxWidth - totalGapW) / c);
    const maxTileH = Math.max(10, (boxHeight - totalGapH) / r);

    let tileW = maxTileW;
    let tileH = tileW / aspectRatio;

    if (tileH > maxTileH) {
      tileH = maxTileH;
      tileW = tileH * aspectRatio;
    }

    const area = tileW * tileH;
    if (area > maxArea) {
      maxArea = area;
      bestCols = c;
      bestRows = r;
      bestWidth = tileW;
      bestHeight = tileH;
    }
  }

  // Stage 2: Threshold Activation - Gracefully transition to scrollable grid when frames would become unreadable
  if (minTileWidth > 0 && n > 1 && bestWidth < minTileWidth && bestWidth < boxWidth) {
    let cols = Math.floor((boxWidth + gap) / (minTileWidth + gap));
    if (cols < 1) cols = 1;
    if (cols > n) cols = n;

    const totalGapW = (cols - 1) * gap;
    const tileW = Math.max(10, (boxWidth - totalGapW) / cols);
    const tileH = tileW / aspectRatio;
    const rows = Math.ceil(n / cols);

    return { cols, rows, tileWidth: tileW, tileHeight: tileH, overflow: true };
  }

  return { cols: bestCols, rows: bestRows, tileWidth: bestWidth, tileHeight: bestHeight, overflow: false };
}

// Diff-checking DOM helper to prevent browser layout thrashing & forced reflows
function applyOptimizedTileStyle(el, x, y, width, height, zIndex) {
  const nx = Math.round(x * 10) / 10;
  const ny = Math.round(y * 10) / 10;
  const nw = Math.round(width * 10) / 10;
  const nh = Math.round(height * 10) / 10;

  if (el._gx !== nx || el._gy !== ny || el._gw !== nw || el._gh !== nh || el._gz !== zIndex) {
    el.style.left = `${nx}px`;
    el.style.top = `${ny}px`;
    el.style.width = `${nw}px`;
    el.style.height = `${nh}px`;
    if (el._gz !== zIndex) el.style.zIndex = `${zIndex}`;
    
    el._gx = nx;
    el._gy = ny;
    el._gw = nw;
    el._gh = nh;
    el._gz = zIndex;
  }
  return ny + nh;
}

let gridLayoutRafId = null;
function scheduleVideoGridLayout() {
  if (gridLayoutRafId) return;
  gridLayoutRafId = requestAnimationFrame(() => {
    gridLayoutRafId = null;
    updateVideoGridLayout();
  });
}

let cachedSpacerEl = null;

function updateVideoGridLayout() {
  const container = ui.videoContainer;
  if (!container || !container.isConnected) return;

  const wrappers = Array.from(container.children).filter(el => el.classList.contains('video-wrapper') && el.style.display !== 'none');
  const count = wrappers.length;
  if (count === 0) return;

  const rect = container.getBoundingClientRect();
  const gap = 12;
  const pb = 80; // Space reserved at bottom of stage for audio/video control buttons
  const availWidth = Math.max(100, rect.width - 24);
  const availHeight = Math.max(100, rect.height - pb - 12);
  const startX = 12;
  const startY = 12;

  const isMobile = window.innerWidth <= 640;
  const normalMinThreshold = isMobile ? Math.min(availWidth, 240) : Math.min(availWidth, 280);

  const focusedWrapper = state.focusedPeerId ? document.getElementById(`video-wrapper-${state.focusedPeerId}`) : null;
  const isFocusMode = focusedWrapper && wrappers.includes(focusedWrapper);

  let maxBottom = 0;

  // NORMAL MODE (No focus, or single participant): Evenly distributed, threshold scroll enabled
  if (!isFocusMode || count === 1) {
    const grid = calculateOptimalGrid(count, availWidth, availHeight, 16 / 9, gap, normalMinThreshold);
    const totalGridW = grid.cols * grid.tileWidth + (grid.cols - 1) * gap;
    const totalGridH = grid.rows * grid.tileHeight + (grid.rows - 1) * gap;
    const offsetX = startX + (availWidth - totalGridW) / 2;
    const offsetY = (totalGridH > availHeight) ? startY : startY + (availHeight - totalGridH) / 2;

    wrappers.forEach((el, idx) => {
      const col = idx % grid.cols;
      const row = Math.floor(idx / grid.cols);
      
      const itemsInRow = (row === grid.rows - 1) ? (count - row * grid.cols) : grid.cols;
      const rowWidth = itemsInRow * grid.tileWidth + (itemsInRow - 1) * gap;
      const rowOffsetX = startX + (availWidth - rowWidth) / 2;

      const x = (row === grid.rows - 1 ? rowOffsetX : offsetX) + col * (grid.tileWidth + gap);
      const y = offsetY + row * (grid.tileHeight + gap);

      const bottom = applyOptimizedTileStyle(el, x, y, grid.tileWidth, grid.tileHeight, 1);
      if (bottom > maxBottom) maxBottom = bottom;
    });
  } else {
    // FOCUS MODE: Focused video occupies exactly 60% area, remaining 40% creates scrollable gallery strip
    const isLandscape = availWidth >= availHeight;
    const others = wrappers.filter(w => w !== focusedWrapper);

    if (isLandscape) {
      // Horizontal Split for Landscape Devices (Laptops, Tablets, Monitors)
      const focusBoxW = (availWidth - gap) * 0.6;
      const focusBoxH = availHeight;
      
      let fW = focusBoxW;
      let fH = fW / (16 / 9);
      if (fH > focusBoxH) {
        fH = focusBoxH;
        fW = fH * (16 / 9);
      }
      const fX = startX + (focusBoxW - fW) / 2;
      const fY = startY + (focusBoxH - fH) / 2;

      const fb = applyOptimizedTileStyle(focusedWrapper, fX, fY, fW, fH, 10);
      if (fb > maxBottom) maxBottom = fb;

      const stripBoxW = (availWidth - gap) * 0.4;
      const stripBoxH = availHeight;
      const stripStartX = startX + focusBoxW + gap;
      const stripMinThreshold = Math.min(stripBoxW, 200);

      const grid = calculateOptimalGrid(others.length, stripBoxW, stripBoxH, 16 / 9, gap, stripMinThreshold);
      const totalGridW = grid.cols * grid.tileWidth + (grid.cols - 1) * gap;
      const totalGridH = grid.rows * grid.tileHeight + (grid.rows - 1) * gap;
      const offsetX = stripStartX + (stripBoxW - totalGridW) / 2;
      const offsetY = (totalGridH > stripBoxH) ? startY : startY + (stripBoxH - totalGridH) / 2;

      others.forEach((el, idx) => {
        const col = idx % grid.cols;
        const row = Math.floor(idx / grid.cols);
        
        const itemsInRow = (row === grid.rows - 1) ? (others.length - row * grid.cols) : grid.cols;
        const rowWidth = itemsInRow * grid.tileWidth + (itemsInRow - 1) * gap;
        const rowOffsetX = stripStartX + (stripBoxW - rowWidth) / 2;

        const x = (row === grid.rows - 1 ? rowOffsetX : offsetX) + col * (grid.tileWidth + gap);
        const y = offsetY + row * (grid.tileHeight + gap);

        const ob = applyOptimizedTileStyle(el, x, y, grid.tileWidth, grid.tileHeight, 5);
        if (ob > maxBottom) maxBottom = ob;
      });
    } else {
      // Vertical Split for Portrait Devices (Mobile Phones, Portrait Tablets)
      const focusBoxW = availWidth;
      const focusBoxH = (availHeight - gap) * 0.6;

      let fW = focusBoxW;
      let fH = fW / (16 / 9);
      if (fH > focusBoxH) {
        fH = focusBoxH;
        fW = fH * (16 / 9);
      }
      const fX = startX + (focusBoxW - fW) / 2;
      const fY = startY + (focusBoxH - fH) / 2;

      const fb = applyOptimizedTileStyle(focusedWrapper, fX, fY, fW, fH, 10);
      if (fb > maxBottom) maxBottom = fb;

      const stripBoxW = availWidth;
      const stripBoxH = (availHeight - gap) * 0.4;
      const stripStartY = startY + focusBoxH + gap;
      const stripMinThreshold = Math.min(stripBoxW, 220);

      const grid = calculateOptimalGrid(others.length, stripBoxW, stripBoxH, 16 / 9, gap, stripMinThreshold);
      const totalGridW = grid.cols * grid.tileWidth + (grid.cols - 1) * gap;
      const totalGridH = grid.rows * grid.tileHeight + (grid.rows - 1) * gap;
      const offsetX = startX + (stripBoxW - totalGridW) / 2;
      const offsetY = (totalGridH > stripBoxH) ? stripStartY : stripStartY + (stripBoxH - totalGridH) / 2;

      others.forEach((el, idx) => {
        const col = idx % grid.cols;
        const row = Math.floor(idx / grid.cols);
        
        const itemsInRow = (row === grid.rows - 1) ? (others.length - row * grid.cols) : grid.cols;
        const rowWidth = itemsInRow * grid.tileWidth + (itemsInRow - 1) * gap;
        const rowOffsetX = startX + (stripBoxW - rowWidth) / 2;

        const x = (row === grid.rows - 1 ? rowOffsetX : offsetX) + col * (grid.tileWidth + gap);
        const y = offsetY + row * (grid.tileHeight + gap);

        const ob = applyOptimizedTileStyle(el, x, y, grid.tileWidth, grid.tileHeight, 5);
        if (ob > maxBottom) maxBottom = ob;
      });
    }
  }

  // Update dynamic scroll sentinel so container generates fluid vertical scrollbars when items overflow
  if (!cachedSpacerEl || !cachedSpacerEl.isConnected) {
    cachedSpacerEl = document.getElementById('video-grid-spacer');
    if (!cachedSpacerEl) {
      cachedSpacerEl = document.createElement('div');
      cachedSpacerEl.id = 'video-grid-spacer';
      cachedSpacerEl.style.position = 'absolute';
      cachedSpacerEl.style.width = '1px';
      cachedSpacerEl.style.pointerEvents = 'none';
      cachedSpacerEl.style.visibility = 'hidden';
      ui.videoContainer.appendChild(cachedSpacerEl);
    }
  }
  applyOptimizedTileStyle(cachedSpacerEl, 0, Math.max(rect.height, maxBottom + 24), 1, 1, -1);
}

let videoGridInitialized = false;
function initVideoGridEngine() {
  if (videoGridInitialized || !ui.videoContainer) return;
  videoGridInitialized = true;
  
  if (window.ResizeObserver) {
    new ResizeObserver(() => scheduleVideoGridLayout()).observe(ui.videoContainer);
  } else {
    window.addEventListener('resize', scheduleVideoGridLayout, { passive: true });
  }
  
  new MutationObserver(() => scheduleVideoGridLayout()).observe(ui.videoContainer, {
    childList: true
  });
  
  window.addEventListener('orientationchange', () => {
    setTimeout(scheduleVideoGridLayout, 50);
    setTimeout(scheduleVideoGridLayout, 350);
  }, { passive: true });
}

function unfocusVideo() {
  if (state.focusedPeerId) {
    const wrapper = document.getElementById(`video-wrapper-${state.focusedPeerId}`);
    if (wrapper) wrapper.classList.remove('focused');
    state.focusedPeerId = null;
    scheduleVideoGridLayout();
  }
}

function focusVideo(peerId) {
  if (state.focusedPeerId === peerId) {
    unfocusVideo();
    return;
  }
  unfocusVideo();
  const wrapper = document.getElementById(`video-wrapper-${peerId}`);
  if (wrapper) {
    wrapper.classList.add('focused');
    state.focusedPeerId = peerId;
    scheduleVideoGridLayout();
  }
}

function buildVideoTile(wrapperId, videoId, username, isLocal, focusTargetId) {
  let wrapper = document.getElementById(wrapperId);
  if (wrapper) return wrapper;

  wrapper = document.createElement('div');
  wrapper.className = 'video-wrapper';
  wrapper.id = wrapperId;

  const avatar = document.createElement('div');
  avatar.className = 'avatar-placeholder';
  avatar.textContent = username.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
  avatar.style.position = 'absolute';
  avatar.style.color = 'white';
  avatar.style.fontSize = '2rem';

  const muteIcon = document.createElement('div');
  muteIcon.className = 'video-mute-icon hidden';
  muteIcon.id = isLocal ? 'mute-icon-local' : `mute-icon-${focusTargetId}`;
  if (!isLocal) {
    muteIcon.style.color = 'var(--danger)';
    muteIcon.style.fontWeight = 'bold';
    muteIcon.style.background = 'rgba(0,0,0,0.6)';
    muteIcon.style.padding = '4px';
    muteIcon.style.borderRadius = '50%';
  }
  muteIcon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"></path>${isLocal ? '' : '<path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line>'}</svg>`;

  const nametag = document.createElement('div');
  nametag.className = 'video-nametag';
  if (!isLocal) nametag.id = `nametag-${focusTargetId}`;
  nametag.textContent = isLocal ? (state.username || 'You (Local)') : username;

  const unpinBtn = document.createElement('div');
  unpinBtn.className = 'unpin-btn';
  unpinBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
  unpinBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    unfocusVideo();
  });

  const fsBtn = document.createElement('div');
  fsBtn.className = 'fullscreen-btn';
  fsBtn.title = 'Fullscreen';
  fsBtn.innerHTML = `
    <svg class="fs-expand" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path></svg>
    <svg class="fs-compress" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path></svg>
  `;
  fsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const videoEl = document.getElementById(videoId);
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      if (wrapper.requestFullscreen) {
        wrapper.requestFullscreen().catch(err => console.warn('Fullscreen denied:', err));
      } else if (videoEl && videoEl.webkitEnterFullscreen) {
        videoEl.webkitEnterFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    }
  });

  const visiCanvas = document.createElement('canvas');
  visiCanvas.className = 'audio-visi-canvas';
  visiCanvas.width = 140;
  visiCanvas.height = 140;

  const pipBtn = document.createElement('div');
  pipBtn.className = 'pip-btn';
  pipBtn.title = 'Picture-in-Picture';
  pipBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 19H5V5h7V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"></path></svg>`;
  pipBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const videoEl = document.getElementById(videoId);
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (videoEl && videoEl.srcObject && videoEl.srcObject.getVideoTracks().length > 0) {
        if (videoEl.paused) {
          await videoEl.play().catch(() => {});
        }
        if (videoEl.requestPictureInPicture) {
          await videoEl.requestPictureInPicture();
        } else {
          showToast('PiP is not supported on this device/browser', 'warning', 3000);
        }
      } else {
        showToast('PiP requires an active video track', 'info', 2500);
      }
    } catch (err) {
      console.warn('PiP failed:', err);
      showToast('PiP failed: ' + (err.message || 'Video track not ready'), 'error', 3000);
    }
  });

  const hudBadge = document.createElement('div');
  hudBadge.className = 'latency-badge';
  hudBadge.id = isLocal ? 'hud-badge-local' : `hud-badge-${focusTargetId}`;
  hudBadge.innerHTML = `<span class="optic-dot"></span><span class="hud-text">${isLocal ? '⚡ You (Local)' : '📶 Connecting...'}</span>`;

  wrapper.addEventListener('click', () => {
    focusVideo(focusTargetId);
  });

  if (isLocal) {
    const localVideoEl = document.createElement('video');
    localVideoEl.id = videoId;
    localVideoEl.autoplay = true;
    localVideoEl.playsInline = true;
    localVideoEl.muted = true;
    wrapper.appendChild(localVideoEl);
  }

  wrapper.appendChild(avatar);
  wrapper.appendChild(visiCanvas);
  wrapper.appendChild(muteIcon);
  wrapper.appendChild(nametag);
  wrapper.appendChild(hudBadge);
  wrapper.appendChild(unpinBtn);
  wrapper.appendChild(pipBtn);
  wrapper.appendChild(fsBtn);
  ui.videoContainer.appendChild(wrapper);

  return wrapper;
}

function updateLocalVideoPreview() {
  const videoTrack = state.screenSharing ? state.localVideoTrack : (state.videoEnabled ? currentVideoTrack() : null);
  const wrapper = buildVideoTile('video-wrapper-local', 'video-local', state.username || 'You', true, 'local');
  const localVideoEl = document.getElementById('video-local');
  const avatarPlaceholder = wrapper.querySelector('.avatar-placeholder');
  const visiCanvasEl = wrapper.querySelector('.audio-visi-canvas');

  if (state.screenSharing) {
    localVideoEl.style.transform = 'none';
  } else {
    localVideoEl.style.transform = 'scaleX(-1)';
  }

  if (!videoTrack) {
    localVideoEl.srcObject = null;
    localVideoEl.style.display = 'none';
    if (avatarPlaceholder) avatarPlaceholder.style.display = 'block';
    if (visiCanvasEl) visiCanvasEl.style.display = 'block';
    return;
  }

  localVideoEl.style.display = 'block';
  if (avatarPlaceholder) avatarPlaceholder.style.display = 'none';
  if (visiCanvasEl) visiCanvasEl.style.display = 'none';
  localVideoEl.srcObject = new MediaStream([videoTrack]);
  localVideoEl.play().catch(e => console.warn('Local video auto-play prevented:', e));
}

function refreshRoomStatus() {
  if (!state.roomId) {
    setStatus(socket.connected ? 'Ready to join' : 'Connecting to signaling...', socket.connected ? 'info' : 'warning');
    updateMicWarningBadge();
    updateRetryButton();
    setChatStateFromPeers();
    return;
  }

  const micReady = Boolean(currentTrack());
  const connectedPeers = state.peers.size;
  const openChannels = openDataChannelCount();

  if (connectedPeers === 0) {
    setStatus(micReady ? 'Waiting for participants...' : 'Waiting for participants without microphone...', micReady ? 'info' : 'warning');
  } else if (openChannels > 0) {
    setStatus(micReady ? `Connected to ${connectedPeers} peer${connectedPeers === 1 ? '' : 's'}` : `Connected to ${connectedPeers} peer${connectedPeers === 1 ? '' : 's'} without microphone`, micReady ? 'success' : 'warning');
  } else {
    setStatus(micReady ? 'Peer connections are negotiating...' : 'Peer connections negotiating without microphone...', micReady ? 'info' : 'warning');
  }

  updateMicWarningBadge();
  updateRetryButton();
  setChatStateFromPeers();
  updatePeerCount();
  renderParticipants();
}

function ensureChatEmptyState() {
  if (ui.chatBox.children.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.textContent = 'Join a room to start exchanging messages.';
    ui.chatBox.appendChild(empty);
  }
}

function clearChat() {
  ui.chatBox.innerHTML = '';
  ensureChatEmptyState();
  activeBlobUrls.forEach(url => URL.revokeObjectURL(url));
  activeBlobUrls = [];
}

function pruneOldChatMessages() {
  while (ui.chatBox.children.length >= MAX_CHAT_MESSAGES) {
    const oldest = ui.chatBox.firstElementChild;
    const links = oldest.querySelectorAll('a');
    links.forEach(a => {
      if (a.href && a.href.startsWith('blob:')) {
        URL.revokeObjectURL(a.href);
        const index = activeBlobUrls.indexOf(a.href);
        if (index > -1) activeBlobUrls.splice(index, 1);
      }
    });
    oldest.remove();
  }
}

function playMessageSound() {
  try {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;
    
    if (!state.audioContext) {
      state.audioContext = new AudioContextCtor();
    }
    
    const ctx = state.audioContext;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1200, ctx.currentTime); 
    
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.2, ctx.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.5);
  } catch (e) {
    console.warn('Could not play message sound:', e);
  }
}

function appendMessage(text, isSelf, senderName = '') {
  const placeholder = ui.chatBox.querySelector('.chat-empty');
  if (placeholder) placeholder.remove();

  pruneOldChatMessages();
  
  if (!isSelf) {
    playMessageSound();
    
    // --- Floating Notification Logic ---
    const sidePanel = document.getElementById('sidePanel');
    const chatPanel = document.getElementById('chatPanel');
    const isChatVisible = sidePanel && !sidePanel.classList.contains('collapsed') && chatPanel && !chatPanel.classList.contains('hidden');

    if (!isChatVisible) {
      const shortMsg = text.length > 30 ? text.substring(0, 30) + '...' : text;
      showToast(`New message from ${senderName || 'Someone'}: "${shortMsg}"`, 'info');
      const badge = document.getElementById('chatUnreadBadge');
      if (badge) badge.classList.remove('hidden');
    }
  }

  const el = document.createElement('div');
  el.className = `chat-msg${isSelf ? ' self' : ''}`;

  if (senderName) {
    const nameEl = document.createElement('div');
    nameEl.style.fontSize = '0.75rem';
    nameEl.style.color = 'var(--muted)';
    nameEl.style.marginBottom = '2px';
    nameEl.textContent = senderName;
    el.appendChild(nameEl);
  }

  const textEl = document.createElement('div');
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = text.split(urlRegex);
  
  parts.forEach(part => {
    if (part.match(urlRegex)) {
      const a = document.createElement('a');
      a.href = part;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = part;
      a.style.color = isSelf ? 'white' : 'var(--accent)';
      a.style.textDecoration = 'underline';
      a.style.wordBreak = 'break-all';
      textEl.appendChild(a);
    } else if (part) {
      textEl.appendChild(document.createTextNode(part));
    }
  });

  el.appendChild(textEl);

  ui.chatBox.appendChild(el);
  ui.chatBox.scrollTop = ui.chatBox.scrollHeight;
}

function normalizeRoomName(value) {
  return String(value ?? '').trim();
}

function isValidRoomName(room) {
  return ROOM_PATTERN.test(room);
}

function waitForSocketConnect(timeoutMs = 8000) {
  if (socket.connected) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timerId = window.setTimeout(() => {
      cleanup();
      reject({ ok: false, code: 'socket-timeout', message: 'Timed out waiting for the signaling server.' });
    }, timeoutMs);

    const onConnect = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject({ ok: false, code: 'socket-error', message: 'Could not reach the signaling server.' });
    };

    function cleanup() {
      window.clearTimeout(timerId);
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
    }

    socket.on('connect', onConnect);
    socket.on('connect_error', onError);
  });
}

function requestRoomJoin(payload) {
  return new Promise((resolve, reject) => {
    const timerId = window.setTimeout(() => {
      reject({ ok: false, code: 'join-timeout', message: 'Timed out while joining the room.' });
    }, 8000);

    socket.emit('join-room', payload, (response) => {
      window.clearTimeout(timerId);

      if (!response || typeof response !== 'object') {
        resolve({ ok: true, room: payload.roomId || payload, peers: [] });
        return;
      }

      if (response.ok === false) {
        reject(response);
        return;
      }

      resolve(response);
    });
  });
}

function stopLocalStream() {
  if (state.rawCameraTrack) {
    try { state.rawCameraTrack.stop(); } catch (e) {}
    state.rawCameraTrack = null;
  }
  try {
    filters.processTrack(null);
  } catch (e) {}

  if (state.localStream) {
    state.localStream.getTracks().forEach(track => {
      try { track.stop(); } catch (e) {}
    });
  }
  if (state.rawStream) {
    state.rawStream.getTracks().forEach(track => {
      try { track.stop(); } catch (e) {}
    });
  }
  state.localStream = null;
  state.rawStream = null;

  clearLocalAudioAnalyser();
}

function isInitiatorFor(peerId) {
  if (!socket.id) return false;
  return socket.id.localeCompare(peerId) < 0;
}

function getPeerState(peerId) {
  return state.peers.get(peerId) || null;
}

function syncPeerRoster(peerIds = [], usernames = {}) {
  if (!state.roomId) return;

  const desiredPeers = new Set(
    (Array.isArray(peerIds) ? peerIds : [])
      .filter((peerId) => Boolean(peerId) && peerId !== socket.id)
  );

  if (state.existingPeers.size === 0) {
    desiredPeers.forEach((id) => state.existingPeers.add(id));
  }

  [...state.peers.keys()].forEach((peerId) => {
    if (!desiredPeers.has(peerId)) {
      cleanupPeer(peerId, 'not in room roster');
    }
  });

  desiredPeers.forEach((peerId) => {
    ensurePeer(peerId, usernames[peerId] || 'Anonymous');
  });

  refreshRoomStatus();
}

function attachDataChannel(peerId, channel) {
  const peer = getPeerState(peerId);
  if (!peer) return;

  channel.bufferedAmountLowThreshold = 65536; // 64 KB baseline buffer line
  peer.dataChannel = channel;

  channel.onopen = () => {
    setChatStateFromPeers();
    refreshRoomStatus();

    const track = currentTrack();
    const isAudioEnabled = track ? track.enabled : false;
    try {
      channel.send(JSON.stringify({ type: 'audio-state', enabled: isAudioEnabled }));
      channel.send(JSON.stringify({ type: 'video-state', enabled: state.videoEnabled }));
      if (!state.existingPeers.has(peerId)) {
        const hostCandidates = [socket.id, ...state.existingPeers];
        hostCandidates.sort();
        const isHost = (socket.id === hostCandidates[0]);
        
        if (isHost) {
          const textarea = document.getElementById('wbTextarea');
          if (textarea && textarea.value.trim()) {
            channel.send(JSON.stringify({ type: 'wb-text', content: textarea.value }));
          }
          if (typeof whiteboard.getCanvasDataURL === 'function') {
            const dataURL = whiteboard.getCanvasDataURL();
            if (dataURL) {
              channel.send(JSON.stringify({ type: 'wb-canvas-image', dataURL }));
            }
          }
          if (typeof whiteboard.getActiveEditorMode === 'function') {
            const currentMode = whiteboard.getActiveEditorMode();
            if (currentMode === 'code') {
              channel.send(JSON.stringify({ type: 'wb-editor-mode', mode: 'code' }));
              const currentLang = whiteboard.getActiveLanguage();
              channel.send(JSON.stringify({ type: 'wb-editor-lang', lang: currentLang }));
              const currentStdin = whiteboard.getActiveStdin();
              if (currentStdin.trim()) {
                channel.send(JSON.stringify({ type: 'wb-editor-stdin', content: currentStdin }));
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn('Failed to send initial state:', e);
    }
  };

  channel.onclose = () => {
    if (peer.dataChannel === channel) {
      peer.dataChannel = null;
    }
    setChatStateFromPeers();
    refreshRoomStatus();
    
    for (const [fileId, fileState] of state.incomingFiles.entries()) {
      if (fileState.peerId === peerId) {
        fileState.chunks = []; // Clear buffers for GC
        removeFileProgress(fileId);
        state.incomingFiles.delete(fileId);
      }
    }
  };

  channel.onerror = () => {
    showToast('Data channel error.', 'warning');
  };

  channel.binaryType = 'arraybuffer';

  channel.onmessage = (event) => {
    if (typeof event.data === 'string') {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'audio-state') {
          handleMediaStateChange({ senderId: peerId, type: 'audio', enabled: msg.enabled });
        } else if (msg.type === 'video-state') {
          handleMediaStateChange({ senderId: peerId, type: 'video', enabled: msg.enabled });
        } else if (msg.type === 'wb-draw') {
          whiteboard.handleIncomingDraw(msg);
        } else if (msg.type === 'wb-clear') {
          whiteboard.clearCanvas();
        } else if (msg.type === 'wb-canvas-image') {
          if (typeof whiteboard.loadCanvasImage === 'function') {
            whiteboard.loadCanvasImage(msg.dataURL);
          }
        } else if (msg.type === 'wb-text') {
          const username = peer.username || 'Peer';
          whiteboard.handleIncomingText(msg.content, msg.caretIndex, username, peerId);
        } else if (msg.type === 'wb-cursor') {
          const username = peer.username || 'Peer';
          whiteboard.handleIncomingCursor(peerId, msg, username);
        } else if (msg.type === 'wb-text-cursor') {
          const username = peer.username || 'Peer';
          whiteboard.handleIncomingTextCursor(peerId, msg, username);
        } else if (msg.type === 'wb-editor-mode') {
          whiteboard.handleIncomingEditorMode(msg.mode);
        } else if (msg.type === 'wb-editor-lang') {
          whiteboard.handleIncomingEditorLang(msg.lang);
        } else if (msg.type === 'wb-editor-stdin') {
          whiteboard.handleIncomingStdin(msg.content);
        } else if (msg.type === 'wb-compile-start') {
          whiteboard.handleIncomingCompileStart();
        } else if (msg.type === 'wb-compile-result') {
          whiteboard.handleIncomingCompileResult(msg);
        } else if (msg.type === 'caption') {
          captions.displayCaption(msg.username || 'Peer', msg.text);
        } else if (msg.type === 'reaction') {
          triggerFloatingReaction(peerId, msg.emoji);
        } else if (msg.type === 'file-meta') {
          const fileName = String(msg.name || 'received-file').slice(0, 120);
          const fileSize = Number(msg.size);
          const fileType = String(msg.fileType || 'application/octet-stream').slice(0, 120);
          const fileId = msg.fileId || ('file-' + Math.random().toString(36).substr(2, 9));
          if (!Number.isFinite(fileSize) || fileSize < 0 || fileSize > MAX_FILE_SIZE) {
            showToast('Incoming file was rejected because its metadata is invalid.', 'warning');
            return;
          }
          state.incomingFiles.set(fileId, {
            fileId,
            peerId,
            metadata: { name: fileName, size: fileSize, fileType },
            chunks: [],
            receivedSize: 0
          });
          appendFileProgress(fileId, fileName, fileSize, false, peer.username || 'Anonymous');
          showToast(`Receiving file: ${fileName}...`, 'info');
        }
      } catch (e) {
        console.warn('Failed to parse data channel message:', e);
      }
    } else if (event.data instanceof ArrayBuffer) {
      if (event.data.byteLength < 16) return;
      const fileIdBytes = new Uint8Array(event.data, 0, 16);
      const fileId = textDecoder.decode(fileIdBytes).trim();
      const chunk = event.data.slice(16);

      const fileState = state.incomingFiles.get(fileId);
      if (!fileState) return;

      fileState.chunks.push(chunk);
      fileState.receivedSize += chunk.byteLength;

      updateFileProgress(fileState.fileId, fileState.receivedSize, fileState.metadata.size);

      if (fileState.receivedSize > MAX_FILE_SIZE || fileState.receivedSize > fileState.metadata.size + FILE_CHUNK_SIZE) {
        removeFileProgress(fileState.fileId);
        state.incomingFiles.delete(fileId);
        showToast('Incoming file was cancelled because it exceeded its declared size.', 'warning');
        return;
      }

      if (fileState.receivedSize >= fileState.metadata.size) {
        const blob = new Blob(fileState.chunks, { type: fileState.metadata.fileType });
        const url = URL.createObjectURL(blob);
        activeBlobUrls.push(url);
        removeFileProgress(fileState.fileId);
        appendFileMessage(fileState.metadata.name, url, fileState.metadata.size, false, peer.username || 'Anonymous');
        state.incomingFiles.delete(fileId);
        showToast(`File received: ${fileState.metadata.name}`, 'success');
      }
    }
  };
}

function queueSignalingTask(peerId, task) {
  const peer = state.peers.get(peerId);
  if (!peer) return;

  peer.signalingQueue = peer.signalingQueue.then(task).catch(error => {
    console.error(`Signaling task failed for peer ${peerId}:`, error);
  });
}


function ensurePeerVideoWrapper(peerId, username = 'Peer') {
  buildVideoTile(`video-wrapper-${peerId}`, `video-${peerId}`, username, false, peerId);
}

function ensurePeer(peerId, providedUsername = null) {
  const existingPeer = state.peers.get(peerId);
  const finalUsername = providedUsername || (existingPeer ? existingPeer.username : 'Anonymous');

  if (existingPeer) {
    existingPeer.username = finalUsername;
    const pcState = existingPeer.pc?.connectionState || existingPeer.pc?.signalingState || 'new';
    if (pcState !== 'closed' && pcState !== 'failed') {
      ensurePeerVideoWrapper(peerId, finalUsername);
      return existingPeer;
    }
    cleanupPeer(peerId, 'recreating closed peer');
  }

  ensurePeerVideoWrapper(peerId, finalUsername);

  if (!window.RTCPeerConnection) {
    showToast('WebRTC is unavailable in this browser.', 'error');
    return null;
  }

  const initiator = isInitiatorFor(peerId);
  const peer = {
    pc: new RTCPeerConnection(rtcConfig),
    username: finalUsername,
    dataChannel: null,
    initiator,
    polite: !initiator,
    makingOffer: false,
    ignoreOffer: false,
    signalingQueue: Promise.resolve(),
    iceQueue: [],
  };

  state.peers.set(peerId, peer);
  renderParticipants();

  const pc = peer.pc;

  pc.onicecandidate = (event) => {
    if (!event.candidate || !state.roomId) return;
    socket.emit('ice-candidate', {
      target: peerId,
      candidate: typeof event.candidate.toJSON === 'function' ? event.candidate.toJSON() : event.candidate,
    });
  };

  pc.ontrack = (event) => {
    const isVideo = event.track.kind === 'video';

    if (isVideo) {
      let videoEl = document.getElementById(`video-${peerId}`);
      if (!videoEl) {
        const wrapper = document.getElementById(`video-wrapper-${peerId}`);
        videoEl = document.createElement('video');
        videoEl.id = `video-${peerId}`;
        videoEl.autoplay = true;
        videoEl.playsInline = true;
        videoEl.muted = true;
        videoEl.style.transition = 'opacity 0.2s ease';
        wrapper.insertBefore(videoEl, wrapper.firstChild);
        const avatar = wrapper.querySelector('.avatar-placeholder');
        const visiCanvas = wrapper.querySelector('.audio-visi-canvas');
        if (avatar) avatar.style.display = 'none';
        if (visiCanvas) visiCanvas.style.display = 'none';
      }
      videoEl.srcObject = new MediaStream([event.track]);
      videoEl.play().catch(e => console.warn('Video auto-play prevented:', e));

      event.track.onmute = () => {
        videoEl.style.opacity = '0';
        const wrapper = document.getElementById(`video-wrapper-${peerId}`);
        if (wrapper) {
          const vCanvas = wrapper.querySelector('.audio-visi-canvas');
          if (vCanvas) vCanvas.style.display = 'block';
        }
      };
      event.track.onunmute = () => {
        videoEl.style.opacity = '1';
        const wrapper = document.getElementById(`video-wrapper-${peerId}`);
        if (wrapper) {
          const vCanvas = wrapper.querySelector('.audio-visi-canvas');
          if (vCanvas) vCanvas.style.display = 'none';
        }
      };

    } else {
      let audioEl = document.getElementById(`audio-${peerId}`);
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.id = `audio-${peerId}`;
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        audioEl.style.display = 'none';
        const wrapper = document.getElementById(`video-wrapper-${peerId}`);
        if (wrapper) wrapper.appendChild(audioEl);
        else ui.videoContainer.appendChild(audioEl);
      }
      const safeAudioStream = new MediaStream([event.track]);
      audioEl.srcObject = safeAudioStream;
      audioEl.play().catch(e => console.warn('Audio auto-play prevented:', e));
      setupAudioAnalyser(safeAudioStream, peerId);
      addPeerToRecordingAudio(peerId, safeAudioStream);
    }
  };

  pc.ondatachannel = (event) => {
    attachDataChannel(peerId, event.channel);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      cleanupPeer(peerId, 'connection failed');
      return;
    }

    if (pc.connectionState === 'disconnected') {
      window.setTimeout(() => {
        const current = state.peers.get(peerId);
        if (current && current.pc === pc && pc.connectionState === 'disconnected') {
          cleanupPeer(peerId, 'disconnected timeout');
        }
      }, 15000);
    }

    refreshRoomStatus();
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') {
      console.warn(`ICE failed for peer ${peerId}. Initiating automatic ICE restart...`);
      try {
        if (typeof pc.restartIce === 'function') {
          pc.restartIce();
        } else {
          pc.createOffer({ iceRestart: true }).then(offer => {
            pc.setLocalDescription(offer);
            socket.emit('webrtc-offer', { target: peerId, sdp: offer });
          });
        }
      } catch (err) {
        console.error('ICE restart attempt failed:', err);
        cleanupPeer(peerId, 'ICE network blocked');
      }
    }
  };

  pc.onnegotiationneeded = () => {
    queueSignalingTask(peerId, async () => {
      if (!state.roomId) return;

      const currentPeer = state.peers.get(peerId);
      if (!currentPeer) return;

      try {
        currentPeer.makingOffer = true;
        await pc.setLocalDescription();
        socket.emit('webrtc-offer', {
          target: peerId,
          sdp: pc.localDescription,
        });
      } catch (error) {
        console.error('Negotiation failed:', error);
        showToast('Negotiation failed for a peer connection.', 'error');
      } finally {
        currentPeer.makingOffer = false;
      }
    });
  };

  if (initiator) {
    const channel = pc.createDataChannel('chat');
    attachDataChannel(peerId, channel);
  }

  applyLocalTracksToPeer(peerId);
  refreshRoomStatus();
  return peer;
}

function applyLocalTracksToPeer(peerId) {
  const peer = getPeerState(peerId);
  if (!peer) return;

  const pc = peer.pc;
  if (pc.signalingState === 'closed') return;
  const transceivers = pc.getTransceivers();

  // Identify the correct channels by checking sender and receiver track kinds
  const audioTransceiver = transceivers.find(t => t.receiver?.track?.kind === 'audio' || t.sender?.track?.kind === 'audio');
  const videoTransceiver = transceivers.find(t => t.receiver?.track?.kind === 'video' || t.sender?.track?.kind === 'video');

  // 1. Handle Audio Track
  const audioTrack = currentTrack();
  if (audioTrack) {
    if (audioTransceiver) {
      audioTransceiver.sender.replaceTrack(audioTrack).catch(() => { });

      // Upgrade direction if it got stuck in receive-only mode
      if (audioTransceiver.direction !== 'sendrecv' && audioTransceiver.direction !== 'sendonly') {
        audioTransceiver.direction = 'sendrecv';
      }
    } else {
      try {
        pc.addTrack(audioTrack, state.localStream || new MediaStream());
      } catch (e) {
        console.warn('Failed to add audio track, trying replaceTrack fallback:', e);
        const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
        if (sender) sender.replaceTrack(audioTrack).catch(() => {});
      }
    }
  } else if (audioTransceiver) {
    audioTransceiver.sender.replaceTrack(null).catch(() => { });
    if (audioTransceiver.direction !== 'recvonly' && audioTransceiver.direction !== 'inactive') {
      audioTransceiver.direction = 'recvonly';
    }
  }

  // 2. Handle Video Track
  const videoTrack = state.screenSharing ? state.localVideoTrack : (state.videoEnabled ? currentVideoTrack() : null);
  if (videoTrack) {
    if (videoTransceiver) {
      videoTransceiver.sender.replaceTrack(videoTrack).catch(() => { });

      // Upgrade direction if it got stuck in receive-only mode
      if (videoTransceiver.direction !== 'sendrecv' && videoTransceiver.direction !== 'sendonly') {
        videoTransceiver.direction = 'sendrecv';
      }
    } else {
      try {
        pc.addTrack(videoTrack, state.localStream || new MediaStream());
      } catch (e) {
        console.warn('Failed to add video track, trying replaceTrack fallback:', e);
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) sender.replaceTrack(videoTrack).catch(() => {});
      }
    }

    const currentTransceiver = videoTransceiver || pc.getTransceivers().find(t => t.sender.track === videoTrack);
    if (currentTransceiver && currentTransceiver.sender) {
      try {
        const params = currentTransceiver.sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        if (state.screenSharing) {
          delete params.encodings[0].maxBitrate;
        } else {
          params.encodings[0].maxBitrate = 300000; // 300kbps for webcam
        }
        currentTransceiver.sender.setParameters(params).catch(e => console.warn('Failed to set video parameters:', e));
      } catch (e) {
        console.warn('Failed to get video parameters:', e);
      }
    }
  } else if (videoTransceiver) {
    videoTransceiver.sender.replaceTrack(null).catch(() => { });
    if (videoTransceiver.direction !== 'recvonly' && videoTransceiver.direction !== 'inactive') {
      videoTransceiver.direction = 'recvonly';
    }
  }
}

function applyLocalTracksToAllPeers() {
  peerEntries().forEach(([peerId]) => applyLocalTracksToPeer(peerId));
}



function cleanupPeer(peerId, reason = '', skipRefresh = false) {
  const peer = getPeerState(peerId);
  if (!peer) return;

  state.peers.delete(peerId);
  stats.cleanupPeerStats(peerId);
  whiteboard.cleanupPeerCursor(peerId);

  if (peer.typingTimeout) {
    clearTimeout(peer.typingTimeout);
    const userName = peer.typingUsername || peer.username || 'Someone';
    if (typingUsers.has(userName)) {
      typingUsers.delete(userName);
      updateTypingIndicator();
    }
  }

  for (const [fileId, fileState] of state.incomingFiles.entries()) {
    if (fileState.peerId === peerId) {
      fileState.chunks = []; // Clear buffers for GC
      removeFileProgress(fileId);
      state.incomingFiles.delete(fileId);
    }
  }

  if (peer.dataChannel && peer.dataChannel.readyState !== 'closed') {
    try {
      peer.dataChannel.onmessage = null;
      peer.dataChannel.onopen = null;
      peer.dataChannel.onclose = null;
      peer.dataChannel.onerror = null;
      peer.dataChannel.close();
    } catch (_error) {
      console.debug(`DataChannel close failed for peer ${peerId}:`, _error);
    }
  }

  peer.signalingQueue = Promise.resolve();

  if (peer.pc) {
    try {
      peer.pc.getReceivers().forEach(receiver => {
        if (receiver.track) {
          try { receiver.track.stop(); } catch (e) {}
        }
      });
      peer.pc.getSenders().forEach(sender => {
        if (sender.track && peer.pc.signalingState !== 'closed') {
          try { peer.pc.removeTrack(sender); } catch (e) {}
        }
      });
    } catch (e) {
      console.debug(`Failed to stop tracks/receivers for peer ${peerId}:`, e);
    }
    try {
      peer.pc.onicecandidate = null;
      peer.pc.ontrack = null;
      peer.pc.ondatachannel = null;
      peer.pc.onconnectionstatechange = null;
      peer.pc.oniceconnectionstatechange = null;
      peer.pc.onsignalingstatechange = null;
      peer.pc.onnegotiationneeded = null;
      peer.pc.close();
    } catch (_error) {
      console.debug(`PeerConnection close failed for peer ${peerId}:`, _error);
    }
  }

  if (state.audioAnalysers.has(peerId)) {
    try {
      state.audioAnalysers.get(peerId).source.disconnect();
    } catch (e) {
      console.debug(`Audio source disconnect failed for peer ${peerId}:`, e);
    }
    state.audioAnalysers.delete(peerId);
  }

  const audioEl = document.getElementById(`audio-${peerId}`);
  if (audioEl) {
    audioEl.srcObject = null;
    audioEl.remove();
  }

  const videoWrapper = document.getElementById(`video-wrapper-${peerId}`);
  if (videoWrapper) {
    if (state.focusedPeerId === peerId) {
      unfocusVideo();
    }
    const vEl = document.getElementById(`video-${peerId}`);
    if (vEl) vEl.srcObject = null;
    videoWrapper.remove();
  } else {
    const videoEl = document.getElementById(`video-${peerId}`);
    if (videoEl) {
      videoEl.srcObject = null;
      videoEl.remove();
    }
  }

  for (const [fileId, fileState] of state.incomingFiles.entries()) {
    if (fileState.peerId === peerId) {
      removeFileProgress(fileId);
      state.incomingFiles.delete(fileId);
    }
  }

  if (!skipRefresh) {
    refreshRoomStatus();
  }

  if (reason) {
    console.log(`Peer ${peerId} cleaned up: ${reason}`);
  }
}

function clearAllPeers() {
  [...state.peers.keys()].forEach((peerId) => cleanupPeer(peerId, '', true));
  refreshRoomStatus();
}

function leaveRoom(options = {}) {
  const { keepRoomInput = true, silent = false } = options;
  if (state.leaving) return;
  state.leaving = true;

  if (state.roomId && !silent) {
    socket.emit('leave-room');
  }

  if (state.screenSharing) {
    stopScreenShare();
  }

  if (state.recording) {
    stopRecording();
  }

  // Reset visual filter
  try {
    filters.processTrack(null);
  } catch (e) {
    console.debug('Failed to reset visual filter during leaveRoom:', e);
  }
  const filterDropdown = document.getElementById('filterDropdown');
  if (filterDropdown) {
    filterDropdown.style.display = 'none';
    filterDropdown.classList.add('hidden');
  }

  // Close whiteboard & clear
  const whiteboardContainer = document.getElementById('whiteboardContainer');
  if (whiteboardContainer) {
    whiteboardContainer.style.display = 'none';
    whiteboardContainer.classList.add('hidden');
  }
  if (ui.whiteboardBtn) ui.whiteboardBtn.classList.remove('active');
  try {
    whiteboard.clearCanvas();
    if (typeof whiteboard.cleanup === 'function') {
      whiteboard.cleanup();
    }
  } catch (e) {
    console.debug('Failed to clear canvas or cleanup whiteboard:', e);
  }
  const textarea = document.getElementById('wbTextarea');
  if (textarea) textarea.value = '';

  // Close CC captions
  const ccOverlay = document.getElementById('ccOverlay');
  if (ccOverlay) {
    ccOverlay.style.display = 'none';
    ccOverlay.classList.add('hidden');
  }
  if (ui.ccBtn) {
    ui.ccBtn.classList.remove('active');
    ui.ccBtn.style.color = '';
  }
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    try {
      if (ui.ccBtn && ui.ccBtn.classList.contains('active')) {
        ui.ccBtn.click();
      }
    } catch (e) {
      console.debug('Failed to toggle captions off on leaveRoom:', e);
    }
  }

  // Turn off stats if active
  if (typeof stats.cleanup === 'function') {
    stats.cleanup();
  } else if (ui.statsBtn && ui.statsBtn.classList.contains('active')) {
    ui.statsBtn.click();
  }

  if (typeof captions.cleanup === 'function') {
    captions.cleanup();
  }

  unfocusVideo();
  clearAllPeers();
  stopLocalStream();
  const localWrapper = document.getElementById('video-wrapper-local');
  if (localWrapper) localWrapper.remove();

  state.roomId = '';
  state.roomPassword = '';
  state.selectedDeviceId = '';
  state.videoEnabled = false;
  state.existingPeers.clear();
  
  if (speakerPollIntervalId) {
    clearInterval(speakerPollIntervalId);
    speakerPollIntervalId = null;
  }
  
  state.audioAnalysers.forEach(data => {
    try { data.source.disconnect(); } catch (e) {}
  });
  state.audioAnalysers.clear();

  if (state.audioContext) {
    if (state.audioContext.state !== 'closed') {
      state.audioContext.close().catch(() => {});
    }
    state.audioContext = null;
  }
  ui.videoBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`; ui.videoBtn.classList.remove('active');
  setMode('join');
  setRoomChip('Not joined');
  setChatEnabled(false);
  clearChat();
  renderParticipants();
  ui.muteBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
  ui.muteBtn.classList.remove('active', 'danger');
  ui.muteBtn.disabled = true;
  ui.videoBtn.disabled = true;
  ui.screenShareBtn.disabled = true;
  ui.recordBtn.disabled = true;
  ui.attachFileBtn.disabled = true;
  updateMicWarningBadge();
  updateRetryButton();
  setStatus('Room closed', 'info');

  if (!keepRoomInput) {
    ui.roomInput.value = '';
  }

  setTimeout(() => { state.leaving = false; }, 150);
}

let isAcquiringMedia = false;

async function acquireMicrophone(deviceId = '', options = {}, isRetry = false) {
  if (!isRetry) {
    if (isAcquiringMedia) return false;
    isAcquiringMedia = true;
  }
  const { silent = false, required = false, exactDevice = false, allowFallback = true } = options;
  if (!navigator.mediaDevices?.getUserMedia) {
    if (!silent) {
      showToast('This browser does not support media access.', required ? 'error' : 'warning');
    }
    return false;
  }

  try {
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: getAudioConstraints(deviceId, exactDevice),
      video: false,
    });
    const audioTrack = micStream.getAudioTracks()[0] || null;

    if (!isUsableAudioTrack(audioTrack)) {
      stopStream(micStream);
      throw new Error('No live microphone track was returned.');
    }

    if (state.audioContext?.state === 'suspended') {
      await state.audioContext.resume().catch(() => { });
    }

    const previousAudioTrack = currentTrack();
    state.selectedDeviceId = audioTrack.getSettings()?.deviceId || deviceId || '';

    bindLocalAudioTrackEvents(audioTrack);
    setupAudioAnalyser(new MediaStream([audioTrack]), 'local');
    rebuildLocalStream(audioTrack, state.videoEnabled ? currentVideoTrack() : null);

    if (previousAudioTrack && previousAudioTrack !== audioTrack) {
      previousAudioTrack.stop();
    }

    await populateDevices(state.selectedDeviceId);
    applyLocalTracksToAllPeers();
    refreshMicUi();
    return true;
  } catch (error) {
    const isPermissionError = error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError';

    if (deviceId && allowFallback && !exactDevice && !isPermissionError) {
      if (!silent) {
        showToast('Selected microphone is unavailable. Trying the default device.', 'warning');
      }
      return await acquireMicrophone('', { silent, required, exactDevice: false, allowFallback: false }, true);
    }

    console.warn('Microphone access failed:', error);
    if (!silent) {
      showToast(
        required
          ? 'Microphone access failed. Check browser permissions and hardware.'
          : 'Microphone access failed. You can allow it later from browser settings.',
        required ? 'error' : 'warning'
      );
    }
    await populateDevices(state.selectedDeviceId);
    refreshMicUi();
    return false;
  } finally {
    if (!isRetry) isAcquiringMedia = false;
  }
}

async function acquireLocalMedia(deviceId = '', options = {}) {
  const { silent = false, required = false, exactDevice = false, allowFallback = true } = options;
  return acquireMicrophone(deviceId, { silent, required, exactDevice, allowFallback });
}

async function populateDevices(selectedDeviceId = state.selectedDeviceId) {
  if (!navigator.mediaDevices?.enumerateDevices) {
    ui.deviceSelect.innerHTML = '<option value="">Microphone discovery unavailable</option>';
    ui.deviceSelect.disabled = true;
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioDevices = devices.filter((d) => d.kind === 'audioinput');
    const videoDevices = devices.filter((d) => d.kind === 'videoinput');

    ui.deviceSelect.innerHTML = '';

    if (!audioDevices.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No microphones found';
      ui.deviceSelect.appendChild(option);
      ui.deviceSelect.disabled = true;
    } else {
      ui.deviceSelect.disabled = false;
      const defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = 'Default Microphone';
      ui.deviceSelect.appendChild(defaultOpt);

      audioDevices.forEach(device => {
        if (device.deviceId === 'default' || device.deviceId === 'communications') return;
        const opt = document.createElement('option');
        opt.value = device.deviceId;
        opt.textContent = device.label || `Microphone ${ui.deviceSelect.options.length}`;
        ui.deviceSelect.appendChild(opt);
      });

      const keepValue = ui.deviceSelect.querySelector(`option[value="${selectedDeviceId}"]`) ? selectedDeviceId : '';
      ui.deviceSelect.value = keepValue;

      if (ui.midCallDeviceSelect) {
        ui.midCallDeviceSelect.innerHTML = ui.deviceSelect.innerHTML;
        ui.midCallDeviceSelect.value = keepValue;
      }
    }

    if (ui.midCallCameraSelect) {
      ui.midCallCameraSelect.innerHTML = '';
      const defCamOpt = document.createElement('option');
      defCamOpt.value = '';
      defCamOpt.textContent = 'Default Camera';
      ui.midCallCameraSelect.appendChild(defCamOpt);

      videoDevices.forEach(device => {
        const opt = document.createElement('option');
        opt.value = device.deviceId;
        opt.textContent = device.label || `Camera ${ui.midCallCameraSelect.options.length}`;
        ui.midCallCameraSelect.appendChild(opt);
      });
      if (state.selectedCameraId) ui.midCallCameraSelect.value = state.selectedCameraId;
    }
  } catch (error) {
    console.warn('Failed to enumerate devices:', error);
  }
}

async function joinRoom() {
  if (state.joining) return;

  const roomId = normalizeRoomName(ui.roomInput.value);
  let username = ui.usernameInput.value.trim();
  
  if (!username || username.toLowerCase() === 'anonymous') {
    const randomTag = Math.floor(1000 + Math.random() * 9000);
    username = `Anonymous#${randomTag}`;
    ui.usernameInput.value = username; // Sync the generated tag back to the UI
  }
  
  let password = ui.passwordInput.value || '';

  if (!password) {
    const array = new Uint8Array(16);
    window.crypto.getRandomValues(array);
    password = Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
    ui.passwordInput.value = password;
  }

  if (!roomId) {
    showToast('Enter a room ID.', 'error');
    return;
  }

  if (!isValidRoomName(roomId)) {
    showToast('Room IDs may only contain letters, numbers, dashes, and underscores.', 'error');
    return;
  }

  if (!supportsRequiredApis()) {
    showToast('This browser is missing microphone or WebRTC support.', 'error');
    return;
  }

  state.joining = true;
  state.username = username;
  ui.joinBtn.disabled = true;
  ui.joinBtn.textContent = 'Joining...';
  setStatus('Joining room...', 'info');

  try {
    await waitForSocketConnect();
    await acquireLocalMedia(ui.deviceSelect.value, {
      silent: true,
      exactDevice: Boolean(ui.deviceSelect.value),
      allowFallback: !ui.deviceSelect.value,
    });
    const hashedPassword = await hashPassword(password);
    const result = await requestRoomJoin({ roomId, username, password: hashedPassword });
    state.e2eeKey = await deriveChatKey(password, roomId);

    state.roomPassword = password;
    state.roomId = result.room;
    setRoomChip(state.roomId);
    setMode('call');

    clearAllPeers();
    syncPeerRoster(result.roomPeers || result.peers || [], result.usernames || {});
    applyLocalTracksToAllPeers();
    updateLocalVideoPreview();

    if (!currentTrack()) {
      showToast('Joined without microphone access. You can retry later.', 'warning');
    }

    ui.roomInput.value = state.roomId;
    window.history.pushState({}, '', `?room=${encodeURIComponent(state.roomId)}`);

    refreshRoomStatus();
  } catch (error) {
    console.error('Join failed:', error);
    const code = error?.code || '';

    if (code === 'room-full') {
      showToast(error.message || 'Room is full.', 'error');
    } else if (code === 'invalid-room') {
      showToast(error.message || 'Invalid room ID.', 'error');
    } else if (code === 'invalid-password') {
      showToast(error.message || 'Incorrect room password.', 'error');
    } else if (code === 'rate-limited') {
      showToast(error.message || 'Too many attempts. Wait a moment and try again.', 'warning');
    } else if (code === 'socket-timeout' || code === 'socket-error' || code === 'join-timeout') {
      showToast(error.message || 'Unable to join the room.', 'error');
    } else {
      showToast('Unable to join the room. Check your connection and try again.', 'error');
    }

    clearAllPeers();
    stopLocalStream();
    setMode('join');
    setChatEnabled(false);
    updateMicWarningBadge();
    updateRetryButton();
    renderParticipants();
  } finally {
    state.joining = false;
    ui.joinBtn.disabled = false;
    ui.joinBtn.textContent = 'Initialize Connection';
    updateMuteButton();
    setCallControlsEnabled(Boolean(state.roomId));
    refreshRoomStatus();
  }
}

async function restoreRoomAfterReconnect() {
  if (!state.roomId || state.leaving || state.joining) return;

  state.reconnecting = true;
  setStatus('Restoring room after reconnect...', 'warning');

  try {
    clearAllPeers();
    await waitForSocketConnect();
    const currentPassword = state.roomPassword || ui.passwordInput.value || '';
    const hashedPassword = await hashPassword(currentPassword);
    const result = await requestRoomJoin({ roomId: state.roomId, username: state.username, password: hashedPassword });
    state.e2eeKey = await deriveChatKey(currentPassword, state.roomId);

    syncPeerRoster(result.roomPeers || result.peers || [], result.usernames || {});
    applyLocalTracksToAllPeers();
    refreshRoomStatus();
    showToast('Room restored after reconnect.', 'success');
  } catch (error) {
    console.error('Room restore failed:', error);
    showToast('Reconnected to signaling, but the room could not be restored.', 'error');
    leaveRoom({ keepRoomInput: true, silent: true });
  } finally {
    state.reconnecting = false;
  }
}

async function handleRemoteOffer(data) {
  if (!data?.sender || !data?.sdp || !state.roomId) return;

  const peer = ensurePeer(data.sender);
  if (!peer) return;

  queueSignalingTask(data.sender, async () => {
    const currentPeer = state.peers.get(data.sender);
    if (!currentPeer) return;
    const pc = currentPeer.pc;
    const description = new RTCSessionDescription(data.sdp);
    const offerCollision = description.type === 'offer' && (currentPeer.makingOffer || pc.signalingState !== 'stable');
    currentPeer.ignoreOffer = !currentPeer.polite && offerCollision;

    if (currentPeer.ignoreOffer) return;

    try {
      if (offerCollision) {
        await pc.setLocalDescription({ type: 'rollback' });
      }

      await pc.setRemoteDescription(description);

      while (currentPeer.iceQueue.length > 0) {
        const candidate = currentPeer.iceQueue.shift();
        await pc.addIceCandidate(candidate).catch(e => console.warn(e));
      }

      if (description.type === 'offer') {
        await pc.setLocalDescription();
        socket.emit('webrtc-answer', {
          target: data.sender,
          sdp: pc.localDescription,
        });
      }

      refreshRoomStatus();
    } catch (error) {
      console.error('Failed to handle offer:', error);
      showToast('Failed to process a signaling offer.', 'error');
      cleanupPeer(data.sender, 'offer handling failed');
    }
  });
}

function handleRemoteAnswer(data) {
  if (!data?.sender || !data?.sdp) return;

  queueSignalingTask(data.sender, async () => {
    const peer = state.peers.get(data.sender);
    if (!peer) return;

    try {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

      while (peer.iceQueue.length > 0) {
        const candidate = peer.iceQueue.shift();
        await peer.pc.addIceCandidate(candidate).catch(e => console.warn(e));
      }

      refreshRoomStatus();
    } catch (error) {
      console.error('Failed to handle answer:', error);
      showToast('Failed to process a signaling answer.', 'error');
      cleanupPeer(data.sender, 'answer handling failed');
    }
  });
}

function handleRemoteIce(data) {
  if (!data?.sender || !data?.candidate || typeof data.candidate !== 'object') return;

  const peer = ensurePeer(data.sender);
  if (!peer) return;

  queueSignalingTask(data.sender, async () => {
    const currentPeer = state.peers.get(data.sender);
    if (!currentPeer) return;

    try {
      if (!data.candidate.candidate) return; // Ignore empty candidates
      const candidate = new RTCIceCandidate(data.candidate);
      if (!currentPeer.pc.remoteDescription) {
        currentPeer.iceQueue.push(candidate);
      } else {
        await currentPeer.pc.addIceCandidate(candidate).catch(e => console.warn('Ignored invalid candidate:', e));
      }
    } catch (error) {
      if (!currentPeer.ignoreOffer) {
        console.warn('ICE parsing failed:', error);
      }
    }
  });
}

function broadcastVideoState(enabled) {
  socket.emit('media-state-change', {
    type: 'video',
    enabled: enabled
  });
}

async function sendChatMessage() {
  const MAX_CHAT_LENGTH = 4000;
  const message = ui.chatInput.value.trim();
  if (!message) return;
  if (message.length > MAX_CHAT_LENGTH) {
    showToast('Message is too long. Maximum ' + MAX_CHAT_LENGTH + ' characters.', 'warning');
    return;
  }

  const payload = {
    type: 'chat',
    text: message,
    username: state.username || 'You'
  };

  if (state.e2eeKey) {
    const encrypted = await encryptMessage(state.e2eeKey, JSON.stringify(payload));
    socket.emit('room-chat-message', {
      encrypted: true,
      payload: encrypted.payload,
      iv: encrypted.iv
    });
  } else {
    socket.emit('room-chat-message', payload);
  }

  appendMessage(message, true, state.username || 'You');
  ui.chatInput.value = '';
}

function appendFileProgress(fileId, name, size, isSelf, senderName = '') {
  const placeholder = ui.chatBox.querySelector('.chat-empty');
  if (placeholder) placeholder.remove();

  pruneOldChatMessages();

  const el = document.createElement('div');
  el.id = `progress-${fileId}`;
  el.className = `chat-msg${isSelf ? ' self' : ''}`;

  if (senderName) {
    const nameEl = document.createElement('div');
    nameEl.style.fontSize = '0.75rem';
    nameEl.style.color = 'var(--muted)';
    nameEl.style.marginBottom = '2px';
    nameEl.textContent = senderName;
    el.appendChild(nameEl);
  }

  const fileInfo = document.createElement('div');
  fileInfo.textContent = `⏳ ${name} (${(size / 1024).toFixed(1)} KB)`;
  fileInfo.style.fontSize = '0.9rem';
  fileInfo.style.marginBottom = '4px'; fileInfo.style.color = isSelf ? 'white' : 'inherit';
  el.appendChild(fileInfo);

  const progressContainer = document.createElement('div');
  progressContainer.style.width = '100%';
  progressContainer.style.height = '6px';
  progressContainer.style.backgroundColor = isSelf ? 'rgba(255,255,255,0.3)' : 'var(--border)';
  progressContainer.style.borderRadius = '3px';
  progressContainer.style.overflow = 'hidden';

  const progressBar = document.createElement('div');
  progressBar.className = 'progress-bar-fill';
  progressBar.style.width = '0%';
  progressBar.style.height = '100%';
  progressBar.style.backgroundColor = isSelf ? 'white' : 'var(--accent)';
  progressBar.style.transition = 'width 0.1s linear';

  progressContainer.appendChild(progressBar);
  el.appendChild(progressContainer);

  ui.chatBox.appendChild(el);
  ui.chatBox.scrollTop = ui.chatBox.scrollHeight;
}

function updateFileProgress(fileId, transferredSize, totalSize) {
  const el = document.getElementById(`progress-${fileId}`);
  if (!el) return;
  const progressBar = el.querySelector('.progress-bar-fill');
  if (progressBar) {
    const percent = Math.min(100, Math.round((transferredSize / totalSize) * 100));
    progressBar.style.width = `${percent}%`;
  }
}

function removeFileProgress(fileId) {
  const el = document.getElementById(`progress-${fileId}`);
  if (el) el.remove();
}

function appendFileMessage(name, url, size, isSelf, senderName = '') {
  const placeholder = ui.chatBox.querySelector('.chat-empty');
  if (placeholder) placeholder.remove();

  pruneOldChatMessages();
  
  if (!isSelf) {
    playMessageSound();
    
    // --- Floating Notification Logic ---
    const sidePanel = document.getElementById('sidePanel');
    const chatPanel = document.getElementById('chatPanel');
    const isChatVisible = sidePanel && !sidePanel.classList.contains('collapsed') && chatPanel && !chatPanel.classList.contains('hidden');

    if (!isChatVisible) {
      showToast(`File received from ${senderName || 'Someone'}: ${name}`, 'success');
      const badge = document.getElementById('chatUnreadBadge');
      if (badge) badge.classList.remove('hidden');
    }
  }

  const el = document.createElement('div');
  el.className = `chat-msg${isSelf ? ' self' : ''}`;

  if (senderName) {
    const nameEl = document.createElement('div');
    nameEl.style.fontSize = '0.75rem';
    nameEl.style.color = 'var(--muted)';
    nameEl.style.marginBottom = '2px';
    nameEl.textContent = senderName;
    el.appendChild(nameEl);
  }

  const fileLink = document.createElement('a');
  fileLink.href = url;
  fileLink.download = name;
  fileLink.rel = 'noopener noreferrer';
  fileLink.textContent = `📎 ${name} (${(size / 1024).toFixed(1)} KB)`;
  fileLink.style.color = isSelf ? 'white' : 'var(--accent)'; fileLink.style.textDecoration = 'underline';
  fileLink.style.textDecoration = 'none';
  el.appendChild(fileLink);

  ui.chatBox.appendChild(el);
  ui.chatBox.scrollTop = ui.chatBox.scrollHeight;
}

let isTogglingVideo = false;

function turnOffVideo() {
  if (!state.videoEnabled) return;
  
  const previousVideoTrack = currentVideoTrack();
  state.videoEnabled = false;

  if (state.rawCameraTrack) {
    try { state.rawCameraTrack.stop(); } catch (e) {}
    state.rawCameraTrack = null;
  }

  try {
    filters.processTrack(null);
  } catch (e) {
    console.debug('Failed to reset visual filter on turnOffVideo:', e);
  }

  if (previousVideoTrack && previousVideoTrack !== state.rawCameraTrack) {
    try { previousVideoTrack.stop(); } catch (e) {}
  }

  rebuildLocalStream(currentTrack(), null);
  updateLocalVideoPreview();
  
  ui.videoBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`; 
  ui.videoBtn.classList.remove('active');
  showToast('Camera turned off.', 'info');
  broadcastVideoState(false);
}

async function toggleVideo() {
  if (isTogglingVideo) return;
  isTogglingVideo = true;
  ui.videoBtn.disabled = true;

  try {
    if (state.videoEnabled) {
      turnOffVideo();
    } else {
      if (state.screenSharing) {
        stopScreenShare();
      }

      const cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: getVideoConstraints(),
      });
      let rawVideoTrack = cameraStream.getVideoTracks()[0] || null;
      if (!rawVideoTrack || rawVideoTrack.readyState !== 'live') {
        stopStream(cameraStream);
        throw new Error('No live camera track was returned.');
      }

      if (state.rawCameraTrack && state.rawCameraTrack !== rawVideoTrack) {
        try { state.rawCameraTrack.stop(); } catch (e) {}
      }
      state.rawCameraTrack = rawVideoTrack;

      let videoTrack = await filters.processTrack(rawVideoTrack);

      const previousVideoTrack = currentVideoTrack();
      state.videoEnabled = true;
      rebuildLocalStream(currentTrack(), videoTrack);
      if (previousVideoTrack && previousVideoTrack !== videoTrack && previousVideoTrack !== rawVideoTrack) {
        try { previousVideoTrack.stop(); } catch (e) {}
      }

      videoTrack.onended = () => {
        if (currentVideoTrack() === videoTrack || state.rawCameraTrack === rawVideoTrack) {
          turnOffVideo();
          applyLocalTracksToAllPeers();
        }
      };

      updateLocalVideoPreview();
      ui.videoBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`; 
      ui.videoBtn.classList.add('active');
      showToast('Camera turned on.', 'success');
      broadcastVideoState(true);
    }

    applyLocalTracksToAllPeers();
    refreshRoomStatus();
  } catch (error) {
    console.error('Camera toggle failed:', error);
    state.videoEnabled = false;
    if (state.rawCameraTrack) {
      try { state.rawCameraTrack.stop(); } catch (e) {}
      state.rawCameraTrack = null;
    }
    ui.videoBtn.innerHTML = '<i class="fa-solid fa-video-slash"></i>'; 
    ui.videoBtn.classList.remove('active');
    showToast('Camera access failed. Check permissions.', 'error');
  } finally {
    isTogglingVideo = false;
    ui.videoBtn.disabled = false;
  }
}

async function toggleScreenShare() {
  if (state.screenSharing) {
    stopScreenShare();
  } else {
    if (state.videoEnabled) {
      turnOffVideo();
      applyLocalTracksToAllPeers();
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      showToast('Screen sharing is not supported on this device/browser.', 'error');
      return;
    }
    
    try {
      ui.screenShareBtn.disabled = true;
      showToast('Warning: Please do not share the current tab to prevent severe audio echo.', 'warning');
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 20, max: 20 }
        },
        audio: true,
        surfaceSwitching: "include",
        selfBrowserSurface: "exclude",
        preferCurrentTab: false
      });
      state.screenSharing = true;
      state.localVideoTrack = displayStream.getVideoTracks()[0];
      if (state.localVideoTrack) {
        state.localVideoTrack.contentHint = 'detail';
      }

      const tabAudioTrack = displayStream.getAudioTracks()[0];
      if (tabAudioTrack) {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        state.screenAudioContext = new AudioContextCtor({ latencyHint: 'interactive' });
        const dest = state.screenAudioContext.createMediaStreamDestination();
        
        // Retain references to prevent Chrome Garbage Collection from dropping audio
        state.tabAudioSource = state.screenAudioContext.createMediaStreamSource(new MediaStream([tabAudioTrack]));
        state.tabAudioSource.connect(dest);
        
        const localMic = state.localStream ? state.localStream.getAudioTracks()[0] : null;
        if (localMic && isUsableAudioTrack(localMic)) {
          state.micAudioSource = state.screenAudioContext.createMediaStreamSource(new MediaStream([localMic]));
          state.micAudioSource.connect(dest);
        }
        
        state.mixedAudioTrack = dest.stream.getAudioTracks()[0];
        if (state.mixedAudioTrack) {
          state.mixedAudioTrack.enabled = localMic ? localMic.enabled : true;
        }
      }

      state.localVideoTrack.onended = () => {
        stopScreenShare();
      };

      ui.screenShareBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2m4 0h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2"></path><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
      ui.screenShareBtn.classList.add('danger');
      ui.screenShareBtn.classList.add('active');

      updateLocalVideoPreview();
      applyLocalTracksToAllPeers();
      broadcastVideoState(true);
    } catch (err) {
      console.warn("Screen share failed or cancelled", err);
      showToast('Screen sharing failed or was cancelled.', 'warning');
    } finally {
      ui.screenShareBtn.disabled = false;
    }
  }
}

function stopScreenShare() {
  if (!state.screenSharing) return;
  state.screenSharing = false;
  if (state.localVideoTrack) {
    state.localVideoTrack.stop();
    state.localVideoTrack = null;
  }
  if (state.mixedAudioTrack) {
    state.mixedAudioTrack.stop();
    state.mixedAudioTrack = null;
  }
  if (state.tabAudioSource) {
    state.tabAudioSource.disconnect();
    state.tabAudioSource = null;
  }
  if (state.micAudioSource) {
    state.micAudioSource.disconnect();
    state.micAudioSource = null;
  }
  if (state.screenAudioContext) {
    if (state.screenAudioContext.state !== 'closed') {
      state.screenAudioContext.close().catch(() => {});
    }
    state.screenAudioContext = null;
  }

  ui.screenShareBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`; 
  ui.screenShareBtn.classList.remove('active');
  ui.screenShareBtn.classList.remove('danger');

  updateLocalVideoPreview();
  applyLocalTracksToAllPeers();
  broadcastVideoState(false);
}

function toggleMute() {
  const track = currentTrack();
  if (!track) {
    showToast('Microphone disconnected. Attempting to restore...', 'warning');
    retryMicAccess();
    return;
  }

  track.enabled = !track.enabled;

  if (track === state.mixedAudioTrack && state.localStream) {
    const mic = state.localStream.getAudioTracks()[0];
    if (mic) mic.enabled = track.enabled;
  }

  updateMuteButton();
  refreshRoomStatus();
  showToast(track.enabled ? 'Microphone unmuted.' : 'Microphone muted.', 'info', 1800);

  if (typeof captions.syncMuteState === 'function') {
    captions.syncMuteState(!track.enabled);
  }

  socket.emit('media-state-change', {
    type: 'audio',
    enabled: track.enabled
  });
}

async function retryMicAccess() {
  if (!state.roomId) return;

  ui.retryMicBtn.disabled = true;

  try {
    await acquireLocalMedia(ui.deviceSelect.value, {
      required: true,
      silent: true,
      exactDevice: Boolean(ui.deviceSelect.value),
      allowFallback: false,
    });
    const micReady = Boolean(currentTrack());
    if (micReady) {
      applyLocalTracksToAllPeers();
      showToast('Microphone connected.', 'success');
    } else {
      showToast('Microphone is still unavailable. Check browser permissions or choose another device.', 'warning');
    }
    refreshRoomStatus();
  } finally {
    updateRetryButton();
  }
}

async function copyInviteLink() {
  const url = new URL(window.location.href);
  const room = state.roomId || normalizeRoomName(ui.roomInput.value);
  const pwd = ui.passwordInput.value;
  
  url.search = ''; 
  const hashParams = new URLSearchParams();
  if (room) hashParams.set('room', room);
  if (pwd) hashParams.set('pwd', pwd);
  url.hash = hashParams.toString();

  try {
    await navigator.clipboard.writeText(url.toString());
    showToast('Invite link copied.', 'success');
  } catch (_error) {
    const fallback = document.createElement('textarea');
    fallback.value = url.toString();
    fallback.style.position = 'fixed';
    fallback.style.opacity = '0';
    document.body.appendChild(fallback);
    fallback.focus();
    fallback.select();
    try {
      document.execCommand('copy');
      showToast('Invite link copied.', 'success');
    } catch (copyError) {
      console.error('Clipboard copy failed:', copyError);
      showToast('Unable to copy the invite link.', 'error');
    } finally {
      fallback.remove();
    }
  }
}

function initializeFromQuery() {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.substring(1) : window.location.hash;
  const hashParams = new URLSearchParams(hash);
  const queryParams = new URLSearchParams(window.location.search);
  
  const roomFromUrl = hashParams.get('room') || queryParams.get('room');
  const pwdFromUrl = hashParams.get('pwd') || queryParams.get('pwd');
  
  if (roomFromUrl) {
    ui.roomInput.value = roomFromUrl;
  }
  if (pwdFromUrl) {
    ui.passwordInput.value = pwdFromUrl;
  }
  setRoomChip(ui.roomInput.value || 'Not joined');
}

window.addEventListener('hashchange', initializeFromQuery);
window.addEventListener('popstate', initializeFromQuery);

socket.on('connect', () => {
  setSocketStateLabel('connected');
  if (state.reconnecting && state.roomId) {
    restoreRoomAfterReconnect();
  } else {
    refreshRoomStatus();
  }
});

socket.on('disconnect', (reason) => {
  setSocketStateLabel('disconnected');
  if (reason !== 'io client disconnect') {
    setStatus('Signaling disconnected', 'warning');
    if (state.roomId && !state.leaving) {
      state.reconnecting = true;
    }
  }
});

socket.on('connect_error', (error) => {
  console.error('Socket connection error:', error);
  setSocketStateLabel('error');
  setStatus('Socket connection error', 'danger');
});

socket.on('peer-joined', async ({ peerId, username }) => {
  if (!peerId || peerId === socket.id || !state.roomId) return;
  
  if (state.peers.has(peerId)) {
    cleanupPeer(peerId, 'peer reconnected');
    // Yield execution control to let the browser clear the old hardware pipeline
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  ensurePeer(peerId, username);

  if (currentTrack()) {
    socket.emit('media-state-change', { type: 'audio', enabled: currentTrack().enabled });
  }
  socket.emit('media-state-change', { type: 'video', enabled: state.videoEnabled || state.screenSharing });
});

socket.on('peer-disconnected', ({ peerId }) => {
  if (!peerId) return;
  cleanupPeer(peerId, 'peer left');
  showToast('A participant left the room.', 'info');
});

socket.on('room-state', ({ room, peers, usernames, peerCount }) => {
  if (!room || room !== state.roomId) return;
  syncPeerRoster(peers || [], usernames || {});
  if (typeof peerCount === 'number') {
    updatePeerCount();
  }
});

socket.on('webrtc-offer', handleRemoteOffer);
socket.on('webrtc-answer', handleRemoteAnswer);
socket.on('ice-candidate', handleRemoteIce);

socket.on('room-chat-message', async (data) => {
  if (data && data.encrypted) {
    if (!state.e2eeKey) {
      return; // Drop message if we have no key
    }
    
    let decryptedText = null;
    let attempts = 0;
    while (attempts < 3) {
      try {
        decryptedText = await decryptMessage(state.e2eeKey, data.payload, data.iv);
        break;
      } catch (e) {
        attempts++;
        if (attempts < 3) {
          await new Promise(r => setTimeout(r, 500));
        }
      }
    }
    
    if (decryptedText) {
      try {
        const msg = JSON.parse(decryptedText);
        appendMessage(msg.text, false, msg.username || 'Anonymous');
        
        // Remove sender from typing list immediately on message arrival
        const senderUsername = msg.username;
        if (senderUsername && typingUsers.has(senderUsername)) {
          typingUsers.delete(senderUsername);
          updateTypingIndicator();
        }
        if (data.senderId) {
          const peer = state.peers.get(data.senderId);
          if (peer && peer.typingTimeout) {
            clearTimeout(peer.typingTimeout);
            peer.typingTimeout = null;
          }
        }
      } catch (e) {
        // Drop malformed JSON
      }
    } else {
      appendMessage(`[Encrypted Payload] ${data.payload}`, false, 'Unknown (Decryption Failed)');
    }
  } else if (data && data.text) {
    appendMessage(data.text, false, data.username || 'Anonymous');
    
    // Remove sender from typing list immediately on message arrival
    const senderUsername = data.username;
    if (senderUsername && typingUsers.has(senderUsername)) {
      typingUsers.delete(senderUsername);
      updateTypingIndicator();
    }
    if (data.senderId) {
      const peer = state.peers.get(data.senderId);
      if (peer && peer.typingTimeout) {
        clearTimeout(peer.typingTimeout);
        peer.typingTimeout = null;
      }
    }
  }
});

function handleMediaStateChange(data) {
  if (!data || !data.senderId || !data.type) return;
  const peerId = data.senderId;
  const peer = state.peers.get(peerId);
  if (!peer) return;

  if (data.type === 'audio') {
    peer.isAudioMuted = !data.enabled;
    const muteIcon = document.getElementById(`mute-icon-${peerId}`);
    if (muteIcon) {
      if (data.enabled) muteIcon.classList.add('hidden');
      else muteIcon.classList.remove('hidden');
    }
    const participantMic = document.getElementById(`participant-mic-${peerId}`);
    if (participantMic) {
      if (data.enabled) {
        participantMic.classList.remove('muted');
      } else {
        participantMic.classList.add('muted');
      }
    }
  } else if (data.type === 'video') {
    const videoEl = document.getElementById(`video-${peerId}`);
    const wrapper = document.getElementById(`video-wrapper-${peerId}`);
    if (videoEl && wrapper) {
      const avatar = wrapper.querySelector('.avatar-placeholder');
      const visiCanvas = wrapper.querySelector('.audio-visi-canvas');
      if (data.enabled) {
        videoEl.style.opacity = '1';
        if (avatar) avatar.style.display = 'none';
        if (visiCanvas) visiCanvas.style.display = 'none';
      } else {
        videoEl.style.opacity = '0';
        if (avatar) avatar.style.display = 'block';
        if (visiCanvas) visiCanvas.style.display = 'block';
      }
    }
  }
}

socket.on('media-state-change', handleMediaStateChange);

socket.on('typing', (data) => {
  if (!data || !data.senderId) return;
  const peerId = data.senderId;
  const peer = state.peers.get(peerId);
  if (!peer) return;

  const userName = data.username || peer.username || 'Someone';
  peer.typingUsername = userName;
  typingUsers.add(userName);
  updateTypingIndicator();
  
  clearTimeout(peer.typingTimeout);
  peer.typingTimeout = setTimeout(() => {
    typingUsers.delete(userName);
    updateTypingIndicator();
    peer.typingTimeout = null;
  }, 3000);
});

initVideoGridEngine();
ui.joinBtn.addEventListener('click', joinRoom);
if (ui.generateLinkBtn) {
  ui.generateLinkBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const genId = (len) => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
      const array = new Uint32Array(len);
      window.crypto.getRandomValues(array);
      let result = '';
      for (let i = 0; i < len; i++) {
        result += chars[array[i] % chars.length];
      }
      return result;
    };
    ui.roomInput.value = genId(16);
    ui.passwordInput.value = genId(16);
    showToast('Secure credentials generated!', 'success');
  });
}
ui.hangupBtn.addEventListener('click', () => leaveRoom({ keepRoomInput: true }));
ui.muteBtn.addEventListener('click', toggleMute);
ui.videoBtn.addEventListener('click', toggleVideo);
ui.screenShareBtn.addEventListener('click', toggleScreenShare);
ui.retryMicBtn.addEventListener('click', retryMicAccess);
ui.copyLinkBtn.addEventListener('click', copyInviteLink);
ui.sendBtn.addEventListener('click', sendChatMessage);
ui.attachFileBtn.addEventListener('click', () => ui.fileInput.click());

if (ui.directorBtn) {
  ui.directorBtn.addEventListener('click', () => {
    state.autoDirectorEnabled = !state.autoDirectorEnabled;
    ui.directorBtn.classList.toggle('active', state.autoDirectorEnabled);
    showToast(
      state.autoDirectorEnabled ? '🤖 AI Auto-Director ENABLED (Auto-focusing active speakers)' : '🤖 AI Auto-Director DISABLED',
      state.autoDirectorEnabled ? 'success' : 'info'
    );
  });
}

if (ui.reactionsToggleBtn && ui.reactionMenu) {
  ui.reactionsToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    ui.reactionMenu.classList.toggle('open');
  });

  document.addEventListener('click', (e) => {
    if (ui.reactionMenu && !ui.reactionMenu.contains(e.target) && e.target !== ui.reactionsToggleBtn) {
      ui.reactionMenu.classList.remove('open');
    }
  });

  ui.reactionMenu.querySelectorAll('.emoji-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const emoji = e.currentTarget.dataset.emoji || e.currentTarget.textContent.trim();
      triggerFloatingReaction('local', emoji);
      broadcastDataChannelMessage({ type: 'reaction', emoji });
      ui.reactionMenu.classList.remove('open');
    });
  });
}

function triggerFloatingReaction(targetId, emoji) {
  const wrapper = document.getElementById(targetId === 'local' ? 'video-wrapper-local' : `video-wrapper-${targetId}`);
  if (!wrapper) return;

  const el = document.createElement('div');
  el.className = 'reaction-particle';
  el.textContent = emoji;
  const drift = Math.floor((Math.random() - 0.5) * 80);
  const rot = Math.floor((Math.random() - 0.5) * 40);
  el.style.setProperty('--drift', `${drift}px`);
  el.style.setProperty('--rot', `${rot}deg`);
  wrapper.appendChild(el);

  setTimeout(() => {
    if (el && el.parentElement) {
      el.remove();
    }
  }, 2200);
}

// Smart Eco-Bandwidth & Telemetry HUD Engine
setInterval(() => {
  if (state.peers.size === 0) return;

  state.peers.forEach(async (peer, peerId) => {
    if (!peer.pc || peer.pc.connectionState !== 'connected') return;

    try {
      const stats = await peer.pc.getStats();
      let rtt = 0;

      stats.forEach((stat) => {
        if (stat.type === 'candidate-pair' && (stat.state === 'succeeded' || stat.selected || stat.nominated)) {
          if (stat.currentRoundTripTime !== undefined) {
            rtt = Math.round(stat.currentRoundTripTime * 1000);
          } else if (stat.roundTripTime !== undefined) {
            rtt = Math.round(stat.roundTripTime * 1000);
          }
        }
        if ((stat.type === 'remote-inbound-rtp' || stat.type === 'remote-outbound-rtp') && stat.roundTripTime !== undefined && rtt === 0) {
          rtt = Math.round(stat.roundTripTime * 1000);
        }
      });

      // Update real-time HUD Badge with zero DOM query overhead
      if (!peer.hudTextEl || !peer.hudTextEl.isConnected || !peer.hudDotEl || !peer.hudDotEl.isConnected) {
        const hudEl = document.getElementById(`hud-badge-${peerId}`);
        if (hudEl) {
          peer.hudTextEl = hudEl.querySelector('.hud-text') || hudEl.querySelector('span:last-child');
          peer.hudDotEl = hudEl.querySelector('.optic-dot');
        }
      }

      if (peer.hudTextEl) {
        peer.hudTextEl.textContent = rtt > 0 ? `📶 ${rtt}ms RTT` : '🟢 Connected';
      }
      if (peer.hudDotEl) {
        peer.hudDotEl.className = 'optic-dot' + (rtt > 250 ? ' bad' : rtt > 120 ? ' warn' : '');
      }

      // Smart Eco-Bandwidth Dynamic Simulcast Adaptation
      const videoSender = peer.pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (videoSender && typeof videoSender.getParameters === 'function') {
        const params = videoSender.getParameters();
        if (params && params.encodings && params.encodings.length > 0) {
          const encoding = params.encodings[0];
          const shouldBeEco = (rtt > 220) || (state.peers.size >= 4);

          if (shouldBeEco && !peer.isEcoMode) {
            peer.isEcoMode = true;
            encoding.maxBitrate = 280000;
            encoding.scaleResolutionDownBy = 2;
            videoSender.setParameters(params).catch(() => {});
            showToast(`🌱 Eco-Bandwidth: Auto-adapted video stream for ${peer.username} to prevent lag`, 'warning', 3000);
          } else if (!shouldBeEco && peer.isEcoMode && rtt < 150) {
            peer.isEcoMode = false;
            delete encoding.maxBitrate;
            encoding.scaleResolutionDownBy = 1;
            videoSender.setParameters(params).catch(() => {});
            showToast(`⚡ High-Performance Mode restored for ${peer.username}`, 'success', 2500);
          }
        }
      }
    } catch (e) {
      // Ignore transient stats fetching glitches
    }
  });
}, 2500);

function sendFileToPeer(peerId, file, fileId, callbacks) {
  const peer = getPeerState(peerId);
  if (!peer || !peer.dataChannel || peer.dataChannel.readyState !== 'open') {
    callbacks.onFinished();
    return;
  }

  const channel = peer.dataChannel;
  let offset = 0;
  const reader = new FileReader();

  // Pre-encode file ID header once to avoid TextEncoder instantiations in the loop
  const fileIdStr = fileId.padEnd(16, ' ');
  const fileIdBytes = textEncoder.encode(fileIdStr);

  reader.onload = (e) => {
    if (channel.readyState !== 'open') {
      callbacks.onFinished();
      return;
    }
    const chunk = e.target.result;
    const chunkWithHeader = new Uint8Array(16 + chunk.byteLength);
    chunkWithHeader.set(fileIdBytes, 0);
    chunkWithHeader.set(new Uint8Array(chunk), 16);

    try {
      channel.send(chunkWithHeader.buffer);
    } catch (err) {
      console.warn(`Failed to send chunk to peer ${peerId}:`, err);
      callbacks.onFinished();
      return;
    }

    offset += chunk.byteLength;
    callbacks.onProgress(offset);

    if (offset < file.size) {
      readNextSlice();
    } else {
      callbacks.onFinished();
    }
  };

  reader.onerror = () => {
    console.error(`Could not read file for peer ${peerId}`);
    callbacks.onFinished();
  };

  const readNextSlice = () => {
    if (channel.readyState !== 'open') {
      callbacks.onFinished();
      return;
    }

    if (channel.bufferedAmount > DATA_CHANNEL_HIGH_WATER) {
      const resumeTransfer = () => {
        channel.onbufferedamountlow = null;
        channel.removeEventListener('close', resumeTransfer);
        readNextSlice();
      };
      channel.onbufferedamountlow = resumeTransfer;
      channel.addEventListener('close', resumeTransfer, { once: true });
      return;
    }

    const slice = file.slice(offset, offset + FILE_CHUNK_SIZE);
    reader.readAsArrayBuffer(slice);
  };

  readNextSlice();
}

ui.fileInput.addEventListener('change', () => {
  const file = ui.fileInput.files[0];
  if (!file) return;
  ui.fileInput.value = '';

  if (file.size > MAX_FILE_SIZE) {
    showToast('File size must be less than 50MB.', 'warning');
    return;
  }
  if (file.size === 0) {
    showToast('Cannot send empty files.', 'warning');
    return;
  }

  const targetPeers = [];
  peerEntries().forEach(([peerId, peer]) => {
    if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
      targetPeers.push(peerId);
    }
  });

  if (!targetPeers.length) {
    showToast('No connected peers are ready for file transfer.', 'warning');
    return;
  }

  const fileId = 'file-' + Math.random().toString(36).substr(2, 9);
  const meta = { type: 'file-meta', fileId, name: file.name.slice(0, 120), size: file.size, fileType: file.type || 'application/octet-stream' };
  
  targetPeers.forEach(peerId => {
    const peer = getPeerState(peerId);
    if (peer && peer.dataChannel) {
      try {
        peer.dataChannel.send(JSON.stringify(meta));
      } catch (error) {
        console.error(`Failed to send file metadata to peer ${peerId}:`, error);
      }
    }
  });

  appendFileProgress(fileId, file.name, file.size, true, state.username || 'You');

  const pendingPeers = new Set(targetPeers);
  let maxOffset = 0;

  targetPeers.forEach(peerId => {
    sendFileToPeer(peerId, file, fileId, {
      onProgress: (offset) => {
        if (offset > maxOffset) {
          maxOffset = offset;
          updateFileProgress(fileId, maxOffset, file.size);
        }
      },
      onFinished: () => {
        pendingPeers.delete(peerId);
        if (pendingPeers.size === 0) {
          removeFileProgress(fileId);
          const url = URL.createObjectURL(file);
          activeBlobUrls.push(url);
          appendFileMessage(file.name, url, file.size, true, state.username || 'You');
          showToast('File sent to all peers.', 'success');
        }
      }
    });
  });
});
ui.recordBtn.addEventListener('click', toggleRecording);
ui.chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    sendChatMessage();
  }
});

let typingTimer = null;
ui.chatInput.addEventListener('input', () => {
  if (typingTimer) return;
  socket.emit('typing', { username: state.username || 'You' });
  typingTimer = setTimeout(() => {
    typingTimer = null;
  }, 2000);
});
if (ui.midCallDeviceSelect) {
  ui.midCallDeviceSelect.addEventListener('change', () => {
    ui.deviceSelect.value = ui.midCallDeviceSelect.value;
    ui.deviceSelect.dispatchEvent(new Event('change'));
  });
}

if (ui.midCallCameraSelect) {
  ui.midCallCameraSelect.addEventListener('change', async () => {
    if (isAcquiringMedia) return;
    state.selectedCameraId = ui.midCallCameraSelect.value;
    if (state.videoEnabled) {
      isAcquiringMedia = true;
      try {
        const cameraStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: getVideoConstraints(),
        });
        let rawVideoTrack = cameraStream.getVideoTracks()[0] || null;
        if (rawVideoTrack) {
          if (state.rawCameraTrack && state.rawCameraTrack !== rawVideoTrack) {
            try { state.rawCameraTrack.stop(); } catch (e) {}
          }
          state.rawCameraTrack = rawVideoTrack;

          let videoTrack = await filters.processTrack(rawVideoTrack);
          const previousVideoTrack = currentVideoTrack();
          rebuildLocalStream(currentTrack(), videoTrack);
          updateLocalVideoPreview();
          applyLocalTracksToAllPeers();
          if (previousVideoTrack && previousVideoTrack !== videoTrack && previousVideoTrack !== rawVideoTrack) {
            try { previousVideoTrack.stop(); } catch (e) {}
          }
          showToast('Camera switched successfully.', 'success');
        }
      } catch (e) {
        console.error('Failed to switch camera:', e);
        showToast('Failed to access selected camera.', 'error');
      } finally {
        isAcquiringMedia = false;
      }
    }
  });
}

ui.deviceSelect.addEventListener('change', async () => {
  const previousTrack = currentTrack();
  const previousDeviceId = state.selectedDeviceId;
  const requestedDeviceId = ui.deviceSelect.value;
  await acquireLocalMedia(ui.deviceSelect.value, {
    silent: true,
    exactDevice: Boolean(ui.deviceSelect.value),
    allowFallback: false,
  });
  const micReady = Boolean(currentTrack());
  const activeLabel = ui.deviceSelect.options[ui.deviceSelect.selectedIndex]?.textContent || 'active microphone';
  if (micReady && state.roomId) {
    applyLocalTracksToAllPeers();
  }

  if (!micReady) {
    showToast('Microphone unavailable. You are still connected without audio.', 'warning');
  } else if (requestedDeviceId && requestedDeviceId === previousDeviceId) {
    showToast('This microphone is already active.', 'info');
  } else if (previousTrack && currentTrack() === previousTrack) {
    showToast('Could not switch microphones. Continuing with the current microphone.', 'warning');
  } else {
    showToast(`Microphone switched to ${activeLabel}.`, 'success');
  }
});

window.addEventListener('beforeunload', () => {
  leaveRoom({ keepRoomInput: true, silent: false });
});

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    try {
      await populateDevices(state.localStream ? state.selectedDeviceId : '');
      refreshRoomStatus();
    } catch (error) {
      console.error('Device refresh failed:', error);
    }
  });
}

function broadcastDataChannelMessage(payload) {
  const json = JSON.stringify(payload);
  state.peers.forEach(peer => {
    if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
      try {
        peer.dataChannel.send(json);
      } catch (e) {
        console.warn('Failed to send data channel message:', e);
      }
    }
  });
}

// Initialize modules
filters.init((nextTrack) => {
  rebuildLocalStream(currentTrack(), nextTrack);
  updateLocalVideoPreview();
  applyLocalTracksToAllPeers();
});

whiteboard.init((data) => {
  broadcastDataChannelMessage(data);
});

captions.init(
  (data) => {
    broadcastDataChannelMessage(data);
  },
  () => state.username,
  () => {
    const track = currentTrack();
    return !track || !track.enabled;
  }
);

stats.init(() => state.peers);

initializeFromQuery();
setMode('join');
setRoomChip(ui.roomInput.value || 'Not joined');
setSocketStateLabel(socket.connected ? 'connected' : 'connecting');
setChatEnabled(false);
clearChat();
renderParticipants();
updateMuteButton();
updateMicWarningBadge();
updateRetryButton();
updatePeerCount();
refreshRoomStatus();
populateDevices();

async function requestInitialPermissions() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach(track => track.stop());
    await populateDevices();
  } catch (error) {
    console.warn("Initial permission request skipped or denied. Device labels will be hidden until joined.", error);
  }
}

if (supportsRequiredApis()) {
  requestInitialPermissions();
}

if (!supportsRequiredApis()) {
  showToast('This browser does not support the required microphone or WebRTC features.', 'error');
  ui.joinBtn.disabled = true;
}

setStatus(
  supportsRequiredApis()
    ? `Ready to join${hasTurnRelayServer(rtcConfig.iceServers) ? ' with relay support' : ''}`
    : 'Unsupported browser',
  supportsRequiredApis() ? 'info' : 'danger'
);

const _tabChat = document.getElementById('tabChat');
const _tabParticipants = document.getElementById('tabParticipants');

if (_tabChat) {
  _tabChat.addEventListener('click', (e) => {
    e.currentTarget.classList.add('active');
    if (_tabParticipants) _tabParticipants.classList.remove('active');
    const chatPanel = document.getElementById('chatPanel');
    const participantsPanel = document.getElementById('participantsPanel');
    if (chatPanel) chatPanel.classList.remove('hidden');
    if (participantsPanel) participantsPanel.classList.add('hidden');
    const badge = document.getElementById('chatUnreadBadge');
    if (badge) badge.classList.add('hidden');
  });
}

if (_tabParticipants) {
  _tabParticipants.addEventListener('click', (e) => {
    e.currentTarget.classList.add('active');
    if (_tabChat) _tabChat.classList.remove('active');
    const participantsPanel = document.getElementById('participantsPanel');
    const chatPanel = document.getElementById('chatPanel');
    if (participantsPanel) participantsPanel.classList.remove('hidden');
    if (chatPanel) chatPanel.classList.add('hidden');
  });
}

const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
if (toggleSidebarBtn) {
  toggleSidebarBtn.addEventListener('click', () => {
    const panel = document.getElementById('sidePanel');
    panel.classList.toggle('collapsed');
    document.body.classList.toggle('sidebar-open', !panel.classList.contains('collapsed'));
    
    if (!panel.classList.contains('collapsed') && !document.getElementById('chatPanel').classList.contains('hidden')) {
      const badge = document.getElementById('chatUnreadBadge');
      if (badge) badge.classList.add('hidden');
    }
  });
}

const closeSidebarBtnMobile = document.getElementById('closeSidebarBtnMobile');
if (closeSidebarBtnMobile) {
  closeSidebarBtnMobile.addEventListener('click', () => {
    document.getElementById('sidePanel').classList.add('collapsed');
    document.body.classList.remove('sidebar-open');
  });
}

document.addEventListener('fullscreenchange', () => {
  const isFs = !!document.fullscreenElement;
  document.querySelectorAll('.fullscreen-btn').forEach(btn => {
    btn.classList.toggle('is-fullscreen', isFs);
  });
});

document.addEventListener('webkitfullscreenchange', () => {
  const isFs = !!document.webkitFullscreenElement;
  document.querySelectorAll('.fullscreen-btn').forEach(btn => {
    btn.classList.toggle('is-fullscreen', isFs);
  });
});

const instructionsBtn = document.getElementById('instructionsBtn');
const closeInstructionsBtn = document.getElementById('closeInstructionsBtn');
const instructionsModal = document.getElementById('instructionsModal');

if (instructionsBtn && closeInstructionsBtn && instructionsModal) {
  instructionsBtn.addEventListener('click', () => {
    instructionsModal.classList.add('active');
  });

  closeInstructionsBtn.addEventListener('click', () => {
    instructionsModal.classList.remove('active');
  });

  instructionsModal.addEventListener('click', (e) => {
    if (e.target === instructionsModal) {
      instructionsModal.classList.remove('active');
    }
  });
}

const privacyPolicyBtn = document.getElementById('privacyPolicyBtn');
const closePrivacyBtn = document.getElementById('closePrivacyBtn');
const privacyPolicyModal = document.getElementById('privacyPolicyModal');

if (privacyPolicyBtn && closePrivacyBtn && privacyPolicyModal) {
  privacyPolicyBtn.addEventListener('click', (e) => {
    e.preventDefault();
    privacyPolicyModal.classList.add('active');
  });

  closePrivacyBtn.addEventListener('click', () => {
    privacyPolicyModal.classList.remove('active');
  });

  privacyPolicyModal.addEventListener('click', (e) => {
    if (e.target === privacyPolicyModal) {
      privacyPolicyModal.classList.remove('active');
    }
  });
}
