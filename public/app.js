const socket = io();

const ROOM_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const runtimeConfig = window.__VOIP_APP_CONFIG__ || {};
const DEFAULT_STUN_URLS = [{ urls: 'stun:stun.l.google.com:19302' }];

function normalizeIceServers(servers) {
  if (!Array.isArray(servers)) return DEFAULT_STUN_URLS;

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

  return normalized.length ? normalized : DEFAULT_STUN_URLS;
}

function hasTurnRelayServer(servers) {
  return Array.isArray(servers) && servers.some((server) => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    return urls.some((url) => String(url || '').toLowerCase().startsWith('turn:'));
  });
}

const rtcConfig = {
  iceServers: normalizeIceServers(runtimeConfig.iceServers),
  iceCandidatePoolSize: 1,
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
};

let mediaRecorder;
let recordedChunks = [];
let audioSources = new Map();
let speakerPollId = null;

const MAX_PENDING_ICE = 20;
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
        ctx.drawImage(vid, x, y, w, h);
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

  ui.recordBtn.textContent = 'Stop Recording';
  ui.recordBtn.classList.add('btn-danger');
  ui.recordBtn.classList.remove('btn-secondary');
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

  ui.recordBtn.textContent = 'Record Call';
  ui.recordBtn.classList.remove('btn-danger');
  ui.recordBtn.classList.add('btn-secondary');
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
  ui.roomView.style.display = isCall ? 'none' : 'grid';
  ui.callView.style.display = isCall ? 'grid' : 'none';
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
  ui.muteBtn.textContent = track && track.enabled ? 'Mute Mic' : 'Unmute Mic';
}

function updateMicWarningBadge() {
  const show = Boolean(state.roomId) && !currentTrack();
  ui.micWarningBadge.classList.toggle('is-hidden', !show);
  ui.micWarningBadge.textContent = 'Mic unavailable';
}

function updateRetryButton() {
  if (!state.roomId) {
    ui.retryMicBtn.textContent = 'Retry Mic Access';
    ui.retryMicBtn.disabled = true;
    return;
  }

  ui.retryMicBtn.disabled = false;
  ui.retryMicBtn.textContent = currentTrack() ? 'Refresh Mic' : 'Retry Mic Access';
}

function setChatStateFromPeers() {
  const hasOpenDataChannel = openDataChannelCount() > 0;
  setChatEnabled(hasOpenDataChannel);
  ui.attachFileBtn.disabled = !state.roomId || !hasOpenDataChannel;
}

function buildParticipantItem(nameText, statusText, badgeLabel, badgeClass) {
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
  item.appendChild(badgeEl);
  return item;
}

function renderParticipants() {
  const peerIds = [...state.peers.keys()].sort((a, b) => a.localeCompare(b));
  ui.participantList.innerHTML = '';

  const hasMic = Boolean(currentTrack());
  const youItem = buildParticipantItem(state.username || 'You', hasMic ? 'Microphone active' : 'Microphone unavailable', hasMic ? 'Ready' : 'No Mic', hasMic ? 'audio' : 'connecting');
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

    const item = buildParticipantItem(peer.username || 'Anonymous', describePeerConnection(peer), badge.label, badge.className);
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
    if (el) {
      if (average > 15) {
        el.classList.add('active-speaker');
      } else {
        el.classList.remove('active-speaker');
      }
    }
  });
}

function getAudioConstraints(deviceId = '', exactDevice = false) {
  return {
    deviceId: deviceId ? { [exactDevice ? 'exact' : 'ideal']: deviceId } : undefined,
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: true },
    sampleRate: { ideal: 48000 },
    channelCount: { ideal: 1 },
  };
}

