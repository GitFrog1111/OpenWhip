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
let tray, overlay;
let overlayReady = false;
let spawnQueued = false;

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
    let img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) {
      if (process.platform === 'darwin') {
        // Template.png has an opaque white background, which macOS draws as a solid square.
        // Turn darkness into alpha so only the whip strokes remain.
        const { width, height } = img.getSize();
        const bmp = img.toBitmap();
        for (let i = 0; i < bmp.length; i += 4) {
          const lum = (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3;
          // Cut off near-white so the source's faint rounded-square edge disappears.
          const ink = Math.max(0, 192 - lum) / 192;
          bmp[i + 3] = Math.round(ink * bmp[i + 3]);
          bmp[i] = bmp[i + 1] = bmp[i + 2] = 0;
        }
        img = nativeImage.createFromBitmap(bmp, { width, height });
        // 512px source is far taller than the menu bar; macOS clips or hides oversized items.
        img = img.resize({ width: 18, height: 18, quality: 'best' });
        img.setTemplateImage(true);
      }
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
    // The monochrome template fits the menu bar; the .icns path below yields a 64px thumbnail.
    const template = createTrayIconFallback();
    if (!template.isEmpty()) return template;
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
function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    x: bounds.x, y: bounds.y,
    width: bounds.width, height: bounds.height,
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
  overlayReady = false;
  overlay.loadFile('overlay.html');
  overlay.webContents.on('did-finish-load', () => {
    overlayReady = true;
    if (spawnQueued && overlay && overlay.isVisible()) {
      spawnQueued = false;
      overlay.webContents.send('spawn-whip');
      refocusPreviousApp();
    }
  });
  overlay.on('closed', () => {
    overlay = null;
    overlayReady = false;
    spawnQueued = false;
  });
}

function toggleOverlay() {
  if (overlay && overlay.isVisible()) {
    overlay.webContents.send('drop-whip');
    return;
  }
  if (!overlay) createOverlay();
  overlay.show();
  if (overlayReady) {
    overlay.webContents.send('spawn-whip');
    refocusPreviousApp();
  } else {
    spawnQueued = true;
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
app.whenReady().then(async () => {
  tray = new Tray(await getTrayIcon());
  tray.setToolTip('OpenWhip - click for whip');
  const menu = Menu.buildFromTemplate([
    { label: 'Quit', click: () => app.quit() },
  ]);
  if (process.platform === 'darwin') {
    // On macOS an attached context menu swallows left-clicks, so 'click' never fires.
    tray.on('right-click', () => tray.popUpContextMenu(menu));
  } else {
    tray.setContextMenu(menu);
  }
  tray.on('click', toggleOverlay);
});

app.on('window-all-closed', e => e.preventDefault()); // keep alive in tray
