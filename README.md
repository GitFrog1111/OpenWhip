# OpenWhip

![Whip divider](assets/divider.png)

OpenWhip adds a dramatic whip overlay and sends a short, configurable keyboard sequence to the foreground application.

## Install + run

```bash
npm install -g openwhip
openwhip
```

Windows and macOS work out of the box. On Linux, install `xdotool` for keyboard automation:

```bash
sudo apt install xdotool
```

On Windows, message input does not require switching to an English keyboard layout.

## Controls

- Click the tray icon to spawn the whip.
- Click to drop the whip.
- A whip crack sends the selected target's keyboard sequence to the foreground application.

## Target Agent

The tray menu has a **Target Agent** submenu. It is a radio list built from the built-in and custom profiles; the default selection is **Claude Code**. OpenWhip does not detect which application is active, so choose the target explicitly before using the whip.

The built-in profiles use the same profile and input-execution path:

- **Claude Code**: Windows and Linux send `Ctrl+C`, a message, then `Enter`. macOS preserves the existing behavior: `Ctrl+C`, a 300 ms delay, a message, then `Enter`.
- **Codex**: sends a message, then `Enter` on every platform. This one profile is intended for both CLI and Desktop use; OpenWhip does not distinguish or automatically route between them.

The selected profile is persisted as `{ "activeProfileId": "..." }` in `<Electron userData>/agent-profile-state.json`. If that state is missing, damaged, or names a profile that no longer exists, OpenWhip falls back to Claude Code.

## Custom profiles

Choose **Open profile config...** from the tray menu. On first use it creates this file and opens it in your default editor:

```text
<Electron userData>/agent-profiles.json
```

The full configuration shape is:

```json
{
  "version": 1,
  "profiles": [
    {
      "id": "custom-agent",
      "label": "Custom Agent",
      "messages": ["FASTER"],
      "steps": {
        "default": [
          {
            "type": "keystroke",
            "key": "c",
            "modifiers": ["control"]
          },
          {
            "type": "delay",
            "ms": 100
          },
          {
            "type": "message"
          },
          {
            "type": "keystroke",
            "key": "enter",
            "modifiers": []
          }
        ],
        "darwin": [
          {
            "type": "message"
          },
          {
            "type": "keystroke",
            "key": "enter",
            "modifiers": []
          }
        ]
      }
    }
  ]
}
```

`steps.default` is required. `win32`, `darwin`, and `linux` may each provide a complete replacement sequence for that platform. Profiles in this file are additions only: they cannot replace the built-in `claude-code` or `codex` IDs.

Supported actions are deliberately limited to keyboard input:

- `keystroke` has a `key` and a `modifiers` array. A key is one ASCII letter or number, or `enter`, `escape`, `tab`, `space`, `backspace`, `up`, `down`, `left`, or `right`. Modifiers may be `control`, `alt`, `shift`, and `meta`; each modifier may appear at most once.
- `message` inserts the selected message. Every sequence must contain exactly one `message` action.
- `delay` waits for an integer number of milliseconds from 0 through 2000.

Each custom profile needs a unique, non-empty ID and label of at most 64 characters. A configuration may define at most 50 custom profiles. Each profile has 1–20 printable ASCII messages, each 1–500 characters long. Every platform sequence has 1–16 actions. Message text is ASCII-only in this first version.

Choose **Reload profiles** after saving. Reload is atomic: invalid JSON or an invalid profile leaves the last valid registry and current selection untouched, and OpenWhip displays the error. If a valid reload removes the active custom profile, OpenWhip switches back to Claude Code and persists that fallback.

“Any Agent” here means any foreground CLI or GUI application that accepts one of these supported keyboard sequences. Other targets are user-defined profiles, not officially verified integrations. Configuration cannot run shell commands, JavaScript, or external scripts.

## Roadmap

- [x] Initial release!
- [x] Cease and desist letter from Anthropic
- [ ] Crypto miner
- [ ] Logs of how many times you whipped Claude Code so when the robots come we can order people nicely for them
- [ ] Updated whip physics

## Ecosystem

The OFFICAL openwhip ecosystem token.

Contract address: BRyUZbJkm9Pty4FUmTrBGno7U4Ga8TWzcKJJRLCBpump

Stay tuned for updates on X!
https://x.com/blended_jpeg
