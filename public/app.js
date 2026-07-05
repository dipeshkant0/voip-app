const socket = io();

const ROOM_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const runtimeConfig = window.__VOIP_APP_CONFIG__ || {};
const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:global.stun.twilio.com:3478' }
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

const state = {
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
  username: '',
  audioAnalysers: new Map(), // peerId -> analyser
  videoEnabled: false,
  screenSharing: false,
  localVideoTrack: null,
  incomingFiles: new Map(), // peerId -> { metadata, chunks, receivedSize }
  recording: false,
  recordingDestination: null,
  recordingPoll: null,
  focusedPeerId: null
};

let mediaRecorder;
let recordedChunks = [];
let audioSources = new Map();
let speakerPollId = null;
let activeBlobUrls = [];

const MAX_CHAT_MESSAGES = 200;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const FILE_CHUNK_SIZE = 16 * 1024;
const DATA_CHANNEL_HIGH_WATER = 1024 * 1024;

function mixVideos() {
  const canvas = document.getElementById('recordingCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const videoElements = Array.from(document.querySelectorAll('video')).filter(v => v.srcObject && v.readyState >= 2);
  if (videoElements.length > 0) {
    const cols = Math.ceil(Math.sqrt(videoElements.length));
    const rows = Math.ceil(videoElements.length / cols);
    const w = canvas.width / cols;
    const h = canvas.height / rows;

    videoElements.forEach((vid, i) => {
      const x = (i % cols) * w;
      const y = Math.floor(i / cols) * h;
      try {
        const vidW = vid.videoWidth;
        const vidH = vid.videoHeight;
        if (vidW > 0 && vidH > 0) {
          const scale = Math.max(w / vidW, h / vidH);
          const drawW = vidW * scale;
          const drawH = vidH * scale;
          const drawX = x + (w - drawW) / 2;
          const drawY = y + (h - drawH) / 2;

          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, w, h);
          ctx.clip();
          ctx.drawImage(vid, drawX, drawY, drawW, drawH);
          ctx.restore();
        }
      } catch (e) { }
    });
  }

  if (state.recording) {
    state.recordingPoll = setTimeout(mixVideos, 1000 / 30);
  }
}

function startRecording() {
  if (!state.audioContext) {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (AudioContextCtor) {
      state.audioContext = new AudioContextCtor();
    }
  }

  if (!state.audioContext) {
    showToast('AudioContext not supported for recording.', 'error');
    return;
  }

  state.recordingDestination = state.audioContext.createMediaStreamDestination();

  if (state.localStream && state.localStream.getAudioTracks().length > 0) {
    try {
      const source = state.audioContext.createMediaStreamSource(new MediaStream([state.localStream.getAudioTracks()[0]]));
      source.connect(state.recordingDestination);
      audioSources.set('local', source);
    } catch (e) { }
  }

  peerEntries().forEach(([peerId]) => {
    const audioEl = document.getElementById(`audio-${peerId}`);
    if (audioEl && audioEl.srcObject) {
      try {
        const source = state.audioContext.createMediaStreamSource(audioEl.srcObject);
        source.connect(state.recordingDestination);
        audioSources.set(peerId, source);
      } catch (e) { }
    }
  });

  state.recording = true;

  let canvas = document.getElementById('recordingCanvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'recordingCanvas';
    canvas.width = 1280;
    canvas.height = 720;
    canvas.style.display = 'none';
    document.body.appendChild(canvas);
  }
  mixVideos();

  const canvasStream = canvas.captureStream(30);
  const mixedStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...state.recordingDestination.stream.getAudioTracks()
  ]);

  recordedChunks = [];
  try {
    mediaRecorder = new MediaRecorder(mixedStream, { mimeType: 'video/webm; codecs=vp9' });
  } catch (e) {
    try {
      mediaRecorder = new MediaRecorder(mixedStream, { mimeType: 'video/webm; codecs=vp8' });
    } catch (e2) {
      mediaRecorder = new MediaRecorder(mixedStream, { mimeType: 'video/webm' });
    }
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `recording-${new Date().toISOString()}.webm`;
    a.click();
    showToast('Recording saved.', 'success');

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 2000);
  };

  mediaRecorder.start(1000);

  ui.recordBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>`;
  ui.recordBtn.classList.add('danger');
  ui.recordBtn.classList.add('active');
  showToast('Recording started.', 'info');
}

function stopRecording() {
  if (!state.recording) return;
  state.recording = false;

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  if (state.recordingPoll) {
    clearTimeout(state.recordingPoll);
    state.recordingPoll = null;
  }

  audioSources.forEach(s => s.disconnect());
  audioSources.clear();
  state.recordingDestination = null;

  ui.recordBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle></svg>`;
  ui.recordBtn.classList.remove('danger');
  ui.recordBtn.classList.remove('active');
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
}

