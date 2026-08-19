{
  lib,
  buildNpmPackage,
  electron,
  makeWrapper,
  makeDesktopItem,
  copyDesktopItems,
  xdotool,
}: let
  pname = "openwhip";
  version = "6.7";

  desktopItem = makeDesktopItem {
    name = pname;
    desktopName = "OpenWhip";
    comment = "Whip to beat AI's arse";
    exec = pname;
    icon = pname;
    categories = [];
    terminal = false;
    startupWMClass = "openwhip";
  };
in
  buildNpmPackage {
    inherit pname version;
    src = ../.;
    npmDepsHash = "sha256-W2mUwhRWVN6z8lCfZOdBEBhM7zC+TMDbeTlV+RZbW8c=";

    nativeBuildInputs = [
      makeWrapper
      copyDesktopItems
    ];

    # Skip npm install scripts (electron tries to download binaries)
    # We use system Electron instead
    npmFlags = ["--ignore-scripts"];
    dontNpmBuild = true;

    # Install the app
    installPhase = ''
      runHook preInstall

      # Create directories
      mkdir -p $out/lib/${pname}
      mkdir -p $out/bin
      mkdir -p $out/lib/${pname}/icon/

      # Copy built files
      cp main.js $out/lib/${pname}/
      cp preload.js $out/lib/${pname}/
      cp package.json $out/lib/${pname}/
      cp overlay.html $out/lib/${pname}/
      cp -r sounds $out/lib/${pname}/
      cp icon/icon.ico $out/lib/${pname}/icon/
      cp icon/Template.png $out/lib/${pname}/icon/

      # Install the icon into the hicolor theme so application launchers
      # (rofi, GNOME Shell, KDE, etc.) can find it by the desktop entry's
      # Icon=${pname} name
      install -Dm444 icon/Template.png $out/share/icons/hicolor/512x512/apps/${pname}.png

      # Create wrapper script that uses system Electron
      # GPU flags help reduce compositor stutter on launch/close
      makeWrapper ${electron}/bin/electron $out/bin/${pname} \
        --add-flags "$out/lib/${pname}/main.js" \
        --add-flags "--disable-features=WaylandWindowDecorations" \
        --set ELECTRON_IS_DEV 0 \
        --prefix PATH : ${lib.makeBinPath [xdotool]}

      runHook postInstall
    '';

    desktopItems = [desktopItem];

    meta = with lib; {
      description = "openwhip";
      homepage = "idk bro";
      license = licenses.mit;
      platforms = platforms.unix;
      mainProgram = pname;
      maintainers = [
        eljangus
      ];
    };
  }
