const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const linuxSessionType = process.platform === 'linux'
  ? ((process.env.XDG_SESSION_TYPE || '').toLowerCase() || (process.env.WAYLAND_DISPLAY ? 'wayland' : (process.env.DISPLAY ? 'x11' : 'unknown')))
  : 'unsupported';
const initialLinuxDesktop = process.platform === 'linux'
  ? `${process.env.XDG_CURRENT_DESKTOP || ''}:${process.env.DESKTOP_SESSION || ''}`.toLowerCase()
  : '';
const preferLinuxX11 = process.platform === 'linux'
  && linuxSessionType === 'wayland'
  && Boolean(process.env.DISPLAY)
  && !initialLinuxDesktop.includes('gnome');
const linuxOzonePlatformHint = process.platform === 'linux'
  ? (process.env.ELECTRON_OZONE_PLATFORM_HINT || '').trim()
  : '';
const hasExplicitLinuxOzonePlatform = process.platform === 'linux'
  && (Boolean(linuxOzonePlatformHint) || app.commandLine.hasSwitch('ozone-platform'));
const forceLinuxX11 = preferLinuxX11 && !hasExplicitLinuxOzonePlatform;

if (process.platform === 'linux') {
  app.disableHardwareAcceleration();
  if (forceLinuxX11) {
    app.commandLine.appendSwitch('ozone-platform', 'x11');
  }
  app.commandLine.appendSwitch('enable-transparent-visuals');
}

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
let tray, overlay, launcher;
let overlayReady = false;
let spawnQueued = false;
const linuxDesktop = initialLinuxDesktop;
const linuxState = {
  sessionType: detectLinuxSessionType(),
  prefersX11: forceLinuxX11,
  automationBackend: 'none',
  usesOverlayFallback: process.env.BADCLAUDE_OPAQUE_OVERLAY === '1',
  needsLauncher: linuxDesktop.includes('gnome'),
  previousWindowId: null,
  warned: new Set(),
};

const VK_CONTROL = 0x11;
const VK_RETURN  = 0x0D;
const VK_C       = 0x43;
const VK_MENU    = 0x12; // Alt
const VK_TAB     = 0x09;
const KEYUP      = 0x0002;