function isUsableAudioTrack(track) {
  return Boolean(track && track.kind === 'audio' && track.readyState === 'live');
}

function currentTrack() {
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
  try {
    state.audioAnalysers.get('local').source.disconnect();
  } catch (e) { }
  state.audioAnalysers.delete('local');

  if (speakerPollId && state.audioAnalysers.size === 0) {
    cancelAnimationFrame(speakerPollId);
    speakerPollId = null;
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
  setChatEnabled(hasOpenDataChannel);
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

  if (isMuted) {
    micEl.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
  } else {
    micEl.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
  }

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
      } catch (e) { }
    }

    const source = state.audioContext.createMediaStreamSource(stream);
    const analyser = state.audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.4;
    source.connect(analyser);

    state.audioAnalysers.set(id, { analyser, source });

    if (!speakerPollId) {
      pollActiveSpeakers();
    }
  } catch (error) {
    console.warn('Could not setup audio analyser:', error);
  }
}

function pollActiveSpeakers() {
  if (state.audioAnalysers.size === 0) {
    speakerPollId = null;
    return;
  }

  speakerPollId = requestAnimationFrame(pollActiveSpeakers);

  state.audioAnalysers.forEach(({ analyser }, id) => {
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i];
    }
    const average = sum / dataArray.length;

    const el = document.getElementById(`participant-${id}`);
    const wrapper = document.getElementById(`video-wrapper-${id}`);

    if (average > 15) {
      if (el) el.classList.add('active-speaker');
      if (wrapper) wrapper.classList.add('active-speaker');
    } else {
      if (el) el.classList.remove('active-speaker');
      if (wrapper) wrapper.classList.remove('active-speaker');
    }
  });
}

function getAudioConstraints(deviceId = '', exactDevice = false) {
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  return {
    deviceId: deviceId ? { [exactDevice ? 'exact' : 'ideal']: deviceId } : undefined,
    echoCancellation: true,
    noiseSuppression: isMobile ? false : true,
    autoGainControl: isMobile ? false : true,
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

function unfocusVideo() {
  if (state.focusedPeerId) {
    const wrapper = document.getElementById(`video-wrapper-${state.focusedPeerId}`);
    if (wrapper) wrapper.classList.remove('focused');
    state.focusedPeerId = null;
  }
}

function focusVideo(peerId) {
  if (state.focusedPeerId === peerId) return;
  unfocusVideo();
  const wrapper = document.getElementById(`video-wrapper-${peerId}`);
  if (wrapper) {
    wrapper.classList.add('focused');
    state.focusedPeerId = peerId;
  }
}

function updateLocalVideoPreview() {
  const videoTrack = state.screenSharing ? state.localVideoTrack : (state.videoEnabled ? currentVideoTrack() : null);
  let localVideoEl = document.getElementById('video-local');
  let wrapper = document.getElementById('video-wrapper-local');

  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = 'video-wrapper';
    wrapper.id = 'video-wrapper-local';

    localVideoEl = document.createElement('video');
    localVideoEl.id = 'video-local';
    localVideoEl.autoplay = true;
    localVideoEl.playsInline = true;
    localVideoEl.muted = true;

    const muteIcon = document.createElement('div');
    muteIcon.className = 'video-mute-icon hidden';
    muteIcon.id = 'mute-icon-local';
    muteIcon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"></path></svg>`;

    const avatar = document.createElement('div');
    avatar.className = 'avatar-placeholder';
    avatar.textContent = state.username || 'You';
    avatar.style.position = 'absolute';
    avatar.style.color = 'white';
    avatar.style.fontSize = '2rem';

    const nametag = document.createElement('div');
    nametag.className = 'video-nametag';
    nametag.textContent = state.username || 'You (Local)';

    const unpinBtn = document.createElement('div');
    unpinBtn.className = 'unpin-btn';
    unpinBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
    unpinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      unfocusVideo();
    });

    wrapper.addEventListener('click', () => {
      focusVideo('local');
    });

    wrapper.appendChild(localVideoEl);
    wrapper.appendChild(muteIcon);
    wrapper.appendChild(avatar);
    wrapper.appendChild(nametag);
    wrapper.appendChild(unpinBtn);
    ui.videoContainer.appendChild(wrapper);
  }

  const avatarPlaceholder = wrapper.querySelector('.avatar-placeholder');

  if (!videoTrack) {
    localVideoEl.srcObject = null;
    localVideoEl.style.display = 'none';
    if (avatarPlaceholder) avatarPlaceholder.style.display = 'block';
    return;
  }

  localVideoEl.style.display = 'block';
  if (avatarPlaceholder) avatarPlaceholder.style.display = 'none';
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

