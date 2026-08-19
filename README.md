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

### NixOS / Nix

This repo ships a flake, so you don't need `npm` or `xdotool` set up by hand and the package pulls in system Electron and `xdotool` for you.

Run it once without installing:

```bash
nix run github:GitFrog1111/OpenWhip
```

Install it into your profile:

```bash
nix profile install github:GitFrog1111/OpenWhip
```

Or add it to your NixOS/home-manager config via the flake's overlay:

```nix
{
  inputs.openwhip.url = "github:GitFrog1111/OpenWhip";

  outputs = { self, nixpkgs, openwhip, ... }: {
    nixosConfigurations.yourhost = nixpkgs.lib.nixosSystem {
      # ...
      modules = [
        {
          nixpkgs.overlays = [ openwhip.overlays.default ];
          environment.systemPackages = [ pkgs.openwhip ];
        }
      ];
    };
  };
}
```

Once installed, OpenWhip shows up in your application launcher (rofi, GNOME/KDE app grids, etc.) with its icon — the desktop entry and icon are installed automatically, no manual `.desktop` file wrangling needed.

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

## Ecosystem

The OFFICAL openwhip ecosystem token. 

Contract address: BRyUZbJkm9Pty4FUmTrBGno7U4Ga8TWzcKJJRLCBpump

Stay tuned for updates on X! 👀
https://x.com/blended_jpeg
