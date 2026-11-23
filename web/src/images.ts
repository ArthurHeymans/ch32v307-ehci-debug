// SPDX-License-Identifier: GPL-2.0-only
// Adapted from the DediBridge installer, 2026-11-23.
export const FILENAMES = {
  acm: "ch32v307-ehci-debug-acm.bin",
  tcp: "ch32v307-ehci-debug-tcp.bin",
  "acm-tcp": "ch32v307-ehci-debug-acm-tcp.bin",
} as const;
export type Variant = keyof typeof FILENAMES;
export const VARIANTS = Object.keys(FILENAMES) as Variant[];
// Stay within the smallest flash partition on a compatible CH32V307VCT6.
export const MAX_IMAGE_BYTES = 192 * 1024;

export function validateImage(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes.length > MAX_IMAGE_BYTES)
    throw new Error("CH32 image must be a raw BIN of 4–196608 bytes.");
  const magic = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(0, true);
  if (magic === 0x464c457f || magic === 0x0a324655)
    throw new Error("Choose the raw CH32 BIN, not an ELF or UF2 image.");
  return Uint8Array.from(bytes);
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes).buffer,
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
