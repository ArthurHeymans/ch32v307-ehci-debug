// SPDX-License-Identifier: GPL-2.0-only
// Adapted from the DediBridge installer, 2026-11-23.
import {
  FILENAMES,
  MAX_IMAGE_BYTES,
  VARIANTS,
  sha256,
  validateImage,
  type Variant,
} from "./images.js";

interface ReleaseFile {
  size: number;
  sha256: string;
}
export interface Release {
  schema: 1;
  commit: string;
  files: Record<Variant, ReleaseFile>;
}

export function parseRelease(value: unknown): Release {
  const input = value as Partial<Release> | null;
  if (
    input?.schema !== 1 ||
    typeof input.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(input.commit)
  )
    throw new Error("Invalid firmware manifest.");
  const files = {} as Record<Variant, ReleaseFile>;
  for (const variant of VARIANTS) {
    const file = input.files?.[variant];
    if (
      !file ||
      !Number.isSafeInteger(file.size) ||
      file.size < 4 ||
      file.size > MAX_IMAGE_BYTES ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error(`Invalid firmware metadata for ${variant}.`);
    files[variant] = { size: file.size, sha256: file.sha256 };
  }
  return { schema: 1, commit: input.commit, files };
}

async function readResponse(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  if (!response.ok || !response.body)
    throw new Error(`Download failed (HTTP ${response.status}).`);
  const reader = response.body.getReader();
  const bytes = new Uint8Array(limit);
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return bytes.subarray(0, size);
      if (size + value.length > limit)
        throw new Error("Download exceeds the expected size.");
      bytes.set(value, size);
      size += value.length;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function loadRelease(): Promise<Release | null> {
  const response = await fetch("./firmware/manifest.json", {
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return null;
  const text = new TextDecoder().decode(
    await readResponse(response, 16 * 1024),
  );
  try {
    return parseRelease(JSON.parse(text));
  } catch (cause) {
    throw new Error("Invalid bundled firmware manifest.", { cause });
  }
}

export async function loadReleaseImage(
  release: Release,
  variant: Variant,
): Promise<Uint8Array> {
  const file = release.files[variant];
  const response = await fetch(`./firmware/${FILENAMES[variant]}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
  });
  const bytes = await readResponse(response, file.size);
  if (bytes.length !== file.size || (await sha256(bytes)) !== file.sha256)
    throw new Error(
      "Bundled image checksum/size mismatch. Nothing was flashed.",
    );
  return validateImage(bytes);
}