function appendMessage(text, isSelf, senderName = '') {
  const placeholder = ui.chatBox.querySelector('.chat-empty');
  if (placeholder) placeholder.remove();

  while (ui.chatBox.children.length >= MAX_CHAT_MESSAGES) {
    ui.chatBox.firstElementChild.remove();
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
  textEl.textContent = text;
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
  stopStream(state.localStream);
  stopStream(state.rawStream);
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

  peer.dataChannel = channel;

  channel.onopen = () => {
    setChatStateFromPeers();
    refreshRoomStatus();

    const track = currentTrack();
    const isAudioEnabled = track ? track.enabled : false;
    try {
      channel.send(JSON.stringify({ type: 'audio-state', enabled: isAudioEnabled }));
      channel.send(JSON.stringify({ type: 'video-state', enabled: state.videoEnabled }));
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
  };

  channel.onerror = () => {
    showToast('Data channel error.', 'warning');
  };

  channel.binaryType = 'arraybuffer';

  channel.onmessage = (event) => {
    if (typeof event.data === 'string') {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'chat') {
          appendMessage(msg.text, false, peer.username || 'Anonymous');
        } else if (msg.type === 'file-meta') {
          const fileName = String(msg.name || 'received-file').slice(0, 120);
          const fileSize = Number(msg.size);
          const fileType = String(msg.fileType || 'application/octet-stream').slice(0, 120);
          const fileId = msg.fileId || ('file-' + Math.random().toString(36).substr(2, 9));
          if (!Number.isFinite(fileSize) || fileSize < 0 || fileSize > MAX_FILE_SIZE) {
            showToast('Incoming file was rejected because its metadata is invalid.', 'warning');
            return;
          }
          state.incomingFiles.set(peerId, {
            fileId,
            metadata: { name: fileName, size: fileSize, fileType },
            chunks: [],
            receivedSize: 0
          });
          appendFileProgress(fileId, fileName, fileSize, false, peer.username || 'Anonymous');
          showToast(`Receiving file: ${fileName}...`, 'info');
        }
        else if (msg.type === 'audio-state') {
          peer.isAudioMuted = !msg.enabled;
          const muteIcon = document.getElementById(`mute-icon-${peerId}`);
          if (muteIcon) {
            if (msg.enabled) muteIcon.classList.add('hidden');
            else muteIcon.classList.remove('hidden');
          }
          const participantMic = document.getElementById(`participant-mic-${peerId}`);
          if (participantMic) {
            if (msg.enabled) {
              participantMic.classList.remove('muted');
              participantMic.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
            } else {
              participantMic.classList.add('muted');
              participantMic.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
            }
          }
        }
        else if (msg.type === 'typing') {
          const typingIndicator = document.getElementById('typingIndicator');
          if (typingIndicator) {
            typingIndicator.textContent = `${peer.username || 'Someone'} is typing...`;
            typingIndicator.style.display = 'block';
            clearTimeout(peer.typingTimeout);
            peer.typingTimeout = setTimeout(() => {
              typingIndicator.style.display = 'none';
            }, 3000);
          }
        }
        else if (msg.type === 'video-state') {
          const videoEl = document.getElementById(`video-${peerId}`);
          const wrapper = document.getElementById(`video-wrapper-${peerId}`);
          if (videoEl && wrapper) {
            const avatar = wrapper.querySelector('.avatar-placeholder');
            if (msg.enabled) {
              videoEl.style.opacity = '1';
              if (avatar) avatar.style.display = 'none';
            } else {
              videoEl.style.opacity = '0';
              if (avatar) avatar.style.display = 'block';
            }
          }
        }
      } catch (e) {
        appendMessage(String(event.data), false, peer.username || 'Anonymous');
      }
    } else if (event.data instanceof ArrayBuffer) {
      const fileState = state.incomingFiles.get(peerId);
      if (!fileState) return;

      fileState.chunks.push(event.data);
      fileState.receivedSize += event.data.byteLength;

      updateFileProgress(fileState.fileId, fileState.receivedSize, fileState.metadata.size);

      if (fileState.receivedSize > MAX_FILE_SIZE || fileState.receivedSize > fileState.metadata.size + FILE_CHUNK_SIZE) {
        removeFileProgress(fileState.fileId);
        state.incomingFiles.delete(peerId);
        showToast('Incoming file was cancelled because it exceeded its declared size.', 'warning');
        return;
      }

      if (fileState.receivedSize >= fileState.metadata.size) {
        const blob = new Blob(fileState.chunks, { type: fileState.metadata.fileType });
        const url = URL.createObjectURL(blob);
        activeBlobUrls.push(url);
        removeFileProgress(fileState.fileId);
        appendFileMessage(fileState.metadata.name, url, fileState.metadata.size, false, peer.username || 'Anonymous');
        state.incomingFiles.delete(peerId);
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
  let wrapper = document.getElementById(`video-wrapper-${peerId}`);
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = 'video-wrapper';
    wrapper.id = `video-wrapper-${peerId}`;

    const avatar = document.createElement('div');
    avatar.className = 'avatar-placeholder';
    avatar.textContent = username;
    avatar.style.position = 'absolute';
    avatar.style.color = 'white';
    avatar.style.fontSize = '2rem';

    const muteIcon = document.createElement('div');
    muteIcon.className = 'video-mute-icon hidden';
    muteIcon.id = `mute-icon-${peerId}`;
    muteIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>';
    muteIcon.style.color = 'var(--danger)';
    muteIcon.style.fontWeight = 'bold';
    muteIcon.style.background = 'rgba(0,0,0,0.6)';
    muteIcon.style.padding = '4px';
    muteIcon.style.borderRadius = '50%';

    const nametag = document.createElement('div');
    nametag.className = 'video-nametag';
    nametag.id = `nametag-${peerId}`;
    nametag.textContent = username;

    const unpinBtn = document.createElement('div');
    unpinBtn.className = 'unpin-btn';
    unpinBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
    unpinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      unfocusVideo();
    });

    wrapper.addEventListener('click', () => {
      focusVideo(peerId);
    });

    wrapper.appendChild(avatar);
    wrapper.appendChild(muteIcon);
    wrapper.appendChild(nametag);
    wrapper.appendChild(unpinBtn);
    ui.videoContainer.appendChild(wrapper);
  }
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
  // const localTrack = currentTrack();
  // if (localTrack && state.localStream) {
  //   pc.addTrack(localTrack, state.localStream);
  // }

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
        videoEl.style.transition = 'opacity 0.2s ease';
        wrapper.appendChild(videoEl);
        const avatar = wrapper.querySelector('.avatar-placeholder');
        if (avatar) avatar.style.display = 'none';
      }
      videoEl.srcObject = new MediaStream([event.track]);
      videoEl.play().catch(e => console.warn('Video auto-play prevented:', e));

      event.track.onmute = () => {
        videoEl.style.opacity = '0';
      };
      event.track.onunmute = () => {
        videoEl.style.opacity = '1';
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

      if (state.recording && state.recordingDestination) {
        try {
          const source = state.audioContext.createMediaStreamSource(safeAudioStream);
          source.connect(state.recordingDestination);
          audioSources.set(peerId, source);
        } catch (e) { }
      }
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
      cleanupPeer(peerId, 'ICE network blocked');
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
  const transceivers = pc.getTransceivers();

  // Permanently identify the correct channels
  const audioTransceiver = transceivers.find(t => t.receiver?.track?.kind === 'audio');
  const videoTransceiver = transceivers.find(t => t.receiver?.track?.kind === 'video');

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
      pc.addTrack(audioTrack, state.localStream);
    }
  } else if (audioTransceiver) {
    audioTransceiver.sender.replaceTrack(null).catch(() => { });
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
      pc.addTrack(videoTrack, state.localStream || new MediaStream());
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
  }
}

