# OpenWhip

![Whip divider](assets/divider.png)

Sometimes claude code is going too shlow, and you must whip him into shape..

## Install + run

```bash
npm install -g openwhip
openwhip
```

windows and mac supported out of the box, but Linux is a special snowflake so you need to install `xdotool` for keyboard automation

```bash
sudo apt install xdotool
```

## Controls

- Click tray icon: spawn whip.
- Click: drop whip.
- Whip him 😩💢
- It sends an interrupt (Ctrl-C) and one of 5 encouraging messages!

## Linux Setup

### X11

```bash
# Debian/Ubuntu
sudo apt install xdotool

# Arch
sudo pacman -S xdotool
```

### Wayland (GNOME, etc.)

```bash
# Arch
sudo pacman -S ydotool

# Debian/Ubuntu
sudo apt install ydotool
```

Enable and start the ydotool daemon:

```bash
sudo systemctl enable --now ydotool
sudo usermod -aG input $USER
```

Log out and back in for the group change to take effect.

### GNOME Tray Icon

GNOME doesn't show tray icons by default. Install the AppIndicator extension:

```bash
# Arch
sudo pacman -S gnome-shell-extension-appindicator

# Debian/Ubuntu
sudo apt install gnome-shell-extension-appindicator
```

Enable it via GNOME Extensions app or:

```bash
gnome-extensions enable appindicatorsupport@rgcjonas.gmail.com
```

## Roadmap

- [x] Initial release! 🥳
- [x] Cease and desist letter from Anthropic
- [ ] Crypto miner
- [ ] Logs of how many times you whipped claude so when the robots come we can order people nicely for them
- [ ] Updated whip physics