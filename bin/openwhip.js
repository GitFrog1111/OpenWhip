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

// On macOS, launch through Launch Services so Electron is its own "responsible" process.
// Spawned directly, TCC checks Accessibility against the parent terminal instead of
// Electron, and every keystroke fails with "osascript is not allowed to send keystrokes".
const macBundle = process.platform === 'darwin'
  ? electronBinary.replace(/\/Contents\/MacOS\/[^/]+$/, '')
  : null;
const [cmd, args] = macBundle && macBundle.endsWith('.app')
  ? ['open', ['-n', '-a', macBundle, '--args', appPath]]
  : [electronBinary, [appPath]];

const child = spawn(cmd, args, {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});

child.on('error', (err) => {
  console.error('Failed to start openwhip:', err.message);
  process.exit(1);
});

child.unref();