function getVideoConstraints() {
  return {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
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

function updateLocalVideoPreview() {
  const videoTrack = state.screenSharing ? state.localVideoTrack : (state.videoEnabled ? currentVideoTrack() : null);
  let localVideoEl = document.getElementById('video-local');

  if (!videoTrack) {
    if (localVideoEl) {
      localVideoEl.srcObject = null;
      localVideoEl.remove();
    }
    return;
  }

  if (!localVideoEl) {
    localVideoEl = document.createElement('video');
    localVideoEl.id = 'video-local';
    localVideoEl.autoplay = true;
    localVideoEl.playsInline = true;
    localVideoEl.muted = true;
    ui.videoContainer.appendChild(localVideoEl);
  }

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
          if (!Number.isFinite(fileSize) || fileSize < 0 || fileSize > MAX_FILE_SIZE) {
            showToast('Incoming file was rejected because its metadata is invalid.', 'warning');
            return;
          }
          state.incomingFiles.set(peerId, {
            metadata: { name: fileName, size: fileSize, fileType },
            chunks: [],
            receivedSize: 0
          });
          showToast(`Receiving file: ${fileName}...`, 'info');
        }
        else if (msg.type === 'video-state'){
          const videoEl = document.getElementById(`video-${peerId}`);
          if (videoEl) {
            videoEl.style.transition = 'opacity 0.2s ease';
            videoEl.style.opacity = msg.enabled ? '1' : '0';
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
      if (fileState.receivedSize > MAX_FILE_SIZE || fileState.receivedSize > fileState.metadata.size + FILE_CHUNK_SIZE) {
        state.incomingFiles.delete(peerId);
        showToast('Incoming file was cancelled because it exceeded its declared size.', 'warning');
        return;
      }

      if (fileState.receivedSize >= fileState.metadata.size) {
        const blob = new Blob(fileState.chunks, { type: fileState.metadata.fileType });
        const url = URL.createObjectURL(blob);
        appendFileMessage(fileState.metadata.name, url, fileState.metadata.size, false, peer.username || 'Anonymous');
        state.incomingFiles.delete(peerId);
        showToast(`File received: ${fileState.metadata.name}`, 'success');
      }
    }
  };
}

function ensurePeer(peerId, providedUsername = null) {
  const existingPeer = state.peers.get(peerId);
  const finalUsername = providedUsername || (existingPeer ? existingPeer.username : 'Anonymous');

  if (existingPeer) {
    existingPeer.username = finalUsername;
    const pcState = existingPeer.pc?.connectionState || existingPeer.pc?.signalingState || 'new';
    if (pcState !== 'closed' && pcState !== 'failed') {
      return existingPeer;
    }
    cleanupPeer(peerId, 'recreating closed peer');
  }

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
    pendingIce: [],
  };

  state.peers.set(peerId, peer);
  renderParticipants();

  const pc = peer.pc;
  const localTrack = currentTrack();
  if (localTrack && state.localStream) {
    pc.addTrack(localTrack, state.localStream);
  }

  pc.onicecandidate = (event) => {
    if (!event.candidate || !state.roomId) return;
    socket.emit('ice-candidate', {
      target: peerId,
      candidate: event.candidate,
    });
  };

  pc.ontrack = (event) => {
    const isVideo = event.track.kind === 'video';

    if (isVideo) {
      let videoEl = document.getElementById(`video-${peerId}`);
      if (!videoEl) {
        videoEl = document.createElement('video');
        videoEl.id = `video-${peerId}`;
        videoEl.autoplay = true;
        videoEl.playsInline = true;
        videoEl.style.transition = 'opacity 0.2s ease';
        ui.videoContainer.appendChild(videoEl);
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
        ui.videoContainer.appendChild(audioEl);
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
      }, 3000);
    }

    refreshRoomStatus();
  };

  pc.onnegotiationneeded = async () => {
    if (!state.roomId) return;

    const currentPeer = state.peers.get(peerId);
    if (!currentPeer || currentPeer.makingOffer || pc.signalingState !== 'stable') return;

    try {
      currentPeer.makingOffer = true;
      await pc.setLocalDescription(await pc.createOffer());
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
  } else if (videoTransceiver) {
    videoTransceiver.sender.replaceTrack(null).catch(() => { });
  }
}

function applyLocalTracksToAllPeers() {
  peerEntries().forEach(([peerId]) => applyLocalTracksToPeer(peerId));
}

