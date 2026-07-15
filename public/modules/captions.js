let recognition = null;
let isActive = false;
let broadcastCallback = null;
let getUsernameCallback = null;
let isMutedCallback = null;
let fadeTimeout = null;
let innerFadeTimeout = null;
let restartAttempts = 0;
let lastRestartTime = 0;

const ui = {
  ccBtn: null,
  ccOverlay: null,
  ccSpeaker: null,
  ccText: null
};

export function init(broadcastFn, getUsernameFn, isMutedFn) {
  broadcastCallback = broadcastFn;
  getUsernameCallback = getUsernameFn;
  isMutedCallback = isMutedFn;
  
  ui.ccBtn = document.getElementById('ccBtn');
  ui.ccOverlay = document.getElementById('ccOverlay');
  ui.ccSpeaker = document.getElementById('ccSpeaker');
  ui.ccText = document.getElementById('ccText');
  
  if (ui.ccBtn) {
    ui.ccBtn.addEventListener('click', toggleCaptions);
  }
}

export function displayCaption(speaker, text) {
  if (!ui.ccOverlay || !ui.ccSpeaker || !ui.ccText) return;
  
  clearTimeout(fadeTimeout);
  clearTimeout(innerFadeTimeout);
  
  ui.ccSpeaker.textContent = speaker + ':';
  ui.ccText.textContent = text;
  
  ui.ccOverlay.style.display = 'block';
  ui.ccOverlay.classList.remove('hidden');
  
  fadeTimeout = setTimeout(() => {
    ui.ccOverlay.classList.add('hidden');
    innerFadeTimeout = setTimeout(() => {
      if (ui.ccOverlay.classList.contains('hidden')) {
        ui.ccOverlay.style.display = 'none';
      }
    }, 200);
  }, 4000);
}

export function syncMuteState(isMuted) {
  if (!isActive) return;
  
  if (isMuted) {
    if (recognition) {
      try {
        recognition.stop();
      } catch (e) {
        console.warn('Failed to stop speech recognition on mute:', e);
      }
    }
  } else {
    setTimeout(() => {
      if (isActive && !(isMutedCallback && isMutedCallback())) {
        try {
          if (recognition) {
            recognition.start();
          } else {
            startRecognition();
          }
        } catch (e) {
          if (e.name !== 'InvalidStateError') {
            console.error('Failed to restart speech recognition on unmute:', e);
          }
        }
      }
    }, 150);
  }
}

function startRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    alert('Speech recognition is not supported in this browser. Please use Chrome, Edge, or Safari.');
    isActive = false;
    return;
  }
  
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  
  recognition.onstart = () => {
    restartAttempts = 0;
    if (ui.ccBtn) {
      ui.ccBtn.classList.add('active');
      ui.ccBtn.style.color = 'var(--success)';
    }
  };
  
  recognition.onresult = (event) => {
    if (isMutedCallback && isMutedCallback()) {
      return;
    }
    
    let finalTranscript = '';
    let interimTranscript = '';
    
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript;
      } else {
        interimTranscript += event.results[i][0].transcript;
      }
    }
    
    if (interimTranscript.trim()) {
      displayCaption('You (Speaking)', interimTranscript);
    }
    
    if (finalTranscript.trim()) {
      const username = getUsernameCallback ? getUsernameCallback() : 'You';
      displayCaption('You', finalTranscript);
      if (broadcastCallback) {
        broadcastCallback({ type: 'caption', text: finalTranscript, username });
      }
    }
  };
  
  recognition.onerror = (event) => {
    console.error('Speech recognition error:', event.error);
    if (event.error === 'not-allowed') {
      stopRecognition();
      if (typeof window.showToast === 'function') {
        window.showToast('Microphone access denied for speech recognition.', 'warning');
      }
    }
  };
  
  recognition.onend = () => {
    if (isActive && !(isMutedCallback && isMutedCallback())) {
      const now = Date.now();
      if (now - lastRestartTime < 2000) {
        restartAttempts++;
      } else {
        restartAttempts = 0;
      }
      lastRestartTime = now;
      
      if (restartAttempts >= 5) {
        console.warn('Speech recognition dropped repeatedly. Aborting auto-restart.');
        stopRecognition();
        if (typeof window.showToast === 'function') {
          window.showToast('Speech recognition service dropped out. Please check microphone permissions.', 'warning');
        }
        return;
      }
      
      const delay = Math.min(5000, 100 + restartAttempts * 1000);
      
      setTimeout(() => {
        if (isActive && !(isMutedCallback && isMutedCallback())) {
          try {
            recognition.start();
          } catch (e) {
            if (e.name !== 'InvalidStateError') {
              console.warn('Speech recognition failed to restart in delayed loop:', e);
            }
          }
        }
      }, delay);
    } else {
      if (ui.ccBtn && !isActive) {
        ui.ccBtn.classList.remove('active');
        ui.ccBtn.style.color = '';
      }
    }
  };
  
  try {
    recognition.start();
  } catch (e) {
    console.error('Failed to start recognition:', e);
  }
}

function stopRecognition() {
  isActive = false;
  if (recognition) {
    try {
      recognition.stop();
    } catch (e) {}
    recognition = null;
  }
  if (ui.ccBtn) {
    ui.ccBtn.classList.remove('active');
    ui.ccBtn.style.color = '';
  }
}

function toggleCaptions() {
  if (isActive) {
    stopRecognition();
  } else {
    isActive = true;
    startRecognition();
  }
}

export function cleanup() {
  stopRecognition();
  getUsernameCallback = null;
  broadcastCallback = null;
  isMutedCallback = null;
}
