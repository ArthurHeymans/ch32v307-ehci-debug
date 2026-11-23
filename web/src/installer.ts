// SPDX-License-Identifier: GPL-2.0-only
// Adapted from the DediBridge installer, 2026-11-23.
import { validateImage } from "./images.js";

export type Progress = (phase: string, done: number, total: number) => void;
export interface InstallResult {
  rebooted: boolean;
}
export interface Backend {
  name: string;
  install(
    image: Uint8Array,
    progress: Progress,
    signal: AbortSignal,
  ): Promise<InstallResult>;
  close(): Promise<void>;
}

// Own the USB session and serialize connect, install and disconnect.
export class Installer {
  private backend?: Backend;
  private abort?: AbortController;
  private active = false;
  get busy(): boolean {
    return this.active;
  }
  get connected(): boolean {
    return Boolean(this.backend);
  }
  get deviceName(): string {
    return this.backend?.name ?? "Not connected";
  }

  async connect(request: () => Promise<Backend>): Promise<void> {
    if (this.busy || this.backend)
      throw new Error("Disconnect the current device first.");
    this.active = true;
    try {
      // No await before request(): preserve the button's user activation.
      this.backend = await request();
    } finally {
      this.active = false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.busy) throw new Error("An operation is in progress.");
    this.active = true;
    try {
      await this.close();
    } finally {
      this.active = false;
    }
  }

  async install(
    image: Uint8Array,
    confirmed: boolean,
    progress: Progress,
  ): Promise<InstallResult> {
    if (this.busy) throw new Error("An operation is already in progress.");
    if (!this.backend) throw new Error("Connect a bootloader first.");
    if (!confirmed)
      throw new Error("Confirm the erase warning before installing.");
    const validated = validateImage(image);
    this.active = true;
    this.abort = new AbortController();
    const { signal } = this.abort;
    try {
      const result = await this.backend.install(validated, progress, signal);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    } finally {
      try {
        await this.close();
      } finally {
        this.abort = undefined;
        this.active = false;
      }
    }
  }

  cancel(): void {
    if (!this.abort || this.abort.signal.aborted) return;
    this.abort.abort(
      new Error(
        "Installation stopped. Firmware may be incomplete; re-enter ISP mode before retrying.",
      ),
    );
    // Closing WebUSB also aborts any pending transfer.
    void this.backend?.close().catch(() => {});
  }

  private async close(): Promise<void> {
    const backend = this.backend;
    this.backend = undefined;
    await backend?.close();
  }
}
