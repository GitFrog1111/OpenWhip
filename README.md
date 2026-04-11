# badclaude

![Whip divider](assets/divider.png)

Sometimes claude code is going too shlow, and you must whip him into shape..

## Install + run

```bash
npm install -g badclaude
badclaude
```

## Platform support

- Windows: full support.
- macOS: full support after granting Accessibility permissions to the terminal or packaged app.
- Linux X11/Xorg: full whip mode when `xdotool` is installed.
- Linux Wayland: the app prefers X11/XWayland automatically when available so the overlay can render more reliably; global typing into native Wayland apps may still be unavailable by design.

### Linux notes

For full Linux automation on X11/Xorg, install `xdotool` first.

Examples:

```bash
# Debian/Ubuntu
sudo apt install xdotool

# Fedora
sudo dnf install xdotool

# Arch
sudo pacman -S xdotool
```

Wayland sessions can still run the app, but some desktops block the exact cross-app keyboard automation this toy relies on. On GNOME-like desktops, tray support may also depend on AppIndicator/StatusNotifier extensions.

On GNOME, badclaude also shows a small floating launcher window because the tray icon is often hidden entirely.

## Controls

- Click tray icon: spawn whip.
- Click: drop whip.
- Whip him 😩💢
- It sends an interrupt (Ctrl-C) and one of 5 encouraging messages!

## Roadmap

- [x] Initial release! 🥳
- [x] Cease and desist letter from Anthropic
- [ ] Crypto miner
- [ ] Logs of how many times you whipped claude so when the robots come we can order people nicely for them
- [ ] Updated whip physics
