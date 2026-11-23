# CH32V307 EHCI debug bridge

Rust/Embassy firmware for using a CH32V307 as a coreboot EHCI debug dongle.

- USBHS (PB7/PB6) is the DUT-facing high-speed USB 2.0 device.
- EHCI debug transactions are limited to 8-byte packets; the debug class uses
  8-byte bulk endpoints and advertises them through `USB_DT_DEBUG`.
- Bridge backends:
  - `acm-bridge` (default): OTG_FS (PA12/PA11) presents a CDC-ACM serial port.
  - `tcp-bridge`: the devboard Ethernet PHY gets an address via DHCP and listens on TCP port `3333`.
  - Both can be enabled at once: DUT output is fanned out to ACM and TCP, while input from either backend is forwarded to the DUT.

![CH32V307 reference board](assets/ch32v307.jpg)

## Install from your browser

Open the [firmware installer](https://arthurheymans.github.io/ch32v307-ehci-debug/)
in desktop Chrome or Edge. Choose **USB serial**, **Ethernet**, or **USB serial +
Ethernet**, then follow the on-screen WCH ISP instructions. The installer uses
USBHS for flashing and verifies the write before it requests a reboot. It supports
unprotected **CH32V307VCT6** boards with at least **64 KiB of configured SRAM** and
never changes option bytes. You can also download the selected `.bin` for manual
flashing. See [the web installer README](web/README.md) for local development and
GitHub Pages setup.

## Build

Default CDC-ACM bridge:

```sh
nix develop
cargo build --release
```

CDC-ACM plus TCP bridge:

```sh
nix develop
cargo build --release --features tcp-bridge
```

TCP-only bridge:

```sh
nix develop
cargo build --release --no-default-features --features tcp-bridge
```

The release ELF is written to:

```text
target/riscv32imfc-unknown-none-elf/release/ch32v307-ehci-debug
```

## Flash

To flash a downloaded `.bin` without a browser, disconnect the board from the
coreboot target. Set **BOOT0 high, BOOT1 low**, reset or power-cycle, and connect
USBHS (not USB serial or WCH-Link) to your computer. Check the chip before
flashing:

```sh
wchisp info
wchisp flash ch32v307-ehci-debug-acm.bin
```

Use the filename of the variant you downloaded. Set **BOOT0 low** and reset
again if needed. The [WCH ISP udev rules](udev/70-wch-isp.rules) grant access to
the ROM bootloader from a local Linux desktop session. Install them under
`/etc/udev/rules.d/`, run `sudo udevadm control --reload-rules`, and replug in ISP
mode. If building locally, `bash scripts/build-firmware.sh` generates all three
`.bin` files under `target/pages-firmware/` (see the [toolchain prerequisites](web/README.md#bundle-firmware)).

SDI logging is disabled by default: it blocks startup when no debugger is
reading the debug registers. Enable `--features sdi-log` only with a WCH-Link
actively draining SDI output (for example, the cargo runner below).

WCH-Link firmware older than v2.10 can't drain SDI at all. With such a
probe, use `--features defmt` instead: it logs over RTT (never blocking without
a reader) and includes the HAL's and embassy-usb's own logging plus a 2 s
register heartbeat. Pick the level with `DEFMT_LOG` at build time:

```sh
DEFMT_LOG=debug cargo build --release --features defmt
probe-rs run --chip CH32V307VCT6 target/riscv32imfc-unknown-none-elf/release/ch32v307-ehci-debug
```

`DEFMT_LOG=trace` also logs every USB interrupt.

The cargo runner is configured for WCH-Link:

```sh
nix develop
cargo run --release
```

TCP-only build:

```sh
cargo run --release --no-default-features --features tcp-bridge
```

ACM plus TCP build:

```sh
cargo run --release --features tcp-bridge
```

## coreboot configuration

In coreboot's `src/drivers/usb/Kconfig`, select:

```text
Type of dongle -> USB gadget driver or Net20DC
CONFIG_USBDEBUG_DONGLE_STD=y
```

This firmware implements the standard USB 2.0 EHCI debug device path: coreboot
probes it with `GET_DESCRIPTOR(USB_DT_DEBUG)`, enables it with
`SET_FEATURE(USB_DEVICE_DEBUG_MODE)`, then uses the advertised bulk IN/OUT debug
endpoint addresses for 8-byte debug transactions. Do not select the FTDI FT232H
or WCH CH347 dongle options; those are for UART bridge chips with
vendor-specific setup requests, not for this firmware.

`USBDEBUG_DONGLE_STD` is coreboot's default dongle type. You still need the usual board-specific USB debug settings, such as `CONFIG_USBDEBUG=y`, the correct EHCI controller index, and possibly the debug port number.

## TCP usage

Flash a build with `tcp-bridge`, connect Ethernet, then connect to the DHCP-assigned address on port `3333`:

```sh
nc <board-ip> 3333
```

The TCP stream is a raw bidirectional byte bridge to coreboot's EHCI debug console. Only one TCP client is accepted at a time; reconnecting starts a new bridge session. In the combined ACM+TCP build, DUT output is broadcast with `embassy_sync::pubsub::PubSubChannel::publish_immediate()`, so an inactive backend does not stall the other one. If the output queue is full, the oldest queued byte is discarded to make room for the newest byte; subscribers skip lagged data with `next_message_pure()`.

## Notes

The `embassy-usb` change that lets class handlers answer
`GET_DESCRIPTOR(USB_DT_DEBUG)` and `SET_FEATURE(USB_DEVICE_DEBUG_MODE)` is
upstream in [embassy-rs/embassy#6408](https://github.com/embassy-rs/embassy/pull/6408).
No `embassy-usb` release contains it yet, so `[patch.crates-io]` pins Embassy
to the same git source and revision as `../ch32-hal` until one does. Keep these
in sync when updating the HAL, otherwise Cargo creates incompatible copies of
the USB driver trait.

The `ch32-hal` USB fixes this firmware needs — reserve endpoint 0 for control
transfers (otherwise CDC-ACM can accidentally allocate data endpoints 0/0x80 and
Linux may drop the ACM device when the tty is opened), arm OUT endpoints as soon
as a configuration enables them (coreboot sends a probe write immediately after
configuring the EHCI debug device), and wake endpoint tasks on reset — are
proposed upstream as [ch32-rs/ch32-hal#189](https://github.com/ch32-rs/ch32-hal/pull/189).
The firmware pins the same `ch32-hal` fork revision for local and GitHub Pages
builds, so a sibling checkout is not required.

The current `ch32-hal` USBHS driver cannot allocate the same endpoint index for
both directions, so this firmware advertises debug OUT endpoint 1 and debug IN
endpoint 2. coreboot reads those addresses from the USB debug descriptor. The
bridge drops coreboot's initial `USB\r\n` probe write instead of forwarding it to
ACM/TCP clients, and the ACM backend waits for DTR before sending data to the
host tty.
