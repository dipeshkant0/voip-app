let recognition = null;
let isActive = false;
let broadcastCallback = null;
let getUsernameCallback = null;
let fadeTimeout = null;
let innerFadeTimeout = null;

export function init(broadcastFn, getUsernameFn) {
  broadcastCallback = broadcastFn;
  getUsernameCallback = getUsernameFn;
  
  const ccBtn = document.getElementById('ccBtn');
  if (ccBtn) {
    ccBtn.addEventListener('click', toggleCaptions);
  }
}

export function displayCaption(speaker, text) {
  const overlay = document.getElementById('ccOverlay');
  const speakerEl = document.getElementById('ccSpeaker');
  const textEl = document.getElementById('ccText');
  
  if (!overlay || !speakerEl || !textEl) return;
  
  clearTimeout(fadeTimeout);
  clearTimeout(innerFadeTimeout);
  
  speakerEl.textContent = speaker + ':';
  textEl.textContent = text;
  
  overlay.style.display = 'block';
  overlay.classList.remove('hidden');
  
  fadeTimeout = setTimeout(() => {
    overlay.classList.add('hidden');
    // Hide display after animation ends
    innerFadeTimeout = setTimeout(() => {
      if (overlay.classList.contains('hidden')) {
        overlay.style.display = 'none';
      }
    }, 200);
  }, 4000);
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
    const ccBtn = document.getElementById('ccBtn');
    if (ccBtn) {
      ccBtn.classList.add('active');
      ccBtn.style.color = 'var(--success)';
    }
  };
  
  recognition.onresult = (event) => {
    let finalTranscript = '';
    let interimTranscript = '';
    
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript;
      } else {
        interimTranscript += event.results[i][0].transcript;
      }
    }
    
    // Display interim results locally
    if (interimTranscript.trim()) {
      displayCaption('You (Speaking)', interimTranscript);
    }
    
    // Display and broadcast final results
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
    }
  };
  
  recognition.onend = () => {
    // Automatically restart if it was active
    if (isActive) {
      try {
        recognition.start();
      } catch (e) {
        console.warn('Speech recognition failed to restart:', e);
      }
    } else {
      const ccBtn = document.getElementById('ccBtn');
      if (ccBtn) {
        ccBtn.classList.remove('active');
        ccBtn.style.color = '';
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
    recognition.stop();
    recognition = null;
  }
  const ccBtn = document.getElementById('ccBtn');
  if (ccBtn) {
    ccBtn.classList.remove('active');
    ccBtn.style.color = '';
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