function applyLocalTracksToAllPeers() {
  peerEntries().forEach(([peerId]) => applyLocalTracksToPeer(peerId));
}



function cleanupPeer(peerId, reason = '', skipRefresh = false) {
  const peer = getPeerState(peerId);
  if (!peer) return;

  state.peers.delete(peerId);

  if (peer.dataChannel && peer.dataChannel.readyState !== 'closed') {
    try {
      peer.dataChannel.close();
    } catch (_error) { }
  }

  peer.signalingQueue = Promise.resolve();

  if (peer.pc) {
    try {
      peer.pc.onicecandidate = null;
      peer.pc.ontrack = null;
      peer.pc.ondatachannel = null;
      peer.pc.onconnectionstatechange = null;
      peer.pc.onnegotiationneeded = null;
      peer.pc.close();
    } catch (_error) { }
  }

  if (state.audioAnalysers.has(peerId)) {
    try {
      state.audioAnalysers.get(peerId).source.disconnect();
    } catch (e) { }
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

  if (audioSources.has(peerId)) {
    try {
      audioSources.get(peerId).disconnect();
    } catch (e) { }
    audioSources.delete(peerId);
  }

  if (state.incomingFiles.has(peerId)) {
    state.incomingFiles.delete(peerId);
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

  unfocusVideo();
  clearAllPeers();
  stopLocalStream();

  state.roomId = '';
  state.selectedDeviceId = '';
  state.videoEnabled = false;
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
      return acquireMicrophone('', { silent, required, exactDevice: false, allowFallback: false }, true);
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

      const midCallDeviceSelect = document.getElementById('midCallDeviceSelect');
      if (midCallDeviceSelect) {
        midCallDeviceSelect.innerHTML = ui.deviceSelect.innerHTML;
        midCallDeviceSelect.value = keepValue;
      }
    }

    const midCallCameraSelect = document.getElementById('midCallCameraSelect');
    if (midCallCameraSelect) {
      midCallCameraSelect.innerHTML = '';
      const defCamOpt = document.createElement('option');
      defCamOpt.value = '';
      defCamOpt.textContent = 'Default Camera';
      midCallCameraSelect.appendChild(defCamOpt);

      videoDevices.forEach(device => {
        const opt = document.createElement('option');
        opt.value = device.deviceId;
        opt.textContent = device.label || `Camera ${midCallCameraSelect.options.length}`;
        midCallCameraSelect.appendChild(opt);
      });
      if (state.selectedCameraId) midCallCameraSelect.value = state.selectedCameraId;
    }
  } catch (error) {
    console.warn('Failed to enumerate devices:', error);
  }
}

