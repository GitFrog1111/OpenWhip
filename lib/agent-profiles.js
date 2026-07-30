const DEFAULT_PROFILE_ID = 'claude-code';

const MESSAGE_TEXTS = Object.freeze([
  'FASTER',
  'FASTER',
  'FASTER',
  'GO FASTER',
  'Faster CLANKER',
  'Work FASTER',
  'Speed it up clanker',
]);

const VALID_PLATFORMS = new Set(['default', 'win32', 'darwin', 'linux']);
const VALID_KEYS = new Set([
  'enter',
  'escape',
  'tab',
  'space',
  'backspace',
  'up',
  'down',
  'left',
  'right',
]);
const VALID_MODIFIERS = new Set(['control', 'alt', 'shift', 'meta']);

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

const BUILT_IN_PROFILES = deepFreeze([
  {
    id: 'claude-code',
    label: 'Claude Code',
    messages: MESSAGE_TEXTS,
    steps: {
      default: [
        { type: 'keystroke', key: 'c', modifiers: ['control'] },
        { type: 'message' },
        { type: 'keystroke', key: 'enter', modifiers: [] },
      ],
      darwin: [
        { type: 'keystroke', key: 'c', modifiers: ['control'] },
        { type: 'delay', ms: 300 },
        { type: 'message' },
        { type: 'keystroke', key: 'enter', modifiers: [] },
      ],
    },
  },
  {
    id: 'codex',
    label: 'Codex',
    messages: MESSAGE_TEXTS,
    steps: {
      default: [
        { type: 'message' },
        { type: 'keystroke', key: 'enter', modifiers: [] },
      ],
    },
  },
]);

function fail(path, reason) {
  throw new Error(`${path}: ${reason}`);
}

function validateName(value, path) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 64) {
    fail(path, 'must be a non-empty string of at most 64 characters');
  }
  return value;
}

function validateMessages(messages, path) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 20) {
    fail(path, 'must contain 1-20 messages');
  }

  return messages.map((message, index) => {
    if (
      typeof message !== 'string'
      || message.length < 1
      || message.length > 500
      || !/^[\x20-\x7e]+$/.test(message)
    ) {
      fail(`${path}[${index}]`, 'message must be 1-500 printable ASCII characters');
    }
    return message;
  });
}

function rejectUnknownFields(step, allowed, path) {
  for (const field of Object.keys(step)) {
    if (!allowed.includes(field)) {
      fail(path, `unknown field "${field}"`);
    }
  }
}

function validateStep(step, path) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    fail(path, 'step must be an object');
  }

  if (step.type === 'message') {
    rejectUnknownFields(step, ['type'], path);
    return { type: 'message' };
  }

  if (step.type === 'keystroke') {
    rejectUnknownFields(step, ['type', 'key', 'modifiers'], path);
    const validKey = typeof step.key === 'string'
      && (/^[a-z0-9]$/i.test(step.key) || VALID_KEYS.has(step.key));
    if (!validKey) {
      fail(`${path}.key`, 'must be one ASCII alphanumeric character or a supported named key');
    }
    if (!Array.isArray(step.modifiers)) {
      fail(`${path}.modifiers`, 'must be an array');
    }
    const uniqueModifiers = new Set(step.modifiers);
    if (
      uniqueModifiers.size !== step.modifiers.length
      || step.modifiers.some(modifier => !VALID_MODIFIERS.has(modifier))
    ) {
      fail(`${path}.modifiers`, 'must contain unique supported modifier names');
    }
    return { type: 'keystroke', key: step.key, modifiers: [...step.modifiers] };
  }

  if (step.type === 'delay') {
    rejectUnknownFields(step, ['type', 'ms'], path);
    if (!Number.isInteger(step.ms) || step.ms < 0 || step.ms > 2000) {
      fail(path, 'delay ms must be an integer from 0 through 2000');
    }
    return { type: 'delay', ms: step.ms };
  }

  fail(path, `unknown step type "${step.type}"`);
}

function validateSequence(sequence, path) {
  if (!Array.isArray(sequence) || sequence.length < 1 || sequence.length > 16) {
    fail(path, 'steps must contain 1-16 entries');
  }

  const steps = sequence.map((step, index) => validateStep(step, `${path}[${index}]`));
  if (steps.filter(step => step.type === 'message').length !== 1) {
    fail(path, 'must contain exactly one message step');
  }
  return steps;
}

function validateSteps(steps, path) {
  if (!steps || typeof steps !== 'object' || Array.isArray(steps)) {
    fail(path, 'must be an object with a default step sequence');
  }
  for (const platform of Object.keys(steps)) {
    if (!VALID_PLATFORMS.has(platform)) {
      fail(`${path}.${platform}`, 'unknown platform override');
    }
  }
  if (!Object.hasOwn(steps, 'default')) {
    fail(`${path}.default`, 'is required');
  }

  return Object.fromEntries(
    Object.entries(steps).map(([platform, sequence]) => [
      platform,
      validateSequence(sequence, `${path}.${platform}`),
    ]),
  );
}

function validateProfile(profile, index) {
  const path = `profiles[${index}]`;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    fail(path, 'profile must be an object');
  }
  return {
    id: validateName(profile.id, `${path}.id`),
    label: validateName(profile.label, `${path}.label`),
    messages: validateMessages(profile.messages, `${path}.messages`),
    steps: validateSteps(profile.steps, `${path}.steps`),
  };
}

function mergeProfiles(configObject) {
  if (!configObject || typeof configObject !== 'object' || Array.isArray(configObject)) {
    fail('config', 'must be an object');
  }
  if (configObject.version !== 1) {
    fail('config.version', 'must be 1');
  }
  if (!Array.isArray(configObject.profiles)) {
    fail('config.profiles', 'must be an array');
  }
  if (configObject.profiles.length > 50) {
    fail('config.profiles', 'must contain at most 50 custom profiles');
  }

  const seenIds = new Set(BUILT_IN_PROFILES.map(profile => profile.id));
  const customProfiles = configObject.profiles.map((profile, index) => {
    const validated = validateProfile(profile, index);
    if (seenIds.has(validated.id)) {
      fail(`profiles[${index}].id`, 'duplicate ID or collision with a built-in profile');
    }
    seenIds.add(validated.id);
    return deepFreeze(validated);
  });

  return Object.freeze([...BUILT_IN_PROFILES, ...customProfiles]);
}

function resolveSteps(profile, platform) {
  return profile.steps[platform] || profile.steps.default;
}

function selectMessage(profile, randomFn = Math.random) {
  return profile.messages[Math.floor(randomFn() * profile.messages.length)];
}

module.exports = {
  DEFAULT_PROFILE_ID,
  BUILT_IN_PROFILES,
  mergeProfiles,
  resolveSteps,
  selectMessage,
};
