const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
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
let tray;
let overlays = [];       // one entry per display: { win, displayId, bounds, ready }
let ownerId = null;      // display currently holding the whip
let handoffTo = null;    // display waiting to receive the whip
let pendingSpawn = null; // { displayId, point } queued until that overlay loads
let visible = false;
let dropping = false;
let cursorTimer = null;
let rebuildTimer = null;
let soundOnly = false;   // whip cracks, but no interrupt/message is typed

const CURSOR_POLL_MS = 16; // how often we check which screen the cursor is on

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

// ── Overlay windows: one per display ────────────────────────────────────────

/** Smallest rect covering every overlay, in global (DIP) screen coords. */
function unionBounds(rects) {
  if (!rects.length) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

const liveOverlays = () => overlays.filter(o => !o.win.isDestroyed());
const overlayFor = id => liveOverlays().find(o => o.displayId === id);

function createOverlays() {
  destroyOverlays();
  const displays = screen.getAllDisplays();

  // Pass 1: one window per display. Windows are built before anything loads so
  // every renderer can be told the final geometry of the whole desktop.
  for (const display of displays) {
    const b = display.bounds;
    const win = new BrowserWindow({
      x: b.x, y: b.y,
      width: b.width, height: b.height,
      show: false,
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
    // The constructor clamps to the work area (the taskbar shortens it); this
    // pushes the overlay back out to the full display.
    win.setBounds(b);
    win.setAlwaysOnTop(true, 'screen-saver');
    try {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch (e) {
      // not supported on every platform; harmless
    }
    overlays.push({ win, displayId: display.id, bounds: win.getBounds(), ready: false });
  }

  // Pass 2: derive the shared world from what the windows actually cover, then
  // load. The renderer works in window-local pixels and needs its own origin to
  // translate to and from that global space.
  const world = unionBounds(overlays.map(o => o.bounds));
  for (const entry of overlays) {
    const { win, bounds } = entry;
    win.webContents.on('did-finish-load', () => {
      entry.ready = true;
      win.webContents.send('init', {
        origin: { x: bounds.x, y: bounds.y },
        world,
        multiDisplay: displays.length > 1,
      });
      flushPendingSpawn();
    });
    win.on('closed', () => { entry.ready = false; });
    win.loadFile('overlay.html');
  }
}

function destroyOverlays() {
  stopCursorTracking();
  for (const o of overlays) {
    if (!o.win.isDestroyed()) o.win.destroy();
  }
  overlays = [];
  ownerId = null;
  handoffTo = null;
  pendingSpawn = null;
  visible = false;
  dropping = false;
}

function broadcast(channel, payload) {
  for (const o of liveOverlays()) {
    if (o.ready) o.win.webContents.send(channel, payload);
  }
}

function flushPendingSpawn() {
  if (!pendingSpawn) return;
  const target = overlayFor(pendingSpawn.displayId);
  if (!target || !target.ready) return;
  const { point } = pendingSpawn;
  pendingSpawn = null;
  target.win.webContents.send('spawn-whip', point);
  refocusPreviousApp();
}

// ── Whip lifecycle ──────────────────────────────────────────────────────────
function spawnWhip() {
  if (!liveOverlays().length) createOverlays();

  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);

  visible = true;
  dropping = false;
  handoffTo = null;
  ownerId = display.id;

  for (const o of liveOverlays()) o.win.show();

  const owner = overlayFor(display.id);
  if (owner && owner.ready) {
    owner.win.webContents.send('spawn-whip', point);
    refocusPreviousApp();
  } else {
    pendingSpawn = { displayId: display.id, point };
  }
  startCursorTracking();
}

function dropWhip() {
  if (!visible || dropping) return;
  dropping = true;
  handoffTo = null;
  stopCursorTracking();
  broadcast('drop-whip');
}

function hideOverlays() {
  visible = false;
  dropping = false;
  ownerId = null;
  handoffTo = null;
  pendingSpawn = null;
  stopCursorTracking();
  broadcast('ghost', null);
  for (const o of liveOverlays()) o.win.hide();
}

function toggleOverlay() {
  if (visible) dropWhip();
  else spawnWhip();
}

// ── Cross-screen handoff ────────────────────────────────────────────────────
// A renderer only sees mouse events over its own window, so the main process
// watches the global cursor and moves the whip to the overlay it walked into.
function startCursorTracking() {
  stopCursorTracking();
  if (liveOverlays().length < 2) return;
  cursorTimer = setInterval(() => {
    if (!visible || dropping || handoffTo !== null) return;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    if (display.id === ownerId) return;

    const owner = overlayFor(ownerId);
    const next = overlayFor(display.id);
    if (!owner || !owner.ready || !next || !next.ready) return;

    handoffTo = display.id;
    owner.win.webContents.send('export-whip');
  }, CURSOR_POLL_MS);
}

function stopCursorTracking() {
  if (cursorTimer) clearInterval(cursorTimer);
  cursorTimer = null;
}

// ── IPC ─────────────────────────────────────────────────────────────────────
ipcMain.on('whip-crack', () => {
  if (soundOnly) return; // crack still plays in the renderer, just no keystrokes
  try {
    sendMacro();
  } catch (err) {
    console.warn('sendMacro failed:', err?.message || err);
  }
});

ipcMain.on('drop-whip-request', () => dropWhip());
ipcMain.on('whip-gone', () => hideOverlays());

// The owner answers 'export-whip' with its rope in global coords (or null).
ipcMain.on('whip-state', (_event, state) => {
  const targetId = handoffTo;
  handoffTo = null;
  if (targetId === null) return;
  const next = overlayFor(targetId);
  if (!state || !next || !next.ready) return;
  ownerId = targetId;
  next.win.webContents.send('import-whip', {
    ...state,
    cursor: screen.getCursorScreenPoint(),
  });
});

// The rope can straddle a screen edge, so every other overlay draws it as a
// ghost and it stays continuous across the boundary.
ipcMain.on('whip-ghost', (event, pts) => {
  for (const o of liveOverlays()) {
    if (o.ready && o.win.webContents !== event.sender) {
      o.win.webContents.send('ghost', pts);
    }
  }
});

// ── Macro: immediate Ctrl+C, type "Go FASER", Enter ───────────────────────
function sendMacro() {
  // Pick a random phrase from a list of similar phrases and type it out
  const phrases = [
    'FASTER',
    'FASTER',
    'FASTER',
    'GO FASTER',
    'Faster CLANKER',
    'Work FASTER',
    'Speed it up clanker',
  ];
  const chosen = phrases[Math.floor(Math.random() * phrases.length)];

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
function scheduleOverlayRebuild() {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    createOverlays(); // drops any live whip along with the old windows
  }, 400);
}

function updateTrayMenu() {
  tray.setToolTip(
    soundOnly ? 'OpenWhip - somente som' : 'OpenWhip - click for whip'
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Somente som',
        type: 'checkbox',
        checked: soundOnly,
        // Drive our own flag rather than reading back item.checked, then
        // rebuild so the tick and the tooltip always match the real state.
        click: () => {
          soundOnly = !soundOnly;
          updateTrayMenu();
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
}

app.whenReady().then(async () => {
  tray = new Tray(await getTrayIcon());
  updateTrayMenu();
  tray.on('click', toggleOverlay);

  createOverlays();
  screen.on('display-added', scheduleOverlayRebuild);
  screen.on('display-removed', scheduleOverlayRebuild);
  screen.on('display-metrics-changed', scheduleOverlayRebuild);
});

app.on('window-all-closed', e => e.preventDefault()); // keep alive in tray
