#!/usr/bin/env node
const path = require('path');
const { spawn } = require('child_process');

const invokedAs = path.basename(process.argv[1] || '');
if (invokedAs === 'badclaude' || invokedAs === 'badclaude.cmd') {
  console.warn('[DEPRECATED] "badclaude" has been renamed to "openwhip".');
  console.warn('Please run: npm install -g openwhip');
}

const appPath = path.resolve(__dirname, '..');

// WSL2: run the Windows build of Electron instead (see wsl.js)
const wsl = require('./wsl');
if (wsl.isWSL()) {
  wsl.launch(appPath);
  return;
}

let electronBinary;
try {
  electronBinary = require('electron');
} catch (e) {
  console.error('Could not load Electron. Try: npm install -g openwhip');
  process.exit(1);
}

const child = spawn(electronBinary, [appPath], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});

child.on('error', (err) => {
  console.error('Failed to start openwhip:', err.message);
  process.exit(1);
});

child.unref();
