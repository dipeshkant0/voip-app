const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, 'public', 'index.html');
let indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

// 1. Revert CSS for .control-btn
indexHtml = indexHtml.replace(
  /\.control-btn {\n      padding: 12px 24px;\n      border-radius: 999px;/g,
  `.control-btn {\n      width: 52px;\n      height: 52px;\n      border-radius: 50%;`
);
indexHtml = indexHtml.replace(
  /display: inline-flex;\n      align-items: center;\n      justify-content: center;\n      font-weight: 500;\n      font-size: 0\.95rem;/g,
  `display: grid;\n      place-items: center;`
);

// SVGs
const icons = {
  mic: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`,
  video: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`,
  screenShare: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`,
  record: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle></svg>`,
  refresh: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`,
  message: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`,
  hangup: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"></path><line x1="23" y1="1" x2="1" y2="23"></line></svg>`
};

// Replace text buttons with SVG
indexHtml = indexHtml.replace(/<button id="muteBtn" class="control-btn" disabled>Mute Mic<\/button>/, `<button id="muteBtn" class="control-btn" title="Toggle Microphone" disabled>${icons.mic}</button>`);
indexHtml = indexHtml.replace(/<button id="videoBtn" class="control-btn" disabled>Enable Video<\/button>/, `<button id="videoBtn" class="control-btn" title="Toggle Camera" disabled>${icons.video}</button>`);
indexHtml = indexHtml.replace(/<button id="screenShareBtn" class="control-btn" disabled>Share Screen<\/button>/, `<button id="screenShareBtn" class="control-btn" title="Share Screen" disabled>${icons.screenShare}</button>`);
indexHtml = indexHtml.replace(/<button id="recordBtn" class="control-btn" disabled>Record Call<\/button>/, `<button id="recordBtn" class="control-btn" title="Record Audio" disabled>${icons.record}</button>`);
indexHtml = indexHtml.replace(/<button id="retryMicBtn" class="control-btn" disabled>Refresh Mic<\/button>/, `<button id="retryMicBtn" class="control-btn" title="Refresh Audio Device">${icons.refresh}</button>`);
indexHtml = indexHtml.replace(/<button id="toggleSidebarBtn" class="control-btn">Toggle Chat<\/button>/, `<button id="toggleSidebarBtn" class="control-btn" title="Toggle Sidebar">${icons.message}</button>`);
indexHtml = indexHtml.replace(/<button id="hangupBtn" class="control-btn danger">Leave Room<\/button>/, `<button id="hangupBtn" class="control-btn danger" title="Leave Call">${icons.hangup}</button>`);

// Also add a mic selector inside the sidebar Participants tab
const sidebarTabs = `<div id="participants-content" class="sidebar-content hidden">`;
const micSelectorHtml = `
          <div class="sidebar-section" style="padding: 12px; background: rgba(255,255,255,0.03); border-radius: 8px; margin-bottom: 16px;">
            <label style="font-size: 0.8rem; color: var(--muted); margin-bottom: 8px; display: block;">Select Microphone</label>
            <select id="midCallDeviceSelect" class="form-input" style="width: 100%; padding: 8px; font-size: 0.9rem;">
              <option value="">Default Microphone</option>
            </select>
          </div>
`;
indexHtml = indexHtml.replace(sidebarTabs, sidebarTabs + micSelectorHtml);

fs.writeFileSync(indexHtmlPath, indexHtml, 'utf8');
console.log('index.html updated with SVGs');
