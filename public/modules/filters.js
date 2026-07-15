let currentFilter = 'none';
let videoEl = null; // hidden video
let canvasEl = null; // hidden canvas
let ctx = null;
let tempCanvasEl = null; // offscreen canvas for masking
let tempCtx = null;
let faceDetector = null;
let faceX = null;
let faceY = null;
let targetFaceX = null;
let targetFaceY = null;
let detectFrameCount = 0;
let animationFrameId = null;
let rawTrack = null;
let filteredStream = null;
let filteredTrack = null;
let trackChangeCallback = null;

export function init(onTrackChanged) {
  trackChangeCallback = onTrackChanged;
  
  // Set up hidden video for processing
  videoEl = document.createElement('video');
  videoEl.muted = true;
  videoEl.playsInline = true;
  videoEl.autoplay = true;
  videoEl.style.display = 'none';
  document.body.appendChild(videoEl);
  
  // Set up hidden canvas for filtering
  canvasEl = document.createElement('canvas');
  canvasEl.style.display = 'none';
  document.body.appendChild(canvasEl);
  ctx = canvasEl.getContext('2d');
  
  // Set up offscreen canvas for portrait blur masking
  tempCanvasEl = document.createElement('canvas');
  tempCtx = tempCanvasEl.getContext('2d');
  
  try {
    if (window.FaceDetector) {
      faceDetector = new FaceDetector({ maxDetectedFaces: 1 });
    }
  } catch (e) {
    console.warn('FaceDetector not supported or disabled:', e);
  }
  
  // Setup dropdown listeners
  const filterDropdown = document.getElementById('filterDropdown');
  const videoFilterBtn = document.getElementById('videoFilterBtn');
  
  if (videoFilterBtn && filterDropdown) {
    videoFilterBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = filterDropdown.style.display === 'none' || filterDropdown.classList.contains('hidden');
      if (isHidden) {
        filterDropdown.style.display = 'flex';
        filterDropdown.classList.remove('hidden');
      } else {
        filterDropdown.style.display = 'none';
        filterDropdown.classList.add('hidden');
      }
    });
    
    document.addEventListener('click', () => {
      filterDropdown.style.display = 'none';
      filterDropdown.classList.add('hidden');
    });
    
    const options = filterDropdown.querySelectorAll('.filter-opt');
    options.forEach(opt => {
      opt.addEventListener('click', async (e) => {
        const filter = e.target.getAttribute('data-filter');
        await setFilter(filter);
      });
    });
  }
}

export async function processTrack(track) {
  if (!track) {
    stopProcessing(true);
    rawTrack = null;
    return null;
  }
  
  if (currentFilter === 'none') {
    stopProcessing(true);
    rawTrack = track;
    return track;
  }
  
  if (rawTrack === track && filteredTrack) {
    return filteredTrack;
  }
  
  // Stop previous processing if track changes
  if (rawTrack !== track) {
    stopProcessing(false);
    rawTrack = track;
  }
  
  // Start canvas loop
  return startProcessing();
}

async function setFilter(filter) {
  if (currentFilter === filter) return;
  currentFilter = filter;
  
  // Style the options
  const filterDropdown = document.getElementById('filterDropdown');
  if (filterDropdown) {
    const options = filterDropdown.querySelectorAll('.filter-opt');
    options.forEach(opt => {
      if (opt.getAttribute('data-filter') === filter) {
        opt.style.background = 'var(--accent)';
      } else {
        opt.style.background = 'transparent';
      }
    });
  }

  if (rawTrack) {
    const nextTrack = await processTrack(rawTrack);
    if (trackChangeCallback) {
      trackChangeCallback(nextTrack);
    }
  }
}

function startProcessing() {
  if (!rawTrack) return null;
  
  // Set dimensions based on track settings, capping at 960x540 for performance
  const settings = rawTrack.getSettings();
  let width = settings.width || 960;
  let height = settings.height || 540;
  
  if (width > 960) {
    const ratio = height / width;
    width = 960;
    height = Math.round(width * ratio);
  }
  
  canvasEl.width = width;
  canvasEl.height = height;
  
  tempCanvasEl.width = width;
  tempCanvasEl.height = height;
  
  videoEl.srcObject = new MediaStream([rawTrack]);
  
  return new Promise((resolve) => {
    videoEl.onloadedmetadata = () => {
      videoEl.play().then(() => {
        stopLoop();
        loop();
        
        if (!filteredStream) {
          filteredStream = canvasEl.captureStream(25);
          filteredTrack = filteredStream.getVideoTracks()[0];
          
          // Propagate track end event from rawTrack
          rawTrack.onended = () => {
            stopProcessing();
            if (filteredTrack) filteredTrack.stop();
          };
        }
        resolve(filteredTrack);
      }).catch(err => {
        console.error('Failed to play raw track in hidden video:', err);
        resolve(rawTrack);
      });
    };
  });
}

