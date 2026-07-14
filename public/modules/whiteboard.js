let canvas = null;
let ctx = null;
let isDrawing = false;
let lastX = 0;
let lastY = 0;
let brushColor = '#ffffff';
let brushSize = 3;
let broadcastCallback = null;
let lastLocalInputTime = 0;
let lastCursorBroadcast = 0;
let lastSentX = -1;
let lastSentY = -1;
let lastTextCursorBroadcast = 0;
let lastSentCaretIndex = -1;
const remoteTextCaretMap = new Map();

let lastTextBroadcastTime = 0;
let pendingTextBroadcast = null;
let lastSentText = '';
let mimicDiv = null;

function broadcastTextThrottled() {
  const now = Date.now();
  const timeSinceLast = now - lastTextBroadcastTime;
  const textarea = document.getElementById('wbTextarea');
  if (!textarea) return;
  
  const content = textarea.value;
  const caretIndex = textarea.selectionStart;
  
  // Network Optimization: Avoid sending packet if content is identical
  if (content === lastSentText) {
    return;
  }
  
  if (timeSinceLast >= 150) {
    lastTextBroadcastTime = now;
    lastSentText = content;
    if (broadcastCallback) {
      broadcastCallback({ type: 'wb-text', content, caretIndex });
    }
    pendingTextBroadcast = null;
  } else {
    if (!pendingTextBroadcast) {
      pendingTextBroadcast = setTimeout(() => {
        broadcastTextThrottled();
      }, 150 - timeSinceLast);
    }
  }
}

function handleCursorMove(x, y, active = true) {
  if (!active) {
    if (broadcastCallback) {
      broadcastCallback({ type: 'wb-cursor', active: false });
    }
    lastSentX = -1;
    lastSentY = -1;
    return;
  }
  
  // Bandwidth Optimization: Skip broadcast if the mouse is stationary
  if (Math.abs(x - lastSentX) < 0.003 && Math.abs(y - lastSentY) < 0.003) {
    return;
  }
  
  const now = Date.now();
  if (now - lastCursorBroadcast > 90) {
    lastCursorBroadcast = now;
    lastSentX = x;
    lastSentY = y;
    if (broadcastCallback) {
      broadcastCallback({ type: 'wb-cursor', x, y, active: true });
    }
  }
}