function detectLinuxSessionType() {
  if (process.platform !== 'linux') return 'unsupported';
  if (forceLinuxX11) return 'x11';
  const session = (process.env.XDG_SESSION_TYPE || '').toLowerCase();
  if (session === 'wayland' || session === 'x11') return session;
  if (process.env.WAYLAND_DISPLAY) return 'wayland';
  if (process.env.DISPLAY) return 'x11';
  return 'unknown';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatCommandError(err) {
  const stderr = err?.stderr?.toString().trim();
  if (stderr) return stderr;
  return err?.message || String(err);
}

function warnOnce(key, message) {
  if (linuxState.warned.has(key)) return;
  linuxState.warned.add(key);
  console.warn(message);
}

async function execFileChecked(file, args, options = {}) {
  return execFileAsync(file, args, {
    timeout: 2500,
    windowsHide: true,
    ...options,
  });
}

async function detectLinuxAutomationBackend() {
  if (process.platform !== 'linux' || !process.env.DISPLAY) {
    return 'none';
  }
  try {
    const { stdout } = await execFileChecked('xdotool', ['getactivewindow']);
    if (stdout.trim()) return 'xdotool';
  } catch {
    return 'none';
  }
  return 'none';
}

async function detectLinuxNeedsLauncher() {
  if (process.platform !== 'linux' || !linuxDesktop.includes('gnome')) {
    return false;
  }

  try {
    const { stdout } = await execFileChecked('gsettings', ['get', 'org.gnome.shell', 'enabled-extensions']);
    const enabled = stdout.toLowerCase();
    const hasTrayExtension = enabled.includes('appindicator')
      || enabled.includes('kstatusnotifier')
      || enabled.includes('trayicons');
    return !hasTrayExtension;
  } catch {
    return true;
  }
}

async function refreshLinuxAutomationBackend() {
  if (process.platform !== 'linux') return 'none';
  linuxState.sessionType = detectLinuxSessionType();
  linuxState.automationBackend = await detectLinuxAutomationBackend();
  return linuxState.automationBackend;
}

async function capturePreviousAppContext() {
  if (process.platform !== 'linux') return;
  linuxState.previousWindowId = null;
  if (linuxState.automationBackend === 'none') {
    await refreshLinuxAutomationBackend();
  }
  if (linuxState.automationBackend !== 'xdotool') return;
  try {
    const { stdout } = await execFileChecked('xdotool', ['getactivewindow']);
    const windowId = stdout.trim();
    if (windowId) linuxState.previousWindowId = windowId;
  } catch (err) {
    warnOnce('linux-window-capture', `badclaude: could not capture the previous Linux window: ${formatCommandError(err)}`);
  }
}

async function activateLinuxWindow(windowId) {
  if (!windowId) return;
  await execFileChecked('xdotool', ['windowactivate', '--sync', windowId]);
}

async function sendMacroLinux(text) {
  if (linuxState.automationBackend === 'none') {
    await refreshLinuxAutomationBackend();
  }

  if (linuxState.automationBackend !== 'xdotool') {
    const message = linuxState.sessionType === 'wayland'
      ? 'badclaude: Linux automation is unavailable on this Wayland session. The overlay still works, but full whip mode needs X11/xdotool.'
      : 'badclaude: Linux automation is unavailable because xdotool could not be used in this session.';
    warnOnce('linux-automation-unavailable', message);
    return;
  }

  if (!linuxState.previousWindowId) {
    warnOnce('linux-no-target-window', 'badclaude: no previous Linux window was captured, so the whip macro was skipped.');
    return;
  }

  try {
    await activateLinuxWindow(linuxState.previousWindowId);
    await sleep(40);
    await execFileChecked('xdotool', ['key', '--clearmodifiers', '--window', linuxState.previousWindowId, 'ctrl+c']);
    await sleep(30);
    await execFileChecked('xdotool', ['type', '--delay', '1', '--clearmodifiers', '--window', linuxState.previousWindowId, text]);
    await sleep(30);
    await execFileChecked('xdotool', ['key', '--clearmodifiers', '--window', linuxState.previousWindowId, 'Return']);
  } catch (err) {
    warnOnce('linux-macro-failed', `badclaude: Linux whip macro failed: ${formatCommandError(err)}`);
  }
}

async function initializeLinuxSupport() {
  if (process.platform !== 'linux') return;
  await refreshLinuxAutomationBackend();
  linuxState.needsLauncher = await detectLinuxNeedsLauncher();
  console.log(`badclaude: linux session=${linuxSessionType}, windowing=${linuxState.sessionType}, automation=${linuxState.automationBackend}`);
  if (linuxState.prefersX11) {
    console.log('badclaude: forcing Electron onto X11/XWayland so the overlay can render on Wayland desktops that expose DISPLAY.');
  }
  if (linuxSessionType === 'wayland' && !linuxState.prefersX11) {
    console.log('badclaude: keeping native Wayland on this desktop so the overlay can stay compositor-native.');
  }
  if (linuxState.needsLauncher) {
    console.log('badclaude: GNOME detected, enabling the floating launcher because tray icons are often hidden.');
    console.log('badclaude: for a more integrated tray experience on GNOME, install/enable the "AppIndicator and KStatusNotifierItem Support" extension.');
  }
}

/** One Alt+Tab / Cmd+Tab so focus returns to the previously active app after tray click. */
async function refocusPreviousApp() {
  await sleep(80);
  if (process.platform === 'win32') {
    if (!keybd_event) return;
    keybd_event(VK_MENU, 0, 0, 0);
    keybd_event(VK_TAB, 0, 0, 0);
    keybd_event(VK_TAB, 0, KEYUP, 0);
    keybd_event(VK_MENU, 0, KEYUP, 0);
    return;
  }
  if (process.platform === 'darwin') {
    const script = [
      'tell application "System Events"',
      '  key down command',
      '  key code 48', // Tab
      '  key up command',
      'end tell',
    ].join('\n');
    try {
      await execFileChecked('osascript', ['-e', script]);
    } catch (err) {
      console.warn('refocus previous app (Cmd+Tab) failed:', formatCommandError(err));
    }
    return;
  }
  if (process.platform === 'linux') {
    if (linuxState.automationBackend === 'none') {
      await refreshLinuxAutomationBackend();
    }
    if (linuxState.automationBackend !== 'xdotool' || !linuxState.previousWindowId) {
      if (linuxState.sessionType === 'wayland') {
        warnOnce('linux-refocus-unavailable', 'badclaude: Linux focus restore is limited on Wayland, so the overlay may stay in front until you click away.');
      }
      return;
    }
    try {
      await activateLinuxWindow(linuxState.previousWindowId);
    } catch (err) {
      warnOnce('linux-refocus-failed', `badclaude: could not refocus the previous Linux window: ${formatCommandError(err)}`);
    }
  }
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

// ── Overlay window ──────────────────────────────────────────────────────────
function createOverlay() {
  const { bounds } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const useLinuxOverlayFallback = process.platform === 'linux' && linuxState.usesOverlayFallback;
  overlay = new BrowserWindow({
    x: bounds.x, y: bounds.y,
    width: bounds.width, height: bounds.height,
    show: false,
    transparent: !useLinuxOverlayFallback,
    backgroundColor: useLinuxOverlayFallback ? '#12000000' : '#00ffffff',
    frame: false,
    alwaysOnTop: true,
    focusable: useLinuxOverlayFallback,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setFullScreenable(false);
  if (useLinuxOverlayFallback) {
    overlay.setOpacity(0.985);
  }
  overlayReady = false;
  overlay.loadFile('overlay.html');
  overlay.once('ready-to-show', () => {
    if (overlay && !overlay.isVisible()) {
      overlay.show();
    }
  });
  overlay.webContents.on('did-finish-load', () => {
    overlayReady = true;
    if (process.platform === 'linux') {
      overlay.webContents.send('set-linux-overlay-mode', {
        fallback: useLinuxOverlayFallback,
      });
    }
    if (spawnQueued && overlay && overlay.isVisible()) {
      spawnQueued = false;
      overlay.webContents.send('spawn-whip');
      void refocusPreviousApp();
    }
  });
  overlay.on('closed', () => {
    overlay = null;
    overlayReady = false;
    spawnQueued = false;
  });
}

function createLauncherWindow() {
  if (process.platform !== 'linux' || !linuxState.needsLauncher || launcher) return;
  const workArea = screen.getPrimaryDisplay().workArea;
  launcher = new BrowserWindow({
    x: workArea.x + workArea.width - 122,
    y: workArea.y + 18,
    width: 104,
    height: 132,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'badclaude launcher',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  launcher.setAlwaysOnTop(true, 'floating');
  launcher.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  launcher.removeMenu();
  launcher.loadFile('launcher.html');
  launcher.once('ready-to-show', () => {
    launcher?.show();
  });
  launcher.on('closed', () => {
    launcher = null;
  });
}

function showLauncherWindow() {
  createLauncherWindow();
  if (!launcher) return;
  launcher.show();
  launcher.moveTop();
  launcher.focus();
}

function hideLauncherWindow() {
  launcher?.hide();
}

async function toggleOverlay() {
  if (overlay && overlay.isVisible()) {
    overlay.webContents.send('drop-whip');
    return;
  }
  await capturePreviousAppContext();
  if (!overlay) createOverlay();
  overlay.show();
  overlay.moveTop();
  if (process.platform === 'linux' && linuxState.usesOverlayFallback) {
    overlay.focus();
  }
  if (overlayReady) {
    overlay.webContents.send('spawn-whip');
    void refocusPreviousApp();
  } else {
    spawnQueued = true;
  }
}

// ── IPC ─────────────────────────────────────────────────────────────────────
ipcMain.on('whip-crack', () => {
  void sendMacro().catch(err => {
    console.warn('sendMacro failed:', err?.message || err);
  });
});
ipcMain.on('hide-overlay', () => { if (overlay) overlay.hide(); });
ipcMain.on('toggle-overlay', () => {
  void toggleOverlay();
});
ipcMain.on('quit-app', () => {
  app.quit();
});

// ── Macro: immediate Ctrl+C, type "Go FASER", Enter ───────────────────────
async function sendMacro() {
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
    await sendMacroMac(chosen);
  } else if (process.platform === 'linux') {
    await sendMacroLinux(chosen);
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

async function sendMacroMac(text) {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = [
    'tell application "System Events"',
    '  key code 8 using {command down}', // Cmd+C
    '  delay 0.03',
    `  keystroke "${escaped}"`,
    '  key code 36', // Enter
    'end tell'
  ].join('\n');

  try {
    await execFileChecked('osascript', ['-e', script]);
  } catch (err) {
    console.warn('mac macro failed (enable Accessibility for terminal/app):', formatCommandError(err));
  }
}

// ── App lifecycle ───────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  await initializeLinuxSupport();
  tray = new Tray(await getTrayIcon());
  tray.setToolTip('Bad Claude – click for whip');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Whip', click: () => void toggleOverlay() },
      { type: 'separator' },
      { label: 'Show Launcher', click: () => showLauncherWindow() },
      { label: 'Hide Launcher', click: () => hideLauncherWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
  tray.on('click', () => {
    void toggleOverlay();
  });
  createLauncherWindow();
});

app.on('window-all-closed', e => e.preventDefault()); // keep alive in tray
