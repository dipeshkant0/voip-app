const fs = require('fs');
const path = require('path');

const appJsPath = path.join(__dirname, 'public', 'app.js');
let appJs = fs.readFileSync(appJsPath, 'utf8');

const icons = {
  mic: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`,
  micSlash: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`,
  video: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`,
  videoSlash: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`,
  screenShare: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`,
  screenShareSlash: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2m4 0h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2"></path><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line><line x1="1" y1="1" x2="23" y2="23"></line></svg>`,
  record: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle></svg>`,
  stopRecord: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>`,
  refresh: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`
};

// 1. Revert UI text updates in app.js back to SVG innerHTML updates
appJs = appJs.replace(/ui\.muteBtn\.textContent = 'Mute Mic';/g, `ui.muteBtn.innerHTML = \`${icons.mic}\`;`);
appJs = appJs.replace(/ui\.muteBtn\.textContent = 'Unmute Mic';/g, `ui.muteBtn.innerHTML = \`${icons.micSlash}\`;`);

appJs = appJs.replace(/ui\.videoBtn\.textContent = 'Disable Video';/g, `ui.videoBtn.innerHTML = \`${icons.video}\`;`);
appJs = appJs.replace(/ui\.videoBtn\.textContent = 'Enable Video';/g, `ui.videoBtn.innerHTML = \`${icons.videoSlash}\`;`);

appJs = appJs.replace(/ui\.screenShareBtn\.textContent = 'Share Screen';/g, `ui.screenShareBtn.innerHTML = \`${icons.screenShare}\`;`);
appJs = appJs.replace(/ui\.screenShareBtn\.textContent = 'Stop Sharing';/g, `ui.screenShareBtn.innerHTML = \`${icons.screenShareSlash}\`;`);

appJs = appJs.replace(/ui\.recordBtn\.textContent = 'Record Call';/g, `ui.recordBtn.innerHTML = \`${icons.record}\`;`);
appJs = appJs.replace(/ui\.recordBtn\.textContent = 'Stop Recording';/g, `ui.recordBtn.innerHTML = \`${icons.stopRecord}\`;`);

appJs = appJs.replace(/ui\.retryMicBtn\.textContent = 'Retry Mic Access';/g, `ui.retryMicBtn.innerHTML = \`${icons.refresh}\`;`);
appJs = appJs.replace(/ui\.retryMicBtn\.textContent = currentTrack\(\) \? 'Refresh Mic' : 'Retry Mic Access';/g, `ui.retryMicBtn.innerHTML = \`${icons.refresh}\`;`);

appJs = appJs.replace(/micEl\.textContent = '\[Mic\]';/g, `micEl.innerHTML = \`${icons.mic}\`;`);
appJs = appJs.replace(/participantMic\.textContent = '\[Mic\]';/g, `participantMic.innerHTML = \`${icons.mic}\`;`);
appJs = appJs.replace(/participantMic\.textContent = '\[Muted\]';/g, `participantMic.innerHTML = \`${icons.micSlash}\`;`);

// 2. Add ensurePeerVideoWrapper logic to always create the grid card!
const ensurePeerVideoWrapper = `
function ensurePeerVideoWrapper(peerId, username = 'Peer') {
  let wrapper = document.getElementById(\`video-wrapper-\${peerId}\`);
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = 'video-wrapper';
    wrapper.id = \`video-wrapper-\${peerId}\`;
    
    const avatar = document.createElement('div');
    avatar.className = 'avatar-placeholder';
    avatar.textContent = username;
    avatar.style.position = 'absolute';
    avatar.style.color = 'white';
    avatar.style.fontSize = '2rem';
    
    const muteIcon = document.createElement('div');
    muteIcon.className = 'video-mute-icon hidden';
    muteIcon.id = \`mute-icon-\${peerId}\`;
    muteIcon.textContent = 'Muted';
    muteIcon.style.color = 'red';
    muteIcon.style.fontWeight = 'bold';
    muteIcon.style.background = 'black';
    muteIcon.style.padding = '4px 8px';
    muteIcon.style.borderRadius = '4px';

    wrapper.appendChild(avatar);
    wrapper.appendChild(muteIcon);
    ui.videoContainer.appendChild(wrapper);
  }
}
`;