export function init(broadcastFn) {
  broadcastCallback = broadcastFn;
  
  canvas = document.getElementById('wbCanvas');
  if (!canvas) return;
  
  ctx = canvas.getContext('2d');
  
  // Set up resize handler to keep drawing data if resized
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  
  // Event listeners for drawing (Mouse)
  canvas.addEventListener('mousedown', startDrawing);
  canvas.addEventListener('mousemove', draw);
  canvas.addEventListener('mouseup', stopDrawing);
  canvas.addEventListener('mouseout', stopDrawing);
  
  // Touch support for tablets/mobile
  canvas.addEventListener('touchstart', startDrawingTouch, { passive: false });
  canvas.addEventListener('touchmove', drawTouch, { passive: false });
  canvas.addEventListener('touchend', stopDrawing);
  
  // Cursor position broadcast listeners
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / canvas.width;
    const y = (e.clientY - rect.top) / canvas.height;
    handleCursorMove(x, y, true);
  });
  
  canvas.addEventListener('mouseleave', () => {
    if (broadcastCallback) {
      broadcastCallback({ type: 'wb-cursor', active: false });
    }
  });
  
  canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.touches[0].clientX - rect.left) / canvas.width;
    const y = (e.touches[0].clientY - rect.top) / canvas.height;
    handleCursorMove(x, y, true);
  }, { passive: true });
  
  canvas.addEventListener('touchend', () => {
    if (broadcastCallback) {
      broadcastCallback({ type: 'wb-cursor', active: false });
    }
  }, { passive: true });
  
  // Controls
  const brushSizeInput = document.getElementById('wbBrushSize');
  const brushSizeVal = document.getElementById('wbBrushSizeVal');
  if (brushSizeInput && brushSizeVal) {
    brushSizeInput.addEventListener('input', (e) => {
      brushSize = e.target.value;
      brushSizeVal.textContent = brushSize + 'px';
    });
  }
  
  const colorBtns = document.querySelectorAll('.wb-color-btn');
  colorBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      colorBtns.forEach(b => {
        b.classList.remove('active');
      });
      const selectedColor = e.currentTarget.getAttribute('data-color');
      brushColor = selectedColor;
      
      e.currentTarget.classList.add('active');
    });
  });
  
  const clearBtn = document.getElementById('wbClearBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      clearCanvas();
      if (broadcastCallback) {
        broadcastCallback({ type: 'wb-clear' });
      }
    });
  }
  
  // Tabs toggle
  const tabDraw = document.getElementById('wbTabDraw');
  const tabEditor = document.getElementById('wbTabEditor');
  const drawPanel = document.getElementById('wbDrawPanel');
  const editorPanel = document.getElementById('wbEditorPanel');
  
  if (tabDraw && tabEditor && drawPanel && editorPanel) {
    tabDraw.addEventListener('click', () => {
      tabDraw.classList.add('active');
      tabDraw.style.borderBottom = '2px solid var(--accent)';
      tabDraw.style.color = 'white';
      
      tabEditor.classList.remove('active');
      tabEditor.style.borderBottom = 'none';
      tabEditor.style.color = 'var(--muted)';
      
      drawPanel.style.display = 'flex';
      drawPanel.classList.remove('hidden');
      
      editorPanel.style.display = 'none';
      editorPanel.classList.add('hidden');
      
      resizeCanvas();
    });
    
    tabEditor.addEventListener('click', () => {
      tabEditor.classList.add('active');
      tabEditor.style.borderBottom = '2px solid var(--accent)';
      tabEditor.style.color = 'white';
      
      tabDraw.classList.remove('active');
      tabDraw.style.borderBottom = 'none';
      tabDraw.style.color = 'var(--muted)';
      
      editorPanel.style.display = 'flex';
      editorPanel.classList.remove('hidden');
      
      drawPanel.style.display = 'none';
      drawPanel.classList.add('hidden');
    });
  }
  
  // Shared Notepad sync
  const textarea = document.getElementById('wbTextarea');
  if (textarea) {
    textarea.addEventListener('input', () => {
      lastLocalInputTime = Date.now();
      if (pendingTextBroadcast) {
        clearTimeout(pendingTextBroadcast);
        pendingTextBroadcast = null;
      }
      broadcastTextThrottled();
    });
    
    // Broadcast text cursor changes (keyup, click, focus) to other collaborators
    const handleTextCursorUpdate = () => {
      const caretIndex = textarea.selectionStart;
      if (caretIndex === lastSentCaretIndex) return;
      
      const now = Date.now();
      if (now - lastTextCursorBroadcast > 90) { // 90ms throttled
        lastTextCursorBroadcast = now;
        lastSentCaretIndex = caretIndex;
        if (broadcastCallback) {
          broadcastCallback({ type: 'wb-text-cursor', caretIndex, active: true });
        }
      }
    };
    
    const handleTextCursorBlur = () => {
      if (broadcastCallback) {
        broadcastCallback({ type: 'wb-text-cursor', active: false });
      }
      lastSentCaretIndex = -1;
    };
    
    textarea.addEventListener('keyup', handleTextCursorUpdate);
    textarea.addEventListener('click', handleTextCursorUpdate);
    textarea.addEventListener('focus', handleTextCursorUpdate);
    textarea.addEventListener('blur', handleTextCursorBlur);
    
    // Re-position other users' cursors on scroll
    textarea.addEventListener('scroll', () => {
      remoteTextCaretMap.forEach((val, peerId) => {
        const coords = getCaretCoordinates(textarea, val.caretIndex);
        const cursorEl = document.getElementById(`wb-text-cursor-${peerId}`);
        if (cursorEl) {
          cursorEl.style.transform = `translate3d(${coords.left}px, ${coords.top}px, 0)`;
        }
      });
    });
  }
  
  // Setup overlay toggle buttons
  const whiteboardBtn = document.getElementById('whiteboardBtn');
  const whiteboardContainer = document.getElementById('whiteboardContainer');
  const closeWbBtn = document.getElementById('closeWbBtn');
  
  if (whiteboardBtn && whiteboardContainer) {
    whiteboardBtn.addEventListener('click', () => {
      const isHidden = whiteboardContainer.style.display === 'none' || whiteboardContainer.classList.contains('hidden');
      if (isHidden) {
        whiteboardContainer.style.display = 'flex';
        whiteboardContainer.classList.remove('hidden');
        whiteboardBtn.classList.add('active');
        resizeCanvas();
      } else {
        whiteboardContainer.style.display = 'none';
        whiteboardContainer.classList.add('hidden');
        whiteboardBtn.classList.remove('active');
      }
    });
  }
  
  if (closeWbBtn && whiteboardContainer && whiteboardBtn) {
    closeWbBtn.addEventListener('click', () => {
      whiteboardContainer.style.display = 'none';
      whiteboardContainer.classList.add('hidden');
      whiteboardBtn.classList.remove('active');
    });
  }
}

