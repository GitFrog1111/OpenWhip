# badclaude

![Whip divider](assets/divider.png)

Sometimes claude code is going too slow, and you must whip him into shape..

## Desktop app (Electron)

```bash
npm install -g badclaude
badclaude
```

### Controls

- Click tray icon: spawn whip.
- Click: drop whip.
- Whip him — it sends an interrupt (Ctrl-C) and one of 5 encouraging messages!

## VS Code / Cursor extension

A local extension that lives in `vscode-extension/`. The whip runs inside an editor tab and cracks into both your terminal and the AI chat.

### Install

Symlink the extension into your editor's extensions directory:

```bash
# Cursor
ln -s "$(pwd)/vscode-extension" ~/.cursor/extensions/badclaude

# VS Code
ln -s "$(pwd)/vscode-extension" ~/.vscode/extensions/badclaude
```

Then install dependencies and reload:

```bash
cd vscode-extension && npm install
```

Reload the editor (Cmd+Shift+P → "Developer: Reload Window").

### Usage

- **Status bar**: click the `⚡ Bad Claude` button
- **Command palette**: `Bad Claude: Toggle Whip`
- **Keybinding**: `Cmd+Shift+W` (macOS) / `Ctrl+Shift+W` (Win/Linux)

Move your mouse to swing the whip. When it cracks it sends an interrupt + encouraging message to the active terminal and the AI chat. Click to drop the whip.

### Platform notes

- **macOS**: requires Accessibility permission for the chat macro (System Settings → Privacy & Security → Accessibility → enable Cursor/VS Code).
- **Windows**: uses PowerShell SendKeys — works out of the box.
- **Linux (X11)**: requires `xdotool` — `sudo apt install xdotool`.

## Roadmap

- [x] Initial release!
- [x] VS Code / Cursor extension
- [ ] Cease and desist letter from Anthropic
- [ ] Crypto miner
- [ ] Logs of how many times you whipped claude so when the robots come we can order people nicely for them
- [ ] Updated whip physics