// Inject this function right before createPeerConnection
appJs = appJs.replace(/function createPeerConnection\(peerId, initiator = false, username = 'Peer'\) \{/, ensurePeerVideoWrapper + "\nfunction createPeerConnection(peerId, initiator = false, username = 'Peer') {\n  ensurePeerVideoWrapper(peerId, username);");

// Ensure that in ontrack, we append the video/audio correctly into the existing wrapper
appJs = appJs.replace(
  /        const wrapper = document\.createElement\('div'\);\n        wrapper\.className = 'video-wrapper';\n        wrapper\.id = `video-wrapper-\${peerId}`;\n        videoEl = document\.createElement\('video'\);\n        videoEl\.id = `video-\${peerId}`;\n        videoEl\.autoplay = true;\n        videoEl\.playsInline = true;\n        videoEl\.style\.transition = 'opacity 0\.2s ease';\n        const muteIcon = document\.createElement\('div'\);\n        muteIcon\.className = 'video-mute-icon hidden';\n        muteIcon\.id = `mute-icon-\${peerId}`;\n        muteIcon\.innerHTML = '<i class="fa-solid fa-microphone-slash"><\/i>';\n        wrapper\.appendChild\(videoEl\);\n        wrapper\.appendChild\(muteIcon\);\n        ui\.videoContainer\.appendChild\(wrapper\);/,
  `        const wrapper = document.getElementById(\`video-wrapper-\${peerId}\`);
        videoEl = document.createElement('video');
        videoEl.id = \`video-\${peerId}\`;
        videoEl.autoplay = true;
        videoEl.playsInline = true;
        videoEl.style.transition = 'opacity 0.2s ease';
        wrapper.appendChild(videoEl);
        const avatar = wrapper.querySelector('.avatar-placeholder');
        if (avatar) avatar.style.display = 'none';`
);

// For audio tracks in ontrack, they should also append to the wrapper, not just ui.videoContainer
appJs = appJs.replace(
  /        audioEl\.style\.display = 'none';\n        ui\.videoContainer\.appendChild\(audioEl\);/,
  `        audioEl.style.display = 'none';\n        const wrapper = document.getElementById(\`video-wrapper-\${peerId}\`);\n        if (wrapper) wrapper.appendChild(audioEl);\n        else ui.videoContainer.appendChild(audioEl);`
);

// 3. Bind the mid-call device select!
const midCallLogic = `
  const midCallDeviceSelect = document.getElementById('midCallDeviceSelect');
  if (midCallDeviceSelect) {
    midCallDeviceSelect.addEventListener('change', async () => {
      // Sync it back to the original select
      ui.deviceSelect.value = midCallDeviceSelect.value;
      // Trigger the original select logic
      ui.deviceSelect.dispatchEvent(new Event('change'));
    });
  }
`;

// Inject inside window.addEventListener('DOMContentLoaded', ...)
appJs = appJs.replace(/  ui\.deviceSelect\.addEventListener\('change'/g, midCallLogic + "\n  ui.deviceSelect.addEventListener('change'");

// Sync the dropdown options from populateDevices to midCallDeviceSelect
appJs = appJs.replace(
  /  ui\.deviceSelect\.disabled = false;\n\}/g,
  `  ui.deviceSelect.disabled = false;\n  const midCallDeviceSelect = document.getElementById('midCallDeviceSelect');\n  if (midCallDeviceSelect) {\n    midCallDeviceSelect.innerHTML = ui.deviceSelect.innerHTML;\n    midCallDeviceSelect.value = keepValue;\n  }\n}`
);

fs.writeFileSync(appJsPath, appJs, 'utf8');
console.log('app.js updated with SVGs and missing grid logic');