function resizeCanvas() {
  if (!canvas) return;
  
  const rect = canvas.parentElement.getBoundingClientRect();
  const width = Math.floor(rect.width) || 800;
  const height = Math.floor(rect.height) || 600;
  
  if (canvas.width === width && canvas.height === height) return;
  
  // Cache current canvas image
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = canvas.width;
  tempCanvas.height = canvas.height;
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.drawImage(canvas, 0, 0);
  
  canvas.width = width;
  canvas.height = height;
  
  // Restore canvas image stretched to new size
  ctx.drawImage(tempCanvas, 0, 0, tempCanvas.width, tempCanvas.height, 0, 0, canvas.width, canvas.height);
}

function startDrawing(e) {
  isDrawing = true;
  const rect = canvas.getBoundingClientRect();
  lastX = e.clientX - rect.left;
  lastY = e.clientY - rect.top;
}

function startDrawingTouch(e) {
  if (e.touches.length !== 1) return;
  isDrawing = true;
  const rect = canvas.getBoundingClientRect();
  lastX = e.touches[0].clientX - rect.left;
  lastY = e.touches[0].clientY - rect.top;
  e.preventDefault();
}

function draw(e) {
  if (!isDrawing) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  
  drawSegment(lastX, lastY, x, y, brushColor, brushSize);
  
  if (broadcastCallback) {
    // Network Optimization: round normalized coordinates to 3 decimal places to reduce JSON string size by 75%
    broadcastCallback({
      type: 'wb-draw',
      x0: Math.round((lastX / canvas.width) * 1000) / 1000,
      y0: Math.round((lastY / canvas.height) * 1000) / 1000,
      x1: Math.round((x / canvas.width) * 1000) / 1000,
      y1: Math.round((y / canvas.height) * 1000) / 1000,
      color: brushColor,
      size: brushSize
    });
  }
  
  lastX = x;
  lastY = y;
}

function drawTouch(e) {
  if (!isDrawing || e.touches.length !== 1) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.touches[0].clientX - rect.left;
  const y = e.touches[0].clientY - rect.top;
  
  drawSegment(lastX, lastY, x, y, brushColor, brushSize);
  
  if (broadcastCallback) {
    broadcastCallback({
      type: 'wb-draw',
      x0: Math.round((lastX / canvas.width) * 1000) / 1000,
      y0: Math.round((lastY / canvas.height) * 1000) / 1000,
      x1: Math.round((x / canvas.width) * 1000) / 1000,
      y1: Math.round((y / canvas.height) * 1000) / 1000,
      color: brushColor,
      size: brushSize
    });
  }
  
  lastX = x;
  lastY = y;
  e.preventDefault();
}

