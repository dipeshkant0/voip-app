let isStatsEnabled = false;
let statsIntervalId = null;
const lastStatsMap = new Map();
let getPeersCallback = null;

export function init(getPeersFn) {
  getPeersCallback = getPeersFn;
  
  const statsBtn = document.getElementById('statsBtn');
  if (statsBtn) {
    statsBtn.addEventListener('click', toggleStats);
  }
}

function toggleStats() {
  isStatsEnabled = !isStatsEnabled;
  const statsBtn = document.getElementById('statsBtn');
  
  if (statsBtn) {
    if (isStatsEnabled) {
      statsBtn.classList.add('active');
      statsBtn.style.color = 'var(--success)';
      startPolling();
    } else {
      statsBtn.classList.remove('active');
      statsBtn.style.color = '';
      stopPolling();
      hideAllBadges();
    }
  }
}

function startPolling() {
  stopPolling();
  updateStats();
  statsIntervalId = setInterval(updateStats, 2000);
}

function stopPolling() {
  if (statsIntervalId) {
    clearInterval(statsIntervalId);
    statsIntervalId = null;
  }
  lastStatsMap.clear();
}

function hideAllBadges() {
  const badges = document.querySelectorAll('.stats-badge');
  badges.forEach(b => {
    b.style.display = 'none';
  });
}

export function cleanupPeerStats(peerId) {
  lastStatsMap.delete(peerId + '-inbound');
  const badge = document.getElementById(`stats-badge-${peerId}`);
  if (badge) {
    badge.remove();
  }
}

async function updateStats() {
  if (!getPeersCallback) return;
  const peers = getPeersCallback(); // Map (peerId -> peerObj)
  
  for (const [peerId, peer] of peers.entries()) {
    if (!peer.pc || peer.pc.connectionState === 'closed') {
      cleanupPeerStats(peerId);
      continue;
    }
    
    try {
      const stats = await peer.pc.getStats();
      let width = 0;
      let height = 0;
      let fps = 0;
      let loss = 0;
      let rtt = 0;
      let kbps = 0;
      
      stats.forEach(report => {
        // Video inbound stream stats
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          width = report.frameWidth || 0;
          height = report.frameHeight || 0;
          loss = report.packetsLost || 0;
          
          const prev = lastStatsMap.get(peerId + '-inbound') || { bytes: 0, time: 0, frames: 0 };
          const byteDiff = report.bytesReceived - prev.bytes;
          const timeDiff = report.timestamp - prev.time;
          
          // Calculate bitrate
          if (prev.bytes > 0 && timeDiff > 0) {
            kbps = Math.round((byteDiff * 8) / timeDiff); // kbps
          }
          
          // Calculate frame rate
          if (prev.frames > 0 && timeDiff > 0) {
            fps = Math.round((report.framesDecoded - prev.frames) * 1000 / timeDiff);
          }
          
          lastStatsMap.set(peerId + '-inbound', { 
            bytes: report.bytesReceived, 
            time: report.timestamp, 
            frames: report.framesDecoded 
          });
        }
        
        // Connection round trip time (RTT)
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          rtt = report.currentRoundTripTime ? Math.round(report.currentRoundTripTime * 1000) : 0;
        }
      });
      
      updateBadge(peerId, width, height, fps, rtt, loss, kbps);
      
    } catch (e) {
      console.warn(`Failed to retrieve stats for peer ${peerId}:`, e);
    }
  }
}

function updateBadge(peerId, width, height, fps, rtt, loss, kbps) {
  const badgeId = `stats-badge-${peerId}`;
  let badgeEl = document.getElementById(badgeId);
  
  if (!badgeEl) {
    const wrapper = document.getElementById(`video-wrapper-${peerId}`);
    if (wrapper) {
      badgeEl = document.createElement('div');
      badgeEl.id = badgeId;
      badgeEl.className = 'stats-badge';
      wrapper.appendChild(badgeEl);
    }
  }
  
  if (badgeEl) {
    if (isStatsEnabled) {
      badgeEl.style.display = 'block';
      badgeEl.textContent = `${width || '---'}x${height || '---'} @ ${fps || 0}fps | RTT: ${rtt || '<1'}ms | ${kbps || 0}kbps | Loss: ${loss}`;
    } else {
      badgeEl.style.display = 'none';
    }
  }
}
