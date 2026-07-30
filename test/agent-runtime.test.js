const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CONFIG_FILENAME,
  STATE_FILENAME,
  createAgentRuntime,
  createTrayMenuTemplate,
  writeActiveProfileState,
} = require('../lib/agent-runtime');

function customConfig(id = 'custom-agent') {
  return {
    version: 1,
    profiles: [{
      id,
      label: 'Custom Agent',
      messages: ['Keep going'],
      steps: { default: [{ type: 'message' }] },
    }],
  };
}

async function makeUserData(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openwhip-runtime-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('missing config and state initialize to built-ins with Claude Code active', async t => {
  const userDataPath = await makeUserData(t);
  const runtime = createAgentRuntime({
    userDataPath,
    platform: 'win32',
    driver: { async execute() {} },
  });

  await runtime.initialize();

  assert.deepEqual(runtime.getProfiles().map(profile => profile.id), ['claude-code', 'codex']);
  assert.equal(runtime.getActiveProfileId(), 'claude-code');
});

test('valid state selects a custom profile while corrupt or unknown state falls back', async t => {
  const userDataPath = await makeUserData(t);
  await fs.writeFile(
    path.join(userDataPath, CONFIG_FILENAME),
    JSON.stringify(customConfig()),
  );
  const statePath = path.join(userDataPath, STATE_FILENAME);

  await fs.writeFile(statePath, JSON.stringify({ activeProfileId: 'custom-agent' }));
  const valid = createAgentRuntime({ userDataPath, platform: 'linux', driver: { async execute() {} } });
  await valid.initialize();
  assert.equal(valid.getActiveProfileId(), 'custom-agent');

  await fs.writeFile(statePath, '{broken');
  const corrupt = createAgentRuntime({ userDataPath, platform: 'linux', driver: { async execute() {} } });
  await corrupt.initialize();
  assert.equal(corrupt.getActiveProfileId(), 'claude-code');

  await fs.writeFile(statePath, JSON.stringify({ activeProfileId: 'not-installed' }));
  const unknown = createAgentRuntime({ userDataPath, platform: 'linux', driver: { async execute() {} } });
  await unknown.initialize();
  assert.equal(unknown.getActiveProfileId(), 'claude-code');
});

test('active profile executes through resolved steps and the injected driver', async t => {
  const userDataPath = await makeUserData(t);
  const calls = [];
  const runtime = createAgentRuntime({
    userDataPath,
    platform: 'darwin',
    randomFn: () => 0,
    driver: {
      async execute(steps, message) {
        calls.push({ steps, message });
      },
    },
  });
  await runtime.initialize();
  await runtime.selectProfile('codex');

  await runtime.executeActiveProfile();

  assert.deepEqual(calls, [{
    steps: [
      { type: 'message' },
      { type: 'keystroke', key: 'enter', modifiers: [] },
    ],
    message: 'FASTER',
  }]);
});

test('openProfileConfig creates an empty template once and opens its path', async t => {
  const userDataPath = await makeUserData(t);
  const opened = [];
  const runtime = createAgentRuntime({
    userDataPath,
    platform: 'win32',
    driver: { async execute() {} },
    async openPath(filePath) {
      opened.push(filePath);
      return '';
    },
  });
  const configPath = path.join(userDataPath, CONFIG_FILENAME);

  await runtime.openProfileConfig();
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), { version: 1, profiles: [] });

  await fs.writeFile(configPath, JSON.stringify(customConfig()));
  await runtime.openProfileConfig();

  assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), customConfig());
  assert.deepEqual(opened, [configPath, configPath]);
});

test('reload swaps a valid registry and rejects invalid config without changing current state', async t => {
  const userDataPath = await makeUserData(t);
  const configPath = path.join(userDataPath, CONFIG_FILENAME);
  const runtime = createAgentRuntime({
    userDataPath,
    platform: 'win32',
    driver: { async execute() {} },
  });
  await runtime.initialize();

  await fs.writeFile(configPath, JSON.stringify(customConfig()));
  await runtime.reloadProfiles();
  await runtime.selectProfile('custom-agent');
  const profilesBeforeFailure = runtime.getProfiles();

  await fs.writeFile(configPath, '{broken');
  await assert.rejects(runtime.reloadProfiles(), /JSON|Unexpected|position/i);

  assert.equal(runtime.getProfiles(), profilesBeforeFailure);
  assert.equal(runtime.getActiveProfileId(), 'custom-agent');
});