async function joinRoom() {
  if (state.joining) return;

  const roomId = normalizeRoomName(ui.roomInput.value);
  const username = ui.usernameInput.value.trim() || 'Anonymous';
  const password = ui.passwordInput.value || '';

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
    const result = await requestRoomJoin({ roomId, username, password });

    state.roomId = result.room;
    setRoomChip(state.roomId);
    setMode('call');

    clearAllPeers();
    syncPeerRoster(result.roomPeers || result.peers || [], result.usernames || {});
    applyLocalTracksToAllPeers();

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
    const result = await requestRoomJoin({ roomId: state.roomId, username: state.username, password: ui.passwordInput.value });

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

  queueSignalingTask(data.sender, async () => {
    const peer = state.peers.get(data.sender);
    if (!peer) return;

    try {
      if (!data.candidate.candidate) return; // Ignore empty candidates
      const candidate = new RTCIceCandidate(data.candidate);
      if (!peer.pc.remoteDescription) {
        peer.iceQueue.push(candidate);
      } else {
        await peer.pc.addIceCandidate(candidate).catch(e => console.warn('Ignored invalid candidate:', e));
      }
    } catch (error) {
      if (!peer.ignoreOffer) {
        console.warn('ICE parsing failed:', error);
      }
    }
  });
}

function broadcastVideoState(enabled) {
  const msgStr = JSON.stringify({ type: 'video-state', enabled: enabled });

  peerEntries().forEach(([, peer]) => {
    if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
      try {
        peer.dataChannel.send(msgStr);
      } catch (error) {
        console.warn('Failed to send video state:', error);
      }
    }
  });
}

