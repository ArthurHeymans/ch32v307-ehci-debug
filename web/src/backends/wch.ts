// SPDX-License-Identifier: GPL-2.0-only
// Adapted from the DediBridge installer, 2026-11-23.
import { WebUsbTransport, WchIspFlasher, type ConnectedChip } from "wchisp-web";
import type { Backend } from "../installer.js";

export function checkWchDevice(info: ConnectedChip): void {
  if (
    info.chipId !== 0x70 ||
    info.deviceType !== 0x17 ||
    info.chip?.name !== "CH32V307VCT6"
  ) {
    throw new Error(
      "This image requires CH32V307VCT6. Unknown or other chips cannot be flashed.",
    );
  }
  if (info.configRaw.length < 26 || info.uid.length !== 8)
    throw new Error("Incomplete CH32 configuration/UID response.");
  if (
    info.codeFlashProtected ||
    info.configRaw[2] !== 0xa5 ||
    !info.configRaw.slice(10, 14).every((byte) => byte === 0xff)
  ) {
    throw new Error(
      "CH32 flash is protected. Resolve protection with native tools; this installer never changes option bytes.",
    );
  }
  const config = new DataView(
    info.configRaw.buffer,
    info.configRaw.byteOffset,
    info.configRaw.byteLength,
  ).getUint32(2, true);
  if (((config >>> 22) & 3) === 3) {
    throw new Error(
      "CH32 is configured for only 32 KiB SRAM; the EHCI debug bridge needs at least 64 KiB. Configure with native tools first.",
    );
  }
}

export async function requestWch(): Promise<Backend> {
  const transport = await WebUsbTransport.request();
  const isp = new WchIspFlasher(transport);
  try {
    const info = await isp.connect();
    checkWchDevice(info);
    return {
      name: `CH32V307VCT6 · UID ${Array.from(info.uid, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
      async install(image, progress, signal) {
        signal.throwIfAborted();
        // Re-read identity/config immediately before erase, not just at pairing.
        checkWchDevice(await isp.connect());
        signal.throwIfAborted();
        await isp.flash(image, {
          unprotect: false,
          erase: true,
          verify: true,
          reset: false,
          progress(event) {
            signal.throwIfAborted();
            progress(event.phase, event.done, event.total);
          },
        });
        signal.throwIfAborted();
        try {
          await isp.reset();
          return { rebooted: true };
        } catch {
          signal.throwIfAborted();
          return { rebooted: false };
        }
      },
      close: () => isp.close(),
    };
  } catch (error) {
    await isp.close();
    throw error;
  }
}
