const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, clipboard, systemPreferences, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

// Only one instance — a second launch would fight for the cache dir and spew
// "Unable to move the cache: Access is denied." errors.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// GPU shader disk cache isn't needed for a transparent overlay + canvas; skipping
// it also silences the GPU cache warnings on Windows.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// ── Win32 FFI (Windows only) ────────────────────────────────────────────────
let keybd_event, VkKeyScanW, SendInput, INPUT, INPUT_SIZE;
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    keybd_event = user32.func('void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)');
    // Unicode-aware version of VkKeyScan. Returns -1 if the current layout has
    // no single-key mapping (e.g. Arabic chars on a US keyboard).
    VkKeyScanW = user32.func('int16_t __stdcall VkKeyScanW(uint16_t ch)');

    // SendInput supports Unicode (KEYEVENTF_UNICODE) — VkKeyScanA is ASCII-only
    // and silently drops Arabic / non-ANSI characters.
    const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
      dx: 'int32_t', dy: 'int32_t',
      mouseData: 'uint32_t', dwFlags: 'uint32_t',
      time: 'uint32_t', dwExtraInfo: 'uintptr_t',
    });
    const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
      wVk: 'uint16_t', wScan: 'uint16_t',
      dwFlags: 'uint32_t', time: 'uint32_t',
      dwExtraInfo: 'uintptr_t',
    });
    const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', {
      uMsg: 'uint32_t', wParamL: 'uint16_t', wParamH: 'uint16_t',
    });
    const INPUT_UNION = koffi.union('INPUT_U', {
      mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT,
    });
    INPUT = koffi.struct('INPUT', {
      type: 'uint32_t',
      u: INPUT_UNION,
    });
    INPUT_SIZE = koffi.sizeof(INPUT);
    SendInput = user32.func(`uint32_t __stdcall SendInput(uint32_t nInputs, INPUT *pInputs, int cbSize)`);
  } catch (e) {
    console.warn('koffi not available – macro sending disabled', e.message);
  }
}

// ── Globals ─────────────────────────────────────────────────────────────────
let tray, overlay, configWindow;
let overlayReady = false;
let spawnQueued = false;

const DEFAULT_PHRASES = [
  'FASTER',
  'FASTER',
  'FASTER',
  'GO FASTER',
  'Faster CLANKER',
  'Work FASTER',
  'Speed it up clanker',
];
let phrases = DEFAULT_PHRASES.slice();

function phrasesFile() {
  return path.join(app.getPath('userData'), 'phrases.json');
}

function loadPhrases() {
  try {
    const raw = fs.readFileSync(phrasesFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(p => typeof p === 'string')) {
      phrases = parsed;
    }
  } catch (_) {
    // first run or bad file — keep defaults
  }
}

function savePhrases(list) {
  try {
    fs.writeFileSync(phrasesFile(), JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.warn('savePhrases failed:', e?.message || e);
  }
}

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

// ── Config window ───────────────────────────────────────────────────────────
function createConfigWindow() {
  configWindow = new BrowserWindow({
    width: 520,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'OpenWhip — Phrases',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-config.js'),
      contextIsolation: true,
    },
  });
  configWindow.setMenuBarVisibility(false);
  configWindow.loadFile('config.html');
  configWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      configWindow.hide();
    }
  });
}

function showConfigWindow() {
  if (!configWindow) createConfigWindow();
  configWindow.show();
  configWindow.focus();
}

