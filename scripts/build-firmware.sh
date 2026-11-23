#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."

toolchain=${RUST_TOOLCHAIN:-nightly-2026-10-08}
target_dir=target
elf=$target_dir/riscv32imfc-unknown-none-elf/release/ch32v307-ehci-debug
output=$target_dir/pages-firmware
objcopy=${OBJCOPY:-"$(rustc "+$toolchain" --print target-libdir)/../bin/llvm-objcopy"}
mkdir -p "$output"

build() {
  local variant=$1
  shift
  cargo "+$toolchain" build --locked --release --target-dir "$target_dir" "$@"
  "$objcopy" -O binary "$elf" "$output/ch32v307-ehci-debug-$variant.bin"
}

# Copy each variant before the next Cargo invocation replaces the output ELF.
build acm
build tcp --no-default-features --features tcp-bridge
build acm-tcp --features tcp-bridge
