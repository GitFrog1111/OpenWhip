const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

// ── Mode registry ───────────────────────────────────────────────────────────
const modes = require('./modes');

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
let trayMenu = null;
let overlayReady = false;
let spawnQueued = false;
let queuedActionId = null;

// Active mode tracking
let activeMode = modes.find(m => m.enabledByDefault) || modes[0];

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
  console.warn('badclaude: icon/Template.png missing or invalid');
  return nativeImage.createEmpty();
}

async function tryIcnsTrayImage(icnsPath) {
  const size = { width: 64, height: 64 };
  const thumb = await nativeImage.createThumbnailFromPath(icnsPath, size);
  if (!thumb.isEmpty()) return thumb;
  return null;
}

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
      const tmp = path.join(os.tmpdir(), 'badclaude-tray.icns');
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

// ── Animation injection ─────────────────────────────────────────────────────
const animFileCache = {};

function getAnimCode(modeId) {
  if (animFileCache[modeId]) return animFileCache[modeId];
  const animPath = path.join(__dirname, 'modes', `${modeId}.anim.js`);
  if (fs.existsSync(animPath)) {
    animFileCache[modeId] = fs.readFileSync(animPath, 'utf-8');
    return animFileCache[modeId];
  }
  return null;
}

function injectAnimations() {
  if (!overlay || !overlayReady) return;
  // Inject animation code for the active mode (if it has an anim file)
  const code = getAnimCode(activeMode.id);
  if (code) {
    overlay.webContents.executeJavaScript(code).catch(err => {
      console.warn(`Failed to inject ${activeMode.id} animations:`, err.message);
    });
  }
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
    // Inject animation code for active mode
    injectAnimations();
    if (spawnQueued && overlay && overlay.isVisible()) {
      spawnQueued = false;
      const actionId = queuedActionId || activeMode.actions[0].id;
      queuedActionId = null;
      overlay.webContents.send('spawn-action', actionId);
      refocusPreviousApp();
    }
  });
  overlay.on('closed', () => {
    overlay = null;
    overlayReady = false;
    spawnQueued = false;
    queuedActionId = null;
  });
}

function triggerAction(actionId) {
  if (overlay && overlay.isVisible()) {
    // Re-inject animations in case mode changed, then re-spawn
    injectAnimations();
    overlay.webContents.send('spawn-action', actionId);
    refocusPreviousApp();
    return;
  }
  if (!overlay) createOverlay();
  overlay.show();
  if (overlayReady) {
    // Re-inject animations in case mode changed since last load
    injectAnimations();
    overlay.webContents.send('spawn-action', actionId);
    refocusPreviousApp();
  } else {
    spawnQueued = true;
    queuedActionId = actionId;
  }
}

function handleTrayClick() {
  triggerAction(activeMode.actions[0].id);
}

// ── IPC ─────────────────────────────────────────────────────────────────────
ipcMain.on('action-triggered', (_event, actionId) => {
  try {
    // Find the action definition across all modes
    let action = null;
    for (const mode of modes) {
      action = mode.actions.find(a => a.id === actionId);
      if (action) break;
    }
    if (!action) {
      console.warn('Unknown action:', actionId);
      return;
    }
    sendMacro(action);
  } catch (err) {
    console.warn('sendMacro failed:', err?.message || err);
  }
});

// Legacy whip-crack handler (backward compat with existing overlay whip code)
ipcMain.on('whip-crack', () => {
  try {
    const whipMode = modes.find(m => m.id === 'whip');
    if (whipMode) {
      sendMacro(whipMode.actions[0]);
    }
  } catch (err) {
    console.warn('sendMacro failed:', err?.message || err);
  }
});

ipcMain.on('hide-overlay', () => { if (overlay) overlay.hide(); });