function stopDrawing() {
  isDrawing = false;
}

function drawSegment(x0, y0, x1, y1, color, size) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  
  if (color === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = size * 2.5; // Eraser is slightly larger
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
  }
  
  ctx.stroke();
  ctx.closePath();
  ctx.globalCompositeOperation = 'source-over'; // Reset to default
}

export function handleIncomingDraw(data) {
  if (!canvas) return;
  // Denormalize coordinates
  const x0 = data.x0 * canvas.width;
  const y0 = data.y0 * canvas.height;
  const x1 = data.x1 * canvas.width;
  const y1 = data.y1 * canvas.height;
  
  drawSegment(x0, y0, x1, y1, data.color, data.size);
}

export function clearCanvas() {
  if (!canvas || !ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

export function handleIncomingText(content, caretIndex, username, peerId) {
  const textarea = document.getElementById('wbTextarea');
  if (!textarea || textarea.value === content) return;
  
  // Mitigate typing conflict glare if the local user is actively writing
  if (document.activeElement === textarea && Date.now() - lastLocalInputTime < 1500) {
    return;
  }
  
  lastSentText = content; // Network Optimization: Prevent echo-broadcast feedback loop
  
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  textarea.value = content;
  
  // Selection ranges are only valid if textarea is focused
  try {
    textarea.setSelectionRange(start, end);
  } catch (e) {}
  
  // Simultaneously update cursor position inside the same frame to prevent latency and sync lag
  if (caretIndex !== undefined && peerId) {
    handleIncomingTextCursor(peerId, { active: true, caretIndex }, username);
  }
}

export function handleIncomingCursor(peerId, data, username) {
  const container = document.getElementById('wbCursorContainer');
  if (!container) return;
  
  const cursorId = `wb-cursor-${peerId}`;
  let cursorEl = document.getElementById(cursorId);
  
  if (!data.active) {
    if (cursorEl) cursorEl.remove();
    return;
  }
  
  if (!cursorEl) {
    cursorEl = document.createElement('div');
    cursorEl.id = cursorId;
    cursorEl.className = 'peer-cursor';
    cursorEl.style.position = 'absolute';
    cursorEl.style.display = 'flex';
    cursorEl.style.alignItems = 'center';
    cursorEl.style.gap = '4px';
    cursorEl.style.pointerEvents = 'none';
    cursorEl.style.zIndex = '20';
    cursorEl.style.top = '0';
    cursorEl.style.left = '0';
    
    // CPU Optimization: use translate3d (GPU composite) instead of left/top to avoid layout paint storms
    cursorEl.style.transition = 'transform 0.08s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
    cursorEl.style.willChange = 'transform';
    
    let hash = 0;
    for (let i = 0; i < peerId.length; i++) {
      hash = peerId.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash % 360);
    const cursorColor = `hsl(${hue}, 85%, 60%)`;
    
    cursorEl.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="${cursorColor}" stroke="white" stroke-width="1.5">
        <polygon points="5 3 20 12 12 14 5 21 5 3"/>
      </svg>
      <span style="background: ${cursorColor}; color: white; font-size: 0.65rem; padding: 2px 6px; border-radius: 4px; font-weight: 600; white-space: nowrap; box-shadow: 0 4px 10px rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15);">${username}</span>
    `;
    container.appendChild(cursorEl);
  }
  
  const x = Math.round(data.x * container.clientWidth);
  const y = Math.round(data.y * container.clientHeight);
  cursorEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

export function cleanupPeerCursor(peerId) {
  const cursorEl = document.getElementById(`wb-cursor-${peerId}`);
  if (cursorEl) {
    cursorEl.remove();
  }
  const textCursorEl = document.getElementById(`wb-text-cursor-${peerId}`);
  if (textCursorEl) {
    textCursorEl.remove();
  }
  remoteTextCaretMap.delete(peerId);
}

export function handleIncomingTextCursor(peerId, data, username) {
  const container = document.getElementById('wbTextCursorContainer');
  const textarea = document.getElementById('wbTextarea');
  if (!container || !textarea) return;
  
  const cursorId = `wb-text-cursor-${peerId}`;
  let cursorEl = document.getElementById(cursorId);
  
  if (!data.active || data.caretIndex === undefined) {
    if (cursorEl) cursorEl.remove();
    remoteTextCaretMap.delete(peerId);
    return;
  }
  
  remoteTextCaretMap.set(peerId, { caretIndex: data.caretIndex, username });
  
  const coords = getCaretCoordinates(textarea, data.caretIndex);
  
  if (!cursorEl) {
    cursorEl = document.createElement('div');
    cursorEl.id = cursorId;
    cursorEl.className = 'peer-text-cursor';
    cursorEl.style.position = 'absolute';
    cursorEl.style.display = 'flex';
    cursorEl.style.flexDirection = 'column';
    cursorEl.style.alignItems = 'flex-start';
    cursorEl.style.pointerEvents = 'none';
    cursorEl.style.zIndex = '20';
    cursorEl.style.top = '0';
    cursorEl.style.left = '0';
    cursorEl.style.transition = 'transform 0.08s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
    cursorEl.style.willChange = 'transform';
    
    let hash = 0;
    for (let i = 0; i < peerId.length; i++) {
      hash = peerId.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash % 360);
    const cursorColor = `hsl(${hue}, 85%, 60%)`;
    
    cursorEl.innerHTML = `
      <div style="width: 2px; height: 16px; background: ${cursorColor}; box-shadow: 0 0 4px ${cursorColor};"></div>
      <span style="background: ${cursorColor}; color: white; font-size: 0.6rem; padding: 1px 4px; border-radius: 3px; font-weight: 600; white-space: nowrap; transform: translateY(-2px); border: 1px solid rgba(255,255,255,0.15);">${username}</span>
    `;
    container.appendChild(cursorEl);
  }
  
  cursorEl.style.transform = `translate3d(${coords.left}px, ${coords.top}px, 0)`;
}

// Textarea Caret Coordinates helper (Memory & CPU Optimized with persistent DOM cache)
function getCaretCoordinates(element, position) {
  if (!mimicDiv) {
    mimicDiv = document.createElement('div');
    const style = window.getComputedStyle(element);
    
    const properties = [
      'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch',
      'lineHeight', 'wordWrap', 'whiteSpace', 'paddingTop', 'paddingRight', 'paddingBottom',
      'paddingLeft', 'borderStyle', 'borderWidth', 'boxSizing', 'width', 'height'
    ];
    
    properties.forEach(prop => {
      mimicDiv.style[prop] = style[prop];
    });
    
    mimicDiv.style.position = 'absolute';
    mimicDiv.style.visibility = 'hidden';
    mimicDiv.style.whiteSpace = 'pre-wrap';
    mimicDiv.style.wordBreak = 'break-word';
    mimicDiv.style.overflowY = 'auto';
    mimicDiv.style.pointerEvents = 'none';
    
    document.body.appendChild(mimicDiv);
  }
  
  // Dynamically synchronize size to match element dimensions
  const rect = element.getBoundingClientRect();
  mimicDiv.style.width = `${rect.width}px`;
  mimicDiv.style.height = `${rect.height}px`;
  
  const text = element.value;
  mimicDiv.textContent = text.substring(0, position);
  
  const span = document.createElement('span');
  span.textContent = '|';
  mimicDiv.appendChild(span);
  
  const nextText = document.createTextNode(element.value.substring(position));
  mimicDiv.appendChild(nextText);
  
  mimicDiv.scrollTop = element.scrollTop;
  
  const spanRect = span.getBoundingClientRect();
  const divRect = mimicDiv.getBoundingClientRect();
  
  const coordinates = {
    top: spanRect.top - divRect.top + element.offsetTop - element.scrollTop,
    left: spanRect.left - divRect.left + element.offsetLeft - element.scrollLeft
  };
  
  return coordinates;
}
