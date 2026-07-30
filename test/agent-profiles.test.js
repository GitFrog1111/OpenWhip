const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_PROFILE_ID,
  BUILT_IN_PROFILES,
  mergeProfiles,
  resolveSteps,
  selectMessage,
} = require('../lib/agent-profiles');

function message() {
  return { type: 'message' };
}

function customProfile(overrides = {}) {
  return {
    id: 'custom-agent',
    label: 'Custom Agent',
    messages: ['Keep going'],
    steps: { default: [message()] },
    ...overrides,
  };
}

function config(profiles) {
  return { version: 1, profiles };
}

test('exports immutable Claude Code and Codex built-in profiles with their platform actions', () => {
  assert.equal(DEFAULT_PROFILE_ID, 'claude-code');
  assert.equal(BUILT_IN_PROFILES.length, 2);
  assert.equal(Object.isFrozen(BUILT_IN_PROFILES), true);

  const claude = BUILT_IN_PROFILES[0];
  const codex = BUILT_IN_PROFILES[1];

  assert.deepEqual(claude, {
    id: 'claude-code',
    label: 'Claude Code',
    messages: [
      'FASTER',
      'FASTER',
      'FASTER',
      'GO FASTER',
      'Faster CLANKER',
      'Work FASTER',
      'Speed it up clanker',
    ],
    steps: {
      default: [
        { type: 'keystroke', key: 'c', modifiers: ['control'] },
        message(),
        { type: 'keystroke', key: 'enter', modifiers: [] },
      ],
      darwin: [
        { type: 'keystroke', key: 'c', modifiers: ['control'] },
        { type: 'delay', ms: 300 },
        message(),
        { type: 'keystroke', key: 'enter', modifiers: [] },
      ],
    },
  });
  assert.deepEqual(codex, {
    id: 'codex',
    label: 'Codex',
    messages: claude.messages,
    steps: {
      default: [message(), { type: 'keystroke', key: 'enter', modifiers: [] }],
    },
  });
  assert.equal(Object.isFrozen(claude.steps.default), true);
});

test('resolves platform overrides and falls back to default steps', () => {
  const profile = customProfile({
    steps: {
      default: [message()],
      win32: [{ type: 'keystroke', key: 'tab', modifiers: [] }, message()],
    },
  });

  assert.deepEqual(resolveSteps(profile, 'win32'), [
    { type: 'keystroke', key: 'tab', modifiers: [] },
    message(),
  ]);
  assert.deepEqual(resolveSteps(profile, 'linux'), [message()]);
});

test('selects a message deterministically from the supplied random function', () => {
  const profile = customProfile({ messages: ['First', 'Second', 'Third'] });

  assert.equal(selectMessage(profile, () => 0), 'First');
  assert.equal(selectMessage(profile, () => 0.999), 'Third');
});

test('merges valid custom profiles after built-ins without mutating inputs', () => {
  const supplied = config([customProfile({ id: 'neutral-tool', label: 'Neutral Tool' })]);
  const before = structuredClone(supplied);

  const profiles = mergeProfiles(supplied);

  assert.deepEqual(profiles.map(profile => profile.id), ['claude-code', 'codex', 'neutral-tool']);
  assert.deepEqual(supplied, before);
  assert.notEqual(profiles[2], supplied.profiles[0]);
});

test('rejects invalid top-level configuration, custom count, IDs, labels, and duplicate IDs', () => {
  assert.throws(() => mergeProfiles({ version: 2, profiles: [] }), /version/i);
  assert.throws(() => mergeProfiles({ version: 1, profiles: 'not-an-array' }), /profiles/i);
  assert.throws(() => mergeProfiles(config(Array.from({ length: 51 }, (_, index) => customProfile({ id: `neutral-${index}` })))), /50/i);
  assert.throws(() => mergeProfiles(config([customProfile({ id: '' })])), /id/i);
  assert.throws(() => mergeProfiles(config([customProfile({ id: 'x'.repeat(65) })])), /id/i);
  assert.throws(() => mergeProfiles(config([customProfile({ label: '' })])), /label/i);
  assert.throws(() => mergeProfiles(config([customProfile({ label: 'x'.repeat(65) })])), /label/i);
  assert.throws(() => mergeProfiles(config([customProfile({ id: 'codex' })])), /built-in|duplicate/i);
  assert.throws(() => mergeProfiles(config([customProfile(), customProfile()])), /duplicate/i);
});

test('rejects invalid message collections and message text', () => {
  assert.throws(() => mergeProfiles(config([customProfile({ messages: [] })])), /messages/i);
  assert.throws(() => mergeProfiles(config([customProfile({ messages: Array(21).fill('Keep going') })])), /messages/i);
  assert.throws(() => mergeProfiles(config([customProfile({ messages: [''] })])), /message/i);
  assert.throws(() => mergeProfiles(config([customProfile({ messages: ['x'.repeat(501)] })])), /message/i);
  assert.throws(() => mergeProfiles(config([customProfile({ messages: ['Keep going \u2713'] })])), /ASCII/i);
});

test('rejects missing or invalid platform step sequences', () => {
  assert.throws(() => mergeProfiles(config([customProfile({ steps: {} })])), /default/i);
  assert.throws(() => mergeProfiles(config([customProfile({ steps: { default: [] } })])), /steps/i);
  assert.throws(() => mergeProfiles(config([customProfile({ steps: { default: Array(17).fill(message()) } })])), /steps/i);
  assert.throws(() => mergeProfiles(config([customProfile({ steps: { default: [{ type: 'delay', ms: 1 }] } })])), /exactly one message/i);
  assert.throws(() => mergeProfiles(config([customProfile({ steps: { default: [message(), message()] } })])), /exactly one message/i);
  assert.throws(() => mergeProfiles(config([customProfile({ steps: { default: [message()], android: [message()] } })])), /platform/i);
});

test('rejects invalid keystroke, delay, and step fields', () => {
  const invalid = (step, pattern) => assert.throws(
    () => mergeProfiles(config([customProfile({ steps: { default: [step, message()] } })])),
    pattern,
  );

  invalid({ type: 'keystroke', key: 'f1', modifiers: [] }, /key/i);
  invalid({ type: 'keystroke', key: 'a', modifiers: ['control', 'control'] }, /modifier/i);
  invalid({ type: 'keystroke', key: 'a', modifiers: ['super'] }, /modifier/i);
  invalid({ type: 'delay', ms: 1.5 }, /delay/i);
  invalid({ type: 'delay', ms: -1 }, /delay/i);
  invalid({ type: 'delay', ms: 2001 }, /delay/i);
  invalid({ type: 'keystroke', key: 'a', modifiers: [], command: 'run this' }, /unknown/i);
  invalid({ type: 'shell', command: 'run this' }, /unknown|type/i);
});