function sendChatMessage() {
  const MAX_CHAT_LENGTH = 4000;
  const message = ui.chatInput.value.trim();
  if (!message) return;
  if (message.length > MAX_CHAT_LENGTH) {
    showToast('Message is too long. Maximum ' + MAX_CHAT_LENGTH + ' characters.', 'warning');
    return;
  }

  const openChannels = peerEntries()
    .map(([, peer]) => peer.dataChannel)
    .filter((channel) => channel && channel.readyState === 'open');

  if (!openChannels.length) return;

  const msgObj = { type: 'chat', text: message };
  const msgStr = JSON.stringify(msgObj);

  openChannels.forEach((channel) => {
    try {
      channel.send(msgStr);
    } catch (error) {
      console.error('Failed to send chat message:', error);
    }
  });

  appendMessage(message, true, state.username || 'You');
  ui.chatInput.value = '';
}

function appendFileProgress(fileId, name, size, isSelf, senderName = '') {
  const placeholder = ui.chatBox.querySelector('.chat-empty');
  if (placeholder) placeholder.remove();

  while (ui.chatBox.children.length >= MAX_CHAT_MESSAGES) {
    ui.chatBox.firstElementChild.remove();
  }

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

  while (ui.chatBox.children.length >= MAX_CHAT_MESSAGES) {
    ui.chatBox.firstElementChild.remove();
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

// Utility function to natively mirror a video track
function mirrorVideoTrack(track) {
  const videoEl = document.createElement('video');
  videoEl.srcObject = new MediaStream([track]);
  videoEl.autoplay = true;
  videoEl.playsInline = true;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  videoEl.onloadedmetadata = () => {
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    videoEl.play().catch(() => { });
  };

  let animationId;
  function drawFrame() {
    if (videoEl.readyState >= 2 && canvas.width > 0) {
      ctx.save();
      ctx.scale(-1, 1);
      ctx.drawImage(videoEl, -canvas.width, 0, canvas.width, canvas.height);
      ctx.restore();
    }
    animationId = requestAnimationFrame(drawFrame);
  }
  animationId = requestAnimationFrame(drawFrame);

  const canvasStream = canvas.captureStream(30);
  const mirroredTrack = canvasStream.getVideoTracks()[0];

  const originalStop = mirroredTrack.stop.bind(mirroredTrack);
  mirroredTrack.stop = () => {
    cancelAnimationFrame(animationId);
    track.stop();
    originalStop();
  };

  return mirroredTrack;
}

let isTogglingVideo = false;

async function toggleVideo() {
  if (state.screenSharing) {
    showToast('Cannot enable video while screen sharing is active.', 'warning');
    return;
  }

  if (isTogglingVideo) return;
  isTogglingVideo = true;

  const nextVideoEnabled = !state.videoEnabled;
  ui.videoBtn.disabled = true;

  try {
    if (nextVideoEnabled) {
      const cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: getVideoConstraints(),
      });
      let videoTrack = cameraStream.getVideoTracks()[0] || null;
      if (videoTrack) videoTrack = mirrorVideoTrack(videoTrack);
      if (!videoTrack || videoTrack.readyState !== 'live') {
        stopStream(cameraStream);
        throw new Error('No live camera track was returned.');
      }

      const previousVideoTrack = currentVideoTrack();
      state.videoEnabled = true;
      rebuildLocalStream(currentTrack(), videoTrack);
      if (previousVideoTrack && previousVideoTrack !== videoTrack) {
        previousVideoTrack.stop();
      }

      videoTrack.onended = () => {
        if (currentVideoTrack() === videoTrack) {
          state.videoEnabled = false;
          rebuildLocalStream(currentTrack(), null);
          updateLocalVideoPreview();
          applyLocalTracksToAllPeers();
          ui.videoBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`; ui.videoBtn.classList.remove('active');
          showToast('Camera stopped.', 'info');
        }
      };

      updateLocalVideoPreview();
      ui.videoBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`; ui.videoBtn.classList.add('active');
      showToast('Camera turned on.', 'success');
      broadcastVideoState(true);
    } else {
      const previousVideoTrack = currentVideoTrack();
      state.videoEnabled = false;
      rebuildLocalStream(currentTrack(), null);
      if (previousVideoTrack) previousVideoTrack.stop();
      updateLocalVideoPreview();
      ui.videoBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`; ui.videoBtn.classList.remove('active');
      showToast('Camera turned off.', 'info');
      broadcastVideoState(false);
    }

    applyLocalTracksToAllPeers();
    refreshRoomStatus();
  } catch (error) {
    console.error('Camera toggle failed:', error);
    state.videoEnabled = !nextVideoEnabled;
    ui.videoBtn.innerHTML = state.videoEnabled ? '<i class="fa-solid fa-video"></i>' : '<i class="fa-solid fa-video-slash"></i>'; if (state.videoEnabled) ui.videoBtn.classList.add('active'); else ui.videoBtn.classList.remove('active');
    showToast('Camera access failed. Check browser permissions or another app using the camera.', 'error');
  } finally {
    isTogglingVideo = false;
    ui.videoBtn.disabled = false;
  }
}

async function toggleScreenShare() {
  if (!state.screenSharing) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      showToast('Screen sharing is not supported on this device/browser.', 'error');
      return;
    }
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 20, max: 20 }
        },
        audio: true
      });
      state.screenSharing = true;
      state.localVideoTrack = displayStream.getVideoTracks()[0];
      if (state.localVideoTrack) {
        state.localVideoTrack.contentHint = 'detail';
      }

      state.localVideoTrack.onended = () => {
        stopScreenShare();
      };

      ui.screenShareBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2m4 0h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2"></path><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
      ui.screenShareBtn.classList.add('danger');
      ui.screenShareBtn.classList.add('active');

      ui.videoBtn.disabled = true;

      updateLocalVideoPreview();
      applyLocalTracksToAllPeers();
      broadcastVideoState(true);
    } catch (err) {
      console.warn("Screen share failed or cancelled", err);
      showToast('Screen sharing failed or was cancelled.', 'warning');
    }
  } else {
    stopScreenShare();
  }
}

function stopScreenShare() {
  if (!state.screenSharing) return;
  state.screenSharing = false;
  if (state.localVideoTrack) {
    state.localVideoTrack.stop();
    state.localVideoTrack = null;
  }

  ui.screenShareBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`; ui.screenShareBtn.classList.remove('active');
  ui.screenShareBtn.classList.remove('btn-danger');
  ui.screenShareBtn.classList.add('btn-secondary');
  ui.videoBtn.disabled = false;

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
  updateMuteButton();
  refreshRoomStatus();
  showToast(track.enabled ? 'Microphone unmuted.' : 'Microphone muted.', 'info', 1800);

  const msgStr = JSON.stringify({ type: 'audio-state', enabled: track.enabled });
  peerEntries().forEach(([, peer]) => {
    if (peer.dataChannel?.readyState === 'open') {
      try { peer.dataChannel.send(msgStr); } catch (e) { }
    }
  });
}

async function retryMicAccess() {
  if (!state.roomId) return;

  ui.retryMicBtn.disabled = true;
  ui.retryMicBtn.textContent = 'Requesting...';

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
  if (room) {
    url.searchParams.set('room', room);
  }

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
  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = params.get('room');
  if (roomFromUrl) {
    ui.roomInput.value = roomFromUrl;
  }
}

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

socket.on('peer-joined', ({ peerId, username }) => {
  if (!peerId || peerId === socket.id || !state.roomId) return;
  ensurePeer(peerId, username);
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

ui.joinBtn.addEventListener('click', joinRoom);
ui.hangupBtn.addEventListener('click', () => leaveRoom({ keepRoomInput: true }));
ui.muteBtn.addEventListener('click', toggleMute);
ui.videoBtn.addEventListener('click', toggleVideo);
ui.screenShareBtn.addEventListener('click', toggleScreenShare);
ui.retryMicBtn.addEventListener('click', retryMicAccess);
ui.copyLinkBtn.addEventListener('click', copyInviteLink);
ui.sendBtn.addEventListener('click', sendChatMessage);
ui.attachFileBtn.addEventListener('click', () => ui.fileInput.click());
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

  const openChannels = peerEntries()
    .map(([, peer]) => peer.dataChannel)
    .filter((channel) => channel && channel.readyState === 'open');

  if (!openChannels.length) {
    showToast('No connected peers are ready for file transfer.', 'warning');
    return;
  }

  const fileId = 'file-' + Math.random().toString(36).substr(2, 9);
  const meta = { type: 'file-meta', fileId, name: file.name.slice(0, 120), size: file.size, fileType: file.type || 'application/octet-stream' };
  openChannels.forEach((channel) => {
    try {
      channel.send(JSON.stringify(meta));
    } catch (error) {
      console.error('Failed to send file metadata:', error);
    }
  });

  appendFileProgress(fileId, file.name, file.size, true, state.username || 'You');
  let offset = 0;

  const reader = new FileReader();
  reader.onload = (e) => {
    const chunk = e.target.result;
    openChannels.forEach(channel => {
      if (channel.readyState === 'open') {
        channel.send(chunk);
      }
    });
    offset += chunk.byteLength;
    updateFileProgress(fileId, offset, file.size);

    if (offset < file.size) {
      readSlice(offset);
    } else {
      removeFileProgress(fileId);
      const url = URL.createObjectURL(file);
      activeBlobUrls.push(url);
      appendFileMessage(file.name, url, file.size, true, state.username || 'You');
      showToast('File sent.', 'success');
    }
  };

  reader.onerror = () => {
    showToast('Could not read the selected file.', 'error');
  };

  const readSlice = (o) => {
    const activeChannels = openChannels.filter(c => c.readyState === 'open');
    if (activeChannels.length === 0) {
      showToast('File transfer stopped because all peers disconnected.', 'warning');
      return;
    }

    const congestedChannel = activeChannels.find(c => c.bufferedAmount > DATA_CHANNEL_HIGH_WATER);
    if (congestedChannel) {
      const resumeTransfer = () => {
        congestedChannel.onbufferedamountlow = null;
        congestedChannel.removeEventListener('close', resumeTransfer);
        readSlice(o);
      };
      congestedChannel.onbufferedamountlow = resumeTransfer;
      congestedChannel.addEventListener('close', resumeTransfer, { once: true });
      return;
    }

    const slice = file.slice(o, o + FILE_CHUNK_SIZE);
    reader.readAsArrayBuffer(slice);
  };

  readSlice(0);
});
ui.recordBtn.addEventListener('click', toggleRecording);
ui.chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    sendChatMessage();
  }
});
const midCallDeviceSelect = document.getElementById('midCallDeviceSelect');
if (midCallDeviceSelect) {
  midCallDeviceSelect.addEventListener('change', () => {
    ui.deviceSelect.value = midCallDeviceSelect.value;
    ui.deviceSelect.dispatchEvent(new Event('change'));
  });
}

const midCallCameraSelect = document.getElementById('midCallCameraSelect');
if (midCallCameraSelect) {
  midCallCameraSelect.addEventListener('change', async () => {
    if (isAcquiringMedia) return;
    state.selectedCameraId = midCallCameraSelect.value;
    if (state.videoEnabled) {
      isAcquiringMedia = true;
      try {
        const cameraStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: getVideoConstraints(),
        });
        let videoTrack = cameraStream.getVideoTracks()[0] || null;
        if (videoTrack) {
          videoTrack = mirrorVideoTrack(videoTrack);
          const previousVideoTrack = currentVideoTrack();
          rebuildLocalStream(currentTrack(), videoTrack);
          updateLocalVideoPreview();
          applyLocalTracksToAllPeers();
          if (previousVideoTrack) previousVideoTrack.stop();
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

document.getElementById('tabChat').addEventListener('click', (e) => {
  e.target.classList.add('active');
  document.getElementById('tabParticipants').classList.remove('active');
  document.getElementById('chatPanel').classList.remove('hidden');
  document.getElementById('participantsPanel').classList.add('hidden');
});

document.getElementById('tabParticipants').addEventListener('click', (e) => {
  e.target.classList.add('active');
  document.getElementById('tabChat').classList.remove('active');
  document.getElementById('participantsPanel').classList.remove('hidden');
  document.getElementById('chatPanel').classList.add('hidden');
});

const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
if (toggleSidebarBtn) {
  toggleSidebarBtn.addEventListener('click', () => {
    document.getElementById('sidePanel').classList.toggle('collapsed');
  });
}

const closeSidebarBtnMobile = document.getElementById('closeSidebarBtnMobile');
if (closeSidebarBtnMobile) {
  closeSidebarBtnMobile.addEventListener('click', () => {
    document.getElementById('sidePanel').classList.add('collapsed');
  });
}