function flushPeerIce(peerId) {
  const peer = getPeerState(peerId);
  if (!peer || !peer.pc.remoteDescription || peer.pendingIce.length === 0) return;

  const candidates = [...peer.pendingIce];
  peer.pendingIce = [];
  candidates.forEach((candidate) => {
    peer.pc.addIceCandidate(candidate).catch((error) => {
      console.error('Failed to add ICE candidate:', error);
    });
  });
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

  peer.pendingIce = [];

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

  const videoEl = document.getElementById(`video-${peerId}`);
  if (videoEl) {
    videoEl.srcObject = null;
    videoEl.remove();
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

  clearAllPeers();
  stopLocalStream();

  state.roomId = '';
  state.selectedDeviceId = '';
  state.videoEnabled = false;
  ui.videoBtn.textContent = 'Turn on Video';
  setMode('join');
  setRoomChip('Not joined');
  setChatEnabled(false);
  clearChat();
  renderParticipants();
  ui.muteBtn.textContent = 'Mute Mic';
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

  window.location.href = window.location.pathname;
  window.setTimeout(() => {
    state.leaving = false;
  }, 150);
}

async function acquireMicrophone(deviceId = '', options = {}) {
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
      return acquireMicrophone('', { silent, required, exactDevice: false, allowFallback: false });
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

  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (error) {
    console.warn('Microphone discovery failed:', error);
    ui.deviceSelect.innerHTML = '<option value="">Microphone discovery unavailable</option>';
    ui.deviceSelect.disabled = true;
    return;
  }
  const inputs = devices.filter((device) => device.kind === 'audioinput');
  const keepValue = selectedDeviceId || ui.deviceSelect.value;

  ui.deviceSelect.innerHTML = '';

  if (!inputs.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No microphones found';
    ui.deviceSelect.appendChild(option);
    ui.deviceSelect.disabled = true;
    return;
  }

  ui.deviceSelect.disabled = false;

  inputs.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `Microphone ${index + 1}`;
    if (device.deviceId === keepValue) {
      option.selected = true;
    }
    ui.deviceSelect.appendChild(option);
  });

  if (!ui.deviceSelect.value) {
    ui.deviceSelect.selectedIndex = 0;
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

    syncPeerRoster(result.roomPeers || result.peers || []);
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

  const pc = peer.pc;
  const description = new RTCSessionDescription(data.sdp);
  const offerCollision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
  peer.ignoreOffer = !peer.polite && offerCollision;

  if (peer.ignoreOffer) return;

  try {
    if (offerCollision) {
      await pc.setLocalDescription({ type: 'rollback' });
    }

    await pc.setRemoteDescription(description);
    flushPeerIce(data.sender);

    if (description.type === 'offer') {
      await pc.setLocalDescription(await pc.createAnswer());
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
}

function handleRemoteAnswer(data) {
  if (!data?.sender || !data?.sdp) return;
  const peer = getPeerState(data.sender);
  if (!peer) return;

  peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
    .then(() => flushPeerIce(data.sender))
    .then(() => refreshRoomStatus())
    .catch((error) => {
      console.error('Failed to handle answer:', error);
      showToast('Failed to process a signaling answer.', 'error');
      cleanupPeer(data.sender, 'answer handling failed');
    });
}

function handleRemoteIce(data) {
  if (!data?.sender || !data?.candidate) return;
  const peer = getPeerState(data.sender);
  if (!peer) return;

  const candidate = new RTCIceCandidate(data.candidate);
  if (peer.pc.remoteDescription) {
    peer.pc.addIceCandidate(candidate).catch((error) => {
      console.error('Failed to add ICE candidate:', error);
    });
    return;
  }

  if (peer.pendingIce.length < MAX_PENDING_ICE) {
    peer.pendingIce.push(candidate);
  }
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
  fileLink.textContent = `📎 ${name} (${(size / 1024).toFixed(1)} KB)`;
  fileLink.style.color = 'var(--accent)';
  fileLink.style.textDecoration = 'none';
  el.appendChild(fileLink);

  ui.chatBox.appendChild(el);
  ui.chatBox.scrollTop = ui.chatBox.scrollHeight;
}

async function toggleVideo() {
  if (state.screenSharing) {
    showToast('Cannot enable video while screen sharing is active.', 'warning');
    return;
  }

  const nextVideoEnabled = !state.videoEnabled;
  ui.videoBtn.disabled = true;

  try {
    if (nextVideoEnabled) {
      const cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: getVideoConstraints(),
      });
      const videoTrack = cameraStream.getVideoTracks()[0] || null;
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
          ui.videoBtn.textContent = 'Turn on Video';
          showToast('Camera stopped.', 'info');
        }
      };

      updateLocalVideoPreview();
      ui.videoBtn.textContent = 'Turn off Video';
      showToast('Camera turned on.', 'success');
      broadcastVideoState(true);
    } else {
      const previousVideoTrack = currentVideoTrack();
      state.videoEnabled = false;
      rebuildLocalStream(currentTrack(), null);
      if (previousVideoTrack) previousVideoTrack.stop();
      updateLocalVideoPreview();
      ui.videoBtn.textContent = 'Turn on Video';
      showToast('Camera turned off.', 'info');
      broadcastVideoState(false);
    }

    applyLocalTracksToAllPeers();
    refreshRoomStatus();
  } catch (error) {
    console.error('Camera toggle failed:', error);
    state.videoEnabled = !nextVideoEnabled;
    ui.videoBtn.textContent = state.videoEnabled ? 'Turn off Video' : 'Turn on Video';
    showToast('Camera access failed. Check browser permissions or another app using the camera.', 'error');
  } finally {
    ui.videoBtn.disabled = false;
  }
}

