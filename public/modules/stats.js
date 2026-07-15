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

export function stopPolling() {
  if (statsIntervalId) {
    clearInterval(statsIntervalId);
    statsIntervalId = null;
  }
  lastStatsMap.clear();
}

export function cleanup() {
  stopPolling();
  isStatsEnabled = false;
  
  const statsBtn = document.getElementById('statsBtn');
  if (statsBtn) {
    statsBtn.classList.remove('active');
    statsBtn.style.color = '';
  }
  
  hideAllBadges();
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
  const peers = getPeersCallback();
  
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
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          width = report.frameWidth || 0;
          height = report.frameHeight || 0;
          loss = report.packetsLost || 0;
          
          const prev = lastStatsMap.get(peerId + '-inbound') || { bytes: 0, time: 0, frames: 0 };
          const byteDiff = report.bytesReceived - prev.bytes;
          const timeDiff = report.timestamp - prev.time;
          
          if (prev.bytes > 0 && timeDiff > 0) {
            kbps = Math.round((byteDiff * 8) / timeDiff);
          }
          
          if (prev.frames > 0 && timeDiff > 0) {
            fps = Math.round((report.framesDecoded - prev.frames) * 1000 / timeDiff);
          }
          
          lastStatsMap.set(peerId + '-inbound', { 
            bytes: report.bytesReceived, 
            time: report.timestamp, 
            frames: report.framesDecoded 
          });
        }
        
        // Nominated candidate pair contains active RTT values
        if (report.type === 'candidate-pair' && report.nominated === true && report.state === 'succeeded') {
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
      badgeEl.innerHTML = `
        <div class="stats-grid">
          <div class="stat-item"><i class="fas fa-expand"></i> <span class="stat-res">---</span></div>
          <div class="stat-item"><i class="fas fa-bolt"></i> <span class="stat-fps">0 fps</span></div>
          <div class="stat-item"><i class="fas fa-tachometer-alt"></i> <span class="stat-bitrate">0 kbps</span></div>
          <div class="stat-item stat-rtt-item"><i class="fas fa-clock"></i> <span class="stat-rtt">0ms</span></div>
          <div class="stat-item stat-loss-item" style="grid-column: span 2;"><i class="fas fa-exclamation-triangle"></i> <span class="stat-loss">Loss: 0</span></div>
        </div>
      `;
      wrapper.appendChild(badgeEl);
    }
  }
  
  if (badgeEl) {
    if (isStatsEnabled) {
      badgeEl.style.display = 'block';
      
      const resSpan = badgeEl.querySelector('.stat-res');
      const fpsSpan = badgeEl.querySelector('.stat-fps');
      const bitrateSpan = badgeEl.querySelector('.stat-bitrate');
      const rttSpan = badgeEl.querySelector('.stat-rtt');
      const rttItem = badgeEl.querySelector('.stat-rtt-item');
      const lossSpan = badgeEl.querySelector('.stat-loss');
      const lossItem = badgeEl.querySelector('.stat-loss-item');
      
      if (resSpan) resSpan.textContent = width && height ? `${width}x${height}` : '---';
      if (fpsSpan) fpsSpan.textContent = `${fps || 0} fps`;
      if (bitrateSpan) bitrateSpan.textContent = `${kbps || 0} kbps`;
      
      if (rttSpan && rttItem) {
        rttSpan.textContent = `${rtt || '<1'}ms`;
        rttItem.className = 'stat-item stat-rtt-item';
        if (rtt < 60) {
          rttItem.classList.add('stat-latency-green');
        } else if (rtt < 150) {
          rttItem.classList.add('stat-latency-warn');
        } else {
          rttItem.classList.add('stat-latency-danger');
        }
      }
      
      if (lossSpan && lossItem) {
        lossSpan.textContent = `Loss: ${loss}`;
        lossItem.className = 'stat-item stat-loss-item';
        if (loss > 0) {
          lossItem.classList.add('stat-loss-bad');
        }
      }
    } else {
      badgeEl.style.display = 'none';
    }
  }
}