test('reload removal falls back to Claude Code and persists the fallback', async t => {
  const userDataPath = await makeUserData(t);
  const configPath = path.join(userDataPath, CONFIG_FILENAME);
  await fs.writeFile(configPath, JSON.stringify(customConfig()));
  const runtime = createAgentRuntime({
    userDataPath,
    platform: 'win32',
    driver: { async execute() {} },
  });
  await runtime.initialize();
  await runtime.selectProfile('custom-agent');

  await fs.writeFile(configPath, JSON.stringify({ version: 1, profiles: [] }));
  await runtime.reloadProfiles();

  assert.equal(runtime.getActiveProfileId(), 'claude-code');
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(userDataPath, STATE_FILENAME), 'utf8')),
    { activeProfileId: 'claude-code' },
  );
});

test('reload keeps the prior registry when persisting a required fallback fails', async t => {
  const userDataPath = await makeUserData(t);
  const configPath = path.join(userDataPath, CONFIG_FILENAME);
  await fs.writeFile(configPath, JSON.stringify(customConfig()));
  await fs.writeFile(
    path.join(userDataPath, STATE_FILENAME),
    JSON.stringify({ activeProfileId: 'custom-agent' }),
  );
  const runtime = createAgentRuntime({
    userDataPath,
    platform: 'win32',
    driver: { async execute() {} },
    fileSystem: {
      ...fs,
      async rename() { throw new Error('state rename failed'); },
    },
  });
  await runtime.initialize();
  const profilesBeforeFailure = runtime.getProfiles();
  await fs.writeFile(configPath, JSON.stringify({ version: 1, profiles: [] }));

  await assert.rejects(runtime.reloadProfiles(), /state rename failed/);

  assert.equal(runtime.getProfiles(), profilesBeforeFailure);
  assert.equal(runtime.getActiveProfileId(), 'custom-agent');
});

test('state writes use a temporary file and rename, and selection stays unchanged on write failure', async t => {
  const calls = [];
  await writeActiveProfileState({
    async writeFile(filePath, contents) {
      calls.push(['write', filePath, JSON.parse(contents)]);
    },
    async rename(from, to) {
      calls.push(['rename', from, to]);
    },
  }, 'C:/user-data/agent-profile-state.json', 'codex', 'fixed');

  assert.deepEqual(calls, [
    ['write', 'C:/user-data/agent-profile-state.json.fixed.tmp', { activeProfileId: 'codex' }],
    ['rename', 'C:/user-data/agent-profile-state.json.fixed.tmp', 'C:/user-data/agent-profile-state.json'],
  ]);

  const userDataPath = await makeUserData(t);
  const runtime = createAgentRuntime({
    userDataPath,
    platform: 'win32',
    driver: { async execute() {} },
    fileSystem: {
      ...fs,
      async rename() { throw new Error('state rename failed'); },
    },
  });
  await runtime.initialize();

  await assert.rejects(runtime.selectProfile('codex'), /state rename failed/);
  assert.equal(runtime.getActiveProfileId(), 'claude-code');
});

test('tray menu is built dynamically with radio profiles and management actions', async t => {
  const userDataPath = await makeUserData(t);
  await fs.writeFile(path.join(userDataPath, CONFIG_FILENAME), JSON.stringify(customConfig()));
  const runtime = createAgentRuntime({
    userDataPath,
    platform: 'win32',
    driver: { async execute() {} },
  });
  await runtime.initialize();
  await runtime.selectProfile('codex');

  const selected = [];
  const menu = createTrayMenuTemplate(runtime, {
    selectProfile(id) { selected.push(id); },
    openProfileConfig() {},
    reloadProfiles() {},
    quit() {},
  });

  assert.equal(menu[0].label, 'Target Agent');
  assert.deepEqual(menu[0].submenu.map(item => ({
    label: item.label,
    type: item.type,
    checked: item.checked,
  })), [
    { label: 'Claude Code', type: 'radio', checked: false },
    { label: 'Codex', type: 'radio', checked: true },
    { label: 'Custom Agent', type: 'radio', checked: false },
  ]);
  menu[0].submenu[2].click();
  assert.deepEqual(selected, ['custom-agent']);
  assert.deepEqual(menu.slice(1).map(item => item.label), [
    'Open profile config...',
    'Reload profiles',
    'Quit',
  ]);
});