function loop() {
  if (!rawTrack || rawTrack.readyState !== 'live' || currentFilter === 'none') {
    return;
  }
  
  const width = canvasEl.width;
  const height = canvasEl.height;
  
  ctx.clearRect(0, 0, width, height);
  
  // Apply visual filter
  if (currentFilter === 'blur') {
    // 1. Draw sharp frame on offscreen canvas
    tempCtx.clearRect(0, 0, width, height);
    tempCtx.drawImage(videoEl, 0, 0, width, height);
    
    // 2. Periodically run face detection (every 20 frames to optimize CPU)
    detectFrameCount++;
    if (faceDetector && detectFrameCount % 20 === 0) {
      faceDetector.detect(videoEl).then(faces => {
        if (faces && faces.length > 0) {
          const box = faces[0].boundingBox;
          targetFaceX = box.x + box.width / 2;
          targetFaceY = box.y + box.height / 2;
        }
      }).catch((err) => {
        console.debug('Face detection skipped/failed:', err);
      });
    }
    
    // Smooth coordinates on *every* frame using a low-pass filter (Exponential Moving Average) to avoid jitter
    if (targetFaceX !== null) {
      faceX = faceX === null ? targetFaceX : faceX + 0.12 * (targetFaceX - faceX);
      faceY = faceY === null ? targetFaceY : faceY + 0.12 * (targetFaceY - faceY);
    }
    
    // 3. Draw radial mask on offscreen canvas (keeps face/center sharp, edges transparent)
    tempCtx.globalCompositeOperation = 'destination-in';
    const cx = faceX !== null ? faceX : width / 2;
    const cy = faceY !== null ? faceY : (height / 2 - 20); // default slightly higher for head
    
    const gradient = tempCtx.createRadialGradient(
      cx, cy,
      height * 0.18, // inner circle (sharp face)
      cx, cy,
      height * 0.45  // outer circle (blur transition edge)
    );
    gradient.addColorStop(0, 'rgba(0,0,0,1)');
    gradient.addColorStop(0.7, 'rgba(0,0,0,0.85)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    tempCtx.fillStyle = gradient;
    tempCtx.fillRect(0, 0, width, height);
    tempCtx.globalCompositeOperation = 'source-over'; // Reset offscreen composite
    
    // 4. Draw blurred background on main canvas
    ctx.filter = 'blur(10px)';
    ctx.drawImage(videoEl, 0, 0, width, height);
    ctx.filter = 'none'; // Reset main filter
    
    // 5. Draw masked sharp center on top
    ctx.drawImage(tempCanvasEl, 0, 0);
  } else {
    if (currentFilter === 'grayscale') {
      ctx.filter = 'grayscale(100%)';
    } else if (currentFilter === 'sepia') {
      ctx.filter = 'sepia(100%)';
    } else if (currentFilter === 'invert') {
      ctx.filter = 'invert(100%)';
    } else if (currentFilter === 'vintage') {
      ctx.filter = 'sepia(50%) contrast(120%) saturate(80%)';
    } else {
      ctx.filter = 'none';
    }
    ctx.drawImage(videoEl, 0, 0, width, height);
  }
  
  animationFrameId = requestAnimationFrame(loop);
}

function stopLoop() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

function stopProcessing(forceStreamDestroy = false) {
  stopLoop();
  if (videoEl) {
    videoEl.pause();
    videoEl.srcObject = null;
  }
  if (forceStreamDestroy) {
    if (filteredTrack) {
      filteredTrack.stop();
      filteredTrack = null;
    }
    filteredStream = null;
  }
  faceX = null;
  faceY = null;
  targetFaceX = null;
  targetFaceY = null;
  detectFrameCount = 0;
}

export function getCurrentFilter() {
  return currentFilter;
}
