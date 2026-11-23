// SPDX-License-Identifier: GPL-2.0-only
// Adapted from the DediBridge installer, 2026-11-23.
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import metadata from "../package.json" with { type: "json" };

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
await rm("dist", { recursive: true, force: true });
await mkdir("dist/licenses", { recursive: true });
await build({
  entryPoints: ["src/app.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: "dist/app.js",
  target: "es2022",
  sourcemap: true,
  minify: true,
  legalComments: "linked",
});
await cp("style.css", "dist/style.css");
const rules = await readFile("../udev/70-wch-isp.rules", "utf8");
const html = await readFile("index.html", "utf8");
const marker = "<!-- udev-rules -->";
if (!html.includes(marker)) throw new Error("Missing udev help placeholder.");
const escapedRules = rules
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");
await writeFile(
  "dist/index.html",
  html.replace(marker, () => escapedRules),
);
await writeFile("dist/70-wch-isp.rules", rules);
await cp("LICENSE", "dist/licenses/GPL-2.0.txt");

// Offer the exact corresponding installer and dependency sources on the site.
await mkdir("dist/sources/udev", { recursive: true });
await writeFile("dist/sources/udev/70-wch-isp.rules", rules);
await mkdir("dist/sources/installer", { recursive: true });
for (const file of [
  "src",
  "scripts",
  "tests",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "playwright.config.mjs",
  "index.html",
  "style.css",
  "README.md",
  "LICENSE",
]) {
  await cp(file, `dist/sources/installer/${file}`, { recursive: true });
}
await mkdir("dist/sources/wchisp-web", { recursive: true });
for (const file of [
  "src",
  "package.json",
  "tsconfig.json",
  "rolldown.config.js",
  "README.md",
  "LICENSE",
]) {
  await cp(
    `node_modules/wchisp-web/${file}`,
    `dist/sources/wchisp-web/${file}`,
    { recursive: true },
  );
}
await writeFile(
  "dist/sources/README.md",
  `# Corresponding source and licenses

Installer (GPL-2.0-only): source and build inputs in [installer/](./installer/README.md).
Derived from [DediBridge’s browser installer](https://github.com/ArthurHeymans/dedibridge/tree/e03eac70d6dea87012c4b93d891dc6098ea45a84/web).

WCH ISP (GPL-2.0-only): source and build inputs in [wchisp-web/](./wchisp-web/README.md).
Pinned dependency: ${metadata.dependencies["wchisp-web"]}
`,
);
