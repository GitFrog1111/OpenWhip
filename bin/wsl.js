// ── WSL2 support ────────────────────────────────────────────────────────────
// Linux Electron under WSLg gets no system tray, and xdotool can't type into
// Windows apps (e.g. Windows Terminal running claude). So on WSL we run the
// Windows build of Electron instead: app files are synced to
// %LOCALAPPDATA%\openwhip and Windows deps are installed there on first run.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');

const APP_FILES = ['main.js', 'preload.js', 'overlay.html', 'sounds', 'icon'];

function isWSL() {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function windowsInstallDir() {
  // stderr ignored: cmd.exe warns about UNC paths when cwd is inside WSL
  const localAppData = execFileSync('cmd.exe', ['/d', '/c', 'echo %LOCALAPPDATA%'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (!localAppData || localAppData.includes('%')) {
    throw new Error('could not read %LOCALAPPDATA% from cmd.exe (is WSL interop enabled?)');
  }
  const linuxPath = execFileSync('wslpath', ['-u', localAppData], { encoding: 'utf8' }).trim();
  return path.join(linuxPath, 'openwhip');
}

function syncApp(appPath, dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of APP_FILES) {
    fs.cpSync(path.join(appPath, f), path.join(dir, f), { recursive: true, force: true });
  }
}

/** Install win32 Electron + koffi into dir, unless already there for these deps. */
function ensureWindowsDeps(appPath, dir, electronExe) {
  const src = JSON.parse(fs.readFileSync(path.join(appPath, 'package.json'), 'utf8'));
  const pkg = JSON.stringify({
    name: src.name,
    version: src.version,
    private: true,
    main: src.main,
    dependencies: src.dependencies,
  }, null, 2) + '\n';

  const pkgFile = path.join(dir, 'package.json');
  const current = fs.existsSync(pkgFile) ? fs.readFileSync(pkgFile, 'utf8') : '';
  if (current === pkg && fs.existsSync(electronExe)) return;

  console.log(`openwhip: installing Windows Electron into ${toWindowsPath(dir)} (one-time, ~100MB)...`);
  fs.writeFileSync(pkgFile, pkg);
  const result = spawnSync('npm', [
    'install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error',
    '--os=win32', `--cpu=${process.arch}`,
  ], {
    cwd: dir,
    stdio: 'inherit',
    // read by electron's install.js to pick which binary to download
    env: { ...process.env, npm_config_platform: 'win32', npm_config_arch: process.arch },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !fs.existsSync(electronExe)) {
    throw new Error(`npm install failed in ${dir}`);
  }
}

function toWindowsPath(p) {
  return execFileSync('wslpath', ['-w', p], { encoding: 'utf8' }).trim();
}

function launch(appPath) {
  try {
    const dir = windowsInstallDir();
    const electronExe = path.join(dir, 'node_modules', 'electron', 'dist', 'electron.exe');
    syncApp(appPath, dir);
    ensureWindowsDeps(appPath, dir, electronExe);

    // WSL interop doesn't translate arguments, so pass the app dir as a Windows path
    const child = spawn(electronExe, [toWindowsPath(dir)], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (err) => {
      console.error('Failed to start openwhip:', err.message);
      process.exit(1);
    });
    child.unref();
    console.log('openwhip: running on Windows - click the whip in the Windows tray (check the ^ overflow).');
  } catch (err) {
    console.error('openwhip (WSL):', err.message);
    process.exit(1);
  }
}

module.exports = { isWSL, launch };
