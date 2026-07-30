const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createInputDriver,
  executeSteps,
} = require('../lib/input-executor');

const KEYUP = 0x0002;

test('Windows executes portable steps in order and types ASCII through VkKeyScanA', async () => {
  const calls = [];
  const packedKeys = new Map([
    ['A', 0x0141],
    ['!', 0x0131],
  ]);
  const driver = createInputDriver('win32', {
    keybdEvent(vk, scan, flags, extraInfo) {
      calls.push(['key', vk, scan, flags, extraInfo]);
    },
    vkKeyScanA(code) {
      const character = String.fromCharCode(code);
      calls.push(['scan', character]);
      return packedKeys.get(character) ?? -1;
    },
    async sleep(ms) {
      calls.push(['sleep', ms]);
    },
  });

  await executeSteps(driver, [
    { type: 'keystroke', key: 'c', modifiers: ['control'] },
    { type: 'delay', ms: 25 },
    { type: 'message' },
    { type: 'keystroke', key: 'enter', modifiers: [] },
  ], 'A!');

  assert.deepEqual(calls, [
    ['key', 0x11, 0, 0, 0],
    ['key', 0x43, 0, 0, 0],
    ['key', 0x43, 0, KEYUP, 0],
    ['key', 0x11, 0, KEYUP, 0],
    ['sleep', 25],
    ['scan', 'A'],
    ['key', 0x10, 0, 0, 0],
    ['key', 0x41, 0, 0, 0],
    ['key', 0x41, 0, KEYUP, 0],
    ['key', 0x10, 0, KEYUP, 0],
    ['scan', '!'],
    ['key', 0x10, 0, 0, 0],
    ['key', 0x31, 0, 0, 0],
    ['key', 0x31, 0, KEYUP, 0],
    ['key', 0x10, 0, KEYUP, 0],
    ['key', 0x0d, 0, 0, 0],
    ['key', 0x0d, 0, KEYUP, 0],
  ]);
});

test('Windows maps portable modifiers and releases them in reverse order', async () => {
  const calls = [];
  const driver = createInputDriver('win32', {
    keybdEvent(vk, scan, flags) {
      calls.push([vk, flags]);
    },
    vkKeyScanA() {
      return 0x41;
    },
    sleep: async () => {},
  });

  await driver.execute([
    { type: 'keystroke', key: 'left', modifiers: ['meta', 'alt', 'shift'] },
  ], 'unused');

  assert.deepEqual(calls, [
    [0x5b, 0],
    [0x12, 0],
    [0x10, 0],
    [0x25, 0],
    [0x25, KEYUP],
    [0x10, KEYUP],
    [0x12, KEYUP],
    [0x5b, KEYUP],
  ]);
});

test('Windows rejects missing injection functions and unmappable ASCII', async () => {
  assert.throws(
    () => createInputDriver('win32', { vkKeyScanA() {} }),
    /keybdEvent/i,
  );
  assert.throws(
    () => createInputDriver('win32', { keybdEvent() {} }),
    /vkKeyScanA/i,
  );

  const driver = createInputDriver('win32', {
    keybdEvent() {},
    vkKeyScanA() { return -1; },
    sleep: async () => {},
  });
  await assert.rejects(
    driver.execute([{ type: 'message' }], 'A'),
    /map ASCII character/i,
  );
});

test('macOS executes one ordered AppleScript with escaped text, named keys, modifiers, and delay seconds', async () => {
  const calls = [];
  const driver = createInputDriver('darwin', {
    execFile(file, args, callback) {
      calls.push([file, args]);
      callback(null);
    },
  });

  await driver.execute([
    { type: 'keystroke', key: 'c', modifiers: ['control'] },
    { type: 'delay', ms: 300 },
    { type: 'message' },
    { type: 'keystroke', key: 'tab', modifiers: ['meta', 'shift'] },
    { type: 'keystroke', key: 'enter', modifiers: [] },
  ], 'A"\\B');

  assert.deepEqual(calls, [[
    'osascript',
    ['-e', [
      'tell application "System Events"',
      '  keystroke "c" using {control down}',
      '  delay 0.3',
      '  keystroke "A\\"\\\\B"',
      '  key code 48 using {command down, shift down}',
      '  key code 36',
      'end tell',
    ].join('\n')],
  ]]);
});

test('Linux executes one ordered xdotool argv plan', async () => {
  const calls = [];
  const driver = createInputDriver('linux', {
    execFile(file, args, callback) {
      calls.push([file, args]);
      callback(null);
    },
  });

  await executeSteps(driver, [
    { type: 'keystroke', key: 'c', modifiers: ['control'] },
    { type: 'delay', ms: 250 },
    { type: 'message' },
    { type: 'keystroke', key: 'left', modifiers: ['meta', 'alt'] },
    { type: 'keystroke', key: 'enter', modifiers: [] },
  ], 'GO FASTER');

  assert.deepEqual(calls, [[
    'xdotool',
    [
      'key', '--clearmodifiers', 'ctrl+c',
      'sleep', '0.25',
      'type', '--delay', '1', '--clearmodifiers', '--', 'GO FASTER',
      'key', '--clearmodifiers', 'super+alt+Left',
      'key', '--clearmodifiers', 'Return',
    ],
  ]]);
});

test('macOS and Linux execution errors propagate', async (t) => {
  for (const [platform, expected] of [['darwin', 'osascript failed'], ['linux', 'xdotool failed']]) {
    await t.test(platform, async () => {
      const driver = createInputDriver(platform, {
        execFile(file, args, callback) {
          callback(new Error(expected));
        },
      });
      await assert.rejects(
        driver.execute([{ type: 'message' }], 'FASTER'),
        new RegExp(expected),
      );
    });
  }
});

test('unsupported platforms fail explicitly', () => {
  assert.throws(
    () => createInputDriver('freebsd', {}),
    /unsupported platform.*freebsd/i,
  );
});

test('executeSteps requires a driver execute function', async () => {
  await assert.rejects(
    executeSteps({}, [{ type: 'message' }], 'FASTER'),
    /driver.*execute/i,
  );
});
