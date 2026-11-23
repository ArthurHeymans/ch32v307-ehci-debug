// SPDX-License-Identifier: GPL-2.0-only
// Adapted from the DediBridge installer, 2026-11-23.
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { FILENAMES } from "../../src/images.ts";

const bin = Buffer.from([0x6f, 0, 0, 0, 1, 2, 3, 4]);

async function mockWch(page, options = {}) {
  await page.addInitScript((options) => {
    window.usbCommands = [];
    let command = 0;
    let configReads = 0;
    let rejectRead;
    const device = {
      opened: false,
      vendorId: 0x4348,
      productId: 0x55e0,
      configuration: {
        configurationValue: 1,
        interfaces: [
          {
            interfaceNumber: 0,
            alternates: [
              {
                endpoints: [
                  { endpointNumber: 2, direction: "in" },
                  { endpointNumber: 2, direction: "out" },
                ],
              },
            ],
          },
        ],
      },
      async open() {
        if (options.accessDenied)
          throw new DOMException("Access denied", "SecurityError");
        this.opened = true;
      },
      async claimInterface() {},
      async close() {
        this.opened = false;
        rejectRead?.(new DOMException("USB session closed", "AbortError"));
      },
      async transferOut(_endpoint, bytes) {
        command = bytes[0];
        window.usbCommands.push(command);
        return { status: "ok", bytesWritten: bytes.byteLength };
      },
      async transferIn() {
        if (command === 0xa5 && options.stallWrite)
          return new Promise((_resolve, reject) => {
            rejectRead = reject;
          });
        let payload = [0];
        if (command === 0xa1) payload = [options.chipId ?? 0x70, 0x17];
        if (command === 0xa7) {
          configReads++;
          payload = Array(26).fill(0);
          payload[2] =
            options.protected || (options.protectOnRecheck && configReads > 1)
              ? 0
              : 0xa5;
          payload[4] = options.smallRam ? 0xc0 : 0;
          payload.fill(0xff, 10, 14);
          payload.splice(18, 8, 1, 2, 3, 4, 5, 6, 7, 8);
        }
        if (command === 0xa3) payload = [0x90]; // ISP key checksum for this UID/chip.
        if (command === 0xa6 && options.verifyFails) payload = [1];
        if (command === 0xa2 && options.resetFails)
          throw new Error("Device disconnected during reset");
        return {
          status: "ok",
          data: new DataView(
            Uint8Array.from([command, 0, payload.length, 0, ...payload]).buffer,
          ),
        };
      },
    };
    Object.defineProperty(navigator, "usb", {
      value: {
        requestDevice: async ({ filters }) => {
          window.usbFilters = filters;
          return device;
        },
      },
    });
  }, options);
}

