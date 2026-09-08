const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP_NAME = 'OpenWhip';
const BUNDLE_ID = 'com.openwhip.app';

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });
}

function plist(appPath, key, value) {
  run('plutil', ['-replace', key, '-string', value, path.join(appPath, 'Contents', 'Info.plist')]);
}

function isFresh(appPath, electronApp) {
  try {
    return fs.statSync(appPath).mtimeMs >= fs.statSync(electronApp).mtimeMs;
  } catch {
    return false;
  }
}

function ensureMacApp(electronBinary, pkgRoot) {
  const electronApp = path.resolve(electronBinary, '..', '..', '..');
  const appPath = path.join(pkgRoot, `${APP_NAME}.app`);
  if (isFresh(appPath, electronApp)) return appPath;

  fs.rmSync(appPath, { recursive: true, force: true });
  run('cp', ['-Rc', electronApp, appPath]);

  const macos = path.join(appPath, 'Contents', 'MacOS');
  fs.renameSync(path.join(macos, 'Electron'), path.join(macos, APP_NAME));
  fs.copyFileSync(path.join(pkgRoot, 'icon', 'AppIcon.icns'), path.join(appPath, 'Contents', 'Resources', 'electron.icns'));

  plist(appPath, 'CFBundleName', APP_NAME);
  plist(appPath, 'CFBundleDisplayName', APP_NAME);
  plist(appPath, 'CFBundleExecutable', APP_NAME);
  plist(appPath, 'CFBundleIdentifier', BUNDLE_ID);

  run('codesign', ['--force', '--deep', '--sign', '-', appPath]);
  fs.utimesSync(appPath, new Date(), new Date());
  return appPath;
}

module.exports = { ensureMacApp };
