const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const APP_SLUG = 'badclaude-and-codex';
app.setName(APP_SLUG);

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
const CODEX_APP_BUNDLE_ID = 'com.openai.codex';
const APPLE_TERMINAL_BUNDLE_ID = 'com.apple.Terminal';
const KNOWN_TERMINAL_BUNDLE_IDS = new Set([
  APPLE_TERMINAL_BUNDLE_ID,
  'com.googlecode.iterm2',
  'com.github.wez.wezterm',
  'com.mitchellh.ghostty',
  'dev.warp.Warp-Stable',
  'co.zeit.hyper',
]);

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
  console.warn(`${APP_SLUG}: icon/Template.png missing or invalid`);
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
      const tmp = path.join(os.tmpdir(), `${APP_SLUG}-tray.icns`);
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

function getRandomPhrase() {
  const phrases = [
    'FASTER',
    'FASTER',
    'FASTER',
    'GO FASTER',
    'Faster CLANKER',
    'Work FASTER',
    'Speed it up clanker',
  ];
  return phrases[Math.floor(Math.random() * phrases.length)];
}

function escapeAppleScriptString(text) {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function runAppleScript(script, cb) {
  execFile('osascript', ['-e', script], (err, stdout) => {
    cb(err, stdout ? stdout.trim() : '');
  });
}

function runAppleScriptJavaScript(script, cb) {
  execFile('osascript', ['-l', 'JavaScript', '-e', script], (err, stdout) => {
    cb(err, stdout ? stdout.trim() : '');
  });
}

function getFrontmostAppMac(cb) {
  const script = [
    'ObjC.import("AppKit");',
    'const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;',
    'JSON.stringify({',
    '  name: ObjC.unwrap(app.localizedName),',
    '  bundleId: ObjC.unwrap(app.bundleIdentifier)',
    '});',
  ].join('\n');

  runAppleScriptJavaScript(script, (err, stdout) => {
    if (err) return cb(err);
    try {
      cb(null, JSON.parse(stdout));
    } catch (parseErr) {
      cb(parseErr);
    }
  });
}

function getFrontWindowTitleMac(appName, cb) {
  const escapedName = escapeAppleScriptString(appName);
  const script = [
    'tell application "System Events"',
    `  tell process "${escapedName}"`,
    '    get name of front window',
    '  end tell',
    'end tell',
  ].join('\n');

  runAppleScript(script, (err, stdout) => {
    if (err) return cb(err);
    cb(null, stdout);
  });
}

function getFrontTerminalTtyMac(appInfo, cb) {
  if (appInfo.bundleId !== APPLE_TERMINAL_BUNDLE_ID) {
    cb(null, null);
    return;
  }

  const script = [
    'tell application "Terminal"',
    '  if not (exists front window) then return ""',
    '  get tty of selected tab of front window',
    'end tell',
  ].join('\n');

  runAppleScript(script, (err, stdout) => {
    if (err) return cb(err);
    cb(null, stdout || null);
  });
}

function isCodexCommandLine(text) {
  return /(^|[\\/ ])codex(\s|$)/i.test(text);
}

function isKnownTerminalApp(appInfo) {
  return KNOWN_TERMINAL_BUNDLE_IDS.has(appInfo.bundleId);
}

function titleLooksLikeCodexCli(title) {
  return /\bcodex\b/i.test(title || '');
}

function checkTtyForCodexMac(tty, cb) {
  if (!tty) {
    cb(null, false);
    return;
  }

  execFile('ps', ['-t', path.basename(tty), '-o', 'command='], (err, stdout) => {
    if (err) return cb(err);
    const isCodex = stdout
      .split('\n')
      .map(line => line.trim())
      .some(line => isCodexCommandLine(line));
    cb(null, isCodex);
  });
}

function detectCodexCliMac(appInfo, cb) {
  if (!isKnownTerminalApp(appInfo)) {
    cb(null, false);
    return;
  }

  getFrontTerminalTtyMac(appInfo, (ttyErr, tty) => {
    if (ttyErr) {
      console.warn('terminal tty lookup failed:', ttyErr.message);
    }

    const fallbackToTitle = () => {
      getFrontWindowTitleMac(appInfo.name, (titleErr, title) => {
        if (titleErr) return cb(titleErr);
        cb(null, titleLooksLikeCodexCli(title));
      });
    };

    if (!tty) {
      fallbackToTitle();
      return;
    }

    checkTtyForCodexMac(tty, (psErr, isCodex) => {
      if (psErr) {
        console.warn('tty codex detection failed:', psErr.message);
        fallbackToTitle();
        return;
      }

      if (isCodex) {
        cb(null, true);
        return;
      }

      fallbackToTitle();
    });
  });
}

// ── IPC ─────────────────────────────────────────────────────────────────────
function isTrustedOverlaySender(event) {
  if (!overlay || overlay.isDestroyed()) return false;
  const contents = overlay.webContents;
  return !!contents && !contents.isDestroyed() && event.sender === contents;
}

function guardOverlayEvent(event, channel) {
  if (isTrustedOverlaySender(event)) return true;
  console.warn(`Ignoring ${channel} from unexpected renderer`);
  return false;
}

ipcMain.on('whip-crack', event => {
  if (!guardOverlayEvent(event, 'whip-crack')) return;
  try {
    sendMacro();
  } catch (err) {
    console.warn('sendMacro failed:', err?.message || err);
  }
});
ipcMain.on('hide-overlay', event => {
  if (!guardOverlayEvent(event, 'hide-overlay')) return;
  if (overlay) overlay.hide();
});

// ── Macro: immediate Ctrl+C, type "Go FASER", Enter ───────────────────────
function sendMacro() {
  const chosen = getRandomPhrase();

  if (process.platform === 'win32') {
    sendMacroWindows(chosen);
  } else if (process.platform === 'darwin') {
    sendMacroMac(chosen);
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

function sendTextAndSubmitMac(text) {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = [
    'tell application "System Events"',
    '  delay 0.03',
    `  keystroke "${escaped}"`,
    '  key code 36', // Enter
    'end tell'
  ].join('\n');

  execFile('osascript', ['-e', script], err => {
    if (err) {
      console.warn('mac macro failed (enable Accessibility for terminal/app):', err.message);
    }
  });
}

function sendTextAndCodexSteerMac(text) {
  const escaped = escapeAppleScriptString(text);
  const script = [
    'tell application "System Events"',
    '  delay 0.03',
    `  keystroke "${escaped}"`,
    '  key code 36 using {command down}', // Cmd+Enter steers when follow-up behavior defaults to queue
    'end tell'
  ].join('\n');

  runAppleScript(script, err => {
    if (err) {
      console.warn('codex steer macro failed (enable Accessibility for terminal/app):', err.message);
    }
  });
}

function sendInterruptAndSubmitMac(text) {
  const escaped = escapeAppleScriptString(text);
  const script = [
    'tell application "System Events"',
    '  key code 8 using {command down}', // Cmd+C
    '  delay 0.03',
    `  keystroke "${escaped}"`,
    '  key code 36', // Enter
    'end tell'
  ].join('\n');

  runAppleScript(script, err => {
    if (err) {
      console.warn('mac macro failed (enable Accessibility for terminal/app):', err.message);
    }
  });
}

function sendMacroMac(text) {
  getFrontmostAppMac((frontErr, appInfo) => {
    if (frontErr || !appInfo) {
      console.warn('frontmost app lookup failed, using legacy macro:', frontErr?.message || frontErr);
      sendInterruptAndSubmitMac(text);
      return;
    }

    if (appInfo.bundleId === CODEX_APP_BUNDLE_ID) {
      sendTextAndCodexSteerMac(text);
      return;
    }

    detectCodexCliMac(appInfo, (detectErr, isCodexCli) => {
      if (detectErr) {
        console.warn('codex cli detection failed, using legacy macro:', detectErr.message);
        sendInterruptAndSubmitMac(text);
        return;
      }

      if (isCodexCli) {
        sendTextAndSubmitMac(text);
        return;
      }

      sendInterruptAndSubmitMac(text);
    });
  });
}

// ── App lifecycle ───────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  tray = new Tray(await getTrayIcon());
  tray.setToolTip('Bad Claude – click for whip');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Quit', click: () => app.quit() },
    ])
  );
  tray.on('click', toggleOverlay);
});

app.on('window-all-closed', e => e.preventDefault()); // keep alive in tray
