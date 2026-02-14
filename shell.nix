{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  # 1. Development tools
  nativeBuildInputs = with pkgs; [
    nodejs
    pkg-config
    gcc
  ];

  # 2. Runtime dependencies (libraries Electron needs to open a window)
  buildInputs = with pkgs; [
    mono             # REQUIRED for Inky's internal compiler
    at-spi2-atk
    atk
    alsa-lib
    cairo
    cups
    dbus
    expat
    fontconfig
    freetype
    gdk-pixbuf
    glib
    gtk3
    libGL
    libuuid
    libxml2
    libxkbcommon
    mesa
    nspr
    nss
    pango
    udev             # Important for hardware/input handling in Electron
    xorg.libX11
    xorg.libXcomposite
    xorg.libXcursor
    xorg.libXdamage
    xorg.libXext
    xorg.libXfixes
    xorg.libXi
    xorg.libXrandr
    xorg.libXrender
    xorg.libXScrnSaver
    xorg.libXtst
    xorg.xcbutil
  ];

  shellHook = ''
    # This creates a path to all the libraries listed above
    # Electron uses this to find its shared objects (.so files)
    export LD_LIBRARY_PATH=${pkgs.lib.makeLibraryPath (with pkgs; [
      stdenv.cc.cc.lib
      at-spi2-atk atk alsa-lib cairo cups dbus expat fontconfig
      freetype gdk-pixbuf glib gtk3 libGL libuuid libxml2
      libxkbcommon mesa nspr nss pango udev
      xorg.libX11 xorg.libXcomposite xorg.libXcursor xorg.libXdamage
      xorg.libXext xorg.libXfixes xorg.libXi xorg.libXrandr
      xorg.libXrender xorg.libXScrnSaver xorg.libXtst xorg.xcbutil
    ])}:$LD_LIBRARY_PATH

    # Common fix for Electron apps in Nix shells
    export ELECTRON_DISABLE_SANDBOX=1
  '';
}