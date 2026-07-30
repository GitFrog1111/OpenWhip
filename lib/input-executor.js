const { execFile: nodeExecFile } = require('child_process');

const KEYUP = 0x0002;

const WINDOWS_KEYS = Object.freeze({
  enter: 0x0d,
  escape: 0x1b,
  tab: 0x09,
  space: 0x20,
  backspace: 0x08,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
});

const WINDOWS_MODIFIERS = Object.freeze({
  control: 0x11,
  alt: 0x12,
  shift: 0x10,
  meta: 0x5b,
});

const MAC_KEY_CODES = Object.freeze({
  enter: 36,
  escape: 53,
  tab: 48,
  space: 49,
  backspace: 51,
  up: 126,
  down: 125,
  left: 123,
  right: 124,
});

const MAC_MODIFIERS = Object.freeze({
  control: 'control down',
  alt: 'option down',
  shift: 'shift down',
  meta: 'command down',
});

const LINUX_KEYS = Object.freeze({
  enter: 'Return',
  escape: 'Escape',
  tab: 'Tab',
  space: 'space',
  backspace: 'BackSpace',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
});

const LINUX_MODIFIERS = Object.freeze({
  control: 'ctrl',
  alt: 'alt',
  shift: 'shift',
  meta: 'super',
});

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runExecFile(execFile, file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function tapWindowsKey(keybdEvent, vk) {
  keybdEvent(vk, 0, 0, 0);
  keybdEvent(vk, 0, KEYUP, 0);
}

function windowsKeyCode(key) {
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
  return WINDOWS_KEYS[key];
}

function pressWindowsKey(keybdEvent, key, modifiers) {
  const modifierCodes = modifiers.map(modifier => WINDOWS_MODIFIERS[modifier]);
  for (const vk of modifierCodes) keybdEvent(vk, 0, 0, 0);
  tapWindowsKey(keybdEvent, windowsKeyCode(key));
  for (const vk of [...modifierCodes].reverse()) keybdEvent(vk, 0, KEYUP, 0);
}

function typeWindowsMessage(keybdEvent, vkKeyScanA, message) {
  for (const character of message) {
    const packed = vkKeyScanA(character.charCodeAt(0));
    if (packed === -1 || (packed & 0xffff) === 0xffff) {
      throw new Error(`Unable to map ASCII character ${JSON.stringify(character)}`);
    }

    const vk = packed & 0xff;
    const shiftState = (packed >> 8) & 0xff;
    const modifiers = [];
    if (shiftState & 1) modifiers.push(WINDOWS_MODIFIERS.shift);
    if (shiftState & 2) modifiers.push(WINDOWS_MODIFIERS.control);
    if (shiftState & 4) modifiers.push(WINDOWS_MODIFIERS.alt);
    for (const modifier of modifiers) keybdEvent(modifier, 0, 0, 0);
    tapWindowsKey(keybdEvent, vk);
    for (const modifier of [...modifiers].reverse()) {
      keybdEvent(modifier, 0, KEYUP, 0);
    }
  }
}

function createWindowsDriver(deps) {
  const { keybdEvent, vkKeyScanA, sleep = defaultSleep } = deps;
  if (typeof keybdEvent !== 'function') {
    throw new Error('Windows input requires keybdEvent');
  }
  if (typeof vkKeyScanA !== 'function') {
    throw new Error('Windows input requires vkKeyScanA');
  }

  return {
    async execute(steps, message) {
      for (const step of steps) {
        if (step.type === 'keystroke') {
          pressWindowsKey(keybdEvent, step.key, step.modifiers);
        } else if (step.type === 'message') {
          typeWindowsMessage(keybdEvent, vkKeyScanA, message);
        } else if (step.type === 'delay') {
          await sleep(step.ms);
        } else {
          throw new Error(`Unsupported input step type: ${step.type}`);
        }
      }
    },
  };
}

function escapeAppleScriptText(message) {
  return message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function macUsingClause(modifiers) {
  if (modifiers.length === 0) return '';
  return ` using {${modifiers.map(modifier => MAC_MODIFIERS[modifier]).join(', ')}}`;
}

function buildAppleScript(steps, message) {
  const lines = ['tell application "System Events"'];
  for (const step of steps) {
    if (step.type === 'message') {
      lines.push(`  keystroke "${escapeAppleScriptText(message)}"`);
    } else if (step.type === 'delay') {
      lines.push(`  delay ${step.ms / 1000}`);
    } else if (step.type === 'keystroke') {
      const using = macUsingClause(step.modifiers);
      if (Object.hasOwn(MAC_KEY_CODES, step.key)) {
        lines.push(`  key code ${MAC_KEY_CODES[step.key]}${using}`);
      } else {
        lines.push(`  keystroke "${step.key}"${using}`);
      }
    } else {
      throw new Error(`Unsupported input step type: ${step.type}`);
    }
  }
  lines.push('end tell');
  return lines.join('\n');
}

function createMacDriver(deps) {
  const execFile = deps.execFile || nodeExecFile;
  return {
    execute(steps, message) {
      return runExecFile(execFile, 'osascript', ['-e', buildAppleScript(steps, message)]);
    },
  };
}

function linuxKeyName(key) {
  return LINUX_KEYS[key] || key;
}

function buildXdotoolArgs(steps, message) {
  const args = [];
  for (const step of steps) {
    if (step.type === 'message') {
      args.push('type', '--delay', '1', '--clearmodifiers', '--', message);
    } else if (step.type === 'delay') {
      args.push('sleep', String(step.ms / 1000));
    } else if (step.type === 'keystroke') {
      const modifiers = step.modifiers.map(modifier => LINUX_MODIFIERS[modifier]);
      const chord = [...modifiers, linuxKeyName(step.key)].join('+');
      args.push('key', '--clearmodifiers', chord);
    } else {
      throw new Error(`Unsupported input step type: ${step.type}`);
    }
  }
  return args;
}

function createLinuxDriver(deps) {
  const execFile = deps.execFile || nodeExecFile;
  return {
    execute(steps, message) {
      return runExecFile(execFile, 'xdotool', buildXdotoolArgs(steps, message));
    },
  };
}

function createInputDriver(platform, deps = {}) {
  if (platform === 'win32') return createWindowsDriver(deps);
  if (platform === 'darwin') return createMacDriver(deps);
  if (platform === 'linux') return createLinuxDriver(deps);
  throw new Error(`Unsupported platform: ${platform}`);
}

async function executeSteps(driver, steps, message) {
  if (!driver || typeof driver.execute !== 'function') {
    throw new Error('Input driver must provide an execute function');
  }
  return driver.execute(steps, message);
}

module.exports = {
  createInputDriver,
  executeSteps,
};