// ── Macro: send text to active terminal ─────────────────────────────────────
function sendMacro(action) {
  const phrases = action.phrases || [];
  if (!phrases.length) return;
  const chosen = phrases[Math.floor(Math.random() * phrases.length)];
  const doInterrupt = action.interrupt !== false;

  if (process.platform === 'win32') {
    sendMacroWindows(chosen, doInterrupt);
  } else if (process.platform === 'darwin') {
    sendMacroMac(chosen, doInterrupt);
  }
}

function sendMacroWindows(text, doInterrupt = true) {
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

  if (doInterrupt) {
    // Ctrl+C (interrupt)
    keybd_event(VK_CONTROL, 0, 0, 0);
    keybd_event(VK_C, 0, 0, 0);
    keybd_event(VK_C, 0, KEYUP, 0);
    keybd_event(VK_CONTROL, 0, KEYUP, 0);
  }
  for (const ch of text) tapChar(ch);
  keybd_event(VK_RETURN, 0, 0, 0);
  keybd_event(VK_RETURN, 0, KEYUP, 0);
}

function sendMacroMac(text, doInterrupt = true) {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines = [
    'tell application "System Events"',
  ];
  if (doInterrupt) {
    lines.push('  key code 8 using {command down}'); // Cmd+C
    lines.push('  delay 0.03');
  }
  lines.push(`  keystroke "${escaped}"`);
  lines.push('  key code 36'); // Enter
  lines.push('end tell');
  const script = lines.join('\n');

  execFile('osascript', ['-e', script], err => {
    if (err) {
      console.warn('mac macro failed (enable Accessibility for terminal/app):', err.message);
    }
  });
}

// ── Hotkey management ───────────────────────────────────────────────────────
function registerHotkeys() {
  // Unregister all first
  globalShortcut.unregisterAll();

  // Register hotkeys for the active mode's actions
  for (const action of activeMode.actions) {
    if (action.hotkey) {
      const registered = globalShortcut.register(action.hotkey, () => {
        triggerAction(action.id);
      });
      if (!registered) {
        console.warn(`Failed to register hotkey ${action.hotkey} for ${action.id}`);
      }
    }
  }
}

function switchMode(modeId) {
  const mode = modes.find(m => m.id === modeId);
  if (!mode) return;
  activeMode = mode;
  registerHotkeys();
  rebuildTrayMenu();
}

// ── Tray menu ───────────────────────────────────────────────────────────────
function rebuildTrayMenu() {
  if (!tray) return;

  const template = [];

  // Mode selection (radio buttons)
  template.push({ label: 'Mode', enabled: false });
  for (const mode of modes) {
    template.push({
      label: mode.name,
      type: 'radio',
      checked: activeMode.id === mode.id,
      click: () => switchMode(mode.id),
    });
  }

  // Separator
  template.push({ type: 'separator' });

  // Actions for active mode
  if (activeMode.actions.length > 1) {
    template.push({ label: `${activeMode.name} Actions`, enabled: false });
    for (const action of activeMode.actions) {
      const hotkeyLabel = action.hotkey ? ` (${action.hotkey.replace('CommandOrControl', '⌘').replace('+Shift+', '⇧')})` : '';
      template.push({
        label: `${action.label}${hotkeyLabel}`,
        click: () => triggerAction(action.id),
      });
    }
    template.push({ type: 'separator' });
  }

  template.push({ label: 'Quit', click: () => app.quit() });

  // Store menu for right-click popup — do NOT use setContextMenu (it hijacks left-click on macOS)
  trayMenu = Menu.buildFromTemplate(template);
}

// ── App lifecycle ───────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  tray = new Tray(await getTrayIcon());
  tray.setToolTip('Bad Claude – click to discipline');
  tray.on('click', handleTrayClick);
  tray.on('right-click', () => {
    if (trayMenu) tray.popUpContextMenu(trayMenu);
  });

  // Set up initial mode
  registerHotkeys();
  rebuildTrayMenu();
});

app.on('window-all-closed', e => e.preventDefault()); // keep alive in tray

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
