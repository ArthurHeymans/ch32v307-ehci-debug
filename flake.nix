{
  description = "CH32V307 EHCI debug USB bridge firmware";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay.url = "github:oxalica/rust-overlay";
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ rust-overlay.overlays.default ];
        pkgs = import nixpkgs { inherit system overlays; };
        rust = pkgs.rust-bin.nightly.latest.default.override {
          extensions = [ "rust-src" "rustfmt" "clippy" ];
        };
      in {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            rust
            cargo-binutils
            llvmPackages.bintools
            pkg-config
            wlink
            probe-rs-tools
            jj
          ];
          RUST_SRC_PATH = "${rust}/lib/rustlib/src/rust/library";
        };
      });
}