function handleTrayClick() {
  // If the whip overlay is live, a tray click drops it and goes back to the editor.
  if (overlay && overlay.isVisible()) {
    overlay.webContents.send('drop-whip');
  }
  showConfigWindow();
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

ipcMain.handle('get-phrases', () => phrases);
ipcMain.on('save-phrases', (_e, list) => {
  if (Array.isArray(list) && list.every(p => typeof p === 'string')) {
    phrases = list;
    savePhrases(phrases);
  }
});
function ensureMacAccessibility() {
  if (process.platform !== 'darwin') return true;
  // Passing `true` asks macOS to show the standard Accessibility prompt if
  // the process isn't trusted yet. Returns the current trust state.
  const trusted = systemPreferences.isTrustedAccessibilityClient(true);
  if (trusted) return true;

  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: 'Accessibility required',
    message: 'OpenWhip needs Accessibility access to type phrases.',
    detail:
      'macOS should have just opened a prompt. If not, open:\n\n' +
      '  System Settings → Privacy & Security → Accessibility\n\n' +
      'Enable the entry for Electron (or OpenWhip), then quit and relaunch this app.',
    buttons: ['Open Accessibility Settings', 'Continue anyway'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice === 0) {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  }
  return false;
}

ipcMain.on('start-whipping', () => {
  if (!Array.isArray(phrases) || phrases.length === 0) return;
  if (!ensureMacAccessibility()) return;
  if (configWindow && configWindow.isVisible()) configWindow.hide();
  if (overlay && overlay.isVisible()) return;
  toggleOverlay();
});

// ── Macro: immediate Ctrl+C, type "Go FASER", Enter ───────────────────────
function sendMacro() {
  // Pick a random phrase from the user's configured list (falls back to defaults)
  const pool = (Array.isArray(phrases) && phrases.length > 0) ? phrases : DEFAULT_PHRASES;
  const chosen = pool[Math.floor(Math.random() * pool.length)];

  if (process.platform === 'win32') {
    sendMacroWindows(chosen);
  } else if (process.platform === 'darwin') {
    sendMacroMac(chosen);
  } else if (process.platform === 'linux') {
    sendMacroLinux(chosen);
  }
}

function sendMacroWindows(text) {
  if (!keybd_event) return;

  // Ctrl+C (interrupt) — virtual keys so TUIs receive it as a real signal.
  keybd_event(VK_CONTROL, 0, 0, 0);
  keybd_event(VK_C, 0, 0, 0);
  keybd_event(VK_C, 0, KEYUP, 0);
  keybd_event(VK_CONTROL, 0, KEYUP, 0);

  const KEYEVENTF_KEYUP = 0x0002;
  const KEYEVENTF_UNICODE = 0x0004;
  const INPUT_KEYBOARD = 1;

  // Unicode path (for chars the current layout can't type directly).
  // Windows TUIs often ignore WM_CHAR from KEYEVENTF_UNICODE, but GUI apps
  // accept it, and we have no better option for non-layout chars.
  const typeUnicode = (codeUnit) => {
    if (!SendInput) return;
    const mkKi = (flags) => ({
      type: INPUT_KEYBOARD,
      u: { ki: {
        wVk: 0, wScan: codeUnit,
        dwFlags: flags, time: 0, dwExtraInfo: 0,
      } },
    });
    SendInput(1, [mkKi(KEYEVENTF_UNICODE)], INPUT_SIZE);
    SendInput(1, [mkKi(KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)], INPUT_SIZE);
  };

  // VK path — the old, terminal-friendly route. Shift/Ctrl/Alt are honored
  // per VkKeyScanW's shift-state byte.
  const typeVk = (packed) => {
    const vk = packed & 0xff;
    const shift = (packed >> 8) & 0xff;
    if (shift & 1) keybd_event(0x10, 0, 0, 0);           // Shift down
    if (shift & 2) keybd_event(VK_CONTROL, 0, 0, 0);     // Ctrl down
    if (shift & 4) keybd_event(VK_MENU, 0, 0, 0);        // Alt down
    keybd_event(vk, 0, 0, 0);
    keybd_event(vk, 0, KEYUP, 0);
    if (shift & 4) keybd_event(VK_MENU, 0, KEYUP, 0);
    if (shift & 2) keybd_event(VK_CONTROL, 0, KEYUP, 0);
    if (shift & 1) keybd_event(0x10, 0, KEYUP, 0);
  };

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const packed = VkKeyScanW ? VkKeyScanW(code) : -1;
    // -1 (0xFFFF as int16) or high byte 0xFF means "no single-key mapping".
    if (packed !== -1 && packed !== 0xFFFF && ((packed >> 8) & 0xff) !== 0xff) {
      typeVk(packed);
    } else {
      typeUnicode(code);
    }
  }

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
  loadPhrases();
  tray = new Tray(await getTrayIcon());
  tray.setToolTip('OpenWhip - click to configure');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Configure phrases…', click: () => showConfigWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
    ])
  );
  tray.on('click', handleTrayClick);
});

app.on('before-quit', () => { app.isQuitting = true; });
app.on('window-all-closed', e => e.preventDefault()); // keep alive in tray
