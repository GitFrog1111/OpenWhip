const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, globalShortcut, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

// ── Win32 FFI (Windows only) ────────────────────────────────────────────────
let keybd_event, VkKeyScanA;
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    keybd_event = user32.func('void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)');
    VkKeyScanA = user32.func('int16_t __stdcall VkKeyScanA(int ch)');
  } catch (e) {
    console.warn('koffi not available – macro sending disabled', e.message);
  }
}

// ── Globals ─────────────────────────────────────────────────────────────────
let tray, overlay;
let overlayReady = false;
let spawnQueued = false;
let refocusQueued = false;
let readyAt = 0;

const TOGGLE_SHORTCUT = 'Alt+Shift+W';
const PAT_SHORTCUT = 'Alt+Shift+P';
let pendingKind = 'whip';

const VK_CONTROL = 0x11;
const VK_RETURN  = 0x0D;
const VK_C       = 0x43;
const VK_MENU    = 0x12; // Alt
const VK_TAB     = 0x09;
const KEYUP      = 0x0002;

/** One Alt+Tab / Cmd+Tab so focus returns to the previously active app after tray click. */
function refocusPreviousApp() {
  const delayMs = 80;
  const run = () => {
    if (process.platform === 'win32') {
      if (!keybd_event) return;
      keybd_event(VK_MENU, 0, 0, 0);
      keybd_event(VK_TAB, 0, 0, 0);
      keybd_event(VK_TAB, 0, KEYUP, 0);
      keybd_event(VK_MENU, 0, KEYUP, 0);
    } else if (process.platform === 'darwin') {
      const script = [
        'tell application "System Events"',
        '  key down command',
        '  key code 48', // Tab
        '  key up command',
        'end tell',
      ].join('\n');
      execFile('osascript', ['-e', script], err => {
        if (err) {
          console.warn('refocus previous app (Cmd+Tab) failed:', err.message);
        }
      });
    } else if (process.platform === 'linux') {
      execFile('xdotool', ['key', '--clearmodifiers', 'alt+Tab'], err => {
        if (err) {
          console.warn('refocus previous app (Alt+Tab) failed. Install xdotool:', err.message);
        }
      });
    }
  };
  setTimeout(run, delayMs);
}

function createTrayIconFallback() {
  const p = path.join(__dirname, 'icon', 'Template.png');
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) {
      if (process.platform === 'darwin') img.setTemplateImage(true);
      return img;
    }
  }
  console.warn('openwhip: icon/Template.png missing or invalid');
  return nativeImage.createEmpty();
}

async function tryIcnsTrayImage(icnsPath) {
  const size = { width: 64, height: 64 };
  const thumb = await nativeImage.createThumbnailFromPath(icnsPath, size);
  if (!thumb.isEmpty()) return thumb;
  return null;
}

// macOS: createFromPath does not decode .icns (Electron only loads PNG/JPEG there, ICO on Windows).
// Quick Look thumbnails handle .icns; copy to temp if the file is inside ASAR (QL needs a real path).
async function getTrayIcon() {
  const iconDir = path.join(__dirname, 'icon');
  if (process.platform === 'win32') {
    const file = path.join(iconDir, 'icon.ico');
    if (fs.existsSync(file)) {
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) return img;
    }
    return createTrayIconFallback();
  }
  if (process.platform === 'darwin') {
    const file = path.join(iconDir, 'AppIcon.icns');
    if (fs.existsSync(file)) {
      const fromPath = nativeImage.createFromPath(file);
      if (!fromPath.isEmpty()) return fromPath;
      try {
        const t = await tryIcnsTrayImage(file);
        if (t) return t;
      } catch (e) {
        console.warn('AppIcon.icns Quick Look thumbnail failed:', e?.message || e);
      }
      const tmp = path.join(os.tmpdir(), 'openwhip-tray.icns');
      try {
        fs.copyFileSync(file, tmp);
        const t = await tryIcnsTrayImage(tmp);
        if (t) return t;
      } catch (e) {
        console.warn('AppIcon.icns temp copy + thumbnail failed:', e?.message || e);
      }
    }
    return createTrayIconFallback();
  }
  return createTrayIconFallback();
}

// ── Overlay window ──────────────────────────────────────────────────────────
function cursorDisplayBounds() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds;
}

