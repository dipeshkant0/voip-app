const LANGUAGE_DICTIONARIES = {
  'text/x-csrc': [
    'int', 'char', 'void', 'float', 'double', 'struct', 'typedef', '#include', '#define',
    'printf', 'malloc', 'free', 'sizeof', 'fopen', 'fread', 'pthread_create', 'pthread_join',
    'fork', 'execvp', 'waitpid', 'omp_get_thread_num'
  ],
  'text/x-c++src': [
    'class', 'public', 'private', 'protected', 'virtual', 'override', 'template', 'typename',
    'std', 'cout', 'cin', 'endl', 'vector', 'string', 'map', 'unordered_map', 'auto',
    'const', 'constexpr', 'nullptr', '#include', 'MPI_Init', 'MPI_Comm_rank'
  ],
  'python': [
    'def', 'class', 'import', 'from', 'return', 'yield', 'pass', 'break', 'continue',
    'if', 'elif', 'else', 'for', 'while', 'in', 'and', 'or', 'not', 'is', 'None', 'True', 'False',
    'print', 'len', 'range', 'enumerate', 'zip', 'self', 'dict', 'list', 'set'
  ],
  'text/x-java': [
    'public', 'private', 'protected', 'class', 'interface', 'implements', 'extends',
    'static', 'final', 'void', 'int', 'boolean', 'double', 'String', 'new', 'return',
    'System.out.println', 'import', 'package', 'Override', 'Exception', 'try', 'catch'
  ],
  'text/x-rustsrc': [
    'fn', 'let', 'mut', 'struct', 'enum', 'impl', 'trait', 'use', 'mod', 'pub', 'return',
    'match', 'if', 'else', 'loop', 'while', 'for', 'in', 'println!', 'String', 'Vec', 'Option',
    'Result', 'Some', 'None', 'Ok', 'Err', 'as', 'const', 'static', 'unsafe'
  ],
  'shell': [
    'if', 'then', 'elif', 'else', 'fi', 'for', 'in', 'do', 'done', 'while', 'case', 'esac',
    'echo', 'exit', 'return', 'local', 'export', 'alias', 'function', 'read', 'cat', 'grep',
    'awk', 'sed', 'mkdir', 'rm', 'cp', 'mv', 'chmod', 'chown', 'ls', 'cd'
  ],
  'javascript': [
    'const', 'let', 'var', 'function', 'class', 'constructor', 'extends', 'super', 'import',
    'export', 'default', 'from', 'return', 'yield', 'async', 'await', 'try', 'catch', 'finally',
    'throw', 'if', 'else', 'switch', 'case', 'break', 'continue', 'for', 'while', 'do', 'in',
    'of', 'typeof', 'instanceof', 'new', 'this', 'console.log', 'document', 'window', 'Promise'
  ]
};

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
const remotePointerMap = new Map();
const peerCursorTimeouts = new Map();
const peerTextCursorTimeouts = new Map();
let cursorThrottleTimeout = null;
let textCursorThrottleTimeout = null;
let codeCursorThrottleTimeout = null;
let isProgrammaticUpdate = false;

let textarea = null;
let cursorContainer = null;
let textCursorContainer = null;
let terminal = null;
let codeEditorWrapper = null;
let splitResizer = null;
let terminalContainer = null;
let modeTextBtn = null;
let modeCodeBtn = null;
let codeControls = null;
let languageSelect = null;

let lastTextBroadcastTime = 0;
let pendingTextBroadcast = null;
let lastSentText = '';
let mimicDiv = null;
let activeEditorMode = 'text';
let breakpointResizeHandler = null;

const getDefaultCodePlaceholder = (lang) => {
  const commentStyle = (lang === 'python' || lang === 'bash') ? '#' : '//';
  return `${commentStyle} code here`;
};

const isPlaceholderOrEmpty = (val) => {
  const trimmed = val.trim();
  return !trimmed || trimmed === '// code here' || trimmed === '# code here';
};

let codeMirrorInstance = null;
let lastCodeCursorBroadcast = 0;
let lastSentCodeCaretIndex = -1;

function broadcastCodeCursorThrottled() {
  if (isProgrammaticUpdate) return;
  if (!codeMirrorInstance) return;
  
  const doc = codeMirrorInstance.getDoc();
  const caretIndex = doc.indexFromPos(doc.getCursor());
  if (caretIndex === lastSentCodeCaretIndex) return;

  const now = Date.now();
  if (now - lastTextBroadcastTime < 50) return;

  const elapsed = now - lastCodeCursorBroadcast;

  const doBroadcast = () => {
    lastCodeCursorBroadcast = Date.now();
    lastSentCodeCaretIndex = caretIndex;
    if (broadcastCallback) {
      broadcastCallback({
        type: 'wb-text-cursor',
        active: true,
        caretIndex
      });
    }
  };

  if (elapsed >= 90) {
    if (codeCursorThrottleTimeout) {
      clearTimeout(codeCursorThrottleTimeout);
      codeCursorThrottleTimeout = null;
    }
    doBroadcast();
  } else {
    if (codeCursorThrottleTimeout) {
      clearTimeout(codeCursorThrottleTimeout);
    }
    codeCursorThrottleTimeout = setTimeout(() => {
      doBroadcast();
      codeCursorThrottleTimeout = null;
    }, 90 - elapsed);
  }
}

let lastStdinBroadcastTime = 0;
let pendingStdinBroadcast = null;
let lastSentStdin = '';

function broadcastStdinThrottled() {
  const now = Date.now();
  const timeSinceLast = now - lastStdinBroadcastTime;
  const stdinEl = document.getElementById('wbStdin');
  if (!stdinEl) return;
  
  const content = stdinEl.value;
  if (content === lastSentStdin) return;
  
  if (timeSinceLast >= 150) {
    lastSentStdin = content;
    lastStdinBroadcastTime = now;
    if (broadcastCallback) {
      broadcastCallback({ type: 'wb-editor-stdin', content });
    }
  } else {
    if (!pendingStdinBroadcast) {
      pendingStdinBroadcast = setTimeout(() => {
        pendingStdinBroadcast = null;
        broadcastStdinThrottled();
      }, 150 - timeSinceLast);
    }
  }
}

