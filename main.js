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

/**
 * sway: remember which window was focused when the whip spawned.
 *
 * Alt+Tab is the wrong tool under a tiling compositor - there is no
 * most-recently-used stack to walk. Worse, sway defaults to
 * focus_follows_mouse=yes, and cracking a whip means flinging the pointer across
 * the screen, so focus lands on whatever it passed over and the macro types
 * there. Recording the target up front and focusing it explicitly before typing
 * makes it deterministic no matter where the cursor ends up.
 */
let swayTargetConId = null;

/** True while a Wayland macro is running - see sendMacroWayland. */
let macroInFlight = false;
let lastMacroEndedAt = 0;

/**
 * Quiet period after a macro before another crack is accepted.
 *
 * overlay.html fires a crack whenever the whip tip exceeds crackSpeed, with only a
 * 200ms cooldown - and one flick of the wrist holds the tip above that threshold
 * for most of a second, so a single whip motion triggers several times. That used
 * to be invisible because the phrases merged into one prompt; once the Return
 * started registering properly it turned into several separate messages per whip.
 */
const MACRO_REFRACTORY_MS = 800;

function captureSwayFocus() {
  if (process.platform !== 'linux' || !process.env.WAYLAND_DISPLAY) return;
  execFile('swaymsg', ['-t', 'get_tree'], (err, stdout) => {
    if (err) return; // not sway (Hyprland, GNOME, ...) - fall back to whatever has focus
    try {
      const find = n =>
        n.focused
          ? n.id
          : [...(n.nodes || []), ...(n.floating_nodes || [])].reduce(
              (found, child) => found || find(child),
              null
            );
      swayTargetConId = find(JSON.parse(stdout));
    } catch {
      swayTargetConId = null;
    }
  });
}

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
    } else if (process.platform === 'linux' && !process.env.WAYLAND_DISPLAY) {
      // Skipped under Wayland: the tray lives in a layer-shell bar and the overlay
      // is focusable:false, so neither ever takes keyboard focus and there is
      // nothing to hand back. sway also has no MRU stack for Alt+Tab to walk.
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
  // Before anything is shown or the pointer starts moving, note who we are whipping.
  captureSwayFocus();
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
  // xdotool drives XTEST, which a wlroots compositor does not route to Wayland
  // clients - under sway it reaches XWayland windows and nothing else, so whipping
  // a Wayland-native terminal silently does nothing. wtype(1) speaks the
  // virtual-keyboard Wayland protocol, which does get through. Pick per session.
  if (process.env.WAYLAND_DISPLAY) {
    sendMacroWayland(text);
  } else {
    sendMacroX11(text);
  }
}

function sendMacroWayland(text) {
  // One macro is three wtype spawns plus a 120ms pause plus the refocus - well over
  // overlay.html's 200ms crack cooldown, so an enthusiastic whipper re-enters this
  // before the previous run has finished. Concurrent wtype invocations each create
  // their own virtual keyboard and interleave, which shows up as phrases running
  // together with no Enter between them and words truncated mid-word. Drop cracks
  // that arrive while one is still in flight rather than stacking them.
  if (macroInFlight || Date.now() - lastMacroEndedAt < MACRO_REFRACTORY_MS) return;
  macroInFlight = true;

  // The overlay is created with alwaysOnTop 'screen-saver', which Electron maps to
  // a layer-shell surface holding keyboard interactivity. While it is up, sway
  // routes the virtual keyboard to IT - not to the window sway still reports as
  // focused - so every keystroke vanishes into the whip. Dropping the surface for
  // the ~200ms the macro takes is what actually releases the keyboard; refocusing
  // alone is not enough. Put it straight back so the whip survives the crack.
  const wasVisible = Boolean(overlay && overlay.isVisible());
  let finished = false;
  let watchdog = null;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    if (wasVisible && overlay && !overlay.isDestroyed()) overlay.show();
    macroInFlight = false;
    lastMacroEndedAt = Date.now();
  };
  // Belt and braces: if wtype ever wedges, this stops one stuck run from leaving
  // the whip permanently unable to crack again.
  watchdog = setTimeout(finish, 3000);
  if (wasVisible) overlay.hide();

  const run = (args, next) =>
    execFile('wtype', args, err => {
      if (err) {
        console.warn('wayland macro failed. Install wtype:', err.message);
        finish();
        return;
      }
      if (next) next();
    });

  // Text goes after `--` so a phrase starting with `-` is never read as an option,
  // and through execFile's argv so there is no shell quoting to get wrong.
  //
  // 120 lets the interrupted TUI redraw its prompt before we type into it, and 150
  // keeps the Return out of the typing burst so a terminal implementing bracketed
  // paste reads it as a keypress rather than a pasted line break.
  //
  // Both are empirical. Raising them does NOT make this more reliable - that was
  // measured, not assumed. Whether the Return submits turns out to depend mostly on
  // what the target app is doing at that instant: it lands reliably against an idle
  // prompt, and unreliably against one that is mid-render or streaming output, where
  // the phrase types in but the newline does not submit and the next crack's text
  // piles in behind it. That is a property of the target, not a constant to tune, so
  // these are deliberately back at the lowest values that worked.
  // Ctrl+C, and it has to be Ctrl+C. Escape was tried and is worse: it does not
  // interrupt, so anything typed during a running operation queues up behind it and
  // arrives as one batch. The interrupt is not incidental here - it is what returns
  // the target to an idle prompt, which is the state where the Return actually
  // submits. No interrupt, no submit.
  const whip = () =>
    run(['-M', 'ctrl', '-k', 'c', '-m', 'ctrl'], () =>
      setTimeout(
        () =>
          run(['-d', '12', '--', text], () =>
            setTimeout(() => run(['-k', 'Return'], finish), 150)
          ),
        120
      )
    );

  // Hand focus back to whoever we are whipping. Without this the keystrokes follow
  // the pointer under focus_follows_mouse and land in whichever window it crossed.
  if (swayTargetConId != null) {
    execFile('swaymsg', [`[con_id=${swayTargetConId}]`, 'focus'], () =>
      setTimeout(whip, 40)
    );
  } else {
    whip();
  }
}

function sendMacroX11(text) {
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
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Quit', click: () => app.quit() },
    ])
  );
  tray.on('click', toggleOverlay);
});

app.on('window-all-closed', e => e.preventDefault()); // keep alive in tray
