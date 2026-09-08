#!/usr/bin/env node
const path = require('path');
const { spawn } = require('child_process');

const invokedAs = path.basename(process.argv[1] || '');
if (invokedAs === 'badclaude' || invokedAs === 'badclaude.cmd') {
  console.warn('[DEPRECATED] "badclaude" has been renamed to "openwhip".');
  console.warn('Please run: npm install -g openwhip');
}

let electronBinary;
try {
  electronBinary = require('electron');
} catch (e) {
  console.error('Could not load Electron. Try: npm install -g openwhip');
  process.exit(1);
}

const appPath = path.resolve(__dirname, '..');
const extraArgs = process.argv.slice(2);

const spawnOpts = { detached: true, stdio: 'ignore', windowsHide: true };
let child;
if (process.platform === 'darwin') {
  const { ensureMacApp } = require('../scripts/mac-app');
  child = spawn('open', ['-n', ensureMacApp(electronBinary, appPath), '--args', appPath, ...extraArgs], spawnOpts);
} else {
  child = spawn(electronBinary, [appPath, ...extraArgs], spawnOpts);
}

child.on('error', (err) => {
  console.error('Failed to start openwhip:', err.message);
  process.exit(1);
});

child.unref();
