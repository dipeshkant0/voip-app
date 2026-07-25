(() => {
  // public/modules/filters.js
  var currentFilter = "none";
  var videoEl = null;
  var canvasEl = null;
  var ctx = null;
  var tempCanvasEl = null;
  var tempCtx = null;
  var faceDetector = null;
  var faceX = null;
  var faceY = null;
  var targetFaceX = null;
  var targetFaceY = null;
  var detectFrameCount = 0;
  var animationFrameId = null;
  var rawTrack = null;
  var filteredStream = null;
  var filteredTrack = null;
  var trackChangeCallback = null;
  function init(onTrackChanged) {
    trackChangeCallback = onTrackChanged;
    videoEl = document.createElement("video");
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.autoplay = true;
    videoEl.style.display = "none";
    document.body.appendChild(videoEl);
    canvasEl = document.createElement("canvas");
    canvasEl.style.display = "none";
    document.body.appendChild(canvasEl);
    ctx = canvasEl.getContext("2d");
    tempCanvasEl = document.createElement("canvas");
    tempCtx = tempCanvasEl.getContext("2d");
    try {
      if (window.FaceDetector) {
        faceDetector = new FaceDetector({ maxDetectedFaces: 1 });
      }
    } catch (e) {
      console.warn("FaceDetector not supported or disabled:", e);
    }
    const filterDropdown = document.getElementById("filterDropdown");
    const videoFilterBtn = document.getElementById("videoFilterBtn");
    if (videoFilterBtn && filterDropdown) {
      videoFilterBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const isHidden = filterDropdown.style.display === "none" || filterDropdown.classList.contains("hidden");
        if (isHidden) {
          filterDropdown.style.display = "flex";
          filterDropdown.classList.remove("hidden");
        } else {
          filterDropdown.style.display = "none";
          filterDropdown.classList.add("hidden");
        }
      });
      document.addEventListener("click", () => {
        filterDropdown.style.display = "none";
        filterDropdown.classList.add("hidden");
      });
      const options = filterDropdown.querySelectorAll(".filter-opt");
      options.forEach((opt) => {
        opt.addEventListener("click", async (e) => {
          const filter = e.target.getAttribute("data-filter");
          await setFilter(filter);
        });
      });
    }
  }
  async function processTrack(track) {
    if (!track) {
      stopProcessing(true, true);
      return null;
    }
    if (currentFilter === "none") {
      stopProcessing(true, false);
      rawTrack = track;
      return track;
    }
    if (rawTrack === track && filteredTrack && filteredTrack.readyState === "live") {
      return filteredTrack;
    }
    if (rawTrack !== track) {
      stopProcessing(false, true);
      rawTrack = track;
    }
    return startProcessing();
  }
  async function setFilter(filter) {
    if (currentFilter === filter) return;
    currentFilter = filter;
    const filterDropdown = document.getElementById("filterDropdown");
    if (filterDropdown) {
      const options = filterDropdown.querySelectorAll(".filter-opt");
      options.forEach((opt) => {
        if (opt.getAttribute("data-filter") === filter) {
          opt.style.background = "var(--accent)";
        } else {
          opt.style.background = "transparent";
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
            rawTrack.onended = () => {
              stopProcessing(true, true);
            };
          }
          resolve(filteredTrack);
        }).catch((err) => {
          console.error("Failed to play raw track in hidden video:", err);
          resolve(rawTrack);
        });
      };
    });
  }
  function loop() {
    if (!rawTrack || rawTrack.readyState !== "live" || currentFilter === "none") {
      return;
    }
    const width = canvasEl.width;
    const height = canvasEl.height;
    ctx.clearRect(0, 0, width, height);
    if (currentFilter === "blur") {
      tempCtx.clearRect(0, 0, width, height);
      tempCtx.drawImage(videoEl, 0, 0, width, height);
      detectFrameCount++;
      if (faceDetector && detectFrameCount % 20 === 0) {
        faceDetector.detect(videoEl).then((faces) => {
          if (faces && faces.length > 0) {
            const box = faces[0].boundingBox;
            targetFaceX = box.x + box.width / 2;
            targetFaceY = box.y + box.height / 2;
          }
        }).catch((err) => {
          console.debug("Face detection skipped/failed:", err);
        });
      }
      if (targetFaceX !== null) {
        faceX = faceX === null ? targetFaceX : faceX + 0.12 * (targetFaceX - faceX);
        faceY = faceY === null ? targetFaceY : faceY + 0.12 * (targetFaceY - faceY);
      }
      tempCtx.globalCompositeOperation = "destination-in";
      const cx = faceX !== null ? faceX : width / 2;
      const cy = faceY !== null ? faceY : height / 2 - 20;
      const gradient = tempCtx.createRadialGradient(
        cx,
        cy,
        height * 0.18,
        // inner circle (sharp face)
        cx,
        cy,
        height * 0.45
        // outer circle (blur transition edge)
      );
      gradient.addColorStop(0, "rgba(0,0,0,1)");
      gradient.addColorStop(0.7, "rgba(0,0,0,0.85)");
      gradient.addColorStop(1, "rgba(0,0,0,0)");
      tempCtx.fillStyle = gradient;
      tempCtx.fillRect(0, 0, width, height);
      tempCtx.globalCompositeOperation = "source-over";
      ctx.filter = "blur(10px)";
      ctx.drawImage(videoEl, 0, 0, width, height);
      ctx.filter = "none";
      ctx.drawImage(tempCanvasEl, 0, 0);
    } else {
      if (currentFilter === "grayscale") {
        ctx.filter = "grayscale(100%)";
      } else if (currentFilter === "sepia") {
        ctx.filter = "sepia(100%)";
      } else if (currentFilter === "invert") {
        ctx.filter = "invert(100%)";
      } else if (currentFilter === "vintage") {
        ctx.filter = "sepia(50%) contrast(120%) saturate(80%)";
      } else {
        ctx.filter = "none";
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
  function stopProcessing(forceStreamDestroy = false, releaseRaw = false) {
    stopLoop();
    if (videoEl) {
      videoEl.pause();
      if (videoEl.srcObject) {
        try {
          const str = videoEl.srcObject;
          if (str && str.getTracks) {
            str.getTracks().forEach((t) => {
              if (releaseRaw) {
                try {
                  t.stop();
                } catch (e) {
                }
              }
            });
          }
        } catch (e) {
        }
        videoEl.srcObject = null;
      }
    }
    if (releaseRaw && rawTrack) {
      try {
        rawTrack.stop();
      } catch (e) {
      }
      rawTrack = null;
    }
    if (forceStreamDestroy) {
      if (filteredTrack) {
        try {
          filteredTrack.stop();
        } catch (e) {
        }
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

  // public/modules/whiteboard.js
  var LANGUAGE_DICTIONARIES = {
    "text/x-csrc": [
      "auto",
      "break",
      "case",
      "char",
      "const",
      "continue",
      "default",
      "do",
      "double",
      "else",
      "enum",
      "extern",
      "float",
      "for",
      "goto",
      "if",
      "int",
      "long",
      "register",
      "return",
      "short",
      "signed",
      "sizeof",
      "static",
      "struct",
      "switch",
      "typedef",
      "union",
      "unsigned",
      "void",
      "volatile",
      "while",
      "#include",
      "#define",
      "#ifdef",
      "#ifndef",
      "#endif",
      "#if",
      "#elif",
      "#else",
      "#pragma",
      "printf",
      "scanf",
      "malloc",
      "calloc",
      "realloc",
      "free",
      "exit",
      "memcpy",
      "memset",
      "strlen",
      "strcpy",
      "strncpy",
      "strcmp",
      "strncmp",
      "fopen",
      "fclose",
      "fread",
      "fwrite",
      "fprintf",
      "fscanf",
      "fgets",
      "fputs",
      "fseek",
      "ftell",
      "rewind",
      "NULL",
      "EOF",
      "FILE",
      "size_t"
    ],
    "text/x-c++src": [
      "alignas",
      "alignof",
      "and",
      "and_eq",
      "asm",
      "atomic",
      "auto",
      "bitand",
      "bitor",
      "bool",
      "break",
      "case",
      "catch",
      "char",
      "char8_t",
      "char16_t",
      "char32_t",
      "class",
      "compl",
      "concept",
      "const",
      "consteval",
      "constexpr",
      "constinit",
      "const_cast",
      "continue",
      "co_await",
      "co_return",
      "co_yield",
      "decltype",
      "default",
      "delete",
      "do",
      "double",
      "dynamic_cast",
      "else",
      "enum",
      "explicit",
      "export",
      "extern",
      "false",
      "float",
      "for",
      "friend",
      "goto",
      "if",
      "inline",
      "int",
      "long",
      "mutable",
      "namespace",
      "new",
      "noexcept",
      "not",
      "not_eq",
      "nullptr",
      "operator",
      "or",
      "or_eq",
      "private",
      "protected",
      "public",
      "register",
      "reinterpret_cast",
      "requires",
      "return",
      "short",
      "signed",
      "sizeof",
      "static",
      "static_assert",
      "static_cast",
      "struct",
      "switch",
      "template",
      "this",
      "thread_local",
      "throw",
      "true",
      "try",
      "typedef",
      "typeid",
      "typename",
      "union",
      "unsigned",
      "using",
      "virtual",
      "void",
      "volatile",
      "wchar_t",
      "while",
      "xor",
      "xor_eq",
      "#include",
      "#define",
      "#ifdef",
      "#ifndef",
      "#endif",
      "#if",
      "#elif",
      "#else",
      "std",
      "cout",
      "cin",
      "endl",
      "vector",
      "string",
      "map",
      "set",
      "unordered_map",
      "unordered_set",
      "shared_ptr",
      "unique_ptr",
      "make_shared",
      "make_unique",
      "push_back",
      "pop_back",
      "size",
      "empty",
      "begin",
      "end",
      "insert",
      "erase",
      "find",
      "count",
      "iostream",
      "algorithm",
      "numeric",
      "functional"
    ],
    "python": [
      "False",
      "None",
      "True",
      "and",
      "as",
      "assert",
      "async",
      "await",
      "break",
      "class",
      "continue",
      "def",
      "del",
      "elif",
      "else",
      "except",
      "finally",
      "for",
      "from",
      "global",
      "if",
      "import",
      "in",
      "is",
      "lambda",
      "nonlocal",
      "not",
      "or",
      "pass",
      "raise",
      "return",
      "try",
      "while",
      "with",
      "yield",
      "abs",
      "all",
      "any",
      "bin",
      "bool",
      "breakpoint",
      "bytearray",
      "bytes",
      "callable",
      "chr",
      "classmethod",
      "compile",
      "complex",
      "delattr",
      "dict",
      "dir",
      "divmod",
      "enumerate",
      "eval",
      "exec",
      "filter",
      "float",
      "format",
      "frozenset",
      "getattr",
      "globals",
      "hasattr",
      "hash",
      "help",
      "hex",
      "id",
      "input",
      "int",
      "isinstance",
      "issubclass",
      "iter",
      "len",
      "list",
      "locals",
      "map",
      "max",
      "min",
      "next",
      "object",
      "oct",
      "open",
      "ord",
      "pow",
      "print",
      "property",
      "range",
      "repr",
      "reversed",
      "round",
      "set",
      "setattr",
      "slice",
      "sorted",
      "staticmethod",
      "str",
      "sum",
      "super",
      "tuple",
      "type",
      "vars",
      "zip",
      "self",
      "append",
      "extend",
      "insert",
      "remove",
      "pop",
      "clear",
      "index",
      "count",
      "sort",
      "reverse",
      "keys",
      "values",
      "items",
      "get",
      "update",
      "split",
      "join"
    ],
    "text/x-java": [
      "abstract",
      "assert",
      "boolean",
      "break",
      "byte",
      "case",
      "catch",
      "char",
      "class",
      "const",
      "continue",
      "default",
      "do",
      "double",
      "else",
      "enum",
      "extends",
      "final",
      "finally",
      "float",
      "for",
      "goto",
      "if",
      "implements",
      "import",
      "instanceof",
      "int",
      "interface",
      "long",
      "native",
      "new",
      "package",
      "private",
      "protected",
      "public",
      "return",
      "short",
      "static",
      "strictfp",
      "super",
      "switch",
      "synchronized",
      "this",
      "throw",
      "throws",
      "transient",
      "try",
      "void",
      "volatile",
      "while",
      "true",
      "false",
      "null",
      "System",
      "System.out.println",
      "System.err.println",
      "String",
      "Integer",
      "Double",
      "Float",
      "Long",
      "Boolean",
      "Character",
      "Byte",
      "Short",
      "Math",
      "List",
      "ArrayList",
      "Map",
      "HashMap",
      "Set",
      "HashSet",
      "LinkedList",
      "Queue",
      "Stack",
      "Collection",
      "Collections",
      "Arrays",
      "add",
      "remove",
      "get",
      "set",
      "size",
      "isEmpty",
      "contains",
      "put",
      "containsKey",
      "containsValue",
      "keySet",
      "values",
      "entrySet",
      "toString",
      "equals",
      "hashCode"
    ],
    "text/x-rustsrc": [
      "as",
      "async",
      "await",
      "break",
      "const",
      "continue",
      "crate",
      "dyn",
      "else",
      "enum",
      "extern",
      "false",
      "fn",
      "for",
      "if",
      "impl",
      "in",
      "let",
      "loop",
      "match",
      "mod",
      "move",
      "mut",
      "pub",
      "ref",
      "return",
      "self",
      "Self",
      "static",
      "struct",
      "super",
      "trait",
      "true",
      "type",
      "union",
      "unsafe",
      "use",
      "where",
      "while",
      "println!",
      "print!",
      "format!",
      "panic!",
      "vec!",
      "String",
      "Vec",
      "Option",
      "Result",
      "Some",
      "None",
      "Ok",
      "Err",
      "Box",
      "Rc",
      "Arc",
      "Mutex",
      "Cell",
      "RefCell",
      "HashMap",
      "HashSet",
      "BTreeMap",
      "BTreeSet",
      "iter",
      "collect",
      "unwrap",
      "expect",
      "as_ref",
      "as_mut",
      "clone",
      "copy",
      "default",
      "std",
      "core",
      "alloc"
    ],
    "shell": [
      "if",
      "then",
      "elif",
      "else",
      "fi",
      "for",
      "in",
      "do",
      "done",
      "while",
      "until",
      "case",
      "esac",
      "select",
      "function",
      "echo",
      "printf",
      "read",
      "exit",
      "return",
      "local",
      "export",
      "alias",
      "unalias",
      "shift",
      "declare",
      "readonly",
      "cat",
      "grep",
      "egrep",
      "fgrep",
      "awk",
      "sed",
      "mkdir",
      "rm",
      "cp",
      "mv",
      "chmod",
      "chown",
      "ls",
      "cd",
      "pwd",
      "date",
      "tar",
      "gzip",
      "gunzip",
      "find",
      "xargs",
      "curl",
      "wget",
      "ssh",
      "scp",
      "rsync",
      "ping",
      "ifconfig",
      "ip",
      "systemctl",
      "journalctl",
      "ps",
      "top",
      "htop",
      "kill",
      "pkill",
      "df",
      "du",
      "free",
      "uptime",
      "whoami",
      "id",
      "uname",
      "awk",
      "sed",
      "grep",
      "cut",
      "head",
      "tail",
      "less",
      "more",
      "wc",
      "sort",
      "uniq",
      "tee"
    ],
    "javascript": [
      "break",
      "case",
      "catch",
      "class",
      "const",
      "continue",
      "debugger",
      "default",
      "delete",
      "do",
      "else",
      "export",
      "extends",
      "finally",
      "for",
      "function",
      "if",
      "import",
      "in",
      "instanceof",
      "new",
      "return",
      "super",
      "switch",
      "this",
      "throw",
      "try",
      "typeof",
      "var",
      "void",
      "while",
      "with",
      "yield",
      "let",
      "static",
      "yield",
      "await",
      "async",
      "null",
      "undefined",
      "true",
      "false",
      "console",
      "console.log",
      "console.error",
      "console.warn",
      "console.dir",
      "document",
      "window",
      "Promise",
      "resolve",
      "reject",
      "setTimeout",
      "setInterval",
      "clearTimeout",
      "clearInterval",
      "fetch",
      "Response",
      "Request",
      "Headers",
      "JSON",
      "JSON.stringify",
      "JSON.parse",
      "Math",
      "Math.random",
      "Math.floor",
      "Math.ceil",
      "Math.round",
      "Math.min",
      "Math.max",
      "Object",
      "Object.keys",
      "Object.values",
      "Object.entries",
      "Array",
      "Array.isArray",
      "map",
      "filter",
      "reduce",
      "forEach",
      "find",
      "findIndex",
      "push",
      "pop",
      "shift",
      "unshift",
      "slice",
      "splice",
      "join",
      "split",
      "length",
      "toString",
      "parseInt",
      "parseFloat",
      "isNaN",
      "isFinite"
    ]
  };
  var LOWERCASE_DICTIONARIES = {};
  for (const mode in LANGUAGE_DICTIONARIES) {
    LOWERCASE_DICTIONARIES[mode] = LANGUAGE_DICTIONARIES[mode].map((word) => ({
      original: word,
      lower: word.toLowerCase()
    }));
  }
  var CODE_TEMPLATES = {
    "javascript": `// JavaScript Starter Template
console.log("Hello, World!");`,
    "python": `# Python Starter Template
def main():
    print("Hello, World!")

if __name__ == "__main__":
    main()`,
    "cpp": `// C++ Starter Template
#include <iostream>

int main() {
    std::cout << "Hello, World!" << std::endl;
    return 0;
}`,
    "c": `// C Starter Template
#include <stdio.h>

int main() {
    printf("Hello, World!\\n");
    return 0;
}`,
    "rust": `// Rust Starter Template
fn main() {
    println!("Hello, World!");
}`,
    "java": `// Java Starter Template
public class Main {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }
}`,
    "bash": `# Bash/Shell Starter Template
echo "Hello, World!"`
  };
  var getDefaultCodePlaceholder = (lang) => {
    return CODE_TEMPLATES[lang] || "// write your code here";
  };
  var isPlaceholderOrEmpty = (val) => {
    const trimmed = val.trim();
    if (!trimmed) return true;
    for (const key in CODE_TEMPLATES) {
      if (trimmed === CODE_TEMPLATES[key].trim()) return true;
    }
    return trimmed === "// code here" || trimmed === "# code here" || trimmed === "// write your code here";
  };
  var codeMirrorInstance = null;
  var lastCodeCursorBroadcast = 0;
  var lastSentCodeCaretIndex = -1;
  var canvas = null;
  var textarea = null;
  var cursorContainer = null;
  var textCursorContainer = null;
  var terminal = null;
  var codeEditorWrapper = null;
  var splitResizer = null;
  var terminalContainer = null;
  var modeTextBtn = null;
  var modeCodeBtn = null;
  var codeControls = null;
  var languageSelect = null;
  var runBtn = null;
  var clearTerminalBtn = null;
  var ctx2 = null;
  var isDrawing = false;
  var lastX = 0;
  var lastY = 0;
  var brushColor = "#ffffff";
  var brushSize = 4;
  var broadcastCallback = null;
  var workspaceResizeHandler = null;
  var canvasResizeObserver = null;
  var breakpointResizeHandler = null;
  var resizeFrameId = null;
  var breakpointFrameId = null;
  var cmScrollFrameId = null;
  var textareaScrollFrameId = null;
  var lastTextBroadcastTime = 0;
  var lastSentText = "";
  var pendingTextBroadcast = null;
  var lastCursorBroadcast = 0;
  var lastSentX = -1;
  var lastSentY = -1;
  var cursorThrottleTimeout = null;
  var textCursorThrottleTimeout = null;
  var codeCursorThrottleTimeout = null;
  var peerCursorTimeouts = /* @__PURE__ */ new Map();
  var peerTextCursorTimeouts = /* @__PURE__ */ new Map();
  var remoteTextCaretMap = /* @__PURE__ */ new Map();
  var remotePointerMap = /* @__PURE__ */ new Map();
  var mimicDiv = null;
  var mimicTextBefore = null;
  var mimicSpan = null;
  var mimicTextAfter = null;
  var cachedTextareaStyles = null;
  var activeEditorMode = "text";
  var cmRetries = 0;
  var isProgrammaticUpdate = false;
  var canvasBoundingRect = null;
  var textCursorContainerBoundingRect = null;
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
          type: "wb-text-cursor",
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
  var lastStdinBroadcastTime = 0;
  var pendingStdinBroadcast = null;
  var lastSentStdin = "";
  function broadcastStdinThrottled() {
    const now = Date.now();
    const timeSinceLast = now - lastStdinBroadcastTime;
    const stdinEl = document.getElementById("wbStdin");
    if (!stdinEl) return;
    const content = stdinEl.value;
    if (content === lastSentStdin) return;
    if (timeSinceLast >= 150) {
      lastSentStdin = content;
      lastStdinBroadcastTime = now;
      if (broadcastCallback) {
        broadcastCallback({ type: "wb-editor-stdin", content });
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
    if (activeEditorMode === "code" && codeMirrorInstance) {
      content = codeMirrorInstance.getValue();
      const doc = codeMirrorInstance.getDoc();
      caretIndex = doc.indexFromPos(doc.getCursor());
    } else {
      content = textarea.value;
      caretIndex = textarea.selectionStart;
    }
    if (content === lastSentText) {
      return;
    }
    if (timeSinceLast >= 150) {
      lastTextBroadcastTime = now;
      lastSentText = content;
      if (broadcastCallback) {
        broadcastCallback({ type: "wb-text", content, caretIndex });
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
        broadcastCallback({ type: "wb-cursor", active: false });
      }
      lastSentX = -1;
      lastSentY = -1;
      return;
    }
    if (Math.abs(x - lastSentX) < 3e-3 && Math.abs(y - lastSentY) < 3e-3) {
      return;
    }
    const now = Date.now();
    const elapsed = now - lastCursorBroadcast;
    const doBroadcast = () => {
      lastCursorBroadcast = Date.now();
      lastSentX = x;
      lastSentY = y;
      if (broadcastCallback) {
        broadcastCallback({ type: "wb-cursor", x, y, active: true });
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
  function cacheTextareaStyles() {
    if (!textarea) return;
    const style = window.getComputedStyle(textarea);
    const properties = [
      "fontFamily",
      "fontSize",
      "fontWeight",
      "fontStyle",
      "fontVariant",
      "fontStretch",
      "lineHeight",
      "wordWrap",
      "whiteSpace",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "borderStyle",
      "borderWidth",
      "boxSizing"
    ];
    cachedTextareaStyles = {};
    properties.forEach((prop) => {
      cachedTextareaStyles[prop] = style[prop];
    });
  }
  var _overlayButtonsWired = false;
  function _wireOverlayButtons() {
    if (_overlayButtonsWired) return;
    _overlayButtonsWired = true;
    const whiteboardBtn = document.getElementById("whiteboardBtn");
    const whiteboardContainer = document.getElementById("whiteboardContainer");
    const closeWbBtn = document.getElementById("closeWbBtn");
    if (whiteboardBtn && whiteboardContainer) {
      whiteboardBtn.addEventListener("click", () => {
        const isHidden = whiteboardContainer.style.display === "none" || whiteboardContainer.classList.contains("hidden");
        if (isHidden) {
          whiteboardContainer.style.display = "flex";
          whiteboardContainer.classList.remove("hidden");
          whiteboardBtn.classList.add("active");
          resizeCanvas();
        } else {
          whiteboardContainer.style.display = "none";
          whiteboardContainer.classList.add("hidden");
          whiteboardBtn.classList.remove("active");
        }
      });
    }
    if (closeWbBtn && whiteboardContainer && whiteboardBtn) {
      closeWbBtn.addEventListener("click", () => {
        whiteboardContainer.style.display = "none";
        whiteboardContainer.classList.add("hidden");
        whiteboardBtn.classList.remove("active");
      });
    }
  }
  function init2(broadcastFn) {
    broadcastCallback = broadcastFn;
    canvas = document.getElementById("wbCanvas");
    textarea = document.getElementById("wbTextarea");
    cursorContainer = document.getElementById("wbCursorContainer");
    textCursorContainer = document.getElementById("wbTextCursorContainer");
    terminal = document.getElementById("wbTerminal");
    codeEditorWrapper = document.getElementById("wbCodeEditorWrapper");
    splitResizer = document.getElementById("wbSplitResizer");
    terminalContainer = document.getElementById("wbTerminalContainer");
    modeTextBtn = document.getElementById("wbModeTextBtn");
    modeCodeBtn = document.getElementById("wbModeCodeBtn");
    codeControls = document.getElementById("wbCodeControls");
    languageSelect = document.getElementById("wbLanguageSelect");
    runBtn = document.getElementById("wbRunBtn");
    clearTerminalBtn = document.getElementById("wbClearTerminalBtn");
    _wireOverlayButtons();
    if (!canvas) return;
    ctx2 = canvas.getContext("2d");
    workspaceResizeHandler = () => {
      if (resizeFrameId) return;
      resizeFrameId = requestAnimationFrame(() => {
        resizeCanvas();
        cacheTextareaStyles();
        resizeFrameId = null;
      });
    };
    window.addEventListener("resize", workspaceResizeHandler);
    if (typeof ResizeObserver !== "undefined" && canvas.parentElement) {
      canvasResizeObserver = new ResizeObserver((entries) => {
        for (let entry of entries) {
          if (resizeFrameId) cancelAnimationFrame(resizeFrameId);
          resizeFrameId = requestAnimationFrame(() => {
            resizeCanvas();
            cacheTextareaStyles();
            resizeFrameId = null;
          });
        }
      });
      canvasResizeObserver.observe(canvas.parentElement);
    }
    resizeCanvas();
    cacheTextareaStyles();
    canvas.addEventListener("mousedown", startDrawing);
    canvas.addEventListener("mousemove", draw);
    canvas.addEventListener("mouseup", stopDrawing);
    canvas.addEventListener("mouseout", stopDrawing);
    canvas.addEventListener("touchstart", startDrawingTouch, { passive: false });
    canvas.addEventListener("touchmove", drawTouch, { passive: false });
    canvas.addEventListener("touchend", stopDrawing);
    canvas.addEventListener("mousemove", (e) => {
      const rect = getCanvasRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const h = rect.height || 1;
      const x = (e.clientX - rect.left - cx) / h;
      const y = (e.clientY - rect.top - cy) / h;
      handleCursorMove(x, y, true);
    });
    canvas.addEventListener("mouseleave", () => {
      handleCursorMove(0, 0, false);
    });
    canvas.addEventListener("touchmove", (e) => {
      if (e.touches.length !== 1) return;
      const rect = getCanvasRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const h = rect.height || 1;
      const x = (e.touches[0].clientX - rect.left - cx) / h;
      const y = (e.touches[0].clientY - rect.top - cy) / h;
      handleCursorMove(x, y, true);
    }, { passive: true });
    canvas.addEventListener("touchend", () => {
      handleCursorMove(0, 0, false);
    }, { passive: true });
    const brushSizeInput = document.getElementById("wbBrushSize");
    const brushSizeVal = document.getElementById("wbBrushSizeVal");
    if (brushSizeInput && brushSizeVal) {
      brushSizeInput.addEventListener("input", (e) => {
        brushSize = e.target.value;
        brushSizeVal.textContent = brushSize + "px";
      });
    }
    const colorBtns = document.querySelectorAll(".wb-color-btn");
    colorBtns.forEach((btn) => {
      btn.addEventListener("click", (e) => {
        colorBtns.forEach((b) => {
          b.classList.remove("active");
        });
        const selectedColor = e.currentTarget.getAttribute("data-color");
        brushColor = selectedColor;
        e.currentTarget.classList.add("active");
      });
    });
    const clearBtn = document.getElementById("wbClearBtn");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        clearCanvas();
        if (broadcastCallback) {
          broadcastCallback({ type: "wb-clear" });
        }
      });
    }
    const tabDraw = document.getElementById("wbTabDraw");
    const tabEditor = document.getElementById("wbTabEditor");
    const drawPanel = document.getElementById("wbDrawPanel");
    const editorPanel = document.getElementById("wbEditorPanel");
    if (tabDraw && tabEditor && drawPanel && editorPanel) {
      tabDraw.addEventListener("click", () => {
        tabDraw.classList.add("active");
        tabDraw.style.borderBottom = "2px solid var(--accent)";
        tabDraw.style.color = "white";
        tabEditor.classList.remove("active");
        tabEditor.style.borderBottom = "none";
        tabEditor.style.color = "var(--muted)";
        drawPanel.style.display = "flex";
        drawPanel.classList.remove("hidden");
        editorPanel.style.display = "none";
        editorPanel.classList.add("hidden");
        resizeCanvas();
      });
      tabEditor.addEventListener("click", () => {
        tabEditor.classList.add("active");
        tabEditor.style.borderBottom = "2px solid var(--accent)";
        tabEditor.style.color = "white";
        tabDraw.classList.remove("active");
        tabDraw.style.borderBottom = "none";
        tabDraw.style.color = "var(--muted)";
        editorPanel.style.display = "flex";
        editorPanel.classList.remove("hidden");
        drawPanel.style.display = "none";
        drawPanel.classList.add("hidden");
      });
    }
    if (textarea) {
      textarea.addEventListener("input", () => {
        lastLocalInputTime = Date.now();
        if (pendingTextBroadcast) {
          clearTimeout(pendingTextBroadcast);
          pendingTextBroadcast = null;
        }
        broadcastTextThrottled();
      });
      const initCodeMirror = () => {
        const codeTextarea = document.getElementById("wbCodeTextarea");
        if (!codeTextarea) return;
        if (typeof CodeMirror === "undefined") {
          if (cmRetries++ > 40) {
            console.error("CodeMirror failed to load.");
            return;
          }
          setTimeout(initCodeMirror, 50);
          return;
        }
        if (CodeMirror.registerHelper && !CodeMirror.hint.advancedComposite) {
          CodeMirror.registerHelper("hint", "advancedComposite", function(cm) {
            const cursor = cm.getCursor();
            const token = cm.getTokenAt(cursor);
            if (token && token.type && (token.type.includes("comment") || token.type.includes("string"))) {
              return null;
            }
            const line = cm.getLine(cursor.line);
            let start = cursor.ch;
            while (start > 0 && /[\w$#\.\!\-\:]/.test(line.charAt(start - 1))) {
              start--;
            }
            const currentWord = line.slice(start, cursor.ch);
            const localHints = CodeMirror.hint && CodeMirror.hint.anyword ? CodeMirror.hint.anyword(cm) || { list: [], from: cursor, to: cursor } : { list: [], from: cursor, to: cursor };
            if (currentWord.length < 2 && !currentWord.endsWith(".") && !currentWord.endsWith("::")) {
              return null;
            }
            const mode = cm.getOption("mode");
            const currentLower = currentWord.toLowerCase();
            const matchedGlobals = LOWERCASE_DICTIONARIES[mode] ? LOWERCASE_DICTIONARIES[mode].filter((item) => item.lower.includes(currentLower) && item.lower !== currentLower).map((item) => item.original) : [];
            const matchedLocals = localHints.list.filter((word) => {
              const wordLower = word.toLowerCase();
              return wordLower.includes(currentLower) && wordLower !== currentLower;
            });
            const combinedList = [.../* @__PURE__ */ new Set([...matchedGlobals, ...matchedLocals])];
            if (combinedList.length === 0) {
              return null;
            }
            const mappedList = combinedList.map((word) => {
              const wordLower = word.toLowerCase();
              return {
                original: word,
                lower: wordLower,
                startsWith: wordLower.startsWith(currentLower)
              };
            });
            mappedList.sort((a, b) => {
              if (a.startsWith && !b.startsWith) return -1;
              if (!a.startsWith && b.startsWith) return 1;
              return a.original.localeCompare(b.original);
            });
            const sortedList = mappedList.map((item) => item.original);
            return {
              list: sortedList.slice(0, 20),
              from: CodeMirror.Pos(cursor.line, start),
              to: CodeMirror.Pos(cursor.line, cursor.ch)
            };
          });
        }
        if (codeMirrorInstance) return;
        codeMirrorInstance = CodeMirror.fromTextArea(codeTextarea, {
          lineNumbers: true,
          mode: "javascript",
          theme: "monokai",
          lineWrapping: true,
          matchBrackets: true,
          autoCloseBrackets: true,
          styleActiveLine: true,
          indentUnit: 4,
          tabSize: 4
        });
        codeMirrorInstance.on("keyup", (cm, event) => {
          if (!/^[a-zA-Z0-9_\.\:\!\#]$/.test(event.key) && event.key !== "Backspace") return;
          if (!cm.state.completionActive && cm.hasFocus()) {
            if (CodeMirror.hint.advancedComposite) {
              cm.showHint({ hint: CodeMirror.hint.advancedComposite, completeSingle: false });
            }
          }
        });
        codeMirrorInstance.on("change", (cm, changeObj) => {
          if (changeObj.origin !== "setValue") {
            lastLocalInputTime = Date.now();
            if (pendingTextBroadcast) {
              clearTimeout(pendingTextBroadcast);
              pendingTextBroadcast = null;
            }
            broadcastTextThrottled();
          }
        });
        codeMirrorInstance.on("cursorActivity", () => {
          broadcastCodeCursorThrottled();
        });
        codeMirrorInstance.on("scroll", () => {
          if (cmScrollFrameId) return;
          cmScrollFrameId = requestAnimationFrame(() => {
            repositionAllRemoteCursors();
            cmScrollFrameId = null;
          });
        });
        const fontSizeSelect2 = document.getElementById("wbFontSizeSelect");
        if (fontSizeSelect2) {
          codeMirrorInstance.getWrapperElement().style.setProperty("font-size", fontSizeSelect2.value, "important");
          setTimeout(() => codeMirrorInstance.refresh(), 50);
        }
        if (activeEditorMode === "code") {
          const languageSelect2 = document.getElementById("wbLanguageSelect");
          const lang = languageSelect2 ? languageSelect2.value : "javascript";
          codeMirrorInstance.setValue(textarea.value.trim() ? textarea.value : getDefaultCodePlaceholder(lang));
          const modeMap = {
            javascript: "javascript",
            python: "python",
            c: "text/x-csrc",
            cpp: "text/x-c++src",
            rust: "text/x-rustsrc",
            java: "text/x-java",
            bash: "shell"
          };
          codeMirrorInstance.setOption("mode", modeMap[lang] || "javascript");
          setTimeout(() => codeMirrorInstance.refresh(), 50);
        }
      };
      initCodeMirror();
      const updateCodeMirrorMode = (lang) => {
        if (!codeMirrorInstance) return;
        const modeMap = {
          javascript: "javascript",
          python: "python",
          c: "text/x-csrc",
          cpp: "text/x-c++src",
          rust: "text/x-rustsrc",
          java: "text/x-java",
          bash: "shell"
        };
        codeMirrorInstance.setOption("mode", modeMap[lang] || "javascript");
      };
      const updateEditorLayout = (mode) => {
        activeEditorMode = mode;
        if (mode === "code") {
          modeCodeBtn.classList.add("active");
          modeCodeBtn.style.background = "rgba(255,255,255,0.08)";
          modeCodeBtn.style.color = "var(--text)";
          modeTextBtn.classList.remove("active");
          modeTextBtn.style.background = "transparent";
          modeTextBtn.style.color = "var(--muted)";
          codeControls.style.display = "flex";
          terminalContainer.style.display = "flex";
          textarea.style.display = "none";
          if (codeEditorWrapper2) codeEditorWrapper2.style.display = "flex";
          if (splitResizer2) splitResizer2.style.display = "block";
          if (codeMirrorInstance) {
            const lang = languageSelect ? languageSelect.value : "javascript";
            codeMirrorInstance.setValue(textarea.value.trim() ? textarea.value : getDefaultCodePlaceholder(lang));
            updateCodeMirrorMode(languageSelect ? languageSelect.value : "javascript");
            setTimeout(() => codeMirrorInstance.refresh(), 20);
          }
        } else {
          modeTextBtn.classList.add("active");
          modeTextBtn.style.background = "rgba(255,255,255,0.08)";
          modeTextBtn.style.color = "var(--text)";
          modeCodeBtn.classList.remove("active");
          modeCodeBtn.style.background = "transparent";
          modeCodeBtn.style.color = "var(--muted)";
          codeControls.style.display = "none";
          terminalContainer.style.display = "none";
          textarea.style.display = "block";
          if (codeEditorWrapper2) codeEditorWrapper2.style.display = "none";
          if (splitResizer2) splitResizer2.style.display = "none";
          if (codeMirrorInstance) {
            textarea.value = codeMirrorInstance.getValue();
          }
        }
        adjustResponsiveWorkspace();
      };
      if (modeTextBtn && modeCodeBtn) {
        modeTextBtn.addEventListener("click", () => {
          if (activeEditorMode === "text") return;
          updateEditorLayout("text");
          if (broadcastCallback) {
            broadcastCallback({ type: "wb-editor-mode", mode: "text" });
          }
        });
        modeCodeBtn.addEventListener("click", () => {
          if (activeEditorMode === "code") return;
          updateEditorLayout("code");
          if (broadcastCallback) {
            broadcastCallback({ type: "wb-editor-mode", mode: "code" });
          }
        });
      }
      if (languageSelect) {
        languageSelect.addEventListener("change", () => {
          updateCodeMirrorMode(languageSelect.value);
          if (codeMirrorInstance) {
            const currentVal = codeMirrorInstance.getValue();
            if (isPlaceholderOrEmpty(currentVal)) {
              codeMirrorInstance.setValue(getDefaultCodePlaceholder(languageSelect.value));
            }
          }
          if (broadcastCallback) {
            broadcastCallback({ type: "wb-editor-lang", lang: languageSelect.value });
          }
        });
      }
      const fontSizeSelect = document.getElementById("wbFontSizeSelect");
      const updateEditorFontSize = (size) => {
        if (codeMirrorInstance) {
          codeMirrorInstance.getWrapperElement().style.setProperty("font-size", size, "important");
          setTimeout(() => codeMirrorInstance.refresh(), 50);
        }
        if (textarea) {
          textarea.style.setProperty("font-size", size, "important");
        }
      };
      if (fontSizeSelect) {
        fontSizeSelect.addEventListener("change", () => {
          updateEditorFontSize(fontSizeSelect.value);
        });
        updateEditorFontSize(fontSizeSelect.value);
      }
      const splitResizer2 = document.getElementById("wbSplitResizer");
      const splitWorkspaceContainer = document.getElementById("wbSplitWorkspaceContainer");
      const codeEditorWrapper2 = document.getElementById("wbCodeEditorWrapper");
      if (splitResizer2 && splitWorkspaceContainer && codeEditorWrapper2 && terminalContainer) {
        let isDragging = false;
        let dragFrameId = null;
        const startDrag = (e) => {
          isDragging = true;
          splitResizer2.classList.add("dragging");
          document.body.style.cursor = window.getComputedStyle(splitResizer2).cursor;
          document.body.style.userSelect = "none";
          window.addEventListener("mousemove", onDrag);
          window.addEventListener("touchmove", onDragTouch, { passive: false });
          window.addEventListener("mouseup", stopDrag);
          window.addEventListener("touchend", stopDrag);
        };
        const stopDrag = () => {
          if (!isDragging) return;
          isDragging = false;
          splitResizer2.classList.remove("dragging");
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          window.removeEventListener("mousemove", onDrag);
          window.removeEventListener("touchmove", onDragTouch);
          window.removeEventListener("mouseup", stopDrag);
          window.removeEventListener("touchend", stopDrag);
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
              const percentage = (clientY - containerRect.top) / containerRect.height * 100;
              if (percentage > 15 && percentage < 85) {
                codeEditorWrapper2.style.flex = "none";
                codeEditorWrapper2.style.setProperty("height", `${percentage}%`, "important");
                terminalContainer.style.flex = "none";
                terminalContainer.style.setProperty("height", `${100 - percentage}%`, "important");
                codeEditorWrapper2.style.width = "";
                terminalContainer.style.width = "";
              }
            } else {
              const clientX = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
              const percentage = (clientX - containerRect.left) / containerRect.width * 100;
              if (percentage > 15 && percentage < 85) {
                codeEditorWrapper2.style.flex = "none";
                codeEditorWrapper2.style.setProperty("width", `${percentage}%`, "important");
                terminalContainer.style.flex = "none";
                terminalContainer.style.setProperty("width", `${100 - percentage}%`, "important");
                codeEditorWrapper2.style.height = "";
                terminalContainer.style.height = "";
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
        splitResizer2.addEventListener("mousedown", startDrag);
        splitResizer2.addEventListener("touchstart", startDrag, { passive: true });
      }
      let lastWidth = window.innerWidth;
      breakpointResizeHandler = () => {
        if (breakpointFrameId) return;
        breakpointFrameId = requestAnimationFrame(() => {
          const currentWidth = window.innerWidth;
          if (lastWidth <= 992 && currentWidth > 992 || lastWidth > 992 && currentWidth <= 992) {
            if (codeEditorWrapper2) {
              codeEditorWrapper2.style.width = "";
              codeEditorWrapper2.style.height = "";
            }
            if (terminalContainer) {
              terminalContainer.style.width = "";
              terminalContainer.style.height = "";
            }
            adjustResponsiveWorkspace();
          } else {
            repositionAllRemoteCursors();
          }
          lastWidth = currentWidth;
          breakpointFrameId = null;
        });
      };
      window.addEventListener("resize", breakpointResizeHandler);
      const terminalResizer = document.getElementById("wbTerminalResizer");
      const stdinContainer = document.getElementById("wbStdinContainer");
      if (terminalResizer && terminalContainer && stdinContainer) {
        let isDragging = false;
        let dragFrameId = null;
        const startDrag = (e) => {
          isDragging = true;
          terminalResizer.classList.add("dragging");
          document.body.style.cursor = "row-resize";
          document.body.style.userSelect = "none";
          window.addEventListener("mousemove", onDrag);
          window.addEventListener("touchmove", onDragTouch, { passive: false });
          window.addEventListener("mouseup", stopDrag);
          window.addEventListener("touchend", stopDrag);
        };
        const stopDrag = () => {
          if (!isDragging) return;
          isDragging = false;
          terminalResizer.classList.remove("dragging");
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          window.removeEventListener("mousemove", onDrag);
          window.removeEventListener("touchmove", onDragTouch);
          window.removeEventListener("mouseup", stopDrag);
          window.removeEventListener("touchend", stopDrag);
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
              stdinContainer.style.flex = "none";
              stdinContainer.style.setProperty("height", `${height}px`, "important");
            }
          });
        };
        const onDragTouch = (e) => {
          if (e.cancelable) {
            e.preventDefault();
          }
          onDrag(e);
        };
        terminalResizer.addEventListener("mousedown", startDrag);
        terminalResizer.addEventListener("touchstart", startDrag, { passive: true });
      }
      if (clearTerminalBtn && terminal) {
        clearTerminalBtn.addEventListener("click", () => {
          terminal.textContent = "";
        });
      }
      const stdinEl = document.getElementById("wbStdin");
      if (stdinEl) {
        stdinEl.addEventListener("input", () => {
          if (pendingStdinBroadcast) {
            clearTimeout(pendingStdinBroadcast);
            pendingStdinBroadcast = null;
          }
          broadcastStdinThrottled();
        });
      }
      if (runBtn && terminal) {
        runBtn.addEventListener("click", async () => {
          const code = activeEditorMode === "code" && codeMirrorInstance ? codeMirrorInstance.getValue() : textarea.value;
          const language = languageSelect.value;
          if (!code.trim()) {
            terminal.textContent = "Error: Cannot run empty code.";
            return;
          }
          runBtn.disabled = true;
          terminal.textContent = "Running code on secure sandbox...";
          terminal.style.color = "#39ff14";
          if (broadcastCallback) {
            broadcastCallback({ type: "wb-compile-start" });
          }
          try {
            const res = await fetch("/api/compile", {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({ code, language, stdin: stdinEl ? stdinEl.value : "" })
            });
            if (!res.ok) {
              const errData = await res.json();
              throw new Error(errData.error || "Server compiler request failed");
            }
            const result = await res.json();
            renderTerminalResult(result);
            if (broadcastCallback) {
              broadcastCallback({
                type: "wb-compile-result",
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode
              });
            }
            runBtn.disabled = false;
          } catch (err) {
            if (language.toLowerCase() === "javascript") {
              terminal.textContent = "Notice: Remote compiler offline. Initiating offline JavaScript sandbox...\n\n";
              terminal.style.color = "#e9b872";
              try {
                const blobCode = `
                self.fetch = undefined;
                self.XMLHttpRequest = undefined;
                self.WebSocket = undefined;
                self.importScripts = undefined;
                
                const logs = [];
                const customConsole = {
                  log: (...args) => logs.push(args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ')),
                  error: (...args) => logs.push('Error: ' + args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ')),
                  warn: (...args) => logs.push('Warning: ' + args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '))
                };
                
                try {
                  const runFn = new Function('console', \`
                    try {
                      ${code.replace(/`/g, "\\`").replace(/\$/g, "\\$")}
                    } catch (e) {
                      console.error(e.message);
                    }
                  \`);
                  runFn(customConsole);
                  self.postMessage({ logs, error: null });
                } catch (e) {
                  self.postMessage({ logs, error: e.message });
                }
              `;
                const blob = new Blob([blobCode], { type: "application/javascript" });
                const workerURL = URL.createObjectURL(blob);
                const worker = new Worker(workerURL);
                const timeoutId = setTimeout(() => {
                  worker.terminate();
                  URL.revokeObjectURL(workerURL);
                  terminal.textContent += "Error: Execution timed out (exceeded 3 seconds).";
                  terminal.style.color = "#ff3333";
                  runBtn.disabled = false;
                }, 3e3);
                worker.onmessage = (event) => {
                  clearTimeout(timeoutId);
                  worker.terminate();
                  URL.revokeObjectURL(workerURL);
                  const { logs: workerLogs, error } = event.data;
                  let outputText = workerLogs.length ? workerLogs.join("\n") : "Process executed successfully with no stdout output.";
                  if (error) {
                    outputText += "\nExecution error: " + error;
                  }
                  terminal.textContent += outputText;
                  terminal.style.color = error ? "#ff3333" : "#39ff14";
                  if (broadcastCallback) {
                    broadcastCallback({
                      type: "wb-compile-result",
                      stdout: outputText,
                      stderr: error || "",
                      exitCode: error ? 1 : 0
                    });
                  }
                  runBtn.disabled = false;
                };
                worker.postMessage("run");
                return;
              } catch (jsErr) {
                terminal.textContent += `Offline execution failure: ${jsErr.message}`;
                terminal.style.color = "#ff3333";
              }
            } else {
              terminal.textContent = `Error: ${err.message}`;
              terminal.style.color = "#ff3333";
            }
            if (broadcastCallback) {
              broadcastCallback({
                type: "wb-compile-result",
                stdout: "",
                stderr: `Error: ${err.message}`,
                exitCode: 1
              });
            }
            runBtn.disabled = false;
          }
        });
      }
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
            broadcastCallback({ type: "wb-text-cursor", caretIndex, active: true });
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
          broadcastCallback({ type: "wb-text-cursor", active: false });
        }
        lastSentCaretIndex = -1;
      };
      textarea.addEventListener("keyup", handleTextCursorUpdate);
      textarea.addEventListener("click", handleTextCursorUpdate);
      textarea.addEventListener("focus", handleTextCursorUpdate);
      textarea.addEventListener("blur", handleTextCursorBlur);
      textarea.addEventListener("scroll", () => {
        if (textareaScrollFrameId) return;
        textareaScrollFrameId = requestAnimationFrame(() => {
          repositionAllRemoteCursors();
          textareaScrollFrameId = null;
        });
      });
    }
    const tabEditorBtn = document.getElementById("wbTabEditorBtn");
    const tabConsoleBtn = document.getElementById("wbTabConsoleBtn");
    if (tabEditorBtn) {
      tabEditorBtn.addEventListener("click", () => {
        activeMobileTab = "editor";
        adjustResponsiveWorkspace();
      });
    }
    if (tabConsoleBtn) {
      tabConsoleBtn.addEventListener("click", () => {
        activeMobileTab = "console";
        adjustResponsiveWorkspace();
      });
    }
    adjustResponsiveWorkspace();
  }
  var activeMobileTab = "editor";
  function adjustResponsiveWorkspace() {
    const isCodeMode = activeEditorMode === "code";
    const isSmallScreen = window.innerWidth <= 992;
    const mobileTabs = document.getElementById("wbMobileTabs");
    const codeWrapper = document.getElementById("wbCodeEditorWrapper");
    const terminalContainer2 = document.getElementById("wbTerminalContainer");
    const splitResizer2 = document.getElementById("wbSplitResizer");
    if (!mobileTabs || !codeWrapper || !terminalContainer2 || !splitResizer2) return;
    if (isCodeMode && isSmallScreen) {
      mobileTabs.style.setProperty("display", "flex", "important");
      splitResizer2.style.setProperty("display", "none", "important");
      const tabEditorBtn = document.getElementById("wbTabEditorBtn");
      const tabConsoleBtn = document.getElementById("wbTabConsoleBtn");
      if (activeMobileTab === "editor") {
        codeWrapper.style.setProperty("display", "flex", "important");
        codeWrapper.style.setProperty("width", "100%", "important");
        codeWrapper.style.setProperty("height", "100%", "important");
        terminalContainer2.style.setProperty("display", "none", "important");
        terminalContainer2.style.setProperty("width", "", "");
        terminalContainer2.style.setProperty("height", "", "");
        if (tabEditorBtn) {
          tabEditorBtn.style.borderBottomColor = "var(--accent)";
          tabEditorBtn.style.color = "var(--text)";
        }
        if (tabConsoleBtn) {
          tabConsoleBtn.style.borderBottomColor = "transparent";
          tabConsoleBtn.style.color = "var(--muted)";
        }
      } else {
        codeWrapper.style.setProperty("display", "none", "important");
        codeWrapper.style.setProperty("width", "", "");
        codeWrapper.style.setProperty("height", "", "");
        terminalContainer2.style.setProperty("display", "flex", "important");
        terminalContainer2.style.setProperty("width", "100%", "important");
        terminalContainer2.style.setProperty("height", "100%", "important");
        if (tabEditorBtn) {
          tabEditorBtn.style.borderBottomColor = "transparent";
          tabEditorBtn.style.color = "var(--muted)";
        }
        if (tabConsoleBtn) {
          tabConsoleBtn.style.borderBottomColor = "var(--accent)";
          tabConsoleBtn.style.color = "var(--text)";
        }
      }
    } else {
      mobileTabs.style.display = "none";
      if (isCodeMode) {
        codeWrapper.style.display = "flex";
        codeWrapper.style.width = "";
        codeWrapper.style.height = "";
        terminalContainer2.style.display = "flex";
        terminalContainer2.style.width = "";
        terminalContainer2.style.height = "";
        splitResizer2.style.display = "block";
      } else {
        codeWrapper.style.display = "none";
        terminalContainer2.style.display = "none";
        splitResizer2.style.display = "none";
      }
    }
    if (codeMirrorInstance) {
      codeMirrorInstance.refresh();
    }
    repositionAllRemoteCursors();
  }
  function getCanvasRect() {
    if (!canvasBoundingRect && canvas) {
      canvasBoundingRect = canvas.getBoundingClientRect();
    }
    return canvasBoundingRect || { top: 0, left: 0, width: 800, height: 600 };
  }
  function getTextCursorContainerRect() {
    if (!textCursorContainerBoundingRect && textCursorContainer) {
      textCursorContainerBoundingRect = textCursorContainer.getBoundingClientRect();
    }
    return textCursorContainerBoundingRect || { top: 0, left: 0 };
  }
  function resizeCanvas() {
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    const width = Math.floor(rect.width) || 800;
    const height = Math.floor(rect.height) || 600;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    if (cursorContainer) {
      cursorContainer.style.width = "100%";
      cursorContainer.style.height = "100%";
    }
    if (canvas.width === width && canvas.height === height) {
      canvasBoundingRect = canvas.getBoundingClientRect();
      textCursorContainerBoundingRect = null;
      return;
    }
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tempCtx2 = tempCanvas.getContext("2d");
    tempCtx2.drawImage(canvas, 0, 0);
    canvas.width = width;
    canvas.height = height;
    ctx2.imageSmoothingEnabled = true;
    ctx2.imageSmoothingQuality = "high";
    ctx2.drawImage(tempCanvas, 0, 0, tempCanvas.width, tempCanvas.height, 0, 0, canvas.width, canvas.height);
    canvasBoundingRect = canvas.getBoundingClientRect();
    textCursorContainerBoundingRect = null;
  }
  function startDrawing(e) {
    isDrawing = true;
    const rect = getCanvasRect();
    lastX = e.clientX - rect.left;
    lastY = e.clientY - rect.top;
  }
  function startDrawingTouch(e) {
    if (e.touches.length !== 1) return;
    isDrawing = true;
    const rect = getCanvasRect();
    lastX = e.touches[0].clientX - rect.left;
    lastY = e.touches[0].clientY - rect.top;
    e.preventDefault();
  }
  function draw(e) {
    if (!isDrawing) return;
    const rect = getCanvasRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    drawSegment(lastX, lastY, x, y, brushColor, brushSize);
    if (broadcastCallback) {
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const h = canvas.height || 1;
      broadcastCallback({
        type: "wb-draw",
        x0: Math.round((lastX - cx) / h * 1e3) / 1e3,
        y0: Math.round((lastY - cy) / h * 1e3) / 1e3,
        x1: Math.round((x - cx) / h * 1e3) / 1e3,
        y1: Math.round((y - cy) / h * 1e3) / 1e3,
        color: brushColor,
        size: brushSize
      });
    }
    lastX = x;
    lastY = y;
  }
  function drawTouch(e) {
    if (!isDrawing || e.touches.length !== 1) return;
    const rect = getCanvasRect();
    const x = e.touches[0].clientX - rect.left;
    const y = e.touches[0].clientY - rect.top;
    drawSegment(lastX, lastY, x, y, brushColor, brushSize);
    if (broadcastCallback) {
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const h = canvas.height || 1;
      broadcastCallback({
        type: "wb-draw",
        x0: Math.round((lastX - cx) / h * 1e3) / 1e3,
        y0: Math.round((lastY - cy) / h * 1e3) / 1e3,
        x1: Math.round((x - cx) / h * 1e3) / 1e3,
        y1: Math.round((y - cy) / h * 1e3) / 1e3,
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
    if (!ctx2) return;
    ctx2.beginPath();
    ctx2.moveTo(x0, y0);
    ctx2.lineTo(x1, y1);
    ctx2.lineCap = "round";
    ctx2.lineJoin = "round";
    if (color === "eraser") {
      ctx2.globalCompositeOperation = "destination-out";
      ctx2.lineWidth = size * 2.5;
    } else {
      ctx2.globalCompositeOperation = "source-over";
      ctx2.strokeStyle = color;
      ctx2.lineWidth = size;
    }
    ctx2.stroke();
    ctx2.closePath();
    ctx2.globalCompositeOperation = "source-over";
  }
  function handleIncomingDraw(data) {
    if (!canvas) return;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const h = canvas.height;
    const x0 = data.x0 * h + cx;
    const y0 = data.y0 * h + cy;
    const x1 = data.x1 * h + cx;
    const y1 = data.y1 * h + cy;
    drawSegment(x0, y0, x1, y1, data.color, data.size);
  }
  function clearCanvas() {
    if (!canvas || !ctx2) return;
    ctx2.clearRect(0, 0, canvas.width, canvas.height);
  }
  function handleIncomingText(content, caretIndex, username, peerId) {
    if (!textarea) return;
    if (activeEditorMode === "code" && codeMirrorInstance) {
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
        } catch (e) {
        }
      } finally {
        isProgrammaticUpdate = false;
      }
    }
    if (caretIndex !== void 0 && peerId) {
      handleIncomingTextCursor(peerId, { active: true, caretIndex }, username);
    }
  }
  function handleIncomingCursor(peerId, data, username) {
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
    remotePointerMap.set(peerId, { x: data.x, y: data.y, username });
    if (!cursorEl) {
      cursorEl = document.createElement("div");
      cursorEl.id = cursorId;
      cursorEl.className = "peer-cursor";
      cursorEl.style.position = "absolute";
      cursorEl.style.display = "flex";
      cursorEl.style.alignItems = "center";
      cursorEl.style.gap = "4px";
      cursorEl.style.pointerEvents = "none";
      cursorEl.style.zIndex = "20";
      cursorEl.style.top = "0";
      cursorEl.style.left = "0";
      cursorEl.style.opacity = "0";
      cursorEl.style.transition = "transform 0.08s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.3s ease";
      cursorEl.style.willChange = "transform, opacity";
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
      cursorEl.offsetHeight;
    }
    const rect = getCanvasRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const h = rect.height;
    const x = Math.round(data.x * h + cx);
    const y = Math.round(data.y * h + cy);
    cursorEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    cursorEl.style.opacity = "1";
    const timeout = setTimeout(() => {
      const el = document.getElementById(cursorId);
      if (el) {
        el.style.opacity = "0";
        setTimeout(() => {
          if (el.style.opacity === "0") {
            el.remove();
            remotePointerMap.delete(peerId);
          }
        }, 300);
      }
      peerCursorTimeouts.delete(peerId);
    }, 3e3);
    peerCursorTimeouts.set(peerId, timeout);
  }
  function cleanupPeerCursor(peerId) {
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
  function handleIncomingTextCursor(peerId, data, username) {
    if (!textCursorContainer || !textarea) return;
    const cursorId = `wb-text-cursor-${peerId}`;
    let cursorEl = document.getElementById(cursorId);
    if (peerTextCursorTimeouts.has(peerId)) {
      clearTimeout(peerTextCursorTimeouts.get(peerId));
      peerTextCursorTimeouts.delete(peerId);
    }
    if (!data.active || data.caretIndex === void 0) {
      if (cursorEl) cursorEl.remove();
      remoteTextCaretMap.delete(peerId);
      return;
    }
    remoteTextCaretMap.set(peerId, { caretIndex: data.caretIndex, username });
    let coords;
    if (activeEditorMode === "code" && codeMirrorInstance) {
      coords = getCodeCaretCoordinates(data.caretIndex);
    } else {
      coords = getCaretCoordinates(textarea, data.caretIndex);
    }
    if (!cursorEl) {
      cursorEl = document.createElement("div");
      cursorEl.id = cursorId;
      cursorEl.className = "peer-text-cursor";
      cursorEl.style.position = "absolute";
      cursorEl.style.display = "flex";
      cursorEl.style.flexDirection = "column";
      cursorEl.style.alignItems = "flex-start";
      cursorEl.style.pointerEvents = "none";
      cursorEl.style.zIndex = "20";
      cursorEl.style.top = "0";
      cursorEl.style.left = "0";
      cursorEl.style.opacity = "0";
      cursorEl.style.transition = "transform 0.08s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.3s ease";
      cursorEl.style.willChange = "transform, opacity";
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
      cursorEl.offsetHeight;
    }
    cursorEl.style.transform = `translate3d(${coords.left}px, ${coords.top}px, 0)`;
    cursorEl.style.opacity = "1";
    const timeout = setTimeout(() => {
      const el = document.getElementById(cursorId);
      if (el) {
        el.style.opacity = "0";
        setTimeout(() => {
          if (el.style.opacity === "0") el.remove();
        }, 300);
      }
      peerTextCursorTimeouts.delete(peerId);
    }, 4e3);
    peerTextCursorTimeouts.set(peerId, timeout);
  }
  function repositionAllRemoteCursors() {
    if (!textarea) return;
    for (const [peerId, caretData] of remoteTextCaretMap.entries()) {
      let coords;
      if (activeEditorMode === "code" && codeMirrorInstance) {
        coords = getCodeCaretCoordinates(caretData.caretIndex);
      } else {
        coords = getCaretCoordinates(textarea, caretData.caretIndex);
      }
      const cursorEl = document.getElementById(`wb-text-cursor-${peerId}`);
      if (cursorEl) {
        cursorEl.style.transform = `translate3d(${coords.left}px, ${coords.top}px, 0)`;
      }
    }
    if (cursorContainer) {
      const rect = getCanvasRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const h = rect.height;
      for (const [peerId, pointerData] of remotePointerMap.entries()) {
        const cursorEl = document.getElementById(`wb-cursor-${peerId}`);
        if (cursorEl) {
          const x = Math.round(pointerData.x * h + cx);
          const y = Math.round(pointerData.y * h + cy);
          cursorEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        }
      }
    }
  }
  function getCodeCaretCoordinates(position) {
    if (!codeMirrorInstance) return { top: 0, left: 0 };
    const doc = codeMirrorInstance.getDoc();
    const pos = doc.posFromIndex(position);
    const coords = codeMirrorInstance.charCoords(pos, "window");
    if (!textCursorContainer) return { top: 0, left: 0 };
    const containerRect = getTextCursorContainerRect();
    return {
      top: coords.top - containerRect.top,
      left: coords.left - containerRect.left
    };
  }
  function getCaretCoordinates(element, position) {
    if (!mimicDiv) {
      mimicDiv = document.createElement("div");
      mimicDiv.style.position = "absolute";
      mimicDiv.style.visibility = "hidden";
      mimicDiv.style.whiteSpace = "pre-wrap";
      mimicDiv.style.wordBreak = "break-word";
      mimicDiv.style.overflowY = "auto";
      mimicDiv.style.pointerEvents = "none";
      mimicTextBefore = document.createTextNode("");
      mimicSpan = document.createElement("span");
      mimicSpan.textContent = "|";
      mimicTextAfter = document.createTextNode("");
      mimicDiv.appendChild(mimicTextBefore);
      mimicDiv.appendChild(mimicSpan);
      mimicDiv.appendChild(mimicTextAfter);
      document.body.appendChild(mimicDiv);
    }
    if (!cachedTextareaStyles) {
      cacheTextareaStyles();
    }
    if (cachedTextareaStyles) {
      Object.keys(cachedTextareaStyles).forEach((prop) => {
        mimicDiv.style[prop] = cachedTextareaStyles[prop];
      });
    }
    const rect = element.getBoundingClientRect();
    mimicDiv.style.width = `${rect.width}px`;
    mimicDiv.style.height = `${rect.height}px`;
    mimicDiv.style.top = `${rect.top + window.scrollY}px`;
    mimicDiv.style.left = `${rect.left + window.scrollX}px`;
    const text = element.value;
    mimicTextBefore.nodeValue = text.substring(0, position);
    mimicTextAfter.nodeValue = text.substring(position);
    mimicDiv.scrollTop = element.scrollTop;
    mimicDiv.scrollLeft = element.scrollLeft;
    const spanRect = mimicSpan.getBoundingClientRect();
    if (!textCursorContainer) return { top: 0, left: 0 };
    const containerRect = getTextCursorContainerRect();
    return {
      top: spanRect.top - containerRect.top,
      left: spanRect.left - containerRect.left
    };
  }
  function renderTerminalResult(result) {
    const terminal2 = document.getElementById("wbTerminal");
    if (!terminal2) return;
    terminal2.textContent = "";
    if (result.stderr) {
      terminal2.style.color = "#ff3333";
      terminal2.textContent += result.stderr;
    }
    if (result.stdout) {
      if (result.stderr) {
        terminal2.textContent += "\n\n";
      }
      terminal2.style.color = "#39ff14";
      terminal2.textContent += result.stdout;
    }
    if (!result.stdout && !result.stderr) {
      terminal2.style.color = "#888888";
      terminal2.textContent = "Process exited with no output.";
    }
    terminal2.scrollTop = terminal2.scrollHeight;
  }
  function handleIncomingEditorMode(mode) {
    activeEditorMode = mode;
    if (!modeTextBtn || !modeCodeBtn || !codeControls || !textarea || !terminalContainer) return;
    const updateCodeMirrorMode = (lang) => {
      if (!codeMirrorInstance) return;
      const modeMap = {
        javascript: "javascript",
        python: "python",
        c: "text/x-csrc",
        cpp: "text/x-c++src",
        rust: "text/x-rustsrc",
        java: "text/x-java",
        bash: "shell"
      };
      codeMirrorInstance.setOption("mode", modeMap[lang] || "javascript");
    };
    if (mode === "code") {
      modeCodeBtn.classList.add("active");
      modeCodeBtn.style.background = "rgba(255,255,255,0.08)";
      modeCodeBtn.style.color = "var(--text)";
      modeTextBtn.classList.remove("active");
      modeTextBtn.style.background = "transparent";
      modeTextBtn.style.color = "var(--muted)";
      codeControls.style.display = "flex";
      terminalContainer.style.display = "flex";
      textarea.style.display = "none";
      if (codeEditorWrapper) codeEditorWrapper.style.display = "flex";
      if (splitResizer) splitResizer.style.display = "block";
      if (codeMirrorInstance) {
        const lang = languageSelect ? languageSelect.value : "javascript";
        codeMirrorInstance.setValue(textarea.value.trim() ? textarea.value : getDefaultCodePlaceholder(lang));
        updateCodeMirrorMode(languageSelect ? languageSelect.value : "javascript");
        setTimeout(() => codeMirrorInstance.refresh(), 20);
      }
    } else {
      modeTextBtn.classList.add("active");
      modeTextBtn.style.background = "rgba(255,255,255,0.08)";
      modeTextBtn.style.color = "var(--text)";
      modeCodeBtn.classList.remove("active");
      modeCodeBtn.style.background = "transparent";
      modeCodeBtn.style.color = "var(--muted)";
      codeControls.style.display = "none";
      terminalContainer.style.display = "none";
      textarea.style.display = "block";
      if (codeEditorWrapper) codeEditorWrapper.style.display = "none";
      if (splitResizer) splitResizer.style.display = "none";
      if (codeMirrorInstance) {
        textarea.value = codeMirrorInstance.getValue();
      }
    }
  }
  function handleIncomingEditorLang(lang) {
    const languageSelect2 = document.getElementById("wbLanguageSelect");
    if (languageSelect2) {
      languageSelect2.value = lang;
    }
    if (codeMirrorInstance) {
      const currentVal = codeMirrorInstance.getValue();
      if (isPlaceholderOrEmpty(currentVal)) {
        codeMirrorInstance.setValue(getDefaultCodePlaceholder(lang));
      }
      const modeMap = {
        javascript: "javascript",
        python: "python",
        c: "text/x-csrc",
        cpp: "text/x-c++src",
        rust: "text/x-rustsrc",
        java: "text/x-java",
        bash: "shell"
      };
      codeMirrorInstance.setOption("mode", modeMap[lang] || "javascript");
    }
  }
  function handleIncomingCompileStart() {
    const terminal2 = document.getElementById("wbTerminal");
    if (terminal2) {
      terminal2.textContent = "Collaborator is running code on secure sandbox...";
      terminal2.style.color = "#39ff14";
    }
  }
  function handleIncomingCompileResult(data) {
    renderTerminalResult({
      stdout: data.stdout,
      stderr: data.stderr,
      exitCode: data.exitCode
    });
  }
  function getActiveEditorMode() {
    return activeEditorMode;
  }
  function getActiveLanguage() {
    const languageSelect2 = document.getElementById("wbLanguageSelect");
    return languageSelect2 ? languageSelect2.value : "javascript";
  }
  function getActiveStdin() {
    const stdinEl = document.getElementById("wbStdin");
    return stdinEl ? stdinEl.value : "";
  }
  function handleIncomingStdin(content) {
    const stdinEl = document.getElementById("wbStdin");
    if (!stdinEl || stdinEl.value === content) return;
    lastSentStdin = content;
    stdinEl.value = content;
  }
  function cleanup() {
    if (codeMirrorInstance) {
      try {
        codeMirrorInstance.setValue("");
      } catch (e) {
        console.debug("Failed to clear CodeMirror instance:", e);
      }
    }
    const cursorContainer2 = document.getElementById("wbCursorContainer");
    if (cursorContainer2) {
      cursorContainer2.innerHTML = "";
    }
    const textCursorContainer2 = document.getElementById("wbTextCursorContainer");
    if (textCursorContainer2) {
      textCursorContainer2.innerHTML = "";
    }
    peerCursorTimeouts.forEach((t) => clearTimeout(t));
    peerCursorTimeouts.clear();
    peerTextCursorTimeouts.forEach((t) => clearTimeout(t));
    peerTextCursorTimeouts.clear();
    remoteTextCaretMap.clear();
    remotePointerMap.clear();
    canvasBoundingRect = null;
    textCursorContainerBoundingRect = null;
    const codeEditorWrapper2 = document.getElementById("wbCodeEditorWrapper");
    const terminalContainer2 = document.getElementById("wbTerminalContainer");
    if (codeEditorWrapper2) {
      codeEditorWrapper2.style.width = "";
      codeEditorWrapper2.style.height = "";
    }
    if (terminalContainer2) {
      terminalContainer2.style.width = "";
      terminalContainer2.style.height = "";
    }
    const stdinContainer = document.getElementById("wbStdinContainer");
    if (stdinContainer) {
      stdinContainer.style.height = "";
    }
    lastSentText = "";
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
    if (cursorThrottleTimeout) {
      clearTimeout(cursorThrottleTimeout);
      cursorThrottleTimeout = null;
    }
    if (textCursorThrottleTimeout) {
      clearTimeout(textCursorThrottleTimeout);
      textCursorThrottleTimeout = null;
    }
    if (codeCursorThrottleTimeout) {
      clearTimeout(codeCursorThrottleTimeout);
      codeCursorThrottleTimeout = null;
    }
    if (resizeFrameId) {
      cancelAnimationFrame(resizeFrameId);
      resizeFrameId = null;
    }
    if (breakpointFrameId) {
      cancelAnimationFrame(breakpointFrameId);
      breakpointFrameId = null;
    }
    if (cmScrollFrameId) {
      cancelAnimationFrame(cmScrollFrameId);
      cmScrollFrameId = null;
    }
    if (textareaScrollFrameId) {
      cancelAnimationFrame(textareaScrollFrameId);
      textareaScrollFrameId = null;
    }
  }
  function getCanvasDataURL() {
    if (!canvas) return null;
    try {
      return canvas.toDataURL("image/png");
    } catch (e) {
      console.error("Failed to get canvas data URL:", e);
      return null;
    }
  }
  function loadCanvasImage(dataURL) {
    if (!canvas || !ctx2) return;
    const img = new Image();
    img.onload = () => {
      ctx2.clearRect(0, 0, canvas.width, canvas.height);
      ctx2.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = dataURL;
  }

  // public/modules/captions.js
  var recognition = null;
  var isActive = false;
  var broadcastCallback2 = null;
  var getUsernameCallback = null;
  var isMutedCallback = null;
  var fadeTimeout = null;
  var innerFadeTimeout = null;
  var restartAttempts = 0;
  var lastRestartTime = 0;
  var ui = {
    ccBtn: null,
    ccOverlay: null,
    ccSpeaker: null,
    ccText: null
  };
  function init3(broadcastFn, getUsernameFn, isMutedFn) {
    broadcastCallback2 = broadcastFn;
    getUsernameCallback = getUsernameFn;
    isMutedCallback = isMutedFn;
    ui.ccBtn = document.getElementById("ccBtn");
    ui.ccOverlay = document.getElementById("ccOverlay");
    ui.ccSpeaker = document.getElementById("ccSpeaker");
    ui.ccText = document.getElementById("ccText");
    if (ui.ccBtn) {
      ui.ccBtn.addEventListener("click", toggleCaptions);
    }
  }
  function displayCaption(speaker, text) {
    if (!ui.ccOverlay || !ui.ccSpeaker || !ui.ccText) return;
    clearTimeout(fadeTimeout);
    clearTimeout(innerFadeTimeout);
    ui.ccSpeaker.textContent = speaker + ":";
    ui.ccText.textContent = text;
    ui.ccOverlay.style.display = "block";
    ui.ccOverlay.classList.remove("hidden");
    fadeTimeout = setTimeout(() => {
      ui.ccOverlay.classList.add("hidden");
      innerFadeTimeout = setTimeout(() => {
        if (ui.ccOverlay.classList.contains("hidden")) {
          ui.ccOverlay.style.display = "none";
        }
      }, 200);
    }, 4e3);
  }
  function syncMuteState(isMuted) {
    if (!isActive) return;
    if (isMuted) {
      if (recognition) {
        try {
          recognition.stop();
        } catch (e) {
          console.warn("Failed to stop speech recognition on mute:", e);
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
            if (e.name !== "InvalidStateError") {
              console.error("Failed to restart speech recognition on unmute:", e);
            }
          }
        }
      }, 150);
    }
  }
  function startRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("Speech recognition is not supported in this browser. Please use Chrome, Edge, or Safari.");
      isActive = false;
      return;
    }
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onstart = () => {
      restartAttempts = 0;
      if (ui.ccBtn) {
        ui.ccBtn.classList.add("active");
        ui.ccBtn.style.color = "var(--success)";
      }
    };
    recognition.onresult = (event) => {
      if (isMutedCallback && isMutedCallback()) {
        return;
      }
      let finalTranscript = "";
      let interimTranscript = "";
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }
      if (interimTranscript.trim()) {
        displayCaption("You (Speaking)", interimTranscript);
      }
      if (finalTranscript.trim()) {
        const username = getUsernameCallback ? getUsernameCallback() : "You";
        displayCaption("You", finalTranscript);
        if (broadcastCallback2) {
          broadcastCallback2({ type: "caption", text: finalTranscript, username });
        }
      }
    };
    recognition.onerror = (event) => {
      console.error("Speech recognition error:", event.error);
      if (event.error === "not-allowed") {
        stopRecognition();
        if (typeof window.showToast === "function") {
          window.showToast("Microphone access denied for speech recognition.", "warning");
        }
      }
    };
    recognition.onend = () => {
      if (isActive && !(isMutedCallback && isMutedCallback())) {
        const now = Date.now();
        if (now - lastRestartTime < 2e3) {
          restartAttempts++;
        } else {
          restartAttempts = 0;
        }
        lastRestartTime = now;
        if (restartAttempts >= 5) {
          console.warn("Speech recognition dropped repeatedly. Aborting auto-restart.");
          stopRecognition();
          if (typeof window.showToast === "function") {
            window.showToast("Speech recognition service dropped out. Please check microphone permissions.", "warning");
          }
          return;
        }
        const delay = Math.min(5e3, 100 + restartAttempts * 1e3);
        setTimeout(() => {
          if (isActive && !(isMutedCallback && isMutedCallback())) {
            try {
              recognition.start();
            } catch (e) {
              if (e.name !== "InvalidStateError") {
                console.warn("Speech recognition failed to restart in delayed loop:", e);
              }
            }
          }
        }, delay);
      } else {
        if (ui.ccBtn && !isActive) {
          ui.ccBtn.classList.remove("active");
          ui.ccBtn.style.color = "";
        }
      }
    };
    try {
      recognition.start();
    } catch (e) {
      console.error("Failed to start recognition:", e);
    }
  }
  function stopRecognition() {
    isActive = false;
    if (recognition) {
      try {
        recognition.stop();
      } catch (e) {
      }
      recognition = null;
    }
    if (ui.ccBtn) {
      ui.ccBtn.classList.remove("active");
      ui.ccBtn.style.color = "";
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
  function cleanup2() {
    stopRecognition();
    getUsernameCallback = null;
    broadcastCallback2 = null;
    isMutedCallback = null;
  }

  // public/modules/stats.js
  var isStatsEnabled = false;
  var statsIntervalId = null;
  var lastStatsMap = /* @__PURE__ */ new Map();
  var badgeCacheMap = /* @__PURE__ */ new Map();
  var getPeersCallback = null;
  function init4(getPeersFn) {
    getPeersCallback = getPeersFn;
    const statsBtn = document.getElementById("statsBtn");
    if (statsBtn) {
      statsBtn.addEventListener("click", toggleStats);
    }
  }
  function stopPolling() {
    if (statsIntervalId) {
      clearInterval(statsIntervalId);
      statsIntervalId = null;
    }
    lastStatsMap.clear();
  }
  function cleanup3() {
    stopPolling();
    isStatsEnabled = false;
    badgeCacheMap.clear();
    const statsBtn = document.getElementById("statsBtn");
    if (statsBtn) {
      statsBtn.classList.remove("active");
      statsBtn.style.color = "";
    }
    hideAllBadges();
  }
  function toggleStats() {
    isStatsEnabled = !isStatsEnabled;
    const statsBtn = document.getElementById("statsBtn");
    if (statsBtn) {
      if (isStatsEnabled) {
        statsBtn.classList.add("active");
        statsBtn.style.color = "var(--success)";
        startPolling();
        const peers = getPeersCallback ? getPeersCallback() : null;
        const hasPeers = peers && peers.size > 0;
        if (!hasPeers) {
          if (typeof window.showToast === "function") {
            window.showToast("Stats enabled \u2014 will show badges when peers connect.", "info", 3e3);
          }
        }
      } else {
        statsBtn.classList.remove("active");
        statsBtn.style.color = "";
        stopPolling();
        hideAllBadges();
      }
    }
  }
  function startPolling() {
    stopPolling();
    updateStats();
    statsIntervalId = setInterval(updateStats, 2e3);
  }
  function hideAllBadges() {
    const badges = document.querySelectorAll(".stats-badge");
    badges.forEach((b) => {
      b.style.display = "none";
      const wrapper = b.parentElement;
      if (wrapper) {
        const latencyEl = wrapper.querySelector(".latency-badge");
        if (latencyEl) latencyEl.style.opacity = "1";
      }
    });
  }
  function cleanupPeerStats(peerId) {
    lastStatsMap.delete(peerId + "-inbound");
    badgeCacheMap.delete(peerId);
    const badge = document.getElementById(`stats-badge-${peerId}`);
    if (badge) {
      const wrapper = badge.parentElement;
      if (wrapper) {
        const latencyEl = wrapper.querySelector(".latency-badge");
        if (latencyEl) latencyEl.style.opacity = "1";
      }
      badge.remove();
    }
  }
  async function updateStats() {
    if (!getPeersCallback) return;
    const peers = getPeersCallback();
    for (const [peerId, peer] of peers.entries()) {
      if (!peer.pc || peer.pc.connectionState === "closed") {
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
        stats.forEach((report) => {
          if (report.type === "inbound-rtp" && report.kind === "video") {
            width = report.frameWidth || 0;
            height = report.frameHeight || 0;
            loss = report.packetsLost || 0;
            const prev = lastStatsMap.get(peerId + "-inbound") || { bytes: 0, time: 0, frames: 0 };
            const byteDiff = report.bytesReceived - prev.bytes;
            const timeDiff = report.timestamp - prev.time;
            if (prev.bytes > 0 && timeDiff > 0) {
              kbps = Math.round(byteDiff * 8 / timeDiff);
            }
            if (prev.frames > 0 && timeDiff > 0) {
              fps = Math.round((report.framesDecoded - prev.frames) * 1e3 / timeDiff);
            }
            lastStatsMap.set(peerId + "-inbound", {
              bytes: report.bytesReceived,
              time: report.timestamp,
              frames: report.framesDecoded
            });
          }
          if (report.type === "candidate-pair" && report.nominated === true && report.state === "succeeded") {
            rtt = report.currentRoundTripTime ? Math.round(report.currentRoundTripTime * 1e3) : 0;
          }
        });
        updateBadge(peerId, width, height, fps, rtt, loss, kbps);
      } catch (e) {
        console.warn(`Failed to retrieve stats for peer ${peerId}:`, e);
      }
    }
  }
  function updateBadge(peerId, width, height, fps, rtt, loss, kbps) {
    let cached = badgeCacheMap.get(peerId);
    if (!cached) {
      const badgeId = `stats-badge-${peerId}`;
      let badgeEl = document.getElementById(badgeId);
      if (!badgeEl) {
        const wrapper = document.getElementById(`video-wrapper-${peerId}`);
        if (wrapper) {
          badgeEl = document.createElement("div");
          badgeEl.id = badgeId;
          badgeEl.className = "stats-badge";
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
        cached = {
          badgeEl,
          resSpan: badgeEl.querySelector(".stat-res"),
          fpsSpan: badgeEl.querySelector(".stat-fps"),
          bitrateSpan: badgeEl.querySelector(".stat-bitrate"),
          rttSpan: badgeEl.querySelector(".stat-rtt"),
          rttItem: badgeEl.querySelector(".stat-rtt-item"),
          lossSpan: badgeEl.querySelector(".stat-loss"),
          lossItem: badgeEl.querySelector(".stat-loss-item")
        };
        badgeCacheMap.set(peerId, cached);
      }
    }
    if (cached) {
      const { badgeEl, resSpan, fpsSpan, bitrateSpan, rttSpan, rttItem, lossSpan, lossItem } = cached;
      if (isStatsEnabled) {
        badgeEl.style.display = "block";
        const wrapper = badgeEl.parentElement;
        if (wrapper) {
          const latencyEl = wrapper.querySelector(".latency-badge");
          if (latencyEl) latencyEl.style.opacity = "0";
        }
        if (resSpan) resSpan.textContent = width && height ? `${width}x${height}` : "---";
        if (fpsSpan) fpsSpan.textContent = `${fps || 0} fps`;
        if (bitrateSpan) bitrateSpan.textContent = `${kbps || 0} kbps`;
        if (rttSpan && rttItem) {
          rttSpan.textContent = `${rtt || "<1"}ms`;
          rttItem.className = "stat-item stat-rtt-item";
          if (rtt < 60) {
            rttItem.classList.add("stat-latency-green");
          } else if (rtt < 150) {
            rttItem.classList.add("stat-latency-warn");
          } else {
            rttItem.classList.add("stat-latency-danger");
          }
        }
        if (lossSpan && lossItem) {
          lossSpan.textContent = `Loss: ${loss}`;
          lossItem.className = "stat-item stat-loss-item";
          if (loss > 0) {
            lossItem.classList.add("stat-loss-bad");
          }
        }
      } else {
        badgeEl.style.display = "none";
        const wrapper = badgeEl.parentElement;
        if (wrapper) {
          const latencyEl = wrapper.querySelector(".latency-badge");
          if (latencyEl) latencyEl.style.opacity = "1";
        }
      }
    }
  }

  // public/app.js
  var socket = io();
  var ROOM_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
  var textEncoder = new TextEncoder();
  var textDecoder = new TextDecoder();
  var runtimeConfig = window.__VOIP_APP_CONFIG__ || {};
  var DEFAULT_ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:global.stun.twilio.com:3478" },
    {
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:443",
        "turn:openrelay.metered.ca:443?transport=tcp"
      ],
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ];
  function normalizeIceServers(servers) {
    if (!Array.isArray(servers)) return DEFAULT_ICE_SERVERS;
    const normalized = servers.map((server) => {
      if (!server || typeof server !== "object" || !server.urls) return null;
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      const cleanedUrls = urls.map((url) => String(url || "").trim()).filter(Boolean);
      if (!cleanedUrls.length) return null;
      const entry = { urls: cleanedUrls.length === 1 ? cleanedUrls[0] : cleanedUrls };
      if (typeof server.username === "string" && server.username.trim()) entry.username = server.username.trim();
      if (typeof server.credential === "string" && server.credential.trim()) entry.credential = server.credential.trim();
      return entry;
    }).filter(Boolean);
    return normalized.length ? normalized : DEFAULT_ICE_SERVERS;
  }
  function hasTurnRelayServer(servers) {
    return Array.isArray(servers) && servers.some((server) => {
      const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
      return urls.some((url) => String(url || "").toLowerCase().startsWith("turn:"));
    });
  }
  var rtcConfig = {
    iceServers: normalizeIceServers(runtimeConfig.iceServers)
  };
  async function hashPassword(password) {
    if (!password) return "";
    const data = textEncoder.encode(password);
    const hashBuffer = await window.crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function deriveChatKey(password, roomId) {
    if (!password) return null;
    const keyMaterial = await window.crypto.subtle.importKey(
      "raw",
      textEncoder.encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveBits", "deriveKey"]
    );
    const salt = textEncoder.encode(roomId || "default_salt");
    return window.crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 1e5, hash: "SHA-256" },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
  }
  function bufferToBase64(buffer) {
    let binary = "";
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
      { name: "AES-GCM", iv },
      key,
      textEncoder.encode(text)
    );
    return {
      payload: bufferToBase64(encrypted),
      iv: bufferToBase64(iv)
    };
  }
  async function decryptMessage(key, encryptedBase64, ivBase64) {
    if (!key) throw new Error("No decryption key available");
    const encrypted = base64ToBuffer(encryptedBase64);
    const iv = base64ToBuffer(ivBase64);
    const decrypted = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      encrypted
    );
    return textDecoder.decode(decrypted);
  }
  var typingUsers = /* @__PURE__ */ new Set();
  function updateTypingIndicator() {
    const typingIndicator = document.getElementById("typingIndicator");
    if (!typingIndicator) return;
    if (typingUsers.size === 0) {
      typingIndicator.style.display = "none";
      typingIndicator.textContent = "";
    } else {
      typingIndicator.style.display = "block";
      if (typingUsers.size === 1) {
        typingIndicator.textContent = `${Array.from(typingUsers)[0]} is typing...`;
      } else if (typingUsers.size === 2) {
        typingIndicator.textContent = `${Array.from(typingUsers).join(" and ")} are typing...`;
      } else {
        typingIndicator.textContent = "Multiple people are typing...";
      }
    }
  }
  var state = {
    e2eeKey: null,
    roomId: "",
    localStream: null,
    rawStream: null,
    audioContext: null,
    audioGraph: null,
    selectedDeviceId: "",
    joining: false,
    leaving: false,
    reconnecting: false,
    peers: /* @__PURE__ */ new Map(),
    // peerId -> peerState
    existingPeers: /* @__PURE__ */ new Set(),
    // peers already in room when we joined
    username: "",
    audioAnalysers: /* @__PURE__ */ new Map(),
    // peerId -> analyser
    videoEnabled: false,
    rawCameraTrack: null,
    screenSharing: false,
    screenAudioContext: null,
    mixedAudioTrack: null,
    tabAudioSource: null,
    micAudioSource: null,
    incomingFiles: /* @__PURE__ */ new Map(),
    // fileId -> { fileId, peerId, metadata, chunks, receivedSize }
    recording: false,
    roomPassword: "",
    focusedPeerId: null,
    autoDirectorEnabled: false,
    lastDirectorSwitchTime: 0
  };
  var mediaRecorder;
  var recordedChunks = [];
  var recordingAudioContext = null;
  var recordingAudioDestination = null;
  var recordingAudioSources = /* @__PURE__ */ new Map();
  var speakerPollIntervalId = null;
  var activeBlobUrls = [];
  var MAX_CHAT_MESSAGES = 200;
  var MAX_FILE_SIZE = 50 * 1024 * 1024;
  var FILE_CHUNK_SIZE = 16 * 1024;
  var DATA_CHANNEL_HIGH_WATER = 1024 * 1024;
  function getRecordingMimeType() {
    const types = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4"
    ];
    for (const t of types) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) {
        return t;
      }
    }
    return "";
  }
  function addPeerToRecordingAudio(id, stream) {
    if (!state.recording || !recordingAudioContext || !recordingAudioDestination) return;
    if (recordingAudioContext.state === "closed") return;
    if (recordingAudioSources.has(id)) return;
    try {
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack && audioTrack.readyState === "live") {
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
      if (state.screenSharing && state.localVideoTrack && state.localVideoTrack.readyState === "live") {
        videoTrack = state.localVideoTrack;
      } else {
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: "browser" },
          audio: true
        });
        videoTrack = displayStream.getVideoTracks()[0] || null;
        if (!videoTrack || videoTrack.readyState !== "live") {
          if (displayStream) displayStream.getTracks().forEach((t) => t.stop());
          throw new Error("No live video track selected for recording.");
        }
      }
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      recordingAudioContext = new AudioContextCtor();
      if (recordingAudioContext.state === "suspended") {
        await recordingAudioContext.resume().catch(() => {
        });
      }
      recordingAudioDestination = recordingAudioContext.createMediaStreamDestination();
      recordingAudioSources.clear();
      const localMic = currentTrack();
      if (localMic && localMic.readyState === "live") {
        try {
          const micSource = recordingAudioContext.createMediaStreamSource(new MediaStream([localMic]));
          micSource.connect(recordingAudioDestination);
          recordingAudioSources.set("local", micSource);
        } catch (e) {
          console.debug("Failed to connect local mic to recorder:", e);
        }
      }
      if (displayStream && displayStream.getAudioTracks().length > 0) {
        try {
          const tabAudioSource = recordingAudioContext.createMediaStreamSource(displayStream);
          tabAudioSource.connect(recordingAudioDestination);
          recordingAudioSources.set("displayTab", tabAudioSource);
        } catch (e) {
          console.debug("Failed to connect display tab audio to recorder:", e);
        }
      }
      state.peers.forEach((peer, peerId) => {
        const audioEl = document.getElementById(`audio-${peerId}`);
        if (audioEl && audioEl.srcObject) {
          addPeerToRecordingAudio(peerId, audioEl.srcObject);
        }
      });
      const mixedAudioTracks = recordingAudioDestination.stream.getAudioTracks();
      const tracksToRecord = [videoTrack];
      if (mixedAudioTracks.length > 0) {
        tracksToRecord.push(mixedAudioTracks[0]);
      }
      const mixedStream = new MediaStream(tracksToRecord);
      state.recording = true;
      recordedChunks = [];
      const mimeType = getRecordingMimeType();
      mediaRecorder = new MediaRecorder(mixedStream, mimeType ? { mimeType } : void 0);
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recordedChunks.push(e.data);
        }
      };
      mediaRecorder.onstop = () => {
        const recordedBlob = new Blob(recordedChunks, { type: mimeType || "video/webm" });
        if (recordedBlob.size > 0) {
          const url = URL.createObjectURL(recordedBlob);
          const a = document.createElement("a");
          a.href = url;
          const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
          a.download = `Session-Recording-${timestamp}.webm`;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }, 1e3);
          showToast("Session recording saved and downloaded.", "success");
        } else {
          showToast("Recording ended (no video/audio captured).", "warning");
        }
        recordedChunks = [];
        recordingAudioSources.forEach((src) => {
          try {
            src.disconnect();
          } catch (e) {
          }
        });
        recordingAudioSources.clear();
        if (recordingAudioContext && recordingAudioContext.state !== "closed") {
          recordingAudioContext.close().catch(() => {
          });
          recordingAudioContext = null;
        }
        recordingAudioDestination = null;
        if (displayStream) {
          displayStream.getTracks().forEach((t) => t.stop());
        }
      };
      if (displayStream && videoTrack) {
        videoTrack.onended = () => {
          if (state.recording) stopRecording();
        };
      }
      mediaRecorder.start(1e3);
      ui2.recordBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>`;
      ui2.recordBtn.classList.add("danger", "active");
      showToast("Session recording started. Capturing full room audio & video.", "info");
    } catch (error) {
      state.recording = false;
      console.warn("Session recording failed or was cancelled:", error);
      if (error.name !== "NotAllowedError" && error.name !== "AbortError") {
        showToast("Could not start recording. Check permissions.", "error");
      } else {
        showToast("Recording cancelled.", "info");
      }
    }
  }
  function stopRecording() {
    if (!state.recording) return;
    state.recording = false;
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try {
        mediaRecorder.stop();
      } catch (e) {
      }
    }
    ui2.recordBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle></svg>`;
    ui2.recordBtn.classList.remove("danger", "active");
  }
  async function toggleRecording() {
    if (state.recording) {
      stopRecording();
    } else {
      startRecording();
    }
  }
  var ui2 = {
    roomView: document.getElementById("roomView"),
    callView: document.getElementById("callView"),
    usernameInput: document.getElementById("usernameInput"),
    roomInput: document.getElementById("roomInput"),
    passwordInput: document.getElementById("passwordInput"),
    generateLinkBtn: document.getElementById("generateLinkBtn"),
    joinBtn: document.getElementById("joinBtn"),
    hangupBtn: document.getElementById("hangupBtn"),
    muteBtn: document.getElementById("muteBtn"),
    videoBtn: document.getElementById("videoBtn"),
    screenShareBtn: document.getElementById("screenShareBtn"),
    retryMicBtn: document.getElementById("retryMicBtn"),
    copyLinkBtn: document.getElementById("copyLinkBtn"),
    deviceSelect: document.getElementById("deviceSelect"),
    statusText: document.getElementById("statusText"),
    statusDot: document.getElementById("statusDot"),
    micWarningBadge: document.getElementById("micWarningBadge"),
    participantList: document.getElementById("participantList"),
    chatBox: document.getElementById("chatBox"),
    chatInput: document.getElementById("chatInput"),
    sendBtn: document.getElementById("sendBtn"),
    fileInput: document.getElementById("fileInput"),
    attachFileBtn: document.getElementById("attachFileBtn"),
    recordBtn: document.getElementById("recordBtn"),
    toastContainer: document.getElementById("toastContainer"),
    videoContainer: document.getElementById("video-grid"),
    roomChipValue: document.getElementById("roomChipValue"),
    peerCount: document.getElementById("peerCount"),
    socketState: document.getElementById("socketState"),
    midCallDeviceSelect: document.getElementById("midCallDeviceSelect"),
    midCallCameraSelect: document.getElementById("midCallCameraSelect"),
    videoFilterBtn: document.getElementById("videoFilterBtn"),
    whiteboardBtn: document.getElementById("whiteboardBtn"),
    statsBtn: document.getElementById("statsBtn"),
    reactionsToggleBtn: document.getElementById("reactionsToggleBtn"),
    reactionMenu: document.getElementById("reactionMenu"),
    directorBtn: document.getElementById("directorBtn")
  };
  function supportsRequiredApis() {
    return Boolean(
      navigator.mediaDevices && navigator.mediaDevices.getUserMedia && navigator.mediaDevices.enumerateDevices && window.RTCPeerConnection
    );
  }
  function showToast(message, type = "info", ttl = 4e3) {
    window.showToast = showToast;
    const MAX_TOASTS = 8;
    while (ui2.toastContainer.children.length >= MAX_TOASTS) {
      ui2.toastContainer.firstElementChild.remove();
    }
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    ui2.toastContainer.appendChild(toast);
    window.setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(10px)";
      window.setTimeout(() => toast.remove(), 240);
    }, ttl);
  }
  function setStatus(message, tone = "info") {
    ui2.statusText.textContent = message;
    const toneMap = {
      info: { color: "var(--accent)", shadow: "0 0 0 4px rgba(59, 130, 246, 0.15)" },
      success: { color: "var(--success)", shadow: "0 0 0 4px rgba(39, 211, 155, 0.15)" },
      warning: { color: "var(--warning)", shadow: "0 0 0 4px rgba(247, 201, 72, 0.15)" },
      danger: { color: "var(--danger)", shadow: "0 0 0 4px rgba(255, 107, 129, 0.16)" }
    };
    const style = toneMap[tone] || toneMap.info;
    ui2.statusDot.style.background = style.color;
    ui2.statusDot.style.boxShadow = style.shadow;
  }
  function setSocketStateLabel(value) {
    ui2.socketState.textContent = `Socket: ${value}`;
  }
  function setRoomChip(value) {
    ui2.roomChipValue.textContent = value || "Not joined";
  }
  function setMode(mode) {
    const isCall = mode === "call";
    ui2.roomView.style.display = isCall ? "none" : "flex";
    ui2.callView.style.display = isCall ? "flex" : "none";
  }
  function setChatEnabled(enabled) {
    ui2.chatInput.disabled = !enabled;
    ui2.sendBtn.disabled = !enabled;
  }
  function setCallControlsEnabled(enabled) {
    ui2.videoBtn.disabled = !enabled;
    ui2.screenShareBtn.disabled = !enabled;
    ui2.recordBtn.disabled = !enabled;
    ui2.attachFileBtn.disabled = !enabled || openDataChannelCount() === 0;
    if (ui2.videoFilterBtn) ui2.videoFilterBtn.disabled = !enabled;
    if (ui2.ccBtn) ui2.ccBtn.disabled = !enabled;
  }
  function isUsableAudioTrack(track) {
    return Boolean(track && track.kind === "audio" && track.readyState === "live");
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
    return track && track.readyState === "live" ? track : null;
  }
  function stopStream(stream) {
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
  }
  function clearLocalAudioAnalyser() {
    if (!state.audioAnalysers.has("local")) return;
    const analyserData = state.audioAnalysers.get("local");
    if (analyserData) {
      try {
        analyserData.source.disconnect();
      } catch (e) {
      }
      const participantEl = analyserData.participantEl || document.getElementById("participant-local");
      const videoWrapperEl = analyserData.videoWrapperEl || document.getElementById("video-wrapper-local");
      if (participantEl) participantEl.classList.remove("active-speaker");
      if (videoWrapperEl) videoWrapperEl.classList.remove("active-speaker");
    }
    state.audioAnalysers.delete("local");
    if (speakerPollIntervalId && state.audioAnalysers.size === 0) {
      clearInterval(speakerPollIntervalId);
      speakerPollIntervalId = null;
    }
  }
  function peerEntries() {
    return [...state.peers.entries()];
  }
  function openDataChannelCount() {
    return peerEntries().filter(([, peer]) => peer.dataChannel && peer.dataChannel.readyState === "open").length;
  }
  function updatePeerCount() {
    const count = state.peers.size;
    ui2.peerCount.textContent = count === 1 ? "Peers: 1" : `Peers: ${count}`;
  }
  function describePeerConnection(peer) {
    const pcState = peer?.pc?.connectionState || "new";
    const dcState = peer?.dataChannel?.readyState || "closed";
    if (pcState === "connected" && dcState === "open") return "Audio and chat ready";
    if (pcState === "connected") return "Connected, waiting for chat";
    if (pcState === "connecting" || pcState === "new") return "Connecting...";
    if (pcState === "failed") return "Connection failed";
    if (pcState === "disconnected") return "Disconnected";
    return "Negotiating";
  }
  function describePeerBadge(peer) {
    const pcState = peer?.pc?.connectionState || "new";
    const dcState = peer?.dataChannel?.readyState || "closed";
    if (pcState === "connected" && dcState === "open") return { label: "Ready", className: "audio" };
    if (pcState === "failed") return { label: "Error", className: "error" };
    if (pcState === "disconnected") return { label: "Offline", className: "offline" };
    if (dcState === "open") return { label: "Chat", className: "connecting" };
    return { label: "Connecting", className: "connecting" };
  }
  function updateMuteButton() {
    const track = currentTrack();
    ui2.muteBtn.disabled = !track;
    const isEnabled = track && track.enabled;
    if (isEnabled) {
      ui2.muteBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
      ui2.muteBtn.classList.add("active");
      ui2.muteBtn.classList.remove("danger");
    } else {
      ui2.muteBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
      ui2.muteBtn.classList.remove("active");
      ui2.muteBtn.classList.add("danger");
    }
    const localMuteIcon = document.getElementById("mute-icon-local");
    if (localMuteIcon) {
      if (isEnabled) localMuteIcon.classList.add("hidden");
      else localMuteIcon.classList.remove("hidden");
    }
  }
  function updateMicWarningBadge() {
    const show = Boolean(state.roomId) && !currentTrack();
    ui2.micWarningBadge.classList.toggle("is-hidden", !show);
    ui2.micWarningBadge.textContent = "Mic unavailable";
  }
  function updateRetryButton() {
    if (!state.roomId) {
      ui2.retryMicBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`;
      ui2.retryMicBtn.disabled = true;
      return;
    }
    ui2.retryMicBtn.disabled = false;
    ui2.retryMicBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`;
  }
  function setChatStateFromPeers() {
    const hasOpenDataChannel = openDataChannelCount() > 0;
    setChatEnabled(Boolean(state.roomId));
    ui2.attachFileBtn.disabled = !state.roomId || !hasOpenDataChannel;
  }
  function buildParticipantItem(nameText, statusText, badgeLabel, badgeClass, peerId = "local", isMuted = false) {
    const item = document.createElement("div");
    item.className = "participant-item";
    const meta = document.createElement("div");
    meta.className = "participant-meta";
    const nameEl = document.createElement("div");
    nameEl.className = "participant-name";
    nameEl.textContent = nameText;
    const statusEl = document.createElement("div");
    statusEl.className = "participant-status";
    statusEl.textContent = statusText;
    meta.appendChild(nameEl);
    meta.appendChild(statusEl);
    const badgeEl = document.createElement("span");
    badgeEl.className = "participant-badge " + badgeClass;
    badgeEl.textContent = badgeLabel;
    item.appendChild(meta);
    const micEl = document.createElement("div");
    micEl.className = "mic-icon";
    if (isMuted) micEl.classList.add("muted");
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
    ui2.participantList.innerHTML = "";
    const track = currentTrack();
    const isLocalMuted = track ? !track.enabled : true;
    const hasMic = Boolean(track);
    const youItem = buildParticipantItem(state.username || "You", hasMic ? isLocalMuted ? "Muted" : "Microphone active" : "Microphone unavailable", hasMic ? "Ready" : "No Mic", hasMic ? "audio" : "connecting", "local", isLocalMuted);
    youItem.id = `participant-local`;
    ui2.participantList.appendChild(youItem);
    if (!state.roomId) {
      const empty = document.createElement("div");
      empty.className = "participant-empty";
      empty.textContent = "Join a room to see participants appear here.";
      ui2.participantList.appendChild(empty);
      return;
    }
    if (!peerIds.length) {
      const empty = document.createElement("div");
      empty.className = "participant-empty";
      empty.textContent = "Waiting for other participants to join.";
      ui2.participantList.appendChild(empty);
      return;
    }
    peerIds.forEach((peerId) => {
      const peer = state.peers.get(peerId);
      const badge = describePeerBadge(peer);
      const isMuted = peer.isAudioMuted || false;
      const item = buildParticipantItem(peer.username || "Anonymous", describePeerConnection(peer), badge.label, badge.className, peerId, isMuted);
      item.id = `participant-${peerId}`;
      ui2.participantList.appendChild(item);
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
        showToast("Microphone disconnected. You are still in the room without audio.", "warning");
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
      if (state.audioContext.state === "suspended") {
        state.audioContext.resume().catch((e) => console.warn("Could not resume audio context:", e));
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
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const timeData = new Float32Array(analyser.fftSize);
      const participantEl = document.getElementById(`participant-${id}`);
      const videoWrapperEl = document.getElementById(`video-wrapper-${id}`);
      if (participantEl) participantEl.classList.remove("active-speaker");
      if (videoWrapperEl) videoWrapperEl.classList.remove("active-speaker");
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
      console.warn("Could not setup audio analyser:", error);
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
      let isTrackLiveAndEnabled = false;
      let track = null;
      if (id === "local") {
        track = currentTrack();
      } else {
        track = analyserData.stream ? analyserData.stream.getAudioTracks()[0] : null;
      }
      isTrackLiveAndEnabled = Boolean(track && track.enabled && !track.muted && track.readyState === "live");
      let rawSpeaking = false;
      const isWarmedUp = now - analyserData.initTime > 400;
      if (isTrackLiveAndEnabled && isWarmedUp) {
        const { analyser, dataArray, timeData } = analyserData;
        let rms = 0;
        if (timeData) {
          analyser.getFloatTimeDomainData(timeData);
          let sumSquares = 0;
          const len = timeData.length;
          for (let i = 0; i < len; i += 2) {
            sumSquares += timeData[i] * timeData[i];
          }
          rms = Math.sqrt(sumSquares * 2 / len);
        }
        if (!timeData || rms > 8e-3) {
          analyser.getByteFrequencyData(dataArray);
          let voiceSum = 0;
          let voiceBinsCount = 0;
          let peak = 0;
          const maxBin = Math.min(dataArray.length, 45);
          for (let i = 3; i < maxBin; i++) {
            const val = dataArray[i];
            voiceSum += val;
            voiceBinsCount++;
            if (val > peak) peak = val;
          }
          const voiceAvg = voiceBinsCount > 0 ? voiceSum / voiceBinsCount : 0;
          rawSpeaking = (rms > 8e-3 || !timeData) && peak > 75 && voiceAvg > 28;
        } else {
          rawSpeaking = false;
        }
      }
      if (rawSpeaking) {
        analyserData.lastSpeakingTime = now;
      }
      if (!isTrackLiveAndEnabled) {
        analyserData.lastSpeakingTime = 0;
      }
      const shouldBeMarkedSpeaking = isTrackLiveAndEnabled && isWarmedUp && (rawSpeaking || now - analyserData.lastSpeakingTime < 600);
      if (shouldBeMarkedSpeaking) {
        if (!analyserData.firstSpeakStart) {
          analyserData.firstSpeakStart = now;
        } else if (state.autoDirectorEnabled && !state.screenSharing) {
          const speakDuration = now - analyserData.firstSpeakStart;
          const timeSinceLastSwitch = now - (state.lastDirectorSwitchTime || 0);
          if (timeSinceLastSwitch >= 5e3) {
            if (id !== "local" && speakDuration >= 800 && state.focusedPeerId !== id) {
              state.lastDirectorSwitchTime = now;
              focusVideo(id);
              if (typeof window.showToast === "function") {
                const peerName = state.peers.get(id)?.username || "Peer";
                window.showToast(`\u{1F916} AI Director: Focused on active speaker (${peerName})`, "info", 2500);
              }
            } else if (id === "local" && speakDuration >= 1500 && state.focusedPeerId && state.focusedPeerId !== "local") {
              const focusedAnalyzer = state.audioAnalysers.get(state.focusedPeerId);
              if (!focusedAnalyzer || !focusedAnalyzer.speakingState) {
                state.lastDirectorSwitchTime = now;
                unfocusVideo();
                if (typeof window.showToast === "function") {
                  window.showToast(`\u{1F916} AI Director: Returning to group grid view as you speak`, "info", 2500);
                }
              }
            }
          }
        }
      } else {
        analyserData.firstSpeakStart = 0;
      }
      if (analyserData.speakingState !== shouldBeMarkedSpeaking) {
        analyserData.speakingState = shouldBeMarkedSpeaking;
        if (!analyserData.participantEl || !analyserData.participantEl.isConnected) {
          analyserData.participantEl = document.getElementById(`participant-${id}`);
        }
        if (!analyserData.videoWrapperEl || !analyserData.videoWrapperEl.isConnected) {
          analyserData.videoWrapperEl = document.getElementById(id === "local" ? "video-wrapper-local" : `video-wrapper-${id}`);
        }
        if (analyserData.participantEl) {
          analyserData.participantEl.classList.toggle("active-speaker", shouldBeMarkedSpeaking);
        }
        if (analyserData.videoWrapperEl) {
          analyserData.videoWrapperEl.classList.toggle("active-speaker", shouldBeMarkedSpeaking);
        }
      }
      renderAudioVisiBar(id, analyserData, shouldBeMarkedSpeaking);
    });
  }
  var VISI_BAR_TABLE = Array.from({ length: 24 }, (_, i) => {
    const angle = i * 2 * Math.PI / 24 - Math.PI / 2;
    return { cos: Math.cos(angle), sin: Math.sin(angle), color: i % 2 === 0 ? "#00f0ff" : "#a3e635" };
  });
  function renderAudioVisiBar(id, analyserData, shouldBeMarkedSpeaking) {
    if (!analyserData.videoWrapperEl || !analyserData.videoWrapperEl.isConnected) {
      analyserData.videoWrapperEl = document.getElementById(id === "local" ? "video-wrapper-local" : `video-wrapper-${id}`);
    }
    const wrapper = analyserData.videoWrapperEl;
    if (!wrapper) return;
    if (!analyserData.canvasEl || !analyserData.canvasEl.isConnected || !analyserData.ctx) {
      analyserData.canvasEl = wrapper.querySelector(".audio-visi-canvas");
      analyserData.ctx = analyserData.canvasEl ? analyserData.canvasEl.getContext("2d") : null;
    }
    const canvas2 = analyserData.canvasEl;
    const ctx3 = analyserData.ctx;
    if (!canvas2 || !ctx3) return;
    const w = canvas2.width;
    const h = canvas2.height;
    const cx = w / 2;
    const cy = h / 2;
    if (!shouldBeMarkedSpeaking) {
      if (!canvas2.dataset.cleared) {
        ctx3.clearRect(0, 0, w, h);
        canvas2.dataset.cleared = "true";
      }
      return;
    }
    delete canvas2.dataset.cleared;
    ctx3.clearRect(0, 0, w, h);
    const dataArray = analyserData.dataArray;
    if (!dataArray) return;
    const step = Math.floor((dataArray.length - 2) / 24) || 1;
    ctx3.lineWidth = 3;
    ctx3.lineCap = "round";
    for (let i = 0; i < 24; i++) {
      const val = dataArray[i * step + 2] || 0;
      const barHeight = Math.max(3, val / 255 * 20);
      const t = VISI_BAR_TABLE[i];
      ctx3.strokeStyle = t.color;
      ctx3.beginPath();
      ctx3.moveTo(cx + t.cos * 46, cy + t.sin * 46);
      ctx3.lineTo(cx + t.cos * (46 + barHeight), cy + t.sin * (46 + barHeight));
      ctx3.stroke();
    }
  }
  function getAudioConstraints(deviceId = "", exactDevice = false) {
    return {
      deviceId: deviceId ? { [exactDevice ? "exact" : "ideal"]: deviceId } : void 0,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: { ideal: 48e3 },
      channelCount: { ideal: 1 }
    };
  }
  function getVideoConstraints() {
    return {
      width: { ideal: 960 },
      height: { ideal: 540 },
      frameRate: { ideal: 25, max: 25 }
    };
  }
  function rebuildLocalStream(audioTrack = currentTrack(), videoTrack = state.videoEnabled ? currentVideoTrack() : null) {
    const tracks = [];
    if (isUsableAudioTrack(audioTrack)) tracks.push(audioTrack);
    if (videoTrack && videoTrack.readyState === "live") tracks.push(videoTrack);
    const nextStream = new MediaStream(tracks);
    state.localStream = nextStream;
    state.rawStream = nextStream;
    return nextStream;
  }
  function calculateOptimalGrid(n, boxWidth, boxHeight, aspectRatio = 16 / 9, gap = 12, minTileWidth = 0) {
    if (n === 0) return { cols: 1, rows: 1, tileWidth: boxWidth, tileHeight: boxHeight, overflow: false };
    let bestCols = 1;
    let bestRows = 1;
    let maxArea = -1;
    let bestWidth = 0;
    let bestHeight = 0;
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
  var gridLayoutRafId = null;
  function scheduleVideoGridLayout() {
    if (gridLayoutRafId) return;
    gridLayoutRafId = requestAnimationFrame(() => {
      gridLayoutRafId = null;
      updateVideoGridLayout();
    });
  }
  var cachedSpacerEl = null;
  function updateVideoGridLayout() {
    const container = ui2.videoContainer;
    if (!container || !container.isConnected) return;
    const wrappers = Array.from(container.children).filter((el) => el.classList.contains("video-wrapper") && el.style.display !== "none");
    const count = wrappers.length;
    if (count === 0) return;
    const rect = container.getBoundingClientRect();
    const gap = 12;
    const pb = 80;
    const availWidth = Math.max(100, rect.width - 24);
    const availHeight = Math.max(100, rect.height - pb - 12);
    const startX = 12;
    const startY = 12;
    const isMobile = window.innerWidth <= 640;
    const normalMinThreshold = isMobile ? Math.min(availWidth, 240) : Math.min(availWidth, 280);
    const focusedWrapper = state.focusedPeerId ? document.getElementById(`video-wrapper-${state.focusedPeerId}`) : null;
    const isFocusMode = focusedWrapper && wrappers.includes(focusedWrapper);
    let maxBottom = 0;
    if (!isFocusMode || count === 1) {
      const grid = calculateOptimalGrid(count, availWidth, availHeight, 16 / 9, gap, normalMinThreshold);
      const totalGridW = grid.cols * grid.tileWidth + (grid.cols - 1) * gap;
      const totalGridH = grid.rows * grid.tileHeight + (grid.rows - 1) * gap;
      const offsetX = startX + (availWidth - totalGridW) / 2;
      const offsetY = totalGridH > availHeight ? startY : startY + (availHeight - totalGridH) / 2;
      wrappers.forEach((el, idx) => {
        const col = idx % grid.cols;
        const row = Math.floor(idx / grid.cols);
        const itemsInRow = row === grid.rows - 1 ? count - row * grid.cols : grid.cols;
        const rowWidth = itemsInRow * grid.tileWidth + (itemsInRow - 1) * gap;
        const rowOffsetX = startX + (availWidth - rowWidth) / 2;
        const x = (row === grid.rows - 1 ? rowOffsetX : offsetX) + col * (grid.tileWidth + gap);
        const y = offsetY + row * (grid.tileHeight + gap);
        const bottom = applyOptimizedTileStyle(el, x, y, grid.tileWidth, grid.tileHeight, 1);
        if (bottom > maxBottom) maxBottom = bottom;
      });
    } else {
      const isLandscape = availWidth >= availHeight;
      const others = wrappers.filter((w) => w !== focusedWrapper);
      if (isLandscape) {
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
        const offsetY = totalGridH > stripBoxH ? startY : startY + (stripBoxH - totalGridH) / 2;
        others.forEach((el, idx) => {
          const col = idx % grid.cols;
          const row = Math.floor(idx / grid.cols);
          const itemsInRow = row === grid.rows - 1 ? others.length - row * grid.cols : grid.cols;
          const rowWidth = itemsInRow * grid.tileWidth + (itemsInRow - 1) * gap;
          const rowOffsetX = stripStartX + (stripBoxW - rowWidth) / 2;
          const x = (row === grid.rows - 1 ? rowOffsetX : offsetX) + col * (grid.tileWidth + gap);
          const y = offsetY + row * (grid.tileHeight + gap);
          const ob = applyOptimizedTileStyle(el, x, y, grid.tileWidth, grid.tileHeight, 5);
          if (ob > maxBottom) maxBottom = ob;
        });
      } else {
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
        const offsetY = totalGridH > stripBoxH ? stripStartY : stripStartY + (stripBoxH - totalGridH) / 2;
        others.forEach((el, idx) => {
          const col = idx % grid.cols;
          const row = Math.floor(idx / grid.cols);
          const itemsInRow = row === grid.rows - 1 ? others.length - row * grid.cols : grid.cols;
          const rowWidth = itemsInRow * grid.tileWidth + (itemsInRow - 1) * gap;
          const rowOffsetX = startX + (stripBoxW - rowWidth) / 2;
          const x = (row === grid.rows - 1 ? rowOffsetX : offsetX) + col * (grid.tileWidth + gap);
          const y = offsetY + row * (grid.tileHeight + gap);
          const ob = applyOptimizedTileStyle(el, x, y, grid.tileWidth, grid.tileHeight, 5);
          if (ob > maxBottom) maxBottom = ob;
        });
      }
    }
    if (!cachedSpacerEl || !cachedSpacerEl.isConnected) {
      cachedSpacerEl = document.getElementById("video-grid-spacer");
      if (!cachedSpacerEl) {
        cachedSpacerEl = document.createElement("div");
        cachedSpacerEl.id = "video-grid-spacer";
        cachedSpacerEl.style.position = "absolute";
        cachedSpacerEl.style.width = "1px";
        cachedSpacerEl.style.pointerEvents = "none";
        cachedSpacerEl.style.visibility = "hidden";
        ui2.videoContainer.appendChild(cachedSpacerEl);
      }
    }
    applyOptimizedTileStyle(cachedSpacerEl, 0, Math.max(rect.height, maxBottom + 24), 1, 1, -1);
  }
  var videoGridInitialized = false;
  function initVideoGridEngine() {
    if (videoGridInitialized || !ui2.videoContainer) return;
    videoGridInitialized = true;
    if (window.ResizeObserver) {
      new ResizeObserver(() => scheduleVideoGridLayout()).observe(ui2.videoContainer);
    } else {
      window.addEventListener("resize", scheduleVideoGridLayout, { passive: true });
    }
    new MutationObserver(() => scheduleVideoGridLayout()).observe(ui2.videoContainer, {
      childList: true
    });
    window.addEventListener("orientationchange", () => {
      setTimeout(scheduleVideoGridLayout, 50);
      setTimeout(scheduleVideoGridLayout, 350);
    }, { passive: true });
  }
  function unfocusVideo() {
    if (state.focusedPeerId) {
      const wrapper = document.getElementById(`video-wrapper-${state.focusedPeerId}`);
      if (wrapper) wrapper.classList.remove("focused");
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
      wrapper.classList.add("focused");
      state.focusedPeerId = peerId;
      scheduleVideoGridLayout();
    }
  }
  function buildVideoTile(wrapperId, videoId, username, isLocal, focusTargetId) {
    let wrapper = document.getElementById(wrapperId);
    if (wrapper) return wrapper;
    wrapper = document.createElement("div");
    wrapper.className = "video-wrapper";
    wrapper.id = wrapperId;
    const avatar = document.createElement("div");
    avatar.className = "avatar-placeholder";
    avatar.textContent = username.split(" ").map((n) => n[0]).join("").substring(0, 2).toUpperCase();
    avatar.style.position = "absolute";
    avatar.style.color = "white";
    avatar.style.fontSize = "2rem";
    const muteIcon = document.createElement("div");
    muteIcon.className = "video-mute-icon hidden";
    muteIcon.id = isLocal ? "mute-icon-local" : `mute-icon-${focusTargetId}`;
    if (!isLocal) {
      muteIcon.style.color = "var(--danger)";
      muteIcon.style.fontWeight = "bold";
      muteIcon.style.background = "rgba(0,0,0,0.6)";
      muteIcon.style.padding = "4px";
      muteIcon.style.borderRadius = "50%";
    }
    muteIcon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"></path>${isLocal ? "" : '<path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line>'}</svg>`;
    const nametag = document.createElement("div");
    nametag.className = "video-nametag";
    if (!isLocal) nametag.id = `nametag-${focusTargetId}`;
    nametag.textContent = isLocal ? state.username || "You (Local)" : username;
    const unpinBtn = document.createElement("div");
    unpinBtn.className = "unpin-btn";
    unpinBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
    unpinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      unfocusVideo();
    });
    const fsBtn = document.createElement("div");
    fsBtn.className = "fullscreen-btn";
    fsBtn.title = "Fullscreen";
    fsBtn.innerHTML = `
    <svg class="fs-expand" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path></svg>
    <svg class="fs-compress" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path></svg>
  `;
    fsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const videoEl2 = document.getElementById(videoId);
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        if (wrapper.requestFullscreen) {
          wrapper.requestFullscreen().catch((err) => console.warn("Fullscreen denied:", err));
        } else if (videoEl2 && videoEl2.webkitEnterFullscreen) {
          videoEl2.webkitEnterFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        }
      }
    });
    const visiCanvas = document.createElement("canvas");
    visiCanvas.className = "audio-visi-canvas";
    visiCanvas.width = 140;
    visiCanvas.height = 140;
    const pipBtn = document.createElement("div");
    pipBtn.className = "pip-btn";
    pipBtn.title = "Picture-in-Picture";
    pipBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 19H5V5h7V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"></path></svg>`;
    pipBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const videoEl2 = document.getElementById(videoId);
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else if (videoEl2 && videoEl2.srcObject && videoEl2.srcObject.getVideoTracks().length > 0) {
          if (videoEl2.paused) {
            await videoEl2.play().catch(() => {
            });
          }
          if (videoEl2.requestPictureInPicture) {
            await videoEl2.requestPictureInPicture();
          } else {
            showToast("PiP is not supported on this device/browser", "warning", 3e3);
          }
        } else {
          showToast("PiP requires an active video track", "info", 2500);
        }
      } catch (err) {
        console.warn("PiP failed:", err);
        showToast("PiP failed: " + (err.message || "Video track not ready"), "error", 3e3);
      }
    });
    const hudBadge = document.createElement("div");
    hudBadge.className = "latency-badge";
    hudBadge.id = isLocal ? "hud-badge-local" : `hud-badge-${focusTargetId}`;
    hudBadge.innerHTML = `<span class="optic-dot"></span><span class="hud-text">${isLocal ? "\u26A1 You (Local)" : "\u{1F4F6} Connecting..."}</span>`;
    wrapper.addEventListener("click", () => {
      focusVideo(focusTargetId);
    });
    if (isLocal) {
      const localVideoEl = document.createElement("video");
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
    ui2.videoContainer.appendChild(wrapper);
    return wrapper;
  }
  function updateLocalVideoPreview() {
    const videoTrack = state.screenSharing ? state.localVideoTrack : state.videoEnabled ? currentVideoTrack() : null;
    const wrapper = buildVideoTile("video-wrapper-local", "video-local", state.username || "You", true, "local");
    const localVideoEl = document.getElementById("video-local");
    const avatarPlaceholder = wrapper.querySelector(".avatar-placeholder");
    const visiCanvasEl = wrapper.querySelector(".audio-visi-canvas");
    if (state.screenSharing) {
      localVideoEl.style.transform = "none";
    } else {
      localVideoEl.style.transform = "scaleX(-1)";
    }
    if (!videoTrack) {
      localVideoEl.srcObject = null;
      localVideoEl.style.display = "none";
      if (avatarPlaceholder) avatarPlaceholder.style.display = "block";
      if (visiCanvasEl) visiCanvasEl.style.display = "block";
      return;
    }
    localVideoEl.style.display = "block";
    if (avatarPlaceholder) avatarPlaceholder.style.display = "none";
    if (visiCanvasEl) visiCanvasEl.style.display = "none";
    localVideoEl.srcObject = new MediaStream([videoTrack]);
    localVideoEl.play().catch((e) => console.warn("Local video auto-play prevented:", e));
  }
  function refreshRoomStatus() {
    if (!state.roomId) {
      setStatus(socket.connected ? "Ready to join" : "Connecting to signaling...", socket.connected ? "info" : "warning");
      updateMicWarningBadge();
      updateRetryButton();
      setChatStateFromPeers();
      return;
    }
    const micReady = Boolean(currentTrack());
    const connectedPeers = state.peers.size;
    const openChannels = openDataChannelCount();
    if (connectedPeers === 0) {
      setStatus(micReady ? "Waiting for participants..." : "Waiting for participants without microphone...", micReady ? "info" : "warning");
    } else if (openChannels > 0) {
      setStatus(micReady ? `Connected to ${connectedPeers} peer${connectedPeers === 1 ? "" : "s"}` : `Connected to ${connectedPeers} peer${connectedPeers === 1 ? "" : "s"} without microphone`, micReady ? "success" : "warning");
    } else {
      setStatus(micReady ? "Peer connections are negotiating..." : "Peer connections negotiating without microphone...", micReady ? "info" : "warning");
    }
    updateMicWarningBadge();
    updateRetryButton();
    setChatStateFromPeers();
    updatePeerCount();
    renderParticipants();
  }
  function ensureChatEmptyState() {
    if (ui2.chatBox.children.length === 0) {
      const empty = document.createElement("div");
      empty.className = "chat-empty";
      empty.textContent = "Join a room to start exchanging messages.";
      ui2.chatBox.appendChild(empty);
    }
  }
  function clearChat() {
    ui2.chatBox.innerHTML = "";
    ensureChatEmptyState();
    activeBlobUrls.forEach((url) => URL.revokeObjectURL(url));
    activeBlobUrls = [];
  }
  function pruneOldChatMessages() {
    while (ui2.chatBox.children.length >= MAX_CHAT_MESSAGES) {
      const oldest = ui2.chatBox.firstElementChild;
      const links = oldest.querySelectorAll("a");
      links.forEach((a) => {
        if (a.href && a.href.startsWith("blob:")) {
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
      const ctx3 = state.audioContext;
      if (ctx3.state === "suspended") {
        ctx3.resume().catch(() => {
        });
      }
      const osc = ctx3.createOscillator();
      const gain = ctx3.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(1200, ctx3.currentTime);
      gain.gain.setValueAtTime(0, ctx3.currentTime);
      gain.gain.linearRampToValueAtTime(0.2, ctx3.currentTime + 0.05);
      gain.gain.exponentialRampToValueAtTime(1e-3, ctx3.currentTime + 0.5);
      osc.connect(gain);
      gain.connect(ctx3.destination);
      osc.start(ctx3.currentTime);
      osc.stop(ctx3.currentTime + 0.5);
    } catch (e) {
      console.warn("Could not play message sound:", e);
    }
  }
  function appendMessage(text, isSelf, senderName = "") {
    const placeholder = ui2.chatBox.querySelector(".chat-empty");
    if (placeholder) placeholder.remove();
    pruneOldChatMessages();
    if (!isSelf) {
      playMessageSound();
      const sidePanel = document.getElementById("sidePanel");
      const chatPanel = document.getElementById("chatPanel");
      const isChatVisible = sidePanel && !sidePanel.classList.contains("collapsed") && chatPanel && !chatPanel.classList.contains("hidden");
      if (!isChatVisible) {
        const shortMsg = text.length > 30 ? text.substring(0, 30) + "..." : text;
        showToast(`New message from ${senderName || "Someone"}: "${shortMsg}"`, "info");
        const badge = document.getElementById("chatUnreadBadge");
        if (badge) badge.classList.remove("hidden");
      }
    }
    const el = document.createElement("div");
    el.className = `chat-msg${isSelf ? " self" : ""}`;
    if (senderName) {
      const nameEl = document.createElement("div");
      nameEl.style.fontSize = "0.75rem";
      nameEl.style.color = "var(--muted)";
      nameEl.style.marginBottom = "2px";
      nameEl.textContent = senderName;
      el.appendChild(nameEl);
    }
    const textEl = document.createElement("div");
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const parts = text.split(urlRegex);
    parts.forEach((part) => {
      if (part.match(urlRegex)) {
        const a = document.createElement("a");
        a.href = part;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = part;
        a.style.color = isSelf ? "white" : "var(--accent)";
        a.style.textDecoration = "underline";
        a.style.wordBreak = "break-all";
        textEl.appendChild(a);
      } else if (part) {
        textEl.appendChild(document.createTextNode(part));
      }
    });
    el.appendChild(textEl);
    ui2.chatBox.appendChild(el);
    ui2.chatBox.scrollTop = ui2.chatBox.scrollHeight;
  }
  function normalizeRoomName(value) {
    return String(value ?? "").trim();
  }
  function isValidRoomName(room) {
    return ROOM_PATTERN.test(room);
  }
  function waitForSocketConnect(timeoutMs = 8e3) {
    if (socket.connected) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timerId = window.setTimeout(() => {
        cleanup4();
        reject({ ok: false, code: "socket-timeout", message: "Timed out waiting for the signaling server." });
      }, timeoutMs);
      const onConnect = () => {
        cleanup4();
        resolve();
      };
      const onError = () => {
        cleanup4();
        reject({ ok: false, code: "socket-error", message: "Could not reach the signaling server." });
      };
      function cleanup4() {
        window.clearTimeout(timerId);
        socket.off("connect", onConnect);
        socket.off("connect_error", onError);
      }
      socket.on("connect", onConnect);
      socket.on("connect_error", onError);
    });
  }
  function requestRoomJoin(payload) {
    return new Promise((resolve, reject) => {
      const timerId = window.setTimeout(() => {
        reject({ ok: false, code: "join-timeout", message: "Timed out while joining the room." });
      }, 8e3);
      socket.emit("join-room", payload, (response) => {
        window.clearTimeout(timerId);
        if (!response || typeof response !== "object") {
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
      try {
        state.rawCameraTrack.stop();
      } catch (e) {
      }
      state.rawCameraTrack = null;
    }
    try {
      processTrack(null);
    } catch (e) {
    }
    if (state.localStream) {
      state.localStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {
        }
      });
    }
    if (state.rawStream) {
      state.rawStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {
        }
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
      (Array.isArray(peerIds) ? peerIds : []).filter((peerId) => Boolean(peerId) && peerId !== socket.id)
    );
    if (state.existingPeers.size === 0) {
      desiredPeers.forEach((id) => state.existingPeers.add(id));
    }
    [...state.peers.keys()].forEach((peerId) => {
      if (!desiredPeers.has(peerId)) {
        cleanupPeer(peerId, "not in room roster");
      }
    });
    desiredPeers.forEach((peerId) => {
      ensurePeer(peerId, usernames[peerId] || "Anonymous");
    });
    refreshRoomStatus();
  }
  function attachDataChannel(peerId, channel) {
    const peer = getPeerState(peerId);
    if (!peer) return;
    channel.bufferedAmountLowThreshold = 65536;
    peer.dataChannel = channel;
    channel.onopen = () => {
      setChatStateFromPeers();
      refreshRoomStatus();
      const track = currentTrack();
      const isAudioEnabled = track ? track.enabled : false;
      try {
        channel.send(JSON.stringify({ type: "audio-state", enabled: isAudioEnabled }));
        channel.send(JSON.stringify({ type: "video-state", enabled: state.videoEnabled }));
        if (!state.existingPeers.has(peerId)) {
          const hostCandidates = [socket.id, ...state.existingPeers];
          hostCandidates.sort();
          const isHost = socket.id === hostCandidates[0];
          if (isHost) {
            const textarea2 = document.getElementById("wbTextarea");
            if (textarea2 && textarea2.value.trim()) {
              channel.send(JSON.stringify({ type: "wb-text", content: textarea2.value }));
            }
            if (typeof getCanvasDataURL === "function") {
              const dataURL = getCanvasDataURL();
              if (dataURL) {
                channel.send(JSON.stringify({ type: "wb-canvas-image", dataURL }));
              }
            }
            if (typeof getActiveEditorMode === "function") {
              const currentMode = getActiveEditorMode();
              if (currentMode === "code") {
                channel.send(JSON.stringify({ type: "wb-editor-mode", mode: "code" }));
                const currentLang = getActiveLanguage();
                channel.send(JSON.stringify({ type: "wb-editor-lang", lang: currentLang }));
                const currentStdin = getActiveStdin();
                if (currentStdin.trim()) {
                  channel.send(JSON.stringify({ type: "wb-editor-stdin", content: currentStdin }));
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn("Failed to send initial state:", e);
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
          fileState.chunks = [];
          removeFileProgress(fileId);
          state.incomingFiles.delete(fileId);
        }
      }
    };
    channel.onerror = () => {
      showToast("Data channel error.", "warning");
    };
    channel.binaryType = "arraybuffer";
    channel.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "audio-state") {
            handleMediaStateChange({ senderId: peerId, type: "audio", enabled: msg.enabled });
          } else if (msg.type === "video-state") {
            handleMediaStateChange({ senderId: peerId, type: "video", enabled: msg.enabled });
          } else if (msg.type === "wb-draw") {
            handleIncomingDraw(msg);
          } else if (msg.type === "wb-clear") {
            clearCanvas();
          } else if (msg.type === "wb-canvas-image") {
            if (typeof loadCanvasImage === "function") {
              loadCanvasImage(msg.dataURL);
            }
          } else if (msg.type === "wb-text") {
            const username = peer.username || "Peer";
            handleIncomingText(msg.content, msg.caretIndex, username, peerId);
          } else if (msg.type === "wb-cursor") {
            const username = peer.username || "Peer";
            handleIncomingCursor(peerId, msg, username);
          } else if (msg.type === "wb-text-cursor") {
            const username = peer.username || "Peer";
            handleIncomingTextCursor(peerId, msg, username);
          } else if (msg.type === "wb-editor-mode") {
            handleIncomingEditorMode(msg.mode);
          } else if (msg.type === "wb-editor-lang") {
            handleIncomingEditorLang(msg.lang);
          } else if (msg.type === "wb-editor-stdin") {
            handleIncomingStdin(msg.content);
          } else if (msg.type === "wb-compile-start") {
            handleIncomingCompileStart();
          } else if (msg.type === "wb-compile-result") {
            handleIncomingCompileResult(msg);
          } else if (msg.type === "caption") {
            displayCaption(msg.username || "Peer", msg.text);
          } else if (msg.type === "reaction") {
            triggerFloatingReaction(peerId, msg.emoji);
          } else if (msg.type === "file-meta") {
            const fileName = String(msg.name || "received-file").slice(0, 120);
            const fileSize = Number(msg.size);
            const fileType = String(msg.fileType || "application/octet-stream").slice(0, 120);
            const fileId = msg.fileId || "file-" + Math.random().toString(36).substr(2, 9);
            if (!Number.isFinite(fileSize) || fileSize < 0 || fileSize > MAX_FILE_SIZE) {
              showToast("Incoming file was rejected because its metadata is invalid.", "warning");
              return;
            }
            state.incomingFiles.set(fileId, {
              fileId,
              peerId,
              metadata: { name: fileName, size: fileSize, fileType },
              chunks: [],
              receivedSize: 0
            });
            appendFileProgress(fileId, fileName, fileSize, false, peer.username || "Anonymous");
            showToast(`Receiving file: ${fileName}...`, "info");
          }
        } catch (e) {
          console.warn("Failed to parse data channel message:", e);
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
          showToast("Incoming file was cancelled because it exceeded its declared size.", "warning");
          return;
        }
        if (fileState.receivedSize >= fileState.metadata.size) {
          const blob = new Blob(fileState.chunks, { type: fileState.metadata.fileType });
          const url = URL.createObjectURL(blob);
          activeBlobUrls.push(url);
          removeFileProgress(fileState.fileId);
          appendFileMessage(fileState.metadata.name, url, fileState.metadata.size, false, peer.username || "Anonymous");
          state.incomingFiles.delete(fileId);
          showToast(`File received: ${fileState.metadata.name}`, "success");
        }
      }
    };
  }
  function queueSignalingTask(peerId, task) {
    const peer = state.peers.get(peerId);
    if (!peer) return;
    peer.signalingQueue = peer.signalingQueue.then(task).catch((error) => {
      console.error(`Signaling task failed for peer ${peerId}:`, error);
    });
  }
  function ensurePeerVideoWrapper(peerId, username = "Peer") {
    buildVideoTile(`video-wrapper-${peerId}`, `video-${peerId}`, username, false, peerId);
  }
  function ensurePeer(peerId, providedUsername = null) {
    const existingPeer = state.peers.get(peerId);
    const finalUsername = providedUsername || (existingPeer ? existingPeer.username : "Anonymous");
    if (existingPeer) {
      existingPeer.username = finalUsername;
      const pcState = existingPeer.pc?.connectionState || existingPeer.pc?.signalingState || "new";
      if (pcState !== "closed" && pcState !== "failed") {
        ensurePeerVideoWrapper(peerId, finalUsername);
        return existingPeer;
      }
      cleanupPeer(peerId, "recreating closed peer");
    }
    ensurePeerVideoWrapper(peerId, finalUsername);
    if (!window.RTCPeerConnection) {
      showToast("WebRTC is unavailable in this browser.", "error");
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
      iceQueue: []
    };
    state.peers.set(peerId, peer);
    renderParticipants();
    const pc = peer.pc;
    pc.onicecandidate = (event) => {
      if (!event.candidate || !state.roomId) return;
      socket.emit("ice-candidate", {
        target: peerId,
        candidate: typeof event.candidate.toJSON === "function" ? event.candidate.toJSON() : event.candidate
      });
    };
    pc.ontrack = (event) => {
      const isVideo = event.track.kind === "video";
      if (isVideo) {
        let videoEl2 = document.getElementById(`video-${peerId}`);
        if (!videoEl2) {
          const wrapper = document.getElementById(`video-wrapper-${peerId}`);
          videoEl2 = document.createElement("video");
          videoEl2.id = `video-${peerId}`;
          videoEl2.autoplay = true;
          videoEl2.playsInline = true;
          videoEl2.muted = true;
          videoEl2.style.transition = "opacity 0.2s ease";
          wrapper.insertBefore(videoEl2, wrapper.firstChild);
          const avatar = wrapper.querySelector(".avatar-placeholder");
          const visiCanvas = wrapper.querySelector(".audio-visi-canvas");
          if (avatar) avatar.style.display = "none";
          if (visiCanvas) visiCanvas.style.display = "none";
        }
        videoEl2.srcObject = new MediaStream([event.track]);
        videoEl2.play().catch((e) => console.warn("Video auto-play prevented:", e));
        event.track.onmute = () => {
          videoEl2.style.opacity = "0";
          const wrapper = document.getElementById(`video-wrapper-${peerId}`);
          if (wrapper) {
            const vCanvas = wrapper.querySelector(".audio-visi-canvas");
            if (vCanvas) vCanvas.style.display = "block";
          }
        };
        event.track.onunmute = () => {
          videoEl2.style.opacity = "1";
          const wrapper = document.getElementById(`video-wrapper-${peerId}`);
          if (wrapper) {
            const vCanvas = wrapper.querySelector(".audio-visi-canvas");
            if (vCanvas) vCanvas.style.display = "none";
          }
        };
      } else {
        let audioEl = document.getElementById(`audio-${peerId}`);
        if (!audioEl) {
          audioEl = document.createElement("audio");
          audioEl.id = `audio-${peerId}`;
          audioEl.autoplay = true;
          audioEl.playsInline = true;
          audioEl.style.display = "none";
          const wrapper = document.getElementById(`video-wrapper-${peerId}`);
          if (wrapper) wrapper.appendChild(audioEl);
          else ui2.videoContainer.appendChild(audioEl);
        }
        const safeAudioStream = new MediaStream([event.track]);
        audioEl.srcObject = safeAudioStream;
        audioEl.play().catch((e) => console.warn("Audio auto-play prevented:", e));
        setupAudioAnalyser(safeAudioStream, peerId);
        addPeerToRecordingAudio(peerId, safeAudioStream);
      }
    };
    pc.ondatachannel = (event) => {
      attachDataChannel(peerId, event.channel);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        cleanupPeer(peerId, "connection failed");
        return;
      }
      if (pc.connectionState === "disconnected") {
        window.setTimeout(() => {
          const current = state.peers.get(peerId);
          if (current && current.pc === pc && pc.connectionState === "disconnected") {
            cleanupPeer(peerId, "disconnected timeout");
          }
        }, 15e3);
      }
      refreshRoomStatus();
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") {
        console.warn(`ICE failed for peer ${peerId}. Initiating automatic ICE restart...`);
        try {
          if (typeof pc.restartIce === "function") {
            pc.restartIce();
          } else {
            pc.createOffer({ iceRestart: true }).then((offer) => {
              pc.setLocalDescription(offer);
              socket.emit("webrtc-offer", { target: peerId, sdp: offer });
            });
          }
        } catch (err) {
          console.error("ICE restart attempt failed:", err);
          cleanupPeer(peerId, "ICE network blocked");
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
          socket.emit("webrtc-offer", {
            target: peerId,
            sdp: pc.localDescription
          });
        } catch (error) {
          console.error("Negotiation failed:", error);
          showToast("Negotiation failed for a peer connection.", "error");
        } finally {
          currentPeer.makingOffer = false;
        }
      });
    };
    if (initiator) {
      const channel = pc.createDataChannel("chat");
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
    if (pc.signalingState === "closed") return;
    const transceivers = pc.getTransceivers();
    const audioTransceiver = transceivers.find((t) => t.receiver?.track?.kind === "audio" || t.sender?.track?.kind === "audio");
    const videoTransceiver = transceivers.find((t) => t.receiver?.track?.kind === "video" || t.sender?.track?.kind === "video");
    const audioTrack = currentTrack();
    if (audioTrack) {
      if (audioTransceiver) {
        audioTransceiver.sender.replaceTrack(audioTrack).catch(() => {
        });
        if (audioTransceiver.direction !== "sendrecv" && audioTransceiver.direction !== "sendonly") {
          audioTransceiver.direction = "sendrecv";
        }
      } else {
        try {
          pc.addTrack(audioTrack, state.localStream || new MediaStream());
        } catch (e) {
          console.warn("Failed to add audio track, trying replaceTrack fallback:", e);
          const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
          if (sender) sender.replaceTrack(audioTrack).catch(() => {
          });
        }
      }
    } else if (audioTransceiver) {
      audioTransceiver.sender.replaceTrack(null).catch(() => {
      });
      if (audioTransceiver.direction !== "recvonly" && audioTransceiver.direction !== "inactive") {
        audioTransceiver.direction = "recvonly";
      }
    }
    const videoTrack = state.screenSharing ? state.localVideoTrack : state.videoEnabled ? currentVideoTrack() : null;
    if (videoTrack) {
      if (videoTransceiver) {
        videoTransceiver.sender.replaceTrack(videoTrack).catch(() => {
        });
        if (videoTransceiver.direction !== "sendrecv" && videoTransceiver.direction !== "sendonly") {
          videoTransceiver.direction = "sendrecv";
        }
      } else {
        try {
          pc.addTrack(videoTrack, state.localStream || new MediaStream());
        } catch (e) {
          console.warn("Failed to add video track, trying replaceTrack fallback:", e);
          const sender = pc.getSenders().find((s) => s.track?.kind === "video");
          if (sender) sender.replaceTrack(videoTrack).catch(() => {
          });
        }
      }
      const currentTransceiver = videoTransceiver || pc.getTransceivers().find((t) => t.sender.track === videoTrack);
      if (currentTransceiver && currentTransceiver.sender) {
        try {
          const params = currentTransceiver.sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
          }
          if (state.screenSharing) {
            delete params.encodings[0].maxBitrate;
          } else {
            params.encodings[0].maxBitrate = 3e5;
          }
          currentTransceiver.sender.setParameters(params).catch((e) => console.warn("Failed to set video parameters:", e));
        } catch (e) {
          console.warn("Failed to get video parameters:", e);
        }
      }
    } else if (videoTransceiver) {
      videoTransceiver.sender.replaceTrack(null).catch(() => {
      });
      if (videoTransceiver.direction !== "recvonly" && videoTransceiver.direction !== "inactive") {
        videoTransceiver.direction = "recvonly";
      }
    }
  }
  function applyLocalTracksToAllPeers() {
    peerEntries().forEach(([peerId]) => applyLocalTracksToPeer(peerId));
  }
  function cleanupPeer(peerId, reason = "", skipRefresh = false) {
    const peer = getPeerState(peerId);
    if (!peer) return;
    state.peers.delete(peerId);
    cleanupPeerStats(peerId);
    cleanupPeerCursor(peerId);
    if (peer.typingTimeout) {
      clearTimeout(peer.typingTimeout);
      const userName = peer.typingUsername || peer.username || "Someone";
      if (typingUsers.has(userName)) {
        typingUsers.delete(userName);
        updateTypingIndicator();
      }
    }
    for (const [fileId, fileState] of state.incomingFiles.entries()) {
      if (fileState.peerId === peerId) {
        fileState.chunks = [];
        removeFileProgress(fileId);
        state.incomingFiles.delete(fileId);
      }
    }
    if (peer.dataChannel && peer.dataChannel.readyState !== "closed") {
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
        peer.pc.getReceivers().forEach((receiver) => {
          if (receiver.track) {
            try {
              receiver.track.stop();
            } catch (e) {
            }
          }
        });
        peer.pc.getSenders().forEach((sender) => {
          if (sender.track && peer.pc.signalingState !== "closed") {
            try {
              peer.pc.removeTrack(sender);
            } catch (e) {
            }
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
      const videoEl2 = document.getElementById(`video-${peerId}`);
      if (videoEl2) {
        videoEl2.srcObject = null;
        videoEl2.remove();
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
    [...state.peers.keys()].forEach((peerId) => cleanupPeer(peerId, "", true));
    refreshRoomStatus();
  }
  function leaveRoom(options = {}) {
    const { keepRoomInput = true, silent = false } = options;
    if (state.leaving) return;
    state.leaving = true;
    if (state.roomId && !silent) {
      socket.emit("leave-room");
    }
    if (state.screenSharing) {
      stopScreenShare();
    }
    if (state.recording) {
      stopRecording();
    }
    try {
      processTrack(null);
    } catch (e) {
      console.debug("Failed to reset visual filter during leaveRoom:", e);
    }
    const filterDropdown = document.getElementById("filterDropdown");
    if (filterDropdown) {
      filterDropdown.style.display = "none";
      filterDropdown.classList.add("hidden");
    }
    const whiteboardContainer = document.getElementById("whiteboardContainer");
    if (whiteboardContainer) {
      whiteboardContainer.style.display = "none";
      whiteboardContainer.classList.add("hidden");
    }
    if (ui2.whiteboardBtn) ui2.whiteboardBtn.classList.remove("active");
    try {
      clearCanvas();
      if (typeof cleanup === "function") {
        cleanup();
      }
    } catch (e) {
      console.debug("Failed to clear canvas or cleanup whiteboard:", e);
    }
    const textarea2 = document.getElementById("wbTextarea");
    if (textarea2) textarea2.value = "";
    const ccOverlay = document.getElementById("ccOverlay");
    if (ccOverlay) {
      ccOverlay.style.display = "none";
      ccOverlay.classList.add("hidden");
    }
    if (ui2.ccBtn) {
      ui2.ccBtn.classList.remove("active");
      ui2.ccBtn.style.color = "";
    }
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      try {
        if (ui2.ccBtn && ui2.ccBtn.classList.contains("active")) {
          ui2.ccBtn.click();
        }
      } catch (e) {
        console.debug("Failed to toggle captions off on leaveRoom:", e);
      }
    }
    if (typeof cleanup3 === "function") {
      cleanup3();
    } else if (ui2.statsBtn && ui2.statsBtn.classList.contains("active")) {
      ui2.statsBtn.click();
    }
    if (typeof cleanup2 === "function") {
      cleanup2();
    }
    unfocusVideo();
    clearAllPeers();
    stopLocalStream();
    const localWrapper = document.getElementById("video-wrapper-local");
    if (localWrapper) localWrapper.remove();
    state.roomId = "";
    state.roomPassword = "";
    state.selectedDeviceId = "";
    state.videoEnabled = false;
    state.existingPeers.clear();
    if (speakerPollIntervalId) {
      clearInterval(speakerPollIntervalId);
      speakerPollIntervalId = null;
    }
    state.audioAnalysers.forEach((data) => {
      try {
        data.source.disconnect();
      } catch (e) {
      }
    });
    state.audioAnalysers.clear();
    if (state.audioContext) {
      if (state.audioContext.state !== "closed") {
        state.audioContext.close().catch(() => {
        });
      }
      state.audioContext = null;
    }
    ui2.videoBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
    ui2.videoBtn.classList.remove("active");
    setMode("join");
    setRoomChip("Not joined");
    setChatEnabled(false);
    clearChat();
    renderParticipants();
    ui2.muteBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
    ui2.muteBtn.classList.remove("active", "danger");
    ui2.muteBtn.disabled = true;
    ui2.videoBtn.disabled = true;
    ui2.screenShareBtn.disabled = true;
    ui2.recordBtn.disabled = true;
    ui2.attachFileBtn.disabled = true;
    updateMicWarningBadge();
    updateRetryButton();
    setStatus("Room closed", "info");
    if (!keepRoomInput) {
      ui2.roomInput.value = "";
    }
    setTimeout(() => {
      state.leaving = false;
    }, 150);
  }
  var isAcquiringMedia = false;
  async function acquireMicrophone(deviceId = "", options = {}, isRetry = false) {
    if (!isRetry) {
      if (isAcquiringMedia) return false;
      isAcquiringMedia = true;
    }
    const { silent = false, required = false, exactDevice = false, allowFallback = true } = options;
    if (!navigator.mediaDevices?.getUserMedia) {
      if (!silent) {
        showToast("This browser does not support media access.", required ? "error" : "warning");
      }
      return false;
    }
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: getAudioConstraints(deviceId, exactDevice),
        video: false
      });
      const audioTrack = micStream.getAudioTracks()[0] || null;
      if (!isUsableAudioTrack(audioTrack)) {
        stopStream(micStream);
        throw new Error("No live microphone track was returned.");
      }
      if (state.audioContext?.state === "suspended") {
        await state.audioContext.resume().catch(() => {
        });
      }
      const previousAudioTrack = currentTrack();
      state.selectedDeviceId = audioTrack.getSettings()?.deviceId || deviceId || "";
      bindLocalAudioTrackEvents(audioTrack);
      setupAudioAnalyser(new MediaStream([audioTrack]), "local");
      rebuildLocalStream(audioTrack, state.videoEnabled ? currentVideoTrack() : null);
      if (previousAudioTrack && previousAudioTrack !== audioTrack) {
        previousAudioTrack.stop();
      }
      await populateDevices(state.selectedDeviceId);
      applyLocalTracksToAllPeers();
      refreshMicUi();
      return true;
    } catch (error) {
      const isPermissionError = error.name === "NotAllowedError" || error.name === "PermissionDeniedError";
      if (deviceId && allowFallback && !exactDevice && !isPermissionError) {
        if (!silent) {
          showToast("Selected microphone is unavailable. Trying the default device.", "warning");
        }
        return await acquireMicrophone("", { silent, required, exactDevice: false, allowFallback: false }, true);
      }
      console.warn("Microphone access failed:", error);
      if (!silent) {
        showToast(
          required ? "Microphone access failed. Check browser permissions and hardware." : "Microphone access failed. You can allow it later from browser settings.",
          required ? "error" : "warning"
        );
      }
      await populateDevices(state.selectedDeviceId);
      refreshMicUi();
      return false;
    } finally {
      if (!isRetry) isAcquiringMedia = false;
    }
  }
  async function acquireLocalMedia(deviceId = "", options = {}) {
    const { silent = false, required = false, exactDevice = false, allowFallback = true } = options;
    return acquireMicrophone(deviceId, { silent, required, exactDevice, allowFallback });
  }
  async function populateDevices(selectedDeviceId = state.selectedDeviceId) {
    if (!navigator.mediaDevices?.enumerateDevices) {
      ui2.deviceSelect.innerHTML = '<option value="">Microphone discovery unavailable</option>';
      ui2.deviceSelect.disabled = true;
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioDevices = devices.filter((d) => d.kind === "audioinput");
      const videoDevices = devices.filter((d) => d.kind === "videoinput");
      ui2.deviceSelect.innerHTML = "";
      if (!audioDevices.length) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No microphones found";
        ui2.deviceSelect.appendChild(option);
        ui2.deviceSelect.disabled = true;
      } else {
        ui2.deviceSelect.disabled = false;
        const defaultOpt = document.createElement("option");
        defaultOpt.value = "";
        defaultOpt.textContent = "Default Microphone";
        ui2.deviceSelect.appendChild(defaultOpt);
        audioDevices.forEach((device) => {
          if (device.deviceId === "default" || device.deviceId === "communications") return;
          const opt = document.createElement("option");
          opt.value = device.deviceId;
          opt.textContent = device.label || `Microphone ${ui2.deviceSelect.options.length}`;
          ui2.deviceSelect.appendChild(opt);
        });
        const keepValue = ui2.deviceSelect.querySelector(`option[value="${selectedDeviceId}"]`) ? selectedDeviceId : "";
        ui2.deviceSelect.value = keepValue;
        if (ui2.midCallDeviceSelect) {
          ui2.midCallDeviceSelect.innerHTML = ui2.deviceSelect.innerHTML;
          ui2.midCallDeviceSelect.value = keepValue;
        }
      }
      if (ui2.midCallCameraSelect) {
        ui2.midCallCameraSelect.innerHTML = "";
        const defCamOpt = document.createElement("option");
        defCamOpt.value = "";
        defCamOpt.textContent = "Default Camera";
        ui2.midCallCameraSelect.appendChild(defCamOpt);
        videoDevices.forEach((device) => {
          const opt = document.createElement("option");
          opt.value = device.deviceId;
          opt.textContent = device.label || `Camera ${ui2.midCallCameraSelect.options.length}`;
          ui2.midCallCameraSelect.appendChild(opt);
        });
        if (state.selectedCameraId) ui2.midCallCameraSelect.value = state.selectedCameraId;
      }
    } catch (error) {
      console.warn("Failed to enumerate devices:", error);
    }
  }
  async function joinRoom() {
    if (state.joining) return;
    const roomId = normalizeRoomName(ui2.roomInput.value);
    let username = ui2.usernameInput.value.trim();
    if (!username || username.toLowerCase() === "anonymous") {
      const randomTag = Math.floor(1e3 + Math.random() * 9e3);
      username = `Anonymous#${randomTag}`;
      ui2.usernameInput.value = username;
    }
    let password = ui2.passwordInput.value || "";
    if (!password) {
      const array = new Uint8Array(16);
      window.crypto.getRandomValues(array);
      password = Array.from(array).map((b) => b.toString(16).padStart(2, "0")).join("");
      ui2.passwordInput.value = password;
    }
    if (!roomId) {
      showToast("Enter a room ID.", "error");
      return;
    }
    if (!isValidRoomName(roomId)) {
      showToast("Room IDs may only contain letters, numbers, dashes, and underscores.", "error");
      return;
    }
    if (!supportsRequiredApis()) {
      showToast("This browser is missing microphone or WebRTC support.", "error");
      return;
    }
    state.joining = true;
    state.username = username;
    ui2.joinBtn.disabled = true;
    ui2.joinBtn.textContent = "Joining...";
    setStatus("Joining room...", "info");
    try {
      await waitForSocketConnect();
      await acquireLocalMedia(ui2.deviceSelect.value, {
        silent: true,
        exactDevice: Boolean(ui2.deviceSelect.value),
        allowFallback: !ui2.deviceSelect.value
      });
      const hashedPassword = await hashPassword(password);
      const result = await requestRoomJoin({ roomId, username, password: hashedPassword });
      state.e2eeKey = await deriveChatKey(password, roomId);
      state.roomPassword = password;
      state.roomId = result.room;
      setRoomChip(state.roomId);
      setMode("call");
      clearAllPeers();
      syncPeerRoster(result.roomPeers || result.peers || [], result.usernames || {});
      applyLocalTracksToAllPeers();
      updateLocalVideoPreview();
      if (!currentTrack()) {
        showToast("Joined without microphone access. You can retry later.", "warning");
      }
      ui2.roomInput.value = state.roomId;
      window.history.pushState({}, "", `?room=${encodeURIComponent(state.roomId)}`);
      refreshRoomStatus();
    } catch (error) {
      console.error("Join failed:", error);
      const code = error?.code || "";
      if (code === "room-full") {
        showToast(error.message || "Room is full.", "error");
      } else if (code === "invalid-room") {
        showToast(error.message || "Invalid room ID.", "error");
      } else if (code === "invalid-password") {
        showToast(error.message || "Incorrect room password.", "error");
      } else if (code === "rate-limited") {
        showToast(error.message || "Too many attempts. Wait a moment and try again.", "warning");
      } else if (code === "socket-timeout" || code === "socket-error" || code === "join-timeout") {
        showToast(error.message || "Unable to join the room.", "error");
      } else {
        showToast("Unable to join the room. Check your connection and try again.", "error");
      }
      clearAllPeers();
      stopLocalStream();
      setMode("join");
      setChatEnabled(false);
      updateMicWarningBadge();
      updateRetryButton();
      renderParticipants();
    } finally {
      state.joining = false;
      ui2.joinBtn.disabled = false;
      ui2.joinBtn.textContent = "Initialize Connection";
      updateMuteButton();
      setCallControlsEnabled(Boolean(state.roomId));
      refreshRoomStatus();
    }
  }
  async function restoreRoomAfterReconnect() {
    if (!state.roomId || state.leaving || state.joining) return;
    state.reconnecting = true;
    setStatus("Restoring room after reconnect...", "warning");
    try {
      clearAllPeers();
      await waitForSocketConnect();
      const currentPassword = state.roomPassword || ui2.passwordInput.value || "";
      const hashedPassword = await hashPassword(currentPassword);
      const result = await requestRoomJoin({ roomId: state.roomId, username: state.username, password: hashedPassword });
      state.e2eeKey = await deriveChatKey(currentPassword, state.roomId);
      syncPeerRoster(result.roomPeers || result.peers || [], result.usernames || {});
      applyLocalTracksToAllPeers();
      refreshRoomStatus();
      showToast("Room restored after reconnect.", "success");
    } catch (error) {
      console.error("Room restore failed:", error);
      showToast("Reconnected to signaling, but the room could not be restored.", "error");
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
      const offerCollision = description.type === "offer" && (currentPeer.makingOffer || pc.signalingState !== "stable");
      currentPeer.ignoreOffer = !currentPeer.polite && offerCollision;
      if (currentPeer.ignoreOffer) return;
      try {
        if (offerCollision) {
          await pc.setLocalDescription({ type: "rollback" });
        }
        await pc.setRemoteDescription(description);
        while (currentPeer.iceQueue.length > 0) {
          const candidate = currentPeer.iceQueue.shift();
          await pc.addIceCandidate(candidate).catch((e) => console.warn(e));
        }
        if (description.type === "offer") {
          await pc.setLocalDescription();
          socket.emit("webrtc-answer", {
            target: data.sender,
            sdp: pc.localDescription
          });
        }
        refreshRoomStatus();
      } catch (error) {
        console.error("Failed to handle offer:", error);
        showToast("Failed to process a signaling offer.", "error");
        cleanupPeer(data.sender, "offer handling failed");
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
          await peer.pc.addIceCandidate(candidate).catch((e) => console.warn(e));
        }
        refreshRoomStatus();
      } catch (error) {
        console.error("Failed to handle answer:", error);
        showToast("Failed to process a signaling answer.", "error");
        cleanupPeer(data.sender, "answer handling failed");
      }
    });
  }
  function handleRemoteIce(data) {
    if (!data?.sender || !data?.candidate || typeof data.candidate !== "object") return;
    const peer = ensurePeer(data.sender);
    if (!peer) return;
    queueSignalingTask(data.sender, async () => {
      const currentPeer = state.peers.get(data.sender);
      if (!currentPeer) return;
      try {
        if (!data.candidate.candidate) return;
        const candidate = new RTCIceCandidate(data.candidate);
        if (!currentPeer.pc.remoteDescription) {
          currentPeer.iceQueue.push(candidate);
        } else {
          await currentPeer.pc.addIceCandidate(candidate).catch((e) => console.warn("Ignored invalid candidate:", e));
        }
      } catch (error) {
        if (!currentPeer.ignoreOffer) {
          console.warn("ICE parsing failed:", error);
        }
      }
    });
  }
  function broadcastVideoState(enabled) {
    socket.emit("media-state-change", {
      type: "video",
      enabled
    });
  }
  async function sendChatMessage() {
    const MAX_CHAT_LENGTH = 4e3;
    const message = ui2.chatInput.value.trim();
    if (!message) return;
    if (message.length > MAX_CHAT_LENGTH) {
      showToast("Message is too long. Maximum " + MAX_CHAT_LENGTH + " characters.", "warning");
      return;
    }
    const payload = {
      type: "chat",
      text: message,
      username: state.username || "You"
    };
    if (state.e2eeKey) {
      const encrypted = await encryptMessage(state.e2eeKey, JSON.stringify(payload));
      socket.emit("room-chat-message", {
        encrypted: true,
        payload: encrypted.payload,
        iv: encrypted.iv
      });
    } else {
      socket.emit("room-chat-message", payload);
    }
    appendMessage(message, true, state.username || "You");
    ui2.chatInput.value = "";
  }
  function appendFileProgress(fileId, name, size, isSelf, senderName = "") {
    const placeholder = ui2.chatBox.querySelector(".chat-empty");
    if (placeholder) placeholder.remove();
    pruneOldChatMessages();
    const el = document.createElement("div");
    el.id = `progress-${fileId}`;
    el.className = `chat-msg${isSelf ? " self" : ""}`;
    if (senderName) {
      const nameEl = document.createElement("div");
      nameEl.style.fontSize = "0.75rem";
      nameEl.style.color = "var(--muted)";
      nameEl.style.marginBottom = "2px";
      nameEl.textContent = senderName;
      el.appendChild(nameEl);
    }
    const fileInfo = document.createElement("div");
    fileInfo.textContent = `\u23F3 ${name} (${(size / 1024).toFixed(1)} KB)`;
    fileInfo.style.fontSize = "0.9rem";
    fileInfo.style.marginBottom = "4px";
    fileInfo.style.color = isSelf ? "white" : "inherit";
    el.appendChild(fileInfo);
    const progressContainer = document.createElement("div");
    progressContainer.style.width = "100%";
    progressContainer.style.height = "6px";
    progressContainer.style.backgroundColor = isSelf ? "rgba(255,255,255,0.3)" : "var(--border)";
    progressContainer.style.borderRadius = "3px";
    progressContainer.style.overflow = "hidden";
    const progressBar = document.createElement("div");
    progressBar.className = "progress-bar-fill";
    progressBar.style.width = "0%";
    progressBar.style.height = "100%";
    progressBar.style.backgroundColor = isSelf ? "white" : "var(--accent)";
    progressBar.style.transition = "width 0.1s linear";
    progressContainer.appendChild(progressBar);
    el.appendChild(progressContainer);
    ui2.chatBox.appendChild(el);
    ui2.chatBox.scrollTop = ui2.chatBox.scrollHeight;
  }
  function updateFileProgress(fileId, transferredSize, totalSize) {
    const el = document.getElementById(`progress-${fileId}`);
    if (!el) return;
    const progressBar = el.querySelector(".progress-bar-fill");
    if (progressBar) {
      const percent = Math.min(100, Math.round(transferredSize / totalSize * 100));
      progressBar.style.width = `${percent}%`;
    }
  }
  function removeFileProgress(fileId) {
    const el = document.getElementById(`progress-${fileId}`);
    if (el) el.remove();
  }
  function appendFileMessage(name, url, size, isSelf, senderName = "") {
    const placeholder = ui2.chatBox.querySelector(".chat-empty");
    if (placeholder) placeholder.remove();
    pruneOldChatMessages();
    if (!isSelf) {
      playMessageSound();
      const sidePanel = document.getElementById("sidePanel");
      const chatPanel = document.getElementById("chatPanel");
      const isChatVisible = sidePanel && !sidePanel.classList.contains("collapsed") && chatPanel && !chatPanel.classList.contains("hidden");
      if (!isChatVisible) {
        showToast(`File received from ${senderName || "Someone"}: ${name}`, "success");
        const badge = document.getElementById("chatUnreadBadge");
        if (badge) badge.classList.remove("hidden");
      }
    }
    const el = document.createElement("div");
    el.className = `chat-msg${isSelf ? " self" : ""}`;
    if (senderName) {
      const nameEl = document.createElement("div");
      nameEl.style.fontSize = "0.75rem";
      nameEl.style.color = "var(--muted)";
      nameEl.style.marginBottom = "2px";
      nameEl.textContent = senderName;
      el.appendChild(nameEl);
    }
    const fileLink = document.createElement("a");
    fileLink.href = url;
    fileLink.download = name;
    fileLink.rel = "noopener noreferrer";
    fileLink.textContent = `\u{1F4CE} ${name} (${(size / 1024).toFixed(1)} KB)`;
    fileLink.style.color = isSelf ? "white" : "var(--accent)";
    fileLink.style.textDecoration = "underline";
    fileLink.style.textDecoration = "none";
    el.appendChild(fileLink);
    ui2.chatBox.appendChild(el);
    ui2.chatBox.scrollTop = ui2.chatBox.scrollHeight;
  }
  var isTogglingVideo = false;
  function turnOffVideo() {
    if (!state.videoEnabled) return;
    const previousVideoTrack = currentVideoTrack();
    state.videoEnabled = false;
    if (state.rawCameraTrack) {
      try {
        state.rawCameraTrack.stop();
      } catch (e) {
      }
      state.rawCameraTrack = null;
    }
    try {
      processTrack(null);
    } catch (e) {
      console.debug("Failed to reset visual filter on turnOffVideo:", e);
    }
    if (previousVideoTrack && previousVideoTrack !== state.rawCameraTrack) {
      try {
        previousVideoTrack.stop();
      } catch (e) {
      }
    }
    rebuildLocalStream(currentTrack(), null);
    updateLocalVideoPreview();
    ui2.videoBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
    ui2.videoBtn.classList.remove("active");
    showToast("Camera turned off.", "info");
    broadcastVideoState(false);
  }
  async function toggleVideo() {
    if (isTogglingVideo) return;
    isTogglingVideo = true;
    ui2.videoBtn.disabled = true;
    try {
      if (state.videoEnabled) {
        turnOffVideo();
      } else {
        if (state.screenSharing) {
          stopScreenShare();
        }
        const cameraStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: getVideoConstraints()
        });
        let rawVideoTrack = cameraStream.getVideoTracks()[0] || null;
        if (!rawVideoTrack || rawVideoTrack.readyState !== "live") {
          stopStream(cameraStream);
          throw new Error("No live camera track was returned.");
        }
        if (state.rawCameraTrack && state.rawCameraTrack !== rawVideoTrack) {
          try {
            state.rawCameraTrack.stop();
          } catch (e) {
          }
        }
        state.rawCameraTrack = rawVideoTrack;
        let videoTrack = await processTrack(rawVideoTrack);
        const previousVideoTrack = currentVideoTrack();
        state.videoEnabled = true;
        rebuildLocalStream(currentTrack(), videoTrack);
        if (previousVideoTrack && previousVideoTrack !== videoTrack && previousVideoTrack !== rawVideoTrack) {
          try {
            previousVideoTrack.stop();
          } catch (e) {
          }
        }
        videoTrack.onended = () => {
          if (currentVideoTrack() === videoTrack || state.rawCameraTrack === rawVideoTrack) {
            turnOffVideo();
            applyLocalTracksToAllPeers();
          }
        };
        updateLocalVideoPreview();
        ui2.videoBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`;
        ui2.videoBtn.classList.add("active");
        showToast("Camera turned on.", "success");
        broadcastVideoState(true);
      }
      applyLocalTracksToAllPeers();
      refreshRoomStatus();
    } catch (error) {
      console.error("Camera toggle failed:", error);
      state.videoEnabled = false;
      if (state.rawCameraTrack) {
        try {
          state.rawCameraTrack.stop();
        } catch (e) {
        }
        state.rawCameraTrack = null;
      }
      ui2.videoBtn.innerHTML = '<i class="fa-solid fa-video-slash"></i>';
      ui2.videoBtn.classList.remove("active");
      showToast("Camera access failed. Check permissions.", "error");
    } finally {
      isTogglingVideo = false;
      ui2.videoBtn.disabled = false;
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
        showToast("Screen sharing is not supported on this device/browser.", "error");
        return;
      }
      try {
        ui2.screenShareBtn.disabled = true;
        showToast("Warning: Please do not share the current tab to prevent severe audio echo.", "warning");
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
          state.localVideoTrack.contentHint = "detail";
        }
        const tabAudioTrack = displayStream.getAudioTracks()[0];
        if (tabAudioTrack) {
          const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
          state.screenAudioContext = new AudioContextCtor({ latencyHint: "interactive" });
          const dest = state.screenAudioContext.createMediaStreamDestination();
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
        ui2.screenShareBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2m4 0h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2"></path><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
        ui2.screenShareBtn.classList.add("danger");
        ui2.screenShareBtn.classList.add("active");
        updateLocalVideoPreview();
        applyLocalTracksToAllPeers();
        broadcastVideoState(true);
      } catch (err) {
        console.warn("Screen share failed or cancelled", err);
        showToast("Screen sharing failed or was cancelled.", "warning");
      } finally {
        ui2.screenShareBtn.disabled = false;
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
      if (state.screenAudioContext.state !== "closed") {
        state.screenAudioContext.close().catch(() => {
        });
      }
      state.screenAudioContext = null;
    }
    ui2.screenShareBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`;
    ui2.screenShareBtn.classList.remove("active");
    ui2.screenShareBtn.classList.remove("danger");
    updateLocalVideoPreview();
    applyLocalTracksToAllPeers();
    broadcastVideoState(false);
  }
  function toggleMute() {
    const track = currentTrack();
    if (!track) {
      showToast("Microphone disconnected. Attempting to restore...", "warning");
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
    showToast(track.enabled ? "Microphone unmuted." : "Microphone muted.", "info", 1800);
    if (typeof syncMuteState === "function") {
      syncMuteState(!track.enabled);
    }
    socket.emit("media-state-change", {
      type: "audio",
      enabled: track.enabled
    });
  }
  async function retryMicAccess() {
    if (!state.roomId) return;
    ui2.retryMicBtn.disabled = true;
    try {
      await acquireLocalMedia(ui2.deviceSelect.value, {
        required: true,
        silent: true,
        exactDevice: Boolean(ui2.deviceSelect.value),
        allowFallback: false
      });
      const micReady = Boolean(currentTrack());
      if (micReady) {
        applyLocalTracksToAllPeers();
        showToast("Microphone connected.", "success");
      } else {
        showToast("Microphone is still unavailable. Check browser permissions or choose another device.", "warning");
      }
      refreshRoomStatus();
    } finally {
      updateRetryButton();
    }
  }
  async function copyInviteLink() {
    const url = new URL(window.location.href);
    const room = state.roomId || normalizeRoomName(ui2.roomInput.value);
    const pwd = ui2.passwordInput.value;
    url.search = "";
    const hashParams = new URLSearchParams();
    if (room) hashParams.set("room", room);
    if (pwd) hashParams.set("pwd", pwd);
    url.hash = hashParams.toString();
    try {
      await navigator.clipboard.writeText(url.toString());
      showToast("Invite link copied.", "success");
    } catch (_error) {
      const fallback = document.createElement("textarea");
      fallback.value = url.toString();
      fallback.style.position = "fixed";
      fallback.style.opacity = "0";
      document.body.appendChild(fallback);
      fallback.focus();
      fallback.select();
      try {
        document.execCommand("copy");
        showToast("Invite link copied.", "success");
      } catch (copyError) {
        console.error("Clipboard copy failed:", copyError);
        showToast("Unable to copy the invite link.", "error");
      } finally {
        fallback.remove();
      }
    }
  }
  function initializeFromQuery() {
    const hash = window.location.hash.startsWith("#") ? window.location.hash.substring(1) : window.location.hash;
    const hashParams = new URLSearchParams(hash);
    const queryParams = new URLSearchParams(window.location.search);
    const roomFromUrl = hashParams.get("room") || queryParams.get("room");
    const pwdFromUrl = hashParams.get("pwd") || queryParams.get("pwd");
    if (roomFromUrl) {
      ui2.roomInput.value = roomFromUrl;
    }
    if (pwdFromUrl) {
      ui2.passwordInput.value = pwdFromUrl;
    }
    setRoomChip(ui2.roomInput.value || "Not joined");
  }
  window.addEventListener("hashchange", initializeFromQuery);
  window.addEventListener("popstate", initializeFromQuery);
  socket.on("connect", () => {
    setSocketStateLabel("connected");
    if (state.reconnecting && state.roomId) {
      restoreRoomAfterReconnect();
    } else {
      refreshRoomStatus();
    }
  });
  socket.on("disconnect", (reason) => {
    setSocketStateLabel("disconnected");
    if (reason !== "io client disconnect") {
      setStatus("Signaling disconnected", "warning");
      if (state.roomId && !state.leaving) {
        state.reconnecting = true;
      }
    }
  });
  socket.on("connect_error", (error) => {
    console.error("Socket connection error:", error);
    setSocketStateLabel("error");
    setStatus("Socket connection error", "danger");
  });
  socket.on("peer-joined", async ({ peerId, username }) => {
    if (!peerId || peerId === socket.id || !state.roomId) return;
    if (state.peers.has(peerId)) {
      cleanupPeer(peerId, "peer reconnected");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    ensurePeer(peerId, username);
    if (currentTrack()) {
      socket.emit("media-state-change", { type: "audio", enabled: currentTrack().enabled });
    }
    socket.emit("media-state-change", { type: "video", enabled: state.videoEnabled || state.screenSharing });
  });
  socket.on("peer-disconnected", ({ peerId }) => {
    if (!peerId) return;
    cleanupPeer(peerId, "peer left");
    showToast("A participant left the room.", "info");
  });
  socket.on("room-state", ({ room, peers, usernames, peerCount }) => {
    if (!room || room !== state.roomId) return;
    syncPeerRoster(peers || [], usernames || {});
    if (typeof peerCount === "number") {
      updatePeerCount();
    }
  });
  socket.on("webrtc-offer", handleRemoteOffer);
  socket.on("webrtc-answer", handleRemoteAnswer);
  socket.on("ice-candidate", handleRemoteIce);
  socket.on("room-chat-message", async (data) => {
    if (data && data.encrypted) {
      if (!state.e2eeKey) {
        return;
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
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      }
      if (decryptedText) {
        try {
          const msg = JSON.parse(decryptedText);
          appendMessage(msg.text, false, msg.username || "Anonymous");
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
        }
      } else {
        appendMessage(`[Encrypted Payload] ${data.payload}`, false, "Unknown (Decryption Failed)");
      }
    } else if (data && data.text) {
      appendMessage(data.text, false, data.username || "Anonymous");
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
    if (data.type === "audio") {
      peer.isAudioMuted = !data.enabled;
      const muteIcon = document.getElementById(`mute-icon-${peerId}`);
      if (muteIcon) {
        if (data.enabled) muteIcon.classList.add("hidden");
        else muteIcon.classList.remove("hidden");
      }
      const participantMic = document.getElementById(`participant-mic-${peerId}`);
      if (participantMic) {
        if (data.enabled) {
          participantMic.classList.remove("muted");
        } else {
          participantMic.classList.add("muted");
        }
      }
    } else if (data.type === "video") {
      const videoEl2 = document.getElementById(`video-${peerId}`);
      const wrapper = document.getElementById(`video-wrapper-${peerId}`);
      if (videoEl2 && wrapper) {
        const avatar = wrapper.querySelector(".avatar-placeholder");
        const visiCanvas = wrapper.querySelector(".audio-visi-canvas");
        if (data.enabled) {
          videoEl2.style.opacity = "1";
          if (avatar) avatar.style.display = "none";
          if (visiCanvas) visiCanvas.style.display = "none";
        } else {
          videoEl2.style.opacity = "0";
          if (avatar) avatar.style.display = "block";
          if (visiCanvas) visiCanvas.style.display = "block";
        }
      }
    }
  }
  socket.on("media-state-change", handleMediaStateChange);
  socket.on("typing", (data) => {
    if (!data || !data.senderId) return;
    const peerId = data.senderId;
    const peer = state.peers.get(peerId);
    if (!peer) return;
    const userName = data.username || peer.username || "Someone";
    peer.typingUsername = userName;
    typingUsers.add(userName);
    updateTypingIndicator();
    clearTimeout(peer.typingTimeout);
    peer.typingTimeout = setTimeout(() => {
      typingUsers.delete(userName);
      updateTypingIndicator();
      peer.typingTimeout = null;
    }, 3e3);
  });
  initVideoGridEngine();
  ui2.joinBtn.addEventListener("click", joinRoom);
  if (ui2.generateLinkBtn) {
    ui2.generateLinkBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const genId = (len) => {
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
        const array = new Uint32Array(len);
        window.crypto.getRandomValues(array);
        let result = "";
        for (let i = 0; i < len; i++) {
          result += chars[array[i] % chars.length];
        }
        return result;
      };
      ui2.roomInput.value = genId(16);
      ui2.passwordInput.value = genId(16);
      showToast("Secure credentials generated!", "success");
    });
  }
  ui2.hangupBtn.addEventListener("click", () => leaveRoom({ keepRoomInput: true }));
  ui2.muteBtn.addEventListener("click", toggleMute);
  ui2.videoBtn.addEventListener("click", toggleVideo);
  ui2.screenShareBtn.addEventListener("click", toggleScreenShare);
  ui2.retryMicBtn.addEventListener("click", retryMicAccess);
  ui2.copyLinkBtn.addEventListener("click", copyInviteLink);
  ui2.sendBtn.addEventListener("click", sendChatMessage);
  ui2.attachFileBtn.addEventListener("click", () => ui2.fileInput.click());
  if (ui2.directorBtn) {
    ui2.directorBtn.addEventListener("click", () => {
      state.autoDirectorEnabled = !state.autoDirectorEnabled;
      ui2.directorBtn.classList.toggle("active", state.autoDirectorEnabled);
      showToast(
        state.autoDirectorEnabled ? "\u{1F916} AI Auto-Director ENABLED (Auto-focusing active speakers)" : "\u{1F916} AI Auto-Director DISABLED",
        state.autoDirectorEnabled ? "success" : "info"
      );
    });
  }
  if (ui2.reactionsToggleBtn && ui2.reactionMenu) {
    ui2.reactionsToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      ui2.reactionMenu.classList.toggle("open");
    });
    document.addEventListener("click", (e) => {
      if (ui2.reactionMenu && !ui2.reactionMenu.contains(e.target) && e.target !== ui2.reactionsToggleBtn) {
        ui2.reactionMenu.classList.remove("open");
      }
    });
    ui2.reactionMenu.querySelectorAll(".emoji-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const emoji = e.currentTarget.dataset.emoji || e.currentTarget.textContent.trim();
        triggerFloatingReaction("local", emoji);
        broadcastDataChannelMessage({ type: "reaction", emoji });
        ui2.reactionMenu.classList.remove("open");
      });
    });
  }
  function triggerFloatingReaction(targetId, emoji) {
    const wrapper = document.getElementById(targetId === "local" ? "video-wrapper-local" : `video-wrapper-${targetId}`);
    if (!wrapper) return;
    const el = document.createElement("div");
    el.className = "reaction-particle";
    el.textContent = emoji;
    const drift = Math.floor((Math.random() - 0.5) * 80);
    const rot = Math.floor((Math.random() - 0.5) * 40);
    el.style.setProperty("--drift", `${drift}px`);
    el.style.setProperty("--rot", `${rot}deg`);
    wrapper.appendChild(el);
    setTimeout(() => {
      if (el && el.parentElement) {
        el.remove();
      }
    }, 2200);
  }
  setInterval(() => {
    if (state.peers.size === 0) return;
    state.peers.forEach(async (peer, peerId) => {
      if (!peer.pc || peer.pc.connectionState !== "connected") return;
      try {
        const stats = await peer.pc.getStats();
        let rtt = 0;
        stats.forEach((stat) => {
          if (stat.type === "candidate-pair" && (stat.state === "succeeded" || stat.selected || stat.nominated)) {
            if (stat.currentRoundTripTime !== void 0) {
              rtt = Math.round(stat.currentRoundTripTime * 1e3);
            } else if (stat.roundTripTime !== void 0) {
              rtt = Math.round(stat.roundTripTime * 1e3);
            }
          }
          if ((stat.type === "remote-inbound-rtp" || stat.type === "remote-outbound-rtp") && stat.roundTripTime !== void 0 && rtt === 0) {
            rtt = Math.round(stat.roundTripTime * 1e3);
          }
        });
        if (!peer.hudTextEl || !peer.hudTextEl.isConnected || !peer.hudDotEl || !peer.hudDotEl.isConnected) {
          const hudEl = document.getElementById(`hud-badge-${peerId}`);
          if (hudEl) {
            peer.hudTextEl = hudEl.querySelector(".hud-text") || hudEl.querySelector("span:last-child");
            peer.hudDotEl = hudEl.querySelector(".optic-dot");
          }
        }
        if (peer.hudTextEl) {
          peer.hudTextEl.textContent = rtt > 0 ? `\u{1F4F6} ${rtt}ms RTT` : "\u{1F7E2} Connected";
        }
        if (peer.hudDotEl) {
          peer.hudDotEl.className = "optic-dot" + (rtt > 250 ? " bad" : rtt > 120 ? " warn" : "");
        }
        const videoSender = peer.pc.getSenders().find((s) => s.track && s.track.kind === "video");
        if (videoSender && typeof videoSender.getParameters === "function") {
          const params = videoSender.getParameters();
          if (params && params.encodings && params.encodings.length > 0) {
            const encoding = params.encodings[0];
            const shouldBeEco = rtt > 220 || state.peers.size >= 4;
            if (shouldBeEco && !peer.isEcoMode) {
              peer.isEcoMode = true;
              encoding.maxBitrate = 28e4;
              encoding.scaleResolutionDownBy = 2;
              videoSender.setParameters(params).catch(() => {
              });
              showToast(`\u{1F331} Eco-Bandwidth: Auto-adapted video stream for ${peer.username} to prevent lag`, "warning", 3e3);
            } else if (!shouldBeEco && peer.isEcoMode && rtt < 150) {
              peer.isEcoMode = false;
              delete encoding.maxBitrate;
              encoding.scaleResolutionDownBy = 1;
              videoSender.setParameters(params).catch(() => {
              });
              showToast(`\u26A1 High-Performance Mode restored for ${peer.username}`, "success", 2500);
            }
          }
        }
      } catch (e) {
      }
    });
  }, 2500);
  function sendFileToPeer(peerId, file, fileId, callbacks) {
    const peer = getPeerState(peerId);
    if (!peer || !peer.dataChannel || peer.dataChannel.readyState !== "open") {
      callbacks.onFinished();
      return;
    }
    const channel = peer.dataChannel;
    let offset = 0;
    const reader = new FileReader();
    const fileIdStr = fileId.padEnd(16, " ");
    const fileIdBytes = textEncoder.encode(fileIdStr);
    reader.onload = (e) => {
      if (channel.readyState !== "open") {
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
      if (channel.readyState !== "open") {
        callbacks.onFinished();
        return;
      }
      if (channel.bufferedAmount > DATA_CHANNEL_HIGH_WATER) {
        const resumeTransfer = () => {
          channel.onbufferedamountlow = null;
          channel.removeEventListener("close", resumeTransfer);
          readNextSlice();
        };
        channel.onbufferedamountlow = resumeTransfer;
        channel.addEventListener("close", resumeTransfer, { once: true });
        return;
      }
      const slice = file.slice(offset, offset + FILE_CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };
    readNextSlice();
  }
  ui2.fileInput.addEventListener("change", () => {
    const file = ui2.fileInput.files[0];
    if (!file) return;
    ui2.fileInput.value = "";
    if (file.size > MAX_FILE_SIZE) {
      showToast("File size must be less than 50MB.", "warning");
      return;
    }
    if (file.size === 0) {
      showToast("Cannot send empty files.", "warning");
      return;
    }
    const targetPeers = [];
    peerEntries().forEach(([peerId, peer]) => {
      if (peer.dataChannel && peer.dataChannel.readyState === "open") {
        targetPeers.push(peerId);
      }
    });
    if (!targetPeers.length) {
      showToast("No connected peers are ready for file transfer.", "warning");
      return;
    }
    const fileId = "file-" + Math.random().toString(36).substr(2, 9);
    const meta = { type: "file-meta", fileId, name: file.name.slice(0, 120), size: file.size, fileType: file.type || "application/octet-stream" };
    targetPeers.forEach((peerId) => {
      const peer = getPeerState(peerId);
      if (peer && peer.dataChannel) {
        try {
          peer.dataChannel.send(JSON.stringify(meta));
        } catch (error) {
          console.error(`Failed to send file metadata to peer ${peerId}:`, error);
        }
      }
    });
    appendFileProgress(fileId, file.name, file.size, true, state.username || "You");
    const pendingPeers = new Set(targetPeers);
    let maxOffset = 0;
    targetPeers.forEach((peerId) => {
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
            appendFileMessage(file.name, url, file.size, true, state.username || "You");
            showToast("File sent to all peers.", "success");
          }
        }
      });
    });
  });
  ui2.recordBtn.addEventListener("click", toggleRecording);
  ui2.chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      sendChatMessage();
    }
  });
  var typingTimer = null;
  ui2.chatInput.addEventListener("input", () => {
    if (typingTimer) return;
    socket.emit("typing", { username: state.username || "You" });
    typingTimer = setTimeout(() => {
      typingTimer = null;
    }, 2e3);
  });
  if (ui2.midCallDeviceSelect) {
    ui2.midCallDeviceSelect.addEventListener("change", () => {
      ui2.deviceSelect.value = ui2.midCallDeviceSelect.value;
      ui2.deviceSelect.dispatchEvent(new Event("change"));
    });
  }
  if (ui2.midCallCameraSelect) {
    ui2.midCallCameraSelect.addEventListener("change", async () => {
      if (isAcquiringMedia) return;
      state.selectedCameraId = ui2.midCallCameraSelect.value;
      if (state.videoEnabled) {
        isAcquiringMedia = true;
        try {
          const cameraStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: getVideoConstraints()
          });
          let rawVideoTrack = cameraStream.getVideoTracks()[0] || null;
          if (rawVideoTrack) {
            if (state.rawCameraTrack && state.rawCameraTrack !== rawVideoTrack) {
              try {
                state.rawCameraTrack.stop();
              } catch (e) {
              }
            }
            state.rawCameraTrack = rawVideoTrack;
            let videoTrack = await processTrack(rawVideoTrack);
            const previousVideoTrack = currentVideoTrack();
            rebuildLocalStream(currentTrack(), videoTrack);
            updateLocalVideoPreview();
            applyLocalTracksToAllPeers();
            if (previousVideoTrack && previousVideoTrack !== videoTrack && previousVideoTrack !== rawVideoTrack) {
              try {
                previousVideoTrack.stop();
              } catch (e) {
              }
            }
            showToast("Camera switched successfully.", "success");
          }
        } catch (e) {
          console.error("Failed to switch camera:", e);
          showToast("Failed to access selected camera.", "error");
        } finally {
          isAcquiringMedia = false;
        }
      }
    });
  }
  ui2.deviceSelect.addEventListener("change", async () => {
    const previousTrack = currentTrack();
    const previousDeviceId = state.selectedDeviceId;
    const requestedDeviceId = ui2.deviceSelect.value;
    await acquireLocalMedia(ui2.deviceSelect.value, {
      silent: true,
      exactDevice: Boolean(ui2.deviceSelect.value),
      allowFallback: false
    });
    const micReady = Boolean(currentTrack());
    const activeLabel = ui2.deviceSelect.options[ui2.deviceSelect.selectedIndex]?.textContent || "active microphone";
    if (micReady && state.roomId) {
      applyLocalTracksToAllPeers();
    }
    if (!micReady) {
      showToast("Microphone unavailable. You are still connected without audio.", "warning");
    } else if (requestedDeviceId && requestedDeviceId === previousDeviceId) {
      showToast("This microphone is already active.", "info");
    } else if (previousTrack && currentTrack() === previousTrack) {
      showToast("Could not switch microphones. Continuing with the current microphone.", "warning");
    } else {
      showToast(`Microphone switched to ${activeLabel}.`, "success");
    }
  });
  window.addEventListener("beforeunload", () => {
    leaveRoom({ keepRoomInput: true, silent: false });
  });
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", async () => {
      try {
        await populateDevices(state.localStream ? state.selectedDeviceId : "");
        refreshRoomStatus();
      } catch (error) {
        console.error("Device refresh failed:", error);
      }
    });
  }
  function broadcastDataChannelMessage(payload) {
    const json = JSON.stringify(payload);
    state.peers.forEach((peer) => {
      if (peer.dataChannel && peer.dataChannel.readyState === "open") {
        try {
          peer.dataChannel.send(json);
        } catch (e) {
          console.warn("Failed to send data channel message:", e);
        }
      }
    });
  }
  init((nextTrack) => {
    rebuildLocalStream(currentTrack(), nextTrack);
    updateLocalVideoPreview();
    applyLocalTracksToAllPeers();
  });
  init2((data) => {
    broadcastDataChannelMessage(data);
  });
  init3(
    (data) => {
      broadcastDataChannelMessage(data);
    },
    () => state.username,
    () => {
      const track = currentTrack();
      return !track || !track.enabled;
    }
  );
  init4(() => state.peers);
  initializeFromQuery();
  setMode("join");
  setRoomChip(ui2.roomInput.value || "Not joined");
  setSocketStateLabel(socket.connected ? "connected" : "connecting");
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
      stream.getTracks().forEach((track) => track.stop());
      await populateDevices();
    } catch (error) {
      console.warn("Initial permission request skipped or denied. Device labels will be hidden until joined.", error);
    }
  }
  if (supportsRequiredApis()) {
    requestInitialPermissions();
  }
  if (!supportsRequiredApis()) {
    showToast("This browser does not support the required microphone or WebRTC features.", "error");
    ui2.joinBtn.disabled = true;
  }
  setStatus(
    supportsRequiredApis() ? `Ready to join${hasTurnRelayServer(rtcConfig.iceServers) ? " with relay support" : ""}` : "Unsupported browser",
    supportsRequiredApis() ? "info" : "danger"
  );
  var _tabChat = document.getElementById("tabChat");
  var _tabParticipants = document.getElementById("tabParticipants");
  if (_tabChat) {
    _tabChat.addEventListener("click", (e) => {
      e.currentTarget.classList.add("active");
      if (_tabParticipants) _tabParticipants.classList.remove("active");
      const chatPanel = document.getElementById("chatPanel");
      const participantsPanel = document.getElementById("participantsPanel");
      if (chatPanel) chatPanel.classList.remove("hidden");
      if (participantsPanel) participantsPanel.classList.add("hidden");
      const badge = document.getElementById("chatUnreadBadge");
      if (badge) badge.classList.add("hidden");
    });
  }
  if (_tabParticipants) {
    _tabParticipants.addEventListener("click", (e) => {
      e.currentTarget.classList.add("active");
      if (_tabChat) _tabChat.classList.remove("active");
      const participantsPanel = document.getElementById("participantsPanel");
      const chatPanel = document.getElementById("chatPanel");
      if (participantsPanel) participantsPanel.classList.remove("hidden");
      if (chatPanel) chatPanel.classList.add("hidden");
    });
  }
  var toggleSidebarBtn = document.getElementById("toggleSidebarBtn");
  if (toggleSidebarBtn) {
    toggleSidebarBtn.addEventListener("click", () => {
      const panel = document.getElementById("sidePanel");
      panel.classList.toggle("collapsed");
      document.body.classList.toggle("sidebar-open", !panel.classList.contains("collapsed"));
      if (!panel.classList.contains("collapsed") && !document.getElementById("chatPanel").classList.contains("hidden")) {
        const badge = document.getElementById("chatUnreadBadge");
        if (badge) badge.classList.add("hidden");
      }
    });
  }
  var closeSidebarBtnMobile = document.getElementById("closeSidebarBtnMobile");
  if (closeSidebarBtnMobile) {
    closeSidebarBtnMobile.addEventListener("click", () => {
      document.getElementById("sidePanel").classList.add("collapsed");
      document.body.classList.remove("sidebar-open");
    });
  }
  document.addEventListener("fullscreenchange", () => {
    const isFs = !!document.fullscreenElement;
    document.querySelectorAll(".fullscreen-btn").forEach((btn) => {
      btn.classList.toggle("is-fullscreen", isFs);
    });
  });
  document.addEventListener("webkitfullscreenchange", () => {
    const isFs = !!document.webkitFullscreenElement;
    document.querySelectorAll(".fullscreen-btn").forEach((btn) => {
      btn.classList.toggle("is-fullscreen", isFs);
    });
  });
  var instructionsBtn = document.getElementById("instructionsBtn");
  var closeInstructionsBtn = document.getElementById("closeInstructionsBtn");
  var instructionsModal = document.getElementById("instructionsModal");
  if (instructionsBtn && closeInstructionsBtn && instructionsModal) {
    instructionsBtn.addEventListener("click", () => {
      instructionsModal.classList.add("active");
    });
    closeInstructionsBtn.addEventListener("click", () => {
      instructionsModal.classList.remove("active");
    });
    instructionsModal.addEventListener("click", (e) => {
      if (e.target === instructionsModal) {
        instructionsModal.classList.remove("active");
      }
    });
  }
  var privacyPolicyBtn = document.getElementById("privacyPolicyBtn");
  var closePrivacyBtn = document.getElementById("closePrivacyBtn");
  var privacyPolicyModal = document.getElementById("privacyPolicyModal");
  if (privacyPolicyBtn && closePrivacyBtn && privacyPolicyModal) {
    privacyPolicyBtn.addEventListener("click", (e) => {
      e.preventDefault();
      privacyPolicyModal.classList.add("active");
    });
    closePrivacyBtn.addEventListener("click", () => {
      privacyPolicyModal.classList.remove("active");
    });
    privacyPolicyModal.addEventListener("click", (e) => {
      if (e.target === privacyPolicyModal) {
        privacyPolicyModal.classList.remove("active");
      }
    });
  }
})();
//# sourceMappingURL=bundle.js.map
