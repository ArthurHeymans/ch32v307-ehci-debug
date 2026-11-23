// SPDX-License-Identifier: GPL-2.0-only
// Adapted from the DediBridge installer, 2026-11-23.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "*.spec.mjs",
  fullyParallel: true,
  use: {
    baseURL: "http://127.0.0.1:4174/ch32v307-ehci-debug/",
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tests/browser/server.mjs",
    url: "http://127.0.0.1:4174/ch32v307-ehci-debug/",
    timeout: 10000,
    reuseExistingServer: false,
  },
});
