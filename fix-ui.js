const fs = require('fs');
const path = require('path');
const appJsPath = path.join(__dirname, 'public', 'app.js');
let code = fs.readFileSync(appJsPath, 'utf8');

// 1. Retry Mic Button
code = code.replace(
  /ui\.retryMicBtn\.textContent = 'Retry Mic Access';/g,
  `ui.retryMicBtn.innerHTML = '<i class="fa-solid fa-rotate-right"></i>'; ui.retryMicBtn.title = 'Retry Mic Access';`
);
code = code.replace(
  /ui\.retryMicBtn\.textContent = currentTrack\(\) \? 'Refresh Mic' : 'Retry Mic Access';/g,
  `ui.retryMicBtn.innerHTML = '<i class="fa-solid fa-rotate-right"></i>'; ui.retryMicBtn.title = currentTrack() ? 'Refresh Mic' : 'Retry Mic Access';`
);

// 2. Record Button
code = code.replace(
  /ui\.recordBtn\.textContent = 'Stop Recording';/g,
  `ui.recordBtn.innerHTML = '<i class="fa-solid fa-record-vinyl"></i>';`
);
code = code.replace(
  /ui\.recordBtn\.classList\.add\('btn-danger'\);/g,
  `ui.recordBtn.classList.add('danger');`
);
code = code.replace(
  /ui\.recordBtn\.classList\.remove\('btn-secondary'\);/g,
  `ui.recordBtn.classList.remove('active');`
);
code = code.replace(
  /ui\.recordBtn\.textContent = 'Record Call';/g,
  `ui.recordBtn.innerHTML = '<i class="fa-solid fa-record-vinyl"></i>';`
);
code = code.replace(
  /ui\.recordBtn\.classList\.remove\('btn-danger'\);/g,
  `ui.recordBtn.classList.remove('danger');`
);
code = code.replace(
  /ui\.recordBtn\.classList\.add\('btn-secondary'\);/g,
  `ui.recordBtn.classList.remove('active');` // Default is just normal control button
);

fs.writeFileSync(appJsPath, code, 'utf8');
console.log('Fixed UI bugs!');
