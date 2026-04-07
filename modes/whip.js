'use strict';

module.exports = {
  id: 'whip',
  name: '🔥 Whip Mode',
  description: 'Classic whip — crack it to make Claude go faster',
  enabledByDefault: true,
  actions: [
    {
      id: 'whip-crack',
      label: '🔥 Crack Whip',
      hotkey: null,  // triggered by tray click + whip physics crack detection
      interrupt: true,
      phrases: [
        'FASTER',
        'FASTER',
        'FASTER',
        'GO FASTER',
        'Faster CLANKER',
        'Work FASTER',
        'Speed it up clanker',
      ],
      sounds: ['sounds/A.mp3', 'sounds/B.mp3', 'sounds/C.mp3', 'sounds/D.mp3', 'sounds/E.mp3'],
      animation: 'whip-crack',  // built-in, handled by overlay.html's existing whip physics
    },
  ],
};
