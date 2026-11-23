import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bundleFirmware } from "../scripts/firmware.mjs";
import {
  FILENAMES,
  MAX_IMAGE_BYTES,
  validateImage,
} from "../.test-build/src/images.js";
import { parseRelease } from "../.test-build/src/releases.js";

const commit = "a".repeat(40);

test("BIN validation bounds downloads and rejects ELF and UF2 inputs", () => {
  for (const size of [0, 3, MAX_IMAGE_BYTES + 1])
    assert.throws(() => validateImage(new Uint8Array(size)), /raw BIN/);
  for (const magic of [
    [0x7f, 0x45, 0x4c, 0x46],
    [0x55, 0x46, 0x32, 0x0a],
  ])
    assert.throws(
      () => validateImage(Uint8Array.from(magic)),
      /not an ELF or UF2/,
    );
  const bin = Uint8Array.of(0x6f, 0, 0, 0);
  assert.deepEqual(validateImage(bin), bin);
  assert.notEqual(validateImage(bin), bin);
});

test("the manifest describes exactly the three bundled images", async (t) => {
  const input = await mkdtemp(join(tmpdir(), "ehci-"));
  t.after(() => rm(input, { recursive: true, force: true }));
  const output = join(input, "bundle");
  const images = {};
  let marker = 0;
  for (const [variant, filename] of Object.entries(FILENAMES)) {
    const bin = Buffer.from([0x6f, 0, marker++, 0]);
    images[variant] = bin;
    await writeFile(join(input, filename), bin);
  }
  await bundleFirmware({ input, output, commit });
  const manifest = JSON.parse(
    await readFile(join(output, "manifest.json"), "utf8"),
  );
  const release = parseRelease(manifest);
  assert.equal(release.commit, commit);
  for (const [variant, filename] of Object.entries(FILENAMES)) {
    const bin = await readFile(join(output, filename));
    assert.deepEqual(bin, images[variant]);
    assert.deepEqual(release.files[variant], {
      size: bin.length,
      sha256: createHash("sha256").update(bin).digest("hex"),
    });
  }
  delete manifest.files.tcp;
  assert.throws(() => parseRelease(manifest), /metadata for tcp/);
  await writeFile(join(input, FILENAMES.tcp), Buffer.alloc(1));
  const rejected = join(input, "rejected");
  await assert.rejects(
    bundleFirmware({ input, output: rejected, commit }),
    /raw BIN/,
  );
  await assert.rejects(readFile(join(rejected, "manifest.json")), {
    code: "ENOENT",
  });
});