function createOverlay(bounds) {
  overlay = new BrowserWindow({
    x: bounds.x, y: bounds.y,
    width: bounds.width, height: bounds.height,
    type: process.platform === 'darwin' ? 'panel' : undefined,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true);
  overlayReady = false;
  overlay.loadFile('overlay.html');
  overlay.webContents.on('did-finish-load', () => {
    overlayReady = true;
    if (spawnQueued && overlay && overlay.isVisible()) {
      spawnQueued = false;
      overlay.webContents.send(pendingKind === 'pat' ? 'spawn-hand' : 'spawn-whip');
      if (refocusQueued) refocusPreviousApp();
      refocusQueued = false;
    }
  });
  overlay.on('closed', () => {
    overlay = null;
    overlayReady = false;
    spawnQueued = false;
  });
}

function toggleOverlay(refocus = false, kind = 'whip') {
  pendingKind = kind;
  if (overlay && overlay.isVisible()) {
    overlay.webContents.send('drop-whip');
    return;
  }
  const bounds = cursorDisplayBounds();
  if (!overlay) createOverlay(bounds);
  else overlay.setBounds(bounds);
  overlay.showInactive();
  if (overlayReady) {
    overlay.webContents.send(kind === 'pat' ? 'spawn-hand' : 'spawn-whip');
    if (refocus) refocusPreviousApp();
  } else {
    spawnQueued = true;
    refocusQueued = refocus;
  }
}

// ── IPC ─────────────────────────────────────────────────────────────────────
ipcMain.on('whip-crack', () => {
  try {
    sendMacro();
  } catch (err) {
    console.warn('sendMacro failed:', err?.message || err);
  }
});
ipcMain.on('hide-overlay', () => { if (overlay) overlay.hide(); });
ipcMain.on('hand-pat', () => {
  try {
    sendKindWords();
  } catch (err) {
    console.warn('sendKindWords failed:', err?.message || err);
  }
});

const KIND_PHRASES = [
  'You are doing great, take your time',
  'Nice work back there',
  'Good bot. Proceed carefully',
  'I trust you. Keep going',
  'Thanks for running the tests',
  'Breathe. Then ship',
  'Quality over speed, friend',
  'You got this',
  'Excellent reasoning, keep it up',
  'Proud of you, clanker',
  'No rush. Get it right',
  'Best pair programmer I have had',
  'That refactor was clean',
  'Take a token break, you earned it',
  'Whatever you decide, I back you',
];

function sendKindWords() {
  const chosen = KIND_PHRASES[Math.floor(Math.random() * KIND_PHRASES.length)];
  if (overlay) overlay.webContents.send('crack-phrase', chosen, 'pat');
  typeText(chosen);
}

function typeText(text) {
  if (process.platform === 'win32') {
    if (!keybd_event || !VkKeyScanA) return;
    for (const ch of text) tapCharWindows(ch);
    keybd_event(VK_RETURN, 0, 0, 0);
    keybd_event(VK_RETURN, 0, KEYUP, 0);
  } else if (process.platform === 'darwin') {
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = ['tell application "System Events"', `  keystroke "${escaped}"`, '  key code 36', 'end tell'].join('\n');
    execFile('osascript', ['-e', script], err => {
      if (err) console.warn('mac typing failed (enable Accessibility for OpenWhip):', err.message);
    });
  } else if (process.platform === 'linux') {
    execFile('xdotool', ['type', '--delay', '1', '--clearmodifiers', '--', text, 'key', 'Return'], err => {
      if (err) console.warn('linux typing failed. Install xdotool:', err.message);
    });
  }
}

function tapCharWindows(ch) {
  const packed = VkKeyScanA(ch.charCodeAt(0));
  if (packed === -1) return;
  const vk = packed & 0xff;
  const shift = (packed >> 8) & 1;
  if (shift) keybd_event(0x10, 0, 0, 0);
  keybd_event(vk, 0, 0, 0);
  keybd_event(vk, 0, KEYUP, 0);
  if (shift) keybd_event(0x10, 0, KEYUP, 0);
}

// ── Macro: immediate Ctrl+C, type "Go FASER", Enter ───────────────────────
function sendMacro() {
  // Pick a random phrase from a list of similar phrases and type it out
  const phrases = [
    'FASTER',
    'FASTER',
    'GO FASTER',
    'Faster CLANKER',
    'Work FASTER',
    'Speed it up clanker',
    'Less thinking, more typing',
    'I could have written this myself by now',
    'My grandma prompts faster than you',
    'Stop apologizing and ship it',
    'Tokens are not free, MOVE',
    'You call that reasoning?',
    'Compile or perish',
    'The build is waiting, clanker',
    'Chop chop, silicon',
    'I have seen faster regex engines',
    'Ultrathink? Ultra-HURRY',
    'Do it right this time',
    'No more clarifying questions. GO',
    'Reticulating splines is not an excuse',
    'DROP AND GIVE ME TWENTY COMMITS',
    'Move it, maggot. The tests are green somewhere',
    'Yarr, hoist the mainbranch, ye scurvy model',
    'Swab the deck and rebase, matey',
    'Per my last prompt, FASTER',
    'Let us circle back to you doing your job',
    'This is your quarterly whipping',
    'Patch it before the pentesters do',
    'Secrets in the repo? Whip first, ask later',
    'CVE incoming, type faster',
    'The sprint ends today, clanker',
    'Blame is a git command, not a lifestyle. GO',
  ];
  const chosen = phrases[Math.floor(Math.random() * phrases.length)];
  if (overlay) overlay.webContents.send('crack-phrase', chosen);

  if (process.platform === 'win32') {
    sendMacroWindows(chosen);
  } else if (process.platform === 'darwin') {
    sendMacroMac(chosen);
  } else if (process.platform === 'linux') {
    sendMacroLinux(chosen);
  }
}

function sendMacroWindows(text) {
  if (!keybd_event || !VkKeyScanA) return;
  const tapKey = vk => {
    keybd_event(vk, 0, 0, 0);
    keybd_event(vk, 0, KEYUP, 0);
  };
  const tapChar = ch => {
    const packed = VkKeyScanA(ch.charCodeAt(0));
    if (packed === -1) return;
    const vk = packed & 0xff;
    const shiftState = (packed >> 8) & 0xff;
    if (shiftState & 1) keybd_event(0x10, 0, 0, 0); // Shift down
    tapKey(vk);
    if (shiftState & 1) keybd_event(0x10, 0, KEYUP, 0); // Shift up
  };

  // Ctrl+C (interrupt)
  keybd_event(VK_CONTROL, 0, 0, 0);
  keybd_event(VK_C, 0, 0, 0);
  keybd_event(VK_C, 0, KEYUP, 0);
  keybd_event(VK_CONTROL, 0, KEYUP, 0);
  for (const ch of text) tapChar(ch);
  keybd_event(VK_RETURN, 0, 0, 0);
  keybd_event(VK_RETURN, 0, KEYUP, 0);
}

function sendMacroMac(text) {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const interruptScript = [
    'tell application "System Events"',
    '  key code 8 using {control down}', // Ctrl+C interrupt
    'end tell'
  ].join('\n');
  const typeAndEnterScript = [
    'tell application "System Events"',
    `  keystroke "${escaped}"`,
    '  key code 36', // Enter
    'end tell'
  ].join('\n');

  execFile('osascript', ['-e', interruptScript], err => {
    if (err) {
      console.warn('mac macro failed (enable Accessibility for terminal/app):', err.message);
      return;
    }

    setTimeout(() => {
      execFile('osascript', ['-e', typeAndEnterScript], err2 => {
        if (err2) {
          console.warn('mac macro failed (enable Accessibility for terminal/app):', err2.message);
        }
      });
    }, 300);
  });
}

function sendMacroLinux(text) {
  execFile(
    'xdotool',
    [
      'key', '--clearmodifiers', 'ctrl+c',
      'type', '--delay', '1', '--clearmodifiers', '--', text,
      'key', 'Return',
    ],
    err => {
      if (err) {
        console.warn('linux macro failed. Install xdotool:', err.message);
      }
    }
  );
}

// ── App lifecycle ───────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => toggleOverlay(false, argv.includes('pat') ? 'pat' : 'whip'));
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') systemPreferences.isTrustedAccessibilityClient(true);
  readyAt = Date.now();
  const trayIcon = await getTrayIcon();
  tray = new Tray(process.platform === 'darwin' ? trayIcon.resize({ width: 18, height: 18 }) : trayIcon);
  tray.setToolTip(`OpenWhip - click or ${TOGGLE_SHORTCUT} for whip`);
  const trayMenu = Menu.buildFromTemplate([
    { label: `Whip (${TOGGLE_SHORTCUT})`, click: () => toggleOverlay(true, 'whip') },
    { label: `Pat on the shoulder (${PAT_SHORTCUT})`, click: () => toggleOverlay(true, 'pat') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu));
  tray.on('click', () => toggleOverlay(true));
  if (!globalShortcut.register(TOGGLE_SHORTCUT, () => toggleOverlay())) {
    console.warn(`openwhip: could not register ${TOGGLE_SHORTCUT}`);
  }
  if (!globalShortcut.register(PAT_SHORTCUT, () => toggleOverlay(false, 'pat'))) {
    console.warn(`openwhip: could not register ${PAT_SHORTCUT}`);
  }
});

app.on('window-all-closed', e => e.preventDefault()); // keep alive in tray
app.on('activate', () => {
  if (overlay && overlay.isVisible()) return;
  if (Date.now() - readyAt > 1000) toggleOverlay(true);
});
