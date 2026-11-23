// SPDX-License-Identifier: GPL-2.0-only
// Adapted from the DediBridge installer, 2026-11-23.
import { Installer } from "./installer.js";
import {
  FILENAMES,
  MAX_IMAGE_BYTES,
  sha256,
  validateImage,
  type Variant,
} from "./images.js";
import { loadRelease, loadReleaseImage, type Release } from "./releases.js";
import { requestWch } from "./backends/wch.js";

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element: ${id}`);
  return found as T;
}
const installer = new Installer();
const controls = {
  variants: element<HTMLFieldSetElement>("firmware-choices"),
  file: element<HTMLInputElement>("file"),
  confirm: element<HTMLInputElement>("confirm"),
  connect: element<HTMLButtonElement>("connect"),
  disconnect: element<HTMLButtonElement>("disconnect"),
  install: element<HTMLButtonElement>("install"),
  stop: element<HTMLButtonElement>("stop"),
  useRelease: element<HTMLButtonElement>("use-release"),
  progress: element<HTMLProgressElement>("progress"),
  download: element<HTMLAnchorElement>("download"),
};
const radios = document.querySelectorAll<HTMLInputElement>(
  'input[name="variant"]',
);
let variant: Variant = "acm";
let release: Release | null = null;
let verifiedVariant: Variant | undefined;
let image: Uint8Array | undefined;
let uiBusy = false;
const supported = window.isSecureContext && Boolean(navigator.usb);

function log(message: string): void {
  const output = element("log");
  output.textContent =
    `${output.textContent}\n${new Date().toLocaleTimeString()}  ${message}`
      .trim()
      .slice(-20000);
  output.scrollTop = output.scrollHeight;
}
function status(message: string, kind = "info"): void {
  const output = element("status");
  output.textContent = message;
  output.dataset.kind = kind;
}
function render(): void {
  const busy = uiBusy || installer.busy;
  controls.variants.disabled = busy;
  controls.file.disabled = busy;
  controls.confirm.disabled = busy || !image || !installer.connected;
  controls.useRelease.disabled = busy || !release;
  controls.connect.disabled = busy || installer.connected || !supported;
  controls.disconnect.disabled = busy || !installer.connected;
  controls.install.disabled =
    busy || !image || !installer.connected || !controls.confirm.checked;
  element("device").textContent = installer.deviceName;
  element("device-indicator").classList.toggle(
    "connected",
    installer.connected,
  );
  element("unsupported").hidden = supported;
  element("manual-image").textContent = FILENAMES[variant];

  const downloadable = verifiedVariant === variant;
  controls.download.hidden = !downloadable;
  if (downloadable) {
    controls.download.href = `./firmware/${FILENAMES[variant]}`;
    controls.download.download = FILENAMES[variant];
  } else {
    controls.download.removeAttribute("href");
  }
}

async function action(operation: () => Promise<void>): Promise<void> {
  if (uiBusy) return;
  uiBusy = true;
  render();
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const accessDenied =
      /access denied|permission denied|libusb_error_access/i.test(message);
    if (accessDenied)
      element<HTMLDetailsElement>("usb-permissions").open = true;
    status(
      accessDenied
        ? `${message} See USB access & udev rules below, then reconnect the bootloader.`
        : message,
      "error",
    );
    log(message);
  } finally {
    uiBusy = false;
    render();
  }
}

function clearImage(): void {
  image = undefined;
  controls.confirm.checked = false;
  controls.progress.value = 0;
  element("image-info").hidden = true;
}

async function setImage(
  bytes: Uint8Array,
  filename: string,
  source: string,
): Promise<void> {
  const hash = await sha256(bytes);
  image = bytes;
  element("image-info").hidden = false;
  element("image-name").textContent = filename;
  element("image-size").textContent =
    `${bytes.length.toLocaleString()} bytes · ${source}`;
  element("image-hash").textContent = `SHA-256 ${hash}`;
  status(
    installer.connected
      ? "Image checked. Confirm the board and erase warning before installing."
      : "Image checked. Connect the bootloader, then confirm the board and erase warning.",
  );
  log(`Image validated: ${filename} · ${source} · SHA-256 ${hash}`);
}

async function useRelease(): Promise<void> {
  clearImage();
  controls.file.value = "";
  verifiedVariant = undefined;
  render();
  if (!release) {
    status("Choose a local firmware image to begin.");
    return;
  }
  status("Downloading and checking the firmware image…");
  await setImage(
    await loadReleaseImage(release, variant),
    FILENAMES[variant],
    "bundled firmware · checksum matched",
  );
  verifiedVariant = variant;
}

for (const radio of radios) {
  radio.checked = radio.value === variant;
  radio.addEventListener("change", () => {
    void action(async () => {
      if (!Object.hasOwn(FILENAMES, radio.value))
        throw new Error("Unknown firmware variant.");
      variant = radio.value as Variant;
      await useRelease();
    });
  });
}
controls.useRelease.addEventListener("click", () => {
  void action(useRelease);
});
controls.file.value = "";
controls.file.addEventListener("change", () => {
  void action(async () => {
    clearImage();
    const file = controls.file.files?.[0];
    if (!file) {
      status("Choose a firmware image to continue.");
      return;
    }
    if (!file.name.toLowerCase().endsWith(".bin"))
      throw new Error("Choose a .bin firmware file.");
    if (file.size < 4 || file.size > MAX_IMAGE_BYTES)
      throw new Error("CH32 image must be a raw BIN of 4–196608 bytes.");
    await setImage(
      validateImage(new Uint8Array(await file.arrayBuffer())),
      file.name,
      "local file · not authenticated",
    );
  });
});
controls.confirm.checked = false;
controls.confirm.addEventListener("change", render);
controls.connect.addEventListener("click", () => {
  void action(async () => {
    controls.confirm.checked = false;
    controls.progress.value = 0;
    status("Select the WCH bootloader in the browser USB chooser…");
    await installer.connect(requestWch);
    status(
      "Bootloader connected. Set BOOT0 low without resetting, then check the image and confirm before installing.",
    );
    log(`Connected: ${installer.deviceName}`);
  });
});
controls.disconnect.addEventListener("click", () => {
  void action(async () => {
    await installer.disconnect();
    controls.confirm.checked = false;
    status("Disconnected.");
    log("Disconnected.");
  });
});
controls.install.addEventListener("click", () => {
  void action(async () => {
    if (!image) throw new Error("Choose an image first.");
    controls.stop.disabled = false;
    controls.progress.value = 0;
    status("Checking the bootloader before erasing…");
    let lastPhase = "";
    try {
      const result = await installer.install(
        image,
        controls.confirm.checked,
        (phase, done, total) => {
          const stage = ["erase", "write", "verify"].indexOf(phase);
          if (stage < 0) return;
          const fraction = total > 0 ? Math.min(1, done / total) : 0;
          controls.progress.value = ((stage + fraction) / 3) * 100;
          status(
            `${phase.charAt(0).toUpperCase() + phase.slice(1)} · ${Math.round(fraction * 100)}%`,
          );
          if (phase !== lastPhase) {
            log(`Starting ${phase}.`);
            lastPhase = phase;
          }
        },
      );
      controls.progress.value = 100;
      const message = result.rebooted
        ? "Firmware written and verified. Reboot requested; check the bridge on your board."
        : "Firmware written and verified, but reboot was not confirmed. Set BOOT0 low and reset the board manually.";
      status(message, "success");
      log(message);
    } finally {
      controls.stop.disabled = true;
      controls.confirm.checked = false;
    }
  });
});
controls.stop.addEventListener("click", () => {
  installer.cancel();
  controls.stop.disabled = true;
  status(
    "Stopping. Firmware may be incomplete; re-enter ISP mode before retrying.",
  );
  log("Stop requested.");
});
window.addEventListener("pagehide", () => {
  if (installer.busy) installer.cancel();
  else void installer.disconnect();
});

void action(async () => {
  try {
    release = await loadRelease();
  } catch (error) {
    element("release").textContent =
      "Bundled firmware unavailable. Choose a trusted local image or follow the manual guide.";
    throw error;
  }
  element("release").textContent = release
    ? `Bundled build · source ${release.commit.slice(0, 12)}`
    : "No firmware bundled with this build. Choose a trusted local image.";
  await useRelease();
});