function broadcastTextThrottled() {
  const now = Date.now();
  const timeSinceLast = now - lastTextBroadcastTime;
  if (!textarea) return;
  
  let content;
  let caretIndex = 0;
  
  if (activeEditorMode === 'code' && codeMirrorInstance) {
    content = codeMirrorInstance.getValue();
    const doc = codeMirrorInstance.getDoc();
    caretIndex = doc.indexFromPos(doc.getCursor());
  } else {
    content = textarea.value;
    caretIndex = textarea.selectionStart;
  }
  
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
    if (cursorThrottleTimeout) {
      clearTimeout(cursorThrottleTimeout);
      cursorThrottleTimeout = null;
    }
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
  const elapsed = now - lastCursorBroadcast;
  
  const doBroadcast = () => {
    lastCursorBroadcast = Date.now();
    lastSentX = x;
    lastSentY = y;
    if (broadcastCallback) {
      broadcastCallback({ type: 'wb-cursor', x, y, active: true });
    }
  };
  
  if (elapsed >= 90) {
    if (cursorThrottleTimeout) {
      clearTimeout(cursorThrottleTimeout);
      cursorThrottleTimeout = null;
    }
    doBroadcast();
  } else {
    if (cursorThrottleTimeout) {
      clearTimeout(cursorThrottleTimeout);
    }
    cursorThrottleTimeout = setTimeout(() => {
      doBroadcast();
      cursorThrottleTimeout = null;
    }, 90 - elapsed);
  }
}