async function openLocalBuild(page) {
  await page.route("**/firmware/manifest.json", (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
  await page.goto("./");
  await expect(page.getByRole("status")).toHaveText(
    "Choose a local firmware image to begin.",
  );
}

async function loadLocalImage(page, buffer = bin) {
  await page.locator("#file").setInputFiles({
    name: "local-firmware.bin",
    mimeType: "application/octet-stream",
    buffer,
  });
}

async function prepareInstall(page, options) {
  await mockWch(page, options);
  await openLocalBuild(page);
  await loadLocalImage(page);
  await expect(page.locator("#image-name")).toHaveText("local-firmware.bin");
  await page.locator("#connect").click();
}

const commands = (page) => page.evaluate(() => window.usbCommands);

test("the real Pages bundle loads and verifies every variant", async ({
  page,
}) => {
  test.skip(
    !process.env.TEST_BUNDLED_FIRMWARE,
    "A firmware bundle is required for this check.",
  );
  await page.goto("./");
  const choices = [
    /^USB serial CDC/,
    /^Ethernet DHCP/,
    /^USB serial \+ Ethernet/,
  ];
  for (const [i, name] of Object.values(FILENAMES).entries()) {
    if (i) await page.getByRole("radio", { name: choices[i] }).check();
    await expect(page.locator("#image-name")).toHaveText(name);
    await expect(page.locator("#image-size")).toContainText("checksum matched");
    await expect(page.locator("#download")).toHaveAttribute(
      "href",
      `./firmware/${name}`,
    );
  }
});

test("unsupported browsers retain the manual route and mobile layout", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "usb", { value: undefined }),
  );
  await openLocalBuild(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Install EHCI debug bridge firmware",
  );
  await expect(page.locator("#unsupported")).toBeVisible();
  await expect(page.locator("#connect")).toBeDisabled();
  await expect(page.getByText("Prefer the manual route?")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("permission failures open help with the canonical downloadable rules", async ({
  page,
}) => {
  await mockWch(page, { accessDenied: true });
  await openLocalBuild(page);
  await page.locator("#connect").click();
  await expect(page.getByRole("status")).toContainText("Access denied");
  await expect(page.locator("#usb-permissions")).toHaveAttribute("open", "");
  const expected = await readFile(
    new URL("../../../udev/70-wch-isp.rules", import.meta.url),
    "utf8",
  );
  await expect(
    page.locator("#usb-permissions pre code").first(),
  ).toHaveJSProperty("textContent", expected);
  expect(await (await page.request.get("70-wch-isp.rules")).text()).toBe(
    expected,
  );
});

test("invalid local BIN does not become installable", async ({ page }) => {
  await openLocalBuild(page);
  await loadLocalImage(page, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  await expect(page.getByRole("status")).toContainText("not an ELF or UF2");
  await expect(page.locator("#image-info")).toBeHidden();
  await expect(page.locator("#install")).toBeDisabled();
});

test("changing to a corrupt variant clears the verified image and consent", async ({
  page,
}) => {
  await mockWch(page);
  const metadata = {
    sha256: createHash("sha256").update(bin).digest("hex"),
    size: bin.length,
  };
  await page.route("**/firmware/manifest.json", (route) =>
    route.fulfill({
      json: {
        schema: 1,
        commit: "a".repeat(40),
        files: { acm: metadata, tcp: metadata, "acm-tcp": metadata },
      },
    }),
  );
  await page.route(`**/firmware/${FILENAMES.acm}`, (route) =>
    route.fulfill({ body: bin }),
  );
  await page.route(`**/firmware/${FILENAMES.tcp}`, (route) =>
    route.fulfill({ body: Buffer.alloc(bin.length) }),
  );
  await page.goto("./");
  await expect(page.locator("#download")).toBeVisible();
  await page.locator("#connect").click();
  await page.locator("#confirm").check();
  await expect(page.locator("#install")).toBeEnabled();
  await page.getByRole("radio", { name: /^Ethernet/ }).check();
  await expect(page.getByRole("status")).toContainText(
    "checksum/size mismatch",
  );
  await expect(page.locator("#image-info")).toBeHidden();
  await expect(page.locator("#download")).toBeHidden();
  await expect(page.locator("#confirm")).not.toBeChecked();
  await expect(page.locator("#install")).toBeDisabled();
  expect(await commands(page)).not.toContain(0xa4);
});

test("explicit confirmation gates erase, and verification precedes reset", async ({
  page,
}) => {
  await prepareInstall(page);
  await expect(page.locator("#device")).toContainText("CH32V307VCT6");
  expect(await page.evaluate(() => window.usbFilters)).toEqual([
    { vendorId: 0x4348, productId: 0x55e0 },
    { vendorId: 0x1a86, productId: 0x55e0 },
  ]);
  await expect(page.locator("#install")).toBeDisabled();
  expect(await commands(page)).not.toContain(0xa4);
  await page.locator("#confirm").check();
  await page.locator("#install").click();
  await expect(page.getByRole("status")).toContainText(
    "Firmware written and verified.",
  );
  const sent = await commands(page);
  expect(
    sent
      .filter((command) => [0xa4, 0xa5, 0xa6, 0xa2].includes(command))
      .filter((command, i, array) => command !== array[i - 1]),
  ).toEqual([0xa4, 0xa5, 0xa6, 0xa2]);
  expect(sent).not.toContain(0xa8);
  await expect(page.locator("#connect")).toBeEnabled();
});

for (const [options, message] of [
  [{ chipId: 0x71 }, "requires CH32V307VCT6"],
  [{ protected: true }, "flash is protected"],
  [{ smallRam: true }, "only 32 KiB SRAM"],
  [{ protectOnRecheck: true }, "flash is protected"],
]) {
  test(`rejects ${Object.keys(options)[0]} before erase`, async ({ page }) => {
    await prepareInstall(page, options);
    if (options.protectOnRecheck) {
      await page.locator("#confirm").check();
      await page.locator("#install").click();
    }
    await expect(page.getByRole("status")).toContainText(message);
    expect(await commands(page)).not.toContain(0xa4);
    await expect(page.locator("#install")).toBeDisabled();
  });
}

test("verification failure closes the connection without resetting", async ({
  page,
}) => {
  await prepareInstall(page, { verifyFails: true });
  await page.locator("#confirm").check();
  await page.locator("#install").click();
  await expect(page.getByRole("status")).toContainText(/verify failed at/i);
  await expect(page.locator("#connect")).toBeEnabled();
  expect(await commands(page)).not.toContain(0xa2);
});

test("a failed reset after verified firmware asks for a manual reset", async ({
  page,
}) => {
  await prepareInstall(page, { resetFails: true });
  await page.locator("#confirm").check();
  await page.locator("#install").click();
  await expect(page.getByRole("status")).toContainText(
    "reboot was not confirmed",
  );
});

test("stop during write closes USB and prevents verify and reset", async ({
  page,
}) => {
  await prepareInstall(page, { stallWrite: true });
  await page.locator("#confirm").check();
  await page.locator("#install").click();
  await expect.poll(() => commands(page)).toContain(0xa5);
  await page.locator("#stop").click();
  await expect(page.getByRole("status")).toContainText(
    "Installation stopped. Firmware may be incomplete",
  );
  await expect(page.locator("#connect")).toBeEnabled();
  expect(await commands(page)).not.toContain(0xa6);
  expect(await commands(page)).not.toContain(0xa2);
});
