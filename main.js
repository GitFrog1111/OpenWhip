const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  screen,
  shell,
  dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { createInputDriver } = require('./lib/input-executor');
const { createAgentRuntime, createTrayMenuTemplate } = require('./lib/agent-runtime');

// ── Win32 FFI (Windows only) ────────────────────────────────────────────────
let keybd_event, SendInput, inputSize;
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
      dx: 'long',
      dy: 'long',
      mouseData: 'uint32_t',
      dwFlags: 'uint32_t',
      time: 'uint32_t',
      dwExtraInfo: 'uintptr_t',
    });
    const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
      wVk: 'uint16_t',
      wScan: 'uint16_t',
      dwFlags: 'uint32_t',
      time: 'uint32_t',
      dwExtraInfo: 'uintptr_t',
    });
    const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', {
      uMsg: 'uint32_t',
      wParamL: 'uint16_t',
      wParamH: 'uint16_t',
    });
    const INPUT = koffi.struct('INPUT', {
      type: 'uint32_t',
      u: koffi.union({
        mi: MOUSEINPUT,
        ki: KEYBDINPUT,
        hi: HARDWAREINPUT,
      }),
    });
    keybd_event = user32.func('void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)');
    SendInput = user32.func('unsigned int __stdcall SendInput(unsigned int cInputs, INPUT *pInputs, int cbSize)');
    inputSize = koffi.sizeof(INPUT);
  } catch (e) {
    console.warn('koffi not available – macro sending disabled', e.message);
  }
}

// ── Globals ─────────────────────────────────────────────────────────────────
let tray, overlay, agentRuntime;
let overlayReady = false;
let spawnQueued = false;

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
  void executeActiveProfile().catch(error => {
    showError('Whip action failed', error);
  });
});
ipcMain.on('hide-overlay', () => { if (overlay) overlay.hide(); });

// ── Agent profile execution ─────────────────────────────────────────────────
function showError(title, error) {
  const message = error?.message || String(error);
  console.warn(`${title}:`, message);
  if (app.isReady()) dialog.showErrorBox(title, message);
}

function createProductionInputDriver() {
  return {
    execute(steps, message) {
      const driver = createInputDriver(process.platform, {
        execFile,
        keybdEvent: keybd_event,
        sendInput(count, events, size) {
          return SendInput(count, events.map(event => ({
            type: event.type,
            u: { ki: event.ki },
          })), size);
        },
        inputSize,
      });
      return driver.execute(steps, message);
    },
  };
}

async function executeActiveProfile() {
  if (!agentRuntime) throw new Error('Agent profiles are not ready');
  await agentRuntime.executeActiveProfile();
}

function runMenuAction(title, action, rebuildAfterward = false) {
  void Promise.resolve()
    .then(action)
    .then(() => {
      if (rebuildAfterward) rebuildTrayMenu();
    })
    .catch(error => {
      showError(title, error);
      if (rebuildAfterward) rebuildTrayMenu();
    });
}

function rebuildTrayMenu() {
  if (!tray || !agentRuntime) return;
  const template = createTrayMenuTemplate(agentRuntime, {
    selectProfile(profileId) {
      runMenuAction(
        'Unable to select target agent',
        () => agentRuntime.selectProfile(profileId),
        true,
      );
    },
    openProfileConfig() {
      runMenuAction('Unable to open profile config', () => agentRuntime.openProfileConfig());
    },
    reloadProfiles() {
      runMenuAction('Unable to reload profiles', () => agentRuntime.reloadProfiles(), true);
    },
    quit() {
      app.quit();
    },
  });
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

// ── App lifecycle ───────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  agentRuntime = createAgentRuntime({
    userDataPath: app.getPath('userData'),
    platform: process.platform,
    driver: createProductionInputDriver(),
    openPath: filePath => shell.openPath(filePath),
  });
  try {
    await agentRuntime.initialize();
  } catch (error) {
    showError('Unable to load agent profiles', error);
  }

  tray = new Tray(await getTrayIcon());
  tray.setToolTip('OpenWhip - click for whip');
  rebuildTrayMenu();
  tray.on('click', toggleOverlay);
});

app.on('window-all-closed', e => e.preventDefault()); // keep alive in tray
