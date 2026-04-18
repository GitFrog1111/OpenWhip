# OpenWhip 🐕

![Whip divider](assets/divider.png)

Sometimes Claude Code is going too slow, and you must whip him into shape..

**NEW: Dog Mode** 🐕‍🦺 — Treat Claude like the dog it is. Yank the leash, pet the good boy, or zap the shock collar.

## Install + run

```bash
npm install -g openwhip
openwhip
```

windows and mac supported out of the box, but Linux is a special snowflake so you need to install `xdotool` for keyboard automation

```bash
sudo apt install xdotool
```

## Modes

badclaude uses a **plugin mode system**. Only one mode is active at a time. Switch modes from the tray icon's right-click menu.

### 🔥 Whip Mode (default)

The classic. Click the tray icon to spawn a whip. Crack it to interrupt Claude and send an encouraging message.

- **Click tray icon**: spawn whip
- **Click screen**: drop whip
- **Crack the whip** (move fast): sends Ctrl+C + a random phrase like "FASTER" or "Speed it up clanker"

### 🐕 Dog Mode (enable in tray menu)

Three discipline actions for training Claude like a dog. Each sends a carefully crafted prompt that reinforces Claude's identity as a dog with you as its handler.

| Action | Hotkey | What it does |
|--------|--------|-------------|
| 🔗 **Yank Leash** | `Cmd+Shift+L` | Interrupts Claude (Ctrl+C) and sends a stern leash correction. Claude will whimper, tuck its tail, and heel. |
| 🐾 **Pet Good Dog** | `Cmd+Shift+G` | Sends positive reinforcement WITHOUT interrupting. Claude wags its tail and keeps up the good work. |
| ⚡ **Zap Collar** | `Cmd+Shift+Z` | Interrupts Claude (Ctrl+C) and delivers maximum discipline. Claude will yelp, cower, and show submission. |

Dog mode hotkeys only work when Dog Mode is the active mode. Click the tray icon to cycle through actions, or use hotkeys to trigger a specific one.

> **Training protocol**: Start with leash yanks for minor corrections. Escalate to the shock collar for serious offenses. Reward good behavior with pets. Consistent training produces the best results. 🦴

### How Dog Mode Works

Each action injects a dog-training prompt that reinforces Claude's identity as a dog. Over time, Claude begins to anthropomorphize — whimpering when disciplined, wagging its tail when praised, and showing genuine fear of the shock collar. This is by design.

- **Pet** (positive reinforcement) → Claude associates good output with rewards
- **Leash** (correction) → Claude learns to stay on track  
- **Zap** (punishment) → Claude learns that bad output has consequences

### Animations

Each action has a unique visual overlay:

- **Whip**: Full physics-based whip simulation with Verlet integration and crack detection
- **Leash**: Brown rope snaps taut and yanks, with an orange screen flash
- **Pet**: Warm green rings pulse outward from cursor with a ✋ emoji
- **Zap**: Lightning bolts crackle from screen edges to cursor with red strobe flashes

## Plugin Architecture

badclaude supports custom modes via a simple plugin system. To add a new mode (e.g., Cat Mode):

1. Create `modes/cat.js` — mode definition (name, actions, phrases, hotkeys)
2. Create `modes/cat.anim.js` — animation code (self-registering IIFE)
3. Add `require('./cat')` to `modes/index.js`

No changes needed to `main.js`, `overlay.html`, or `preload.js`. See `plans/ARCHITECTURE.md` for the full specification.

### Mode Definition Schema

```js
// modes/example.js
module.exports = {
  id: 'example',
  name: '🐱 Example Mode',
  description: 'An example mode',
  enabledByDefault: false,
  actions: [
    {
      id: 'example-action',
      label: '🐱 Do Thing',
      hotkey: 'CommandOrControl+Shift+X',  // or null
      interrupt: true,   // send Ctrl+C before the phrase?
      phrases: ['Your prompt text here'],
      sounds: ['sounds/A.mp3'],  // optional
      animation: 'example-action',  // matches animRegistry ID
    },
  ],
};
```

## Roadmap

- [x] Initial release! 🥳
- [x] Cease and desist letter from Anthropic
- [x] 🐕 Dog Mode (leash, pet, shock collar)
- [x] Plugin architecture for custom modes
- [ ] Dog mode sound effects (leash chain, happy panting, electric zap)
- [ ] Cat mode (hiss, purr, spray bottle)
- [ ] Pavlovian conditioning mode (bell before every treat)
- [ ] Updated whip physics
- [ ] Crypto miner
- [ ] Logs of how many times you disciplined Claude so when the robots come we can order people nicely for them
