// SPDX-License-Identifier: GPL-2.0-only
// Adapted from the DediBridge installer, 2026-11-23.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { FILENAMES, VARIANTS, validateImage } from "../src/images.ts";

export async function bundleFirmware({ input, output, commit }) {
  if (!input || !output || !/^[a-f0-9]{40}$/.test(commit ?? ""))
    throw new Error("Expected --input, --output and a full --commit SHA.");
  if (resolve(input) === resolve(output))
    throw new Error("Input and output must be separate directories.");

  const files = {};
  const images = new Map();
  for (const variant of VARIANTS) {
    const name = FILENAMES[variant];
    const bytes = validateImage(await readFile(join(input, name)));
    files[variant] = {
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    images.set(name, bytes);
  }

  await mkdir(output, { recursive: true });
  for (const [name, bytes] of images)
    await writeFile(join(output, name), bytes);
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify({ schema: 1, commit, files }, null, 2) + "\n",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      output: { type: "string" },
      commit: { type: "string" },
    },
  });
  await bundleFirmware(values);
}
