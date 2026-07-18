const fs = require('fs');
const path = require('path');

const packagePath = path.join(__dirname, '../package.json');
const htmlPath = path.join(__dirname, '../public/index.html');

try {
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const version = pkg.version || '1.0.0';
  
  // Use version + timestamp as the build identifier for absolute cache busting safety
  const buildId = `${version}-${Date.now()}`;
  
  let html = fs.readFileSync(htmlPath, 'utf8');
  
  // Replace dist/bundle.js?v=... with dist/bundle.js?v=buildId
  html = html.replace(/bundle\.js\?v=[a-zA-Z0-9.-]*/g, `bundle.js?v=${buildId}`);
  // Replace dist/styles.css?v=... with dist/styles.css?v=buildId
  html = html.replace(/styles\.css\?v=[a-zA-Z0-9.-]*/g, `styles.css?v=${buildId}`);
  
  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log(`Successfully updated cache buster versions in index.html to: ${buildId}`);
} catch (e) {
  console.error('Failed to update version cache buster in index.html:', e);
  process.exit(1);
}
