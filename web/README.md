# CH32V307 EHCI debug bridge installer

Static TypeScript and WebUSB, adapted from [DediBridge’s firmware installer][dedi]
on 2026-11-23. The web installer and its commit-pinned `wchisp-web` dependency
are GPL-2.0-only; the Pages build ships their source, build inputs and licenses
under `dist/sources/` and `dist/licenses/`.

## Develop and test

From `web/` with Node.js 24+:

```sh
npm ci
npm run format:check
npm test
npm run build
npx playwright install --with-deps chromium
npm run test:browser
```

Serve `dist/` on localhost for development or over HTTPS when hosted. A build
without a firmware manifest accepts trusted local `.bin` images. Browser tests
mock WebUSB; they never flash connected hardware. The test server uses the Pages
project subpath (`/ch32v307-ehci-debug/`).

## Bundle firmware

Start in the repository root. The Rust build pins the tested HAL commit and
requires no sibling checkout. Install the same Rust toolchain as CI, with the
standard library sources for the custom RISC-V target and LLVM for ELF-to-BIN
conversion:

```sh
rustup toolchain install nightly-2026-10-08 --profile minimal \
  --component rust-src --component llvm-tools
bash scripts/build-firmware.sh
cd web
npm run build
npm run firmware -- --input ../target/pages-firmware --output dist/firmware \
  --commit "$(git rev-parse HEAD)"
TEST_BUNDLED_FIRMWARE=1 npm run test:browser
```

`npm run build` cleans `dist/`, so bundle after building. Generated images are
raw BIN at flash offset zero, without SDI or RTT logging. The manifest identifies
the source commit and records the size and SHA-256 of each bundled image. These
checks detect mismatched downloads; they do not authenticate a compromised site.

## Publish with GitHub Pages

Set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**.
The `Firmware installer` workflow builds and tests pull requests without
publishing. A successful run on `master` deploys the app and all three firmware
variants together to <https://arthurheymans.github.io/ch32v307-ehci-debug/>.

## USB requirements

Use desktop Chrome or Edge. Enter WCH ISP with BOOT0 high and BOOT1 low, connect
using USBHS, then return BOOT0 low without resetting. The flasher checks for
CH32V307VCT6 with at least 64 KiB configured SRAM and no flash protection before
erasing. It does not change option bytes. Verify is mandatory. If stopped during
an install, the board may have incomplete firmware; re-enter ISP before retrying.

The page includes Linux udev setup, a downloadable rule, Windows WinUSB guidance,
and a manual `wchisp` fallback. A local raw BIN is checked for size and common
wrong formats but cannot identify its target or bridge variant.

[dedi]: https://github.com/ArthurHeymans/dedibridge/tree/e03eac70d6dea87012c4b93d891dc6098ea45a84/web
