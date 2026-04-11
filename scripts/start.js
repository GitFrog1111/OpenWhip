#!/usr/bin/env node
const path = require('path');
const { spawn } = require('child_process');

let electronBinary;
try {
  electronBinary = require('electron');
} catch (err) {
  console.error('Could not load Electron. Run `npm install` first.');
  process.exit(1);
}

const appPath = path.resolve(__dirname, '..');
const extraArgs = process.argv.slice(2);
const env = { ...process.env };

if (process.platform === 'linux' && env.WAYLAND_DISPLAY && env.DISPLAY && !env.ELECTRON_OZONE_PLATFORM_HINT) {
  env.ELECTRON_OZONE_PLATFORM_HINT = 'x11';
}

const child = spawn(electronBinary, [appPath, ...extraArgs], {
  env,
  stdio: 'inherit',
  windowsHide: true,
});

child.on('error', err => {
  console.error('Failed to start badclaude:', err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
