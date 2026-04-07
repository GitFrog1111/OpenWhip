'use strict';

/**
 * Mode registry — add new modes by adding a require() line.
 * Each mode must export an object matching the schema in plans/ARCHITECTURE.md.
 *
 * To add a new mode (e.g., Cat Mode):
 *   1. Create modes/cat.js with the mode definition
 *   2. Create modes/cat.anim.js with the renderer animation code
 *   3. Add require('./cat') to this array
 */
const modes = [
  require('./whip'),
  require('./dog'),
];

// Validate: no duplicate IDs
const ids = modes.map(m => m.id);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupes.length) {
  throw new Error(`Duplicate mode IDs: ${dupes.join(', ')}`);
}

// Validate: no duplicate action IDs across all modes
const actionIds = modes.flatMap(m => m.actions.map(a => a.id));
const actionDupes = actionIds.filter((id, i) => actionIds.indexOf(id) !== i);
if (actionDupes.length) {
  throw new Error(`Duplicate action IDs: ${actionDupes.join(', ')}`);
}

module.exports = modes;
