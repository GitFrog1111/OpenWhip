{
  description = "OpenWhip: Sometimes claude code is going too shlow, and you must whip him into shape..";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = {
    self,
    nixpkgs,
    ...
  }: let
    inherit (nixpkgs.lib) getExe genAttrs;

    systems = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];

    forEachSystem = perSystem:
      genAttrs systems (
        system:
          perSystem {
            pkgs = nixpkgs.legacyPackages.${system};
            inherit system;
          }
      );
  in {
    overlays.default = final: prev: {
      openwhip = final.callPackage ./nix/package.nix {};
    };

    packages = forEachSystem (
      {pkgs, ...}: rec {
        openwhip = pkgs.callPackage ./nix/package.nix {};
        default = openwhip;
      }
    );

    apps = forEachSystem (
      {system, ...}: {
        default = {
          type = "app";
          program = getExe self.packages.${system}.default;
        };
      }
    );
  };
}
