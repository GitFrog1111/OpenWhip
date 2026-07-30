const fs = require('node:fs/promises');
const path = require('node:path');

const {
  BUILT_IN_PROFILES,
  DEFAULT_PROFILE_ID,
  mergeProfiles,
  resolveSteps,
  selectMessage,
} = require('./agent-profiles');
const { executeSteps } = require('./input-executor');

const CONFIG_FILENAME = 'agent-profiles.json';
const STATE_FILENAME = 'agent-profile-state.json';
const EMPTY_CONFIG = Object.freeze({ version: 1, profiles: Object.freeze([]) });

function isMissingFile(error) {
  return error && error.code === 'ENOENT';
}

async function readOptionalFile(fileSystem, filePath) {
  try {
    return await fileSystem.readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function loadRegistry(fileSystem, configPath) {
  const contents = await readOptionalFile(fileSystem, configPath);
  return contents === null
    ? BUILT_IN_PROFILES
    : mergeProfiles(JSON.parse(contents));
}

async function loadActiveProfileId(fileSystem, statePath, registry) {
  const contents = await readOptionalFile(fileSystem, statePath);
  if (contents === null) return DEFAULT_PROFILE_ID;

  try {
    const state = JSON.parse(contents);
    const requestedId = state && state.activeProfileId;
    return registry.some(profile => profile.id === requestedId)
      ? requestedId
      : DEFAULT_PROFILE_ID;
  } catch {
    return DEFAULT_PROFILE_ID;
  }
}

async function writeActiveProfileState(
  fileSystem,
  statePath,
  activeProfileId,
  tempToken = `${process.pid}-${Date.now()}`,
) {
  const tempPath = `${statePath}.${tempToken}.tmp`;
  const contents = `${JSON.stringify({ activeProfileId }, null, 2)}\n`;
  await fileSystem.writeFile(tempPath, contents, 'utf8');
  await fileSystem.rename(tempPath, statePath);
}

async function createConfigIfMissing(fileSystem, configPath) {
  const contents = `${JSON.stringify(EMPTY_CONFIG, null, 2)}\n`;
  try {
    await fileSystem.writeFile(configPath, contents, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error && error.code === 'EEXIST') return;
    throw error;
  }
}

function createAgentRuntime({
  userDataPath,
  platform,
  driver,
  randomFn = Math.random,
  fileSystem = fs,
  openPath,
}) {
  if (typeof userDataPath !== 'string' || userDataPath.length === 0) {
    throw new Error('userDataPath is required');
  }

  const configPath = path.join(userDataPath, CONFIG_FILENAME);
  const statePath = path.join(userDataPath, STATE_FILENAME);
  let registry = BUILT_IN_PROFILES;
  let activeProfileId = DEFAULT_PROFILE_ID;

  async function persistSelection(profileId) {
    await writeActiveProfileState(fileSystem, statePath, profileId);
  }

  return {
    async initialize() {
      const nextRegistry = await loadRegistry(fileSystem, configPath);
      const nextActiveProfileId = await loadActiveProfileId(fileSystem, statePath, nextRegistry);
      registry = nextRegistry;
      activeProfileId = nextActiveProfileId;
    },

    getProfiles() {
      return registry;
    },

    getActiveProfileId() {
      return activeProfileId;
    },

    async selectProfile(profileId) {
      if (!registry.some(profile => profile.id === profileId)) {
        throw new Error(`Unknown agent profile: ${profileId}`);
      }
      await persistSelection(profileId);
      activeProfileId = profileId;
    },

    async reloadProfiles() {
      const nextRegistry = await loadRegistry(fileSystem, configPath);
      const activeStillExists = nextRegistry.some(profile => profile.id === activeProfileId);
      const nextActiveProfileId = activeStillExists ? activeProfileId : DEFAULT_PROFILE_ID;

      if (!activeStillExists) {
        await persistSelection(nextActiveProfileId);
      }
      registry = nextRegistry;
      activeProfileId = nextActiveProfileId;
    },

    async openProfileConfig() {
      if (typeof openPath !== 'function') {
        throw new Error('openPath is required to open the profile config');
      }
      await createConfigIfMissing(fileSystem, configPath);
      const errorMessage = await openPath(configPath);
      if (errorMessage) throw new Error(errorMessage);
    },

    async executeActiveProfile() {
      const profile = registry.find(candidate => candidate.id === activeProfileId);
      const steps = resolveSteps(profile, platform);
      const message = selectMessage(profile, randomFn);
      return executeSteps(driver, steps, message);
    },
  };
}

function createTrayMenuTemplate(runtime, handlers) {
  return [
    {
      label: 'Target Agent',
      submenu: runtime.getProfiles().map(profile => ({
        label: profile.label,
        type: 'radio',
        checked: profile.id === runtime.getActiveProfileId(),
        click: () => handlers.selectProfile(profile.id),
      })),
    },
    { label: 'Open profile config...', click: handlers.openProfileConfig },
    { label: 'Reload profiles', click: handlers.reloadProfiles },
    { label: 'Quit', click: handlers.quit },
  ];
}

module.exports = {
  CONFIG_FILENAME,
  STATE_FILENAME,
  createAgentRuntime,
  createTrayMenuTemplate,
  writeActiveProfileState,
};