async function toggleScreenShare() {
  if (!state.screenSharing) {
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      state.screenSharing = true;
      state.localVideoTrack = displayStream.getVideoTracks()[0];

      state.localVideoTrack.onended = () => {
        stopScreenShare();
      };

      ui.screenShareBtn.textContent = 'Stop Screen Share';
      ui.screenShareBtn.classList.add('btn-danger');
      ui.screenShareBtn.classList.remove('btn-secondary');
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

  ui.screenShareBtn.textContent = 'Share Screen';
  ui.screenShareBtn.classList.remove('btn-danger');
  ui.screenShareBtn.classList.add('btn-secondary');
  ui.videoBtn.disabled = false;

  updateLocalVideoPreview();
  applyLocalTracksToAllPeers();
  broadcastVideoState(false);
}

function toggleMute() {
  const track = currentTrack();
  if (!track) return;

  track.enabled = !track.enabled;
  updateMuteButton();
  refreshRoomStatus();
  showToast(track.enabled ? 'Microphone unmuted.' : 'Microphone muted.', 'info', 1800);
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

  const openChannels = peerEntries()
    .map(([, peer]) => peer.dataChannel)
    .filter((channel) => channel && channel.readyState === 'open');

  if (!openChannels.length) {
    showToast('No connected peers are ready for file transfer.', 'warning');
    return;
  }

  const meta = { type: 'file-meta', name: file.name.slice(0, 120), size: file.size, fileType: file.type || 'application/octet-stream' };
  openChannels.forEach((channel) => {
    try {
      channel.send(JSON.stringify(meta));
    } catch (error) {
      console.error('Failed to send file metadata:', error);
    }
  });

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
    if (offset < file.size) {
      readSlice(offset);
    } else {
      const url = URL.createObjectURL(file);
      appendFileMessage(file.name, url, file.size, true, state.username || 'You');
      showToast('File sent.', 'success');
    }
  };

  reader.onerror = () => {
    showToast('Could not read the selected file.', 'error');
  };

  const readSlice = (o) => {
    if (!openChannels.some((channel) => channel.readyState === 'open')) {
      showToast('File transfer stopped because all peers disconnected.', 'warning');
      return;
    }
    if (openChannels.some(c => c.bufferedAmount > DATA_CHANNEL_HIGH_WATER)) {
      setTimeout(() => readSlice(o), 50);
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