export function init(broadcastFn) {
  broadcastCallback = broadcastFn;
  
  canvas = document.getElementById('wbCanvas');
  textarea = document.getElementById('wbTextarea');
  cursorContainer = document.getElementById('wbCursorContainer');
  textCursorContainer = document.getElementById('wbTextCursorContainer');
  terminal = document.getElementById('wbTerminal');
  codeEditorWrapper = document.getElementById('wbCodeEditorWrapper');
  splitResizer = document.getElementById('wbSplitResizer');
  terminalContainer = document.getElementById('wbTerminalContainer');
  modeTextBtn = document.getElementById('wbModeTextBtn');
  modeCodeBtn = document.getElementById('wbModeCodeBtn');
  codeControls = document.getElementById('wbCodeControls');
  languageSelect = document.getElementById('wbLanguageSelect');
  
  if (!canvas) return;
  
  ctx = canvas.getContext('2d');
  
  // Set up resize handler to keep drawing data if resized
  resizeCanvas();
  window.removeEventListener('resize', resizeCanvas);
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
    const x = rect.width ? (e.clientX - rect.left) / rect.width : 0;
    const y = rect.height ? (e.clientY - rect.top) / rect.height : 0;
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
    const x = rect.width ? (e.touches[0].clientX - rect.left) / rect.width : 0;
    const y = rect.height ? (e.touches[0].clientY - rect.top) / rect.height : 0;
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
  if (textarea) {
    textarea.addEventListener('input', () => {
      lastLocalInputTime = Date.now();
      if (pendingTextBroadcast) {
        clearTimeout(pendingTextBroadcast);
        pendingTextBroadcast = null;
      }
      broadcastTextThrottled();
    });

    const initCodeMirror = () => {
      const codeTextarea = document.getElementById('wbCodeTextarea');
      if (!codeTextarea) return;
             
      if (typeof CodeMirror === 'undefined') {
        setTimeout(initCodeMirror, 50);
        return;
      }
             
      // Register custom composite hinter
      if (CodeMirror.registerHelper && !CodeMirror.hint.advancedComposite) {
        CodeMirror.registerHelper("hint", "advancedComposite", function(cm) {
          const cursor = cm.getCursor();
          const token = cm.getTokenAt(cursor);
          let currentWord = token.string.trim();

          const localHints = (CodeMirror.hint && CodeMirror.hint.anyword)
            ? (CodeMirror.hint.anyword(cm) || { list: [], from: cursor, to: cursor })
            : { list: [], from: cursor, to: cursor };
          
          if (!currentWord || !/^[a-zA-Z_0-9#\.\!]+$/.test(currentWord)) {
            return localHints;
          }

          const mode = cm.getOption("mode");
          const globalKeywords = LANGUAGE_DICTIONARIES[mode] || [];

          const matchedGlobals = globalKeywords.filter(word => 
            word.toLowerCase().startsWith(currentWord.toLowerCase()) && word !== currentWord
          );

          const combinedList = [...new Set([...matchedGlobals, ...localHints.list])];

          return {
            list: combinedList.slice(0, 20),
            from: CodeMirror.Pos(cursor.line, token.start),
            to: CodeMirror.Pos(cursor.line, token.end)
          };
        });
      }

      if (codeMirrorInstance) return;

      codeMirrorInstance = CodeMirror.fromTextArea(codeTextarea, {
        lineNumbers: true,
        mode: 'javascript',
        theme: 'monokai',
        lineWrapping: true,
        matchBrackets: true,
        autoCloseBrackets: true,
        styleActiveLine: true,
        indentUnit: 4,
        tabSize: 4
      });

      // 1. Fixed Autocomplete: Use 'keyup' and validate character keys to prevent "undefined" selections
      codeMirrorInstance.on('keyup', (cm, event) => {
        if (!/^[a-zA-Z0-9_\.]$/.test(event.key)) return;

        if (!cm.state.completionActive && cm.hasFocus()) {
          if (CodeMirror.hint.advancedComposite) {
            cm.showHint({ hint: CodeMirror.hint.advancedComposite, completeSingle: false });
          }
        }
      });

      codeMirrorInstance.on('change', (cm, changeObj) => {
        if (changeObj.origin !== 'setValue') {
          lastLocalInputTime = Date.now();
          if (pendingTextBroadcast) {
            clearTimeout(pendingTextBroadcast);
            pendingTextBroadcast = null;
          }
          broadcastTextThrottled();
        }
      });

      codeMirrorInstance.on('cursorActivity', () => {
        broadcastCodeCursorThrottled();
      });

      codeMirrorInstance.on('scroll', () => {
        repositionAllRemoteCursors();
      });

      // Initialize default font size
      const fontSizeSelect = document.getElementById('wbFontSizeSelect');
      if (fontSizeSelect) {
        codeMirrorInstance.getWrapperElement().style.setProperty('font-size', fontSizeSelect.value, 'important');
        setTimeout(() => codeMirrorInstance.refresh(), 50);
      }

      // Restore existing code if switching from text mode
      if (activeEditorMode === 'code') {
        const languageSelect = document.getElementById('wbLanguageSelect');
        const lang = languageSelect ? languageSelect.value : 'javascript';
        codeMirrorInstance.setValue(textarea.value.trim() ? textarea.value : getDefaultCodePlaceholder(lang));
        const modeMap = {
          javascript: 'javascript',
          python: 'python',
          c: 'text/x-csrc',
          cpp: 'text/x-c++src',
          rust: 'text/x-rustsrc',
          java: 'text/x-java',
          bash: 'shell'
        };
        codeMirrorInstance.setOption('mode', modeMap[lang] || 'javascript');
        setTimeout(() => codeMirrorInstance.refresh(), 50);
      }
    };

    initCodeMirror();

    const updateCodeMirrorMode = (lang) => {
      if (!codeMirrorInstance) return;
      const modeMap = {
        javascript: 'javascript',
        python: 'python',
        c: 'text/x-csrc',
        cpp: 'text/x-c++src',
        rust: 'text/x-rustsrc',
        java: 'text/x-java',
        bash: 'shell'
      };
      codeMirrorInstance.setOption('mode', modeMap[lang] || 'javascript');
    };

    const updateEditorLayout = (mode) => {
      activeEditorMode = mode;
      
      if (mode === 'code') {
        modeCodeBtn.classList.add('active');
        modeCodeBtn.style.background = 'rgba(255,255,255,0.08)';
        modeCodeBtn.style.color = 'var(--text)';
        modeTextBtn.classList.remove('active');
        modeTextBtn.style.background = 'transparent';
        modeTextBtn.style.color = 'var(--muted)';
        
        codeControls.style.display = 'flex';
        terminalContainer.style.display = 'flex';
        
        textarea.style.display = 'none';
        if (codeEditorWrapper) codeEditorWrapper.style.display = 'flex';
        if (splitResizer) splitResizer.style.display = 'block';
        
        if (codeMirrorInstance) {
          const lang = languageSelect ? languageSelect.value : 'javascript';
          codeMirrorInstance.setValue(textarea.value.trim() ? textarea.value : getDefaultCodePlaceholder(lang));
          updateCodeMirrorMode(languageSelect ? languageSelect.value : 'javascript');
          setTimeout(() => codeMirrorInstance.refresh(), 20);
        }
      } else {
        modeTextBtn.classList.add('active');
        modeTextBtn.style.background = 'rgba(255,255,255,0.08)';
        modeTextBtn.style.color = 'var(--text)';
        modeCodeBtn.classList.remove('active');
        modeCodeBtn.style.background = 'transparent';
        modeCodeBtn.style.color = 'var(--muted)';
        
        codeControls.style.display = 'none';
        terminalContainer.style.display = 'none';
        
        textarea.style.display = 'block';
        if (codeEditorWrapper) codeEditorWrapper.style.display = 'none';
        if (splitResizer) splitResizer.style.display = 'none';
        
        if (codeMirrorInstance) {
          textarea.value = codeMirrorInstance.getValue();
        }
      }
      
      adjustResponsiveWorkspace();
    };

    if (modeTextBtn && modeCodeBtn) {
      modeTextBtn.addEventListener('click', () => {
        if (activeEditorMode === 'text') return;
        updateEditorLayout('text');
        if (broadcastCallback) {
          broadcastCallback({ type: 'wb-editor-mode', mode: 'text' });
        }
      });

      modeCodeBtn.addEventListener('click', () => {
        if (activeEditorMode === 'code') return;
        updateEditorLayout('code');
        if (broadcastCallback) {
          broadcastCallback({ type: 'wb-editor-mode', mode: 'code' });
        }
      });
    }

    if (languageSelect) {
      languageSelect.addEventListener('change', () => {
        updateCodeMirrorMode(languageSelect.value);
        if (codeMirrorInstance) {
          const currentVal = codeMirrorInstance.getValue();
          if (isPlaceholderOrEmpty(currentVal)) {
            codeMirrorInstance.setValue(getDefaultCodePlaceholder(languageSelect.value));
          }
        }
        if (broadcastCallback) {
          broadcastCallback({ type: 'wb-editor-lang', lang: languageSelect.value });
        }
      });
    }

    const fontSizeSelect = document.getElementById('wbFontSizeSelect');
    
    const updateEditorFontSize = (size) => {
      if (codeMirrorInstance) {
        codeMirrorInstance.getWrapperElement().style.setProperty('font-size', size, 'important');
        // Critical Fix: Force CodeMirror to recalculate gutter heights AFTER the DOM paints
        setTimeout(() => codeMirrorInstance.refresh(), 50);
      }
      if (textarea) {
        textarea.style.setProperty('font-size', size, 'important');
      }
    };

    if (fontSizeSelect) {
      fontSizeSelect.addEventListener('change', () => {
        updateEditorFontSize(fontSizeSelect.value);
      });
      updateEditorFontSize(fontSizeSelect.value);
    }

    // Initialize draggable split resizer divider
    const splitResizer = document.getElementById('wbSplitResizer');
    const splitWorkspaceContainer = document.getElementById('wbSplitWorkspaceContainer');
    const codeEditorWrapper = document.getElementById('wbCodeEditorWrapper');
    
    if (splitResizer && splitWorkspaceContainer && codeEditorWrapper && terminalContainer) {
      let isDragging = false;
      let dragFrameId = null;

      const startDrag = (e) => {
        isDragging = true;
        splitResizer.classList.add('dragging');
        document.body.style.cursor = window.getComputedStyle(splitResizer).cursor;
        document.body.style.userSelect = 'none';
        
        window.addEventListener('mousemove', onDrag);
        window.addEventListener('touchmove', onDragTouch, { passive: false });
        window.addEventListener('mouseup', stopDrag);
        window.addEventListener('touchend', stopDrag);
      };

      const stopDrag = () => {
        if (!isDragging) return;
        isDragging = false;
        splitResizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        
        window.removeEventListener('mousemove', onDrag);
        window.removeEventListener('touchmove', onDragTouch);
        window.removeEventListener('mouseup', stopDrag);
        window.removeEventListener('touchend', stopDrag);
        
        if (dragFrameId) {
          cancelAnimationFrame(dragFrameId);
          dragFrameId = null;
        }
        
        if (codeMirrorInstance) {
          codeMirrorInstance.refresh();
        }
      };

      const onDrag = (e) => {
        if (!isDragging) return;
        
        if (dragFrameId) cancelAnimationFrame(dragFrameId);
        
        dragFrameId = requestAnimationFrame(() => {
          const containerRect = splitWorkspaceContainer.getBoundingClientRect();
          const isVertical = window.innerWidth <= 992;
          
          if (isVertical) {
            const clientY = e.clientY || (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
            const percentage = ((clientY - containerRect.top) / containerRect.height) * 100;
            if (percentage > 15 && percentage < 85) {
              codeEditorWrapper.style.flex = 'none';
              codeEditorWrapper.style.setProperty('height', `${percentage}%`, 'important');
              terminalContainer.style.flex = 'none';
              terminalContainer.style.setProperty('height', `${100 - percentage}%`, 'important');
              
              codeEditorWrapper.style.width = '';
              terminalContainer.style.width = '';
            }
          } else {
            const clientX = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
            const percentage = ((clientX - containerRect.left) / containerRect.width) * 100;
            if (percentage > 15 && percentage < 85) {
              codeEditorWrapper.style.flex = 'none';
              codeEditorWrapper.style.setProperty('width', `${percentage}%`, 'important');
              terminalContainer.style.flex = 'none';
              terminalContainer.style.setProperty('width', `${100 - percentage}%`, 'important');
              
              codeEditorWrapper.style.height = '';
              terminalContainer.style.height = '';
            }
          }
          
          if (codeMirrorInstance) {
            codeMirrorInstance.refresh();
          }
          repositionAllRemoteCursors();
        });
      };

      const onDragTouch = (e) => {
        if (e.cancelable) {
          e.preventDefault();
        }
        onDrag(e);
      };

      splitResizer.addEventListener('mousedown', startDrag);
      splitResizer.addEventListener('touchstart', startDrag, { passive: true });
    }

    let lastWidth = window.innerWidth;
    breakpointResizeHandler = () => {
      const currentWidth = window.innerWidth;
      if ((lastWidth <= 992 && currentWidth > 992) || (lastWidth > 992 && currentWidth <= 992)) {
        if (codeEditorWrapper) {
          codeEditorWrapper.style.width = '';
          codeEditorWrapper.style.height = '';
        }
        if (terminalContainer) {
          terminalContainer.style.width = '';
          terminalContainer.style.height = '';
        }
        adjustResponsiveWorkspace();
      } else {
        repositionAllRemoteCursors();
      }
      lastWidth = currentWidth;
    };
    window.addEventListener('resize', breakpointResizeHandler);

    // Initialize draggable terminal resizer divider (between stdin and stdout terminal)
    const terminalResizer = document.getElementById('wbTerminalResizer');
    const stdinContainer = document.getElementById('wbStdinContainer');
    
    if (terminalResizer && terminalContainer && stdinContainer) {
      let isDragging = false;
      let dragFrameId = null;

      const startDrag = (e) => {
        isDragging = true;
        terminalResizer.classList.add('dragging');
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
        
        window.addEventListener('mousemove', onDrag);
        window.addEventListener('touchmove', onDragTouch, { passive: false });
        window.addEventListener('mouseup', stopDrag);
        window.addEventListener('touchend', stopDrag);
      };

      const stopDrag = () => {
        if (!isDragging) return;
        isDragging = false;
        terminalResizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        
        window.removeEventListener('mousemove', onDrag);
        window.removeEventListener('touchmove', onDragTouch);
        window.removeEventListener('mouseup', stopDrag);
        window.removeEventListener('touchend', stopDrag);
        
        if (dragFrameId) {
          cancelAnimationFrame(dragFrameId);
          dragFrameId = null;
        }
      };

      const onDrag = (e) => {
        if (!isDragging) return;
        
        if (dragFrameId) cancelAnimationFrame(dragFrameId);
        
        dragFrameId = requestAnimationFrame(() => {
          const containerRect = terminalContainer.getBoundingClientRect();
          const clientY = e.clientY || (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
          const height = clientY - containerRect.top;
          
          if (height > 40 && height < containerRect.height - 60) {
            stdinContainer.style.flex = 'none';
            stdinContainer.style.setProperty('height', `${height}px`, 'important');
          }
        });
      };

      const onDragTouch = (e) => {
        if (e.cancelable) {
          e.preventDefault();
        }
        onDrag(e);
      };

      terminalResizer.addEventListener('mousedown', startDrag);
      terminalResizer.addEventListener('touchstart', startDrag, { passive: true });
    }

    if (clearTerminalBtn && terminal) {
      clearTerminalBtn.addEventListener('click', () => {
        terminal.textContent = '';
      });
    }

    const stdinEl = document.getElementById('wbStdin');
    if (stdinEl) {
      stdinEl.addEventListener('input', () => {
        if (pendingStdinBroadcast) {
          clearTimeout(pendingStdinBroadcast);
          pendingStdinBroadcast = null;
        }
        broadcastStdinThrottled();
      });
    }

    if (runBtn && terminal) {
      runBtn.addEventListener('click', async () => {
        const code = (activeEditorMode === 'code' && codeMirrorInstance) ? codeMirrorInstance.getValue() : textarea.value;
        const language = languageSelect.value;
        if (!code.trim()) {
          terminal.textContent = 'Error: Cannot run empty code.';
          return;
        }

        runBtn.disabled = true;
        terminal.textContent = 'Running code on secure sandbox...';
        terminal.style.color = '#39ff14';

        if (broadcastCallback) {
          broadcastCallback({ type: 'wb-compile-start' });
        }

        try {
          const res = await fetch('/api/compile', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ code, language, stdin: stdinEl ? stdinEl.value : '' })
          });

          if (!res.ok) {
            const errData = await res.json();
            throw new Error(errData.error || 'Server compiler request failed');
          }

          const result = await res.json();
          renderTerminalResult(result);

          if (broadcastCallback) {
            broadcastCallback({
              type: 'wb-compile-result',
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode
            });
          }
        } catch (err) {
          if (language.toLowerCase() === 'javascript') {
            terminal.textContent = 'Notice: Remote compiler offline. Initiating offline JavaScript sandbox...\n\n';
            terminal.style.color = '#e9b872';
            try {
              let logs = [];
              const customConsole = {
                log: (...args) => logs.push(args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ')),
                error: (...args) => logs.push('Error: ' + args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ')),
                warn: (...args) => logs.push('Warning: ' + args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '))
              };

              const runFn = new Function('console', `
                try {
                  ${code}
                } catch (e) {
                  console.error(e.message);
                }
              `);
              
              runFn(customConsole);
              const outputText = logs.length ? logs.join('\n') : 'Process executed successfully with no stdout output.';
              terminal.textContent += outputText;
              terminal.style.color = '#39ff14';
              
              if (broadcastCallback) {
                broadcastCallback({
                  type: 'wb-compile-result',
                  stdout: outputText,
                  stderr: '',
                  exitCode: 0
                });
              }
              return;
            } catch (jsErr) {
              terminal.textContent += `Offline execution failure: ${jsErr.message}`;
              terminal.style.color = '#ff3333';
            }
          } else {
            terminal.textContent = `Error: ${err.message}`;
            terminal.style.color = '#ff3333';
          }

          if (broadcastCallback) {
            broadcastCallback({
              type: 'wb-compile-result',
              stdout: '',
              stderr: `Error: ${err.message}`,
              exitCode: 1
            });
          }
        } finally {
          runBtn.disabled = false;
        }
      });
    }
    
    // Broadcast text cursor changes (keyup, click, focus) to other collaborators
    const handleTextCursorUpdate = () => {
      if (isProgrammaticUpdate) return;
      const caretIndex = textarea.selectionStart;
      if (caretIndex === lastSentCaretIndex) return;
      
      const now = Date.now();
      const elapsed = now - lastTextCursorBroadcast;
      
      const doBroadcast = () => {
        lastTextCursorBroadcast = Date.now();
        lastSentCaretIndex = caretIndex;
        if (broadcastCallback) {
          broadcastCallback({ type: 'wb-text-cursor', caretIndex, active: true });
        }
      };
      
      if (elapsed >= 90) {
        if (textCursorThrottleTimeout) {
          clearTimeout(textCursorThrottleTimeout);
          textCursorThrottleTimeout = null;
        }
        doBroadcast();
      } else {
        if (textCursorThrottleTimeout) {
          clearTimeout(textCursorThrottleTimeout);
        }
        textCursorThrottleTimeout = setTimeout(() => {
          doBroadcast();
          textCursorThrottleTimeout = null;
        }, 90 - elapsed);
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
      repositionAllRemoteCursors();
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

  // Setup mobile responsive workspace tab controls
  const tabEditorBtn = document.getElementById('wbTabEditorBtn');
  const tabConsoleBtn = document.getElementById('wbTabConsoleBtn');
  
  if (tabEditorBtn) {
    tabEditorBtn.addEventListener('click', () => {
      activeMobileTab = 'editor';
      adjustResponsiveWorkspace();
    });
  }
  if (tabConsoleBtn) {
    tabConsoleBtn.addEventListener('click', () => {
      activeMobileTab = 'console';
      adjustResponsiveWorkspace();
    });
  }

  adjustResponsiveWorkspace();
}

let activeMobileTab = 'editor';

export function adjustResponsiveWorkspace() {
  const isCodeMode = activeEditorMode === 'code';
  const isSmallScreen = window.innerWidth <= 992;
  const mobileTabs = document.getElementById('wbMobileTabs');
  const codeWrapper = document.getElementById('wbCodeEditorWrapper');
  const terminalContainer = document.getElementById('wbTerminalContainer');
  const splitResizer = document.getElementById('wbSplitResizer');
  
  if (!mobileTabs || !codeWrapper || !terminalContainer || !splitResizer) return;
  
  if (isCodeMode && isSmallScreen) {
    mobileTabs.style.setProperty('display', 'flex', 'important');
    splitResizer.style.setProperty('display', 'none', 'important');
    
    const tabEditorBtn = document.getElementById('wbTabEditorBtn');
    const tabConsoleBtn = document.getElementById('wbTabConsoleBtn');
    
    if (activeMobileTab === 'editor') {
      codeWrapper.style.setProperty('display', 'flex', 'important');
      codeWrapper.style.setProperty('width', '100%', 'important');
      codeWrapper.style.setProperty('height', '100%', 'important');
      
      terminalContainer.style.setProperty('display', 'none', 'important');
      terminalContainer.style.setProperty('width', '', '');
      terminalContainer.style.setProperty('height', '', '');
      
      if (tabEditorBtn) {
        tabEditorBtn.style.borderBottomColor = 'var(--accent)';
        tabEditorBtn.style.color = 'var(--text)';
      }
      if (tabConsoleBtn) {
        tabConsoleBtn.style.borderBottomColor = 'transparent';
        tabConsoleBtn.style.color = 'var(--muted)';
      }
    } else {
      codeWrapper.style.setProperty('display', 'none', 'important');
      codeWrapper.style.setProperty('width', '', '');
      codeWrapper.style.setProperty('height', '', '');
      
      terminalContainer.style.setProperty('display', 'flex', 'important');
      terminalContainer.style.setProperty('width', '100%', 'important');
      terminalContainer.style.setProperty('height', '100%', 'important');
      
      if (tabEditorBtn) {
        tabEditorBtn.style.borderBottomColor = 'transparent';
        tabEditorBtn.style.color = 'var(--muted)';
      }
      if (tabConsoleBtn) {
        tabConsoleBtn.style.borderBottomColor = 'var(--accent)';
        tabConsoleBtn.style.color = 'var(--text)';
      }
    }
  } else {
    mobileTabs.style.display = 'none';
    
    if (isCodeMode) {
      codeWrapper.style.display = 'flex';
      codeWrapper.style.width = '';
      codeWrapper.style.height = '';
      
      terminalContainer.style.display = 'flex';
      terminalContainer.style.width = '';
      terminalContainer.style.height = '';
      
      splitResizer.style.display = 'block';
    } else {
      codeWrapper.style.display = 'none';
      terminalContainer.style.display = 'none';
      splitResizer.style.display = 'none';
    }
  }
  
  if (codeMirrorInstance) {
    codeMirrorInstance.refresh();
  }
  repositionAllRemoteCursors();
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
  if (!ctx) return;
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
  if (!textarea) return;
  
  if (activeEditorMode === 'code' && codeMirrorInstance) {
    if (codeMirrorInstance.getValue() === content) return;
    if (codeMirrorInstance.hasFocus() && Date.now() - lastLocalInputTime < 1500) {
      return;
    }
    
    lastSentText = content;
    const doc = codeMirrorInstance.getDoc();
    const currentCursor = doc.getCursor();
    const scrollInfo = codeMirrorInstance.getScrollInfo();
    
    isProgrammaticUpdate = true;
    try {
      codeMirrorInstance.setValue(content);
      doc.setCursor(currentCursor);
      codeMirrorInstance.scrollTo(scrollInfo.left, scrollInfo.top);
    } finally {
      isProgrammaticUpdate = false;
    }
  } else {
    if (textarea.value === content) return;
    if (document.activeElement === textarea && Date.now() - lastLocalInputTime < 1500) {
      return;
    }
    
    lastSentText = content;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    isProgrammaticUpdate = true;
    try {
      textarea.value = content;
      try {
        textarea.setSelectionRange(start, end);
      } catch (e) {}
    } finally {
      isProgrammaticUpdate = false;
    }
  }
  
  if (caretIndex !== undefined && peerId) {
    handleIncomingTextCursor(peerId, { active: true, caretIndex }, username);
  }
}

export function handleIncomingCursor(peerId, data, username) {
  if (!cursorContainer) return;
  
  const cursorId = `wb-cursor-${peerId}`;
  let cursorEl = document.getElementById(cursorId);
  
  if (peerCursorTimeouts.has(peerId)) {
    clearTimeout(peerCursorTimeouts.get(peerId));
    peerCursorTimeouts.delete(peerId);
  }
  
  if (!data.active) {
    if (cursorEl) cursorEl.remove();
    remotePointerMap.delete(peerId);
    return;
  }
  
  // Cache the relative pointer positions
  remotePointerMap.set(peerId, { x: data.x, y: data.y, username });
  
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
    cursorEl.style.opacity = '0';
    
    // CPU Optimization: use translate3d (GPU composite) instead of left/top to avoid layout paint storms
    cursorEl.style.transition = 'transform 0.08s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.3s ease';
    cursorEl.style.willChange = 'transform, opacity';
    
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
    cursorContainer.appendChild(cursorEl);
    // Force browser reflow to trigger initial fade-in transition
    cursorEl.offsetHeight;
  }
  
  const x = Math.round(data.x * cursorContainer.clientWidth);
  const y = Math.round(data.y * cursorContainer.clientHeight);
  cursorEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  cursorEl.style.opacity = '1';
  
  // Fade out cursor if inactive for 3 seconds
  const timeout = setTimeout(() => {
    const el = document.getElementById(cursorId);
    if (el) {
      el.style.opacity = '0';
      setTimeout(() => {
        if (el.style.opacity === '0') {
          el.remove();
          remotePointerMap.delete(peerId);
        }
      }, 300);
    }
    peerCursorTimeouts.delete(peerId);
  }, 3000);
  peerCursorTimeouts.set(peerId, timeout);
}

export function cleanupPeerCursor(peerId) {
  if (peerCursorTimeouts.has(peerId)) {
    clearTimeout(peerCursorTimeouts.get(peerId));
    peerCursorTimeouts.delete(peerId);
  }
  if (peerTextCursorTimeouts.has(peerId)) {
    clearTimeout(peerTextCursorTimeouts.get(peerId));
    peerTextCursorTimeouts.delete(peerId);
  }
  
  const cursorEl = document.getElementById(`wb-cursor-${peerId}`);
  if (cursorEl) {
    cursorEl.remove();
  }
  const textCursorEl = document.getElementById(`wb-text-cursor-${peerId}`);
  if (textCursorEl) {
    textCursorEl.remove();
  }
  remoteTextCaretMap.delete(peerId);
  remotePointerMap.delete(peerId);
}

export function handleIncomingTextCursor(peerId, data, username) {
  if (!textCursorContainer || !textarea) return;
  
  const cursorId = `wb-text-cursor-${peerId}`;
  let cursorEl = document.getElementById(cursorId);
  
  if (peerTextCursorTimeouts.has(peerId)) {
    clearTimeout(peerTextCursorTimeouts.get(peerId));
    peerTextCursorTimeouts.delete(peerId);
  }
  
  if (!data.active || data.caretIndex === undefined) {
    if (cursorEl) cursorEl.remove();
    remoteTextCaretMap.delete(peerId);
    return;
  }
  
  remoteTextCaretMap.set(peerId, { caretIndex: data.caretIndex, username });
  
  let coords;
  if (activeEditorMode === 'code' && codeMirrorInstance) {
    coords = getCodeCaretCoordinates(data.caretIndex);
  } else {
    coords = getCaretCoordinates(textarea, data.caretIndex);
  }
  
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
    cursorEl.style.opacity = '0';
    cursorEl.style.transition = 'transform 0.08s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.3s ease';
    cursorEl.style.willChange = 'transform, opacity';
    
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
    textCursorContainer.appendChild(cursorEl);
    // Force browser reflow to trigger initial fade-in transition
    cursorEl.offsetHeight;
  }
  
  cursorEl.style.transform = `translate3d(${coords.left}px, ${coords.top}px, 0)`;
  cursorEl.style.opacity = '1';
  
  // Fade out caret if inactive for 4 seconds
  const timeout = setTimeout(() => {
    const el = document.getElementById(cursorId);
    if (el) {
      el.style.opacity = '0';
      setTimeout(() => {
        if (el.style.opacity === '0') el.remove();
      }, 300);
    }
    peerTextCursorTimeouts.delete(peerId);
  }, 4000);
  peerTextCursorTimeouts.set(peerId, timeout);
}

export function repositionAllRemoteCursors() {
  if (!textarea) return;
  
  // Reposition editor text carets
  for (const [peerId, caretData] of remoteTextCaretMap.entries()) {
    let coords;
    if (activeEditorMode === 'code' && codeMirrorInstance) {
      coords = getCodeCaretCoordinates(caretData.caretIndex);
    } else {
      coords = getCaretCoordinates(textarea, caretData.caretIndex);
    }
    const cursorEl = document.getElementById(`wb-text-cursor-${peerId}`);
    if (cursorEl) {
      cursorEl.style.transform = `translate3d(${coords.left}px, ${coords.top}px, 0)`;
    }
  }
  
  // Reposition whiteboard mouse pointers
  if (cursorContainer) {
    for (const [peerId, pointerData] of remotePointerMap.entries()) {
      const cursorEl = document.getElementById(`wb-cursor-${peerId}`);
      if (cursorEl) {
        const x = Math.round(pointerData.x * cursorContainer.clientWidth);
        const y = Math.round(pointerData.y * cursorContainer.clientHeight);
        cursorEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      }
    }
  }
}

function getCodeCaretCoordinates(position) {
  if (!codeMirrorInstance) return { top: 0, left: 0 };
  const doc = codeMirrorInstance.getDoc();
  const pos = doc.posFromIndex(position);
  
  const coords = codeMirrorInstance.charCoords(pos, 'window');
  if (!textCursorContainer) return { top: 0, left: 0 };
  
  const containerRect = textCursorContainer.getBoundingClientRect();
  
  return {
    top: coords.top - containerRect.top,
    left: coords.left - containerRect.left
  };
}

// Textarea Caret Coordinates helper (Memory & CPU Optimized with persistent DOM cache)
function getCaretCoordinates(element, position) {
  if (!mimicDiv) {
    mimicDiv = document.createElement('div');
    mimicDiv.style.position = 'absolute';
    mimicDiv.style.visibility = 'hidden';
    mimicDiv.style.whiteSpace = 'pre-wrap';
    mimicDiv.style.wordBreak = 'break-word';
    mimicDiv.style.overflowY = 'auto';
    mimicDiv.style.pointerEvents = 'none';
    document.body.appendChild(mimicDiv);
  }
  
  const style = window.getComputedStyle(element);
  const properties = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch',
    'lineHeight', 'wordWrap', 'whiteSpace', 'paddingTop', 'paddingRight', 'paddingBottom',
    'paddingLeft', 'borderStyle', 'borderWidth', 'boxSizing'
  ];
  
  properties.forEach(prop => {
    mimicDiv.style[prop] = style[prop];
  });
  
  // Dynamically synchronize size and position to match element dimensions
  const rect = element.getBoundingClientRect();
  mimicDiv.style.width = `${rect.width}px`;
  mimicDiv.style.height = `${rect.height}px`;
  mimicDiv.style.top = `${rect.top + window.scrollY}px`;
  mimicDiv.style.left = `${rect.left + window.scrollX}px`;
  
  const text = element.value;
  mimicDiv.textContent = text.substring(0, position);
  
  const span = document.createElement('span');
  span.textContent = '|';
  mimicDiv.appendChild(span);
  
  const nextText = document.createTextNode(element.value.substring(position));
  mimicDiv.appendChild(nextText);
  
  mimicDiv.scrollTop = element.scrollTop;
  mimicDiv.scrollLeft = element.scrollLeft;
  
  const spanRect = span.getBoundingClientRect();
  const container = document.getElementById('wbTextCursorContainer');
  if (!container) return { top: 0, left: 0 };
  
  const containerRect = container.getBoundingClientRect();
  
  return {
    top: spanRect.top - containerRect.top,
    left: spanRect.left - containerRect.left
  };
}

export function renderTerminalResult(result) {
  const terminal = document.getElementById('wbTerminal');
  if (!terminal) return;

  terminal.textContent = '';
  
  if (result.stderr) {
    terminal.style.color = '#ff3333';
    terminal.textContent += result.stderr;
  }
  
  if (result.stdout) {
    if (result.stderr) {
      terminal.textContent += '\n\n';
    }
    terminal.style.color = '#39ff14';
    terminal.textContent += result.stdout;
  }

  if (!result.stdout && !result.stderr) {
    terminal.style.color = '#888888';
    terminal.textContent = 'Process exited with no output.';
  }

  terminal.scrollTop = terminal.scrollHeight;
}

export function handleIncomingEditorMode(mode) {
  activeEditorMode = mode;
  
  if (!modeTextBtn || !modeCodeBtn || !codeControls || !textarea || !terminalContainer) return;

  const updateCodeMirrorMode = (lang) => {
    if (!codeMirrorInstance) return;
    const modeMap = {
      javascript: 'javascript',
      python: 'python',
      c: 'text/x-csrc',
      cpp: 'text/x-c++src',
      rust: 'text/x-rustsrc',
      java: 'text/x-java',
      bash: 'shell'
    };
    codeMirrorInstance.setOption('mode', modeMap[lang] || 'javascript');
  };

  if (mode === 'code') {
    modeCodeBtn.classList.add('active');
    modeCodeBtn.style.background = 'rgba(255,255,255,0.08)';
    modeCodeBtn.style.color = 'var(--text)';
    modeTextBtn.classList.remove('active');
    modeTextBtn.style.background = 'transparent';
    modeTextBtn.style.color = 'var(--muted)';
    
    codeControls.style.display = 'flex';
    terminalContainer.style.display = 'flex';
    
    textarea.style.display = 'none';
    if (codeEditorWrapper) codeEditorWrapper.style.display = 'flex';
    if (splitResizer) splitResizer.style.display = 'block';
    
    if (codeMirrorInstance) {
      const lang = languageSelect ? languageSelect.value : 'javascript';
      codeMirrorInstance.setValue(textarea.value.trim() ? textarea.value : getDefaultCodePlaceholder(lang));
      updateCodeMirrorMode(languageSelect ? languageSelect.value : 'javascript');
      setTimeout(() => codeMirrorInstance.refresh(), 20);
    }
  } else {
    modeTextBtn.classList.add('active');
    modeTextBtn.style.background = 'rgba(255,255,255,0.08)';
    modeTextBtn.style.color = 'var(--text)';
    modeCodeBtn.classList.remove('active');
    modeCodeBtn.style.background = 'transparent';
    modeCodeBtn.style.color = 'var(--muted)';
    
    codeControls.style.display = 'none';
    terminalContainer.style.display = 'none';
    
    textarea.style.display = 'block';
    if (codeEditorWrapper) codeEditorWrapper.style.display = 'none';
    if (splitResizer) splitResizer.style.display = 'none';
    
    if (codeMirrorInstance) {
      textarea.value = codeMirrorInstance.getValue();
    }
  }
}

export function handleIncomingEditorLang(lang) {
  const languageSelect = document.getElementById('wbLanguageSelect');
  if (languageSelect) {
    languageSelect.value = lang;
  }
  if (codeMirrorInstance) {
    const currentVal = codeMirrorInstance.getValue();
    if (isPlaceholderOrEmpty(currentVal)) {
      codeMirrorInstance.setValue(getDefaultCodePlaceholder(lang));
    }
    const modeMap = {
      javascript: 'javascript',
      python: 'python',
      c: 'text/x-csrc',
      cpp: 'text/x-c++src',
      rust: 'text/x-rustsrc',
      java: 'text/x-java',
      bash: 'shell'
    };
    codeMirrorInstance.setOption('mode', modeMap[lang] || 'javascript');
  }
}

export function handleIncomingCompileStart() {
  const terminal = document.getElementById('wbTerminal');
  if (terminal) {
    terminal.textContent = 'Collaborator is running code on secure sandbox...';
    terminal.style.color = '#39ff14';
  }
}

export function handleIncomingCompileResult(data) {
  renderTerminalResult({
    stdout: data.stdout,
    stderr: data.stderr,
    exitCode: data.exitCode
  });
}

export function getActiveEditorMode() {
  return activeEditorMode;
}

export function getActiveLanguage() {
  const languageSelect = document.getElementById('wbLanguageSelect');
  return languageSelect ? languageSelect.value : 'javascript';
}

export function getActiveStdin() {
  const stdinEl = document.getElementById('wbStdin');
  return stdinEl ? stdinEl.value : '';
}

export function handleIncomingStdin(content) {
  const stdinEl = document.getElementById('wbStdin');
  if (!stdinEl || stdinEl.value === content) return;
  lastSentStdin = content;
  stdinEl.value = content;
}

export function cleanup() {
  window.removeEventListener('resize', resizeCanvas);
  if (breakpointResizeHandler) {
    window.removeEventListener('resize', breakpointResizeHandler);
    breakpointResizeHandler = null;
  }
  
  const cursorContainer = document.getElementById('wbCursorContainer');
  if (cursorContainer) {
    cursorContainer.innerHTML = '';
  }
  const textCursorContainer = document.getElementById('wbTextCursorContainer');
  if (textCursorContainer) {
    textCursorContainer.innerHTML = '';
  }
  
  peerCursorTimeouts.forEach(t => clearTimeout(t));
  peerCursorTimeouts.clear();
  peerTextCursorTimeouts.forEach(t => clearTimeout(t));
  peerTextCursorTimeouts.clear();
  
  remoteTextCaretMap.clear();
  remotePointerMap.clear();
  
  if (mimicDiv) {
    mimicDiv.remove();
    mimicDiv = null;
  }
  
  const codeEditorWrapper = document.getElementById('wbCodeEditorWrapper');
  const terminalContainer = document.getElementById('wbTerminalContainer');
  if (codeEditorWrapper) {
    codeEditorWrapper.style.width = '';
    codeEditorWrapper.style.height = '';
  }
  if (terminalContainer) {
    terminalContainer.style.width = '';
    terminalContainer.style.height = '';
  }
  const stdinContainer = document.getElementById('wbStdinContainer');
  if (stdinContainer) {
    stdinContainer.style.height = '';
  }
  
  lastSentText = '';
  lastSentCaretIndex = -1;
  lastSentCodeCaretIndex = -1;
  lastLocalInputTime = 0;
  
  if (pendingTextBroadcast) {
    clearTimeout(pendingTextBroadcast);
    pendingTextBroadcast = null;
  }
  if (pendingStdinBroadcast) {
    clearTimeout(pendingStdinBroadcast);
    pendingStdinBroadcast = null;
  }
}

export function getCanvasDataURL() {
  if (!canvas) return null;
  try {
    return canvas.toDataURL('image/png');
  } catch (e) {
    console.error('Failed to get canvas data URL:', e);
    return null;
  }
}

export function loadCanvasImage(dataURL) {
  if (!canvas || !ctx) return;
  const img = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.src = dataURL;
}
