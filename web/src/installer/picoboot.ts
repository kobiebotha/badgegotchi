import {
  copyFirmwarePages, FLASH_SECTOR_SIZE, type Uf2Image,
} from "./uf2";
import type {
  UsbControlSetup, UsbDevice, UsbNavigator, UsbOutResult,
} from "./usb-types";

// Reference implementation/protocol:
// https://github.com/raspberrypi/picotool/blob/master/picoboot_connection/picoboot_connection.c
// https://github.com/raspberrypi/pico-sdk/blob/master/src/common/boot_picoboot_headers/include/boot/picoboot.h
const VID = 0x2e8a;
const PID = 0x000f; // RP2350 BOOTSEL, NOT the RP2040 PID 0x0003.
const MAGIC = 0x431fd10b;
const COMMAND = {
  exclusive: 0x01, erase: 0x03, read: 0x84, write: 0x05,
  exitXip: 0x06, enterXip: 0x07, reboot2: 0x0a,
} as const;

export interface InstallProgress {
  phase: "preparing" | "erasing" | "writing" | "verifying" | "rebooting";
  completed: number;
  total: number;
}
export interface InstallOptions {
  onProgress?: (progress: InstallProgress) => void;
  signal?: AbortSignal;
}

function words(...values: number[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value, true));
  return bytes;
}

function checkOut(result: UsbOutResult, expected: number): void {
  if (result.status !== "ok" || result.bytesWritten !== expected) {
    throw new Error("The badge did not accept the complete USB transfer. Reconnect in BOOTSEL mode.");
  }
}

export class PicobootConnection {
  readonly deviceName: string;
  readonly serialNumber?: string;
  private token = 1;
  private closed = false;
  private installing = false;
  private signal?: AbortSignal;

  constructor(
    private readonly device: UsbDevice,
    private readonly interfaceNumber: number,
    private readonly inEndpoint: number,
    private readonly outEndpoint: number,
  ) {
    this.deviceName = device.productName || "RP2350 in BOOTSEL mode";
    this.serialNumber = device.serialNumber;
  }

  matchesDevice(device: unknown): boolean {
    return device === this.device;
  }

  private setup(request: number): UsbControlSetup {
    return { requestType: "vendor", recipient: "interface", request, value: 0, index: this.interfaceNumber };
  }

  private checkOpen(): void {
    if (this.closed) throw new Error("USB connection is closed. Reconnect the badge in BOOTSEL mode.");
    this.signal?.throwIfAborted();
  }

  // WebUSB has no per-transfer timeout or abort API. On timeout/abort, close the
  // handle and fail the whole installation; never send a second command while a
  // timed-out operation could still be running.
  private async transfer<T>(operation: () => Promise<T>): Promise<T> {
    this.checkOpen();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const signal = this.signal;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          const fail = (error: Error) => {
            this.closed = true;
            void this.device.close().catch(() => undefined);
            reject(error);
          };
          timeout = setTimeout(() => fail(new Error("The badge stopped responding. Reconnect in BOOTSEL mode and retry the installation.")), 15000);
          abort = () => fail(new DOMException("Installation interrupted. Reconnect in BOOTSEL mode to reinstall.", "AbortError"));
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }

  async initialize(): Promise<void> {
    // Clear stale stalls before resetting protocol state, as picotool does.
    await this.transfer(() => this.device.clearHalt("in", this.inEndpoint));
    await this.transfer(() => this.device.clearHalt("out", this.outEndpoint));
    checkOut(await this.transfer(() => this.device.controlTransferOut(this.setup(0x41))), 0);
  }

  private async command(
    id: number, args = new Uint8Array(0), write?: Uint8Array, readLength = 0,
    checkStatus = true,
  ): Promise<Uint8Array> {
    this.checkOpen();
    const token = this.token++;
    const packet = new Uint8Array(32);
    const header = new DataView(packet.buffer);
    header.setUint32(0, MAGIC, true);
    header.setUint32(4, token, true);
    header.setUint8(8, id);
    header.setUint8(9, args.length);
    header.setUint32(12, write?.length ?? readLength, true);
    packet.set(args, 16);
    checkOut(await this.transfer(() => this.device.transferOut(this.outEndpoint, packet)), 32);
    let received = new Uint8Array(0);
    if (write) {
      // Always use an owned ArrayBuffer (WebUSB disallows SharedArrayBuffer).
      const owned = new Uint8Array(write);
      checkOut(await this.transfer(() => this.device.transferOut(this.outEndpoint, owned)), owned.length);
    } else if (readLength) {
      const result = await this.transfer(() => this.device.transferIn(this.inEndpoint, readLength));
      if (result.status !== "ok" || result.data?.byteLength !== readLength) {
        throw new Error("Incomplete USB read from the badge. No further flash writes will be attempted.");
      }
      received = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength).slice();
    }
    // picotool sends one OUT byte after reads. The device consumes this as the
    // ACK handshake; after OUT commands, a 1-byte IN request receives a zero-byte
    // packet. A zero-length WebUSB request can be optimized away by the host.
    if (id & 0x80) {
      checkOut(await this.transfer(() => this.device.transferOut(this.outEndpoint, new Uint8Array(1))), 1);
    } else {
      const ack = await this.transfer(() => this.device.transferIn(this.inEndpoint, 1));
      if (ack.status !== "ok" || (ack.data?.byteLength ?? 0) !== 0) {
        throw new Error("The badge did not acknowledge the flash command.");
      }
    }
    if (checkStatus) {
      const status = await this.transfer(() => this.device.controlTransferIn(this.setup(0x42), 16));
      if (status.status !== "ok" || status.data?.byteLength !== 16 ||
          status.data.getUint32(0, true) !== token || status.data.getUint8(8) !== id ||
          status.data.getUint8(9) !== 0) {
        throw new Error("The badge returned an invalid command status.");
      }
      const code = status.data.getUint32(4, true);
      if (code !== 0) throw new Error(`The badge rejected the flash command (PICOBOOT status ${code}).`);
    }
    return received;
  }

  async install(image: Uf2Image, options: InstallOptions = {}): Promise<void> {
    this.checkOpen();
    if (this.installing) throw new Error("A badge installation is already running.");
    const pages = copyFirmwarePages(image); // Validate before touching the USB device.
    this.installing = true;
    this.signal = options.signal;
    const progress = (phase: InstallProgress["phase"], completed: number, total: number) => {
      options.onProgress?.({ phase, completed, total });
    };
    try {
      this.checkOpen();
      const sectors = new Map<number, Uint8Array>();
      for (const page of pages) {
        const address = Math.floor(page.address / FLASH_SECTOR_SIZE) * FLASH_SECTOR_SIZE;
        if (!sectors.has(address)) sectors.set(address, new Uint8Array(0));
      }
      const total = sectors.size;
      progress("preparing", 0, total);
      // Eject/lock mass storage so Finder cannot interleave a UF2 write.
      await this.command(COMMAND.exclusive, new Uint8Array([2]));
      await this.command(COMMAND.enterXip);
      let completed = 0;
      for (const address of sectors.keys()) {
        sectors.set(address, await this.command(COMMAND.read, words(address, FLASH_SECTOR_SIZE), undefined, FLASH_SECTOR_SIZE));
        progress("preparing", ++completed, total);
      }
      for (const page of pages) {
        const address = Math.floor(page.address / FLASH_SECTOR_SIZE) * FLASH_SECTOR_SIZE;
        sectors.get(address)!.set(page.data, page.address - address);
      }
      await this.command(COMMAND.exitXip);
      // Commit one sector at a time; preserve bytes absent from sparse firmware.
      // No read/erase/write ever touches the reserved upper 1 MiB.
      completed = 0;
      for (const [address, data] of sectors) {
        progress("erasing", completed, total);
        await this.command(COMMAND.erase, words(address, FLASH_SECTOR_SIZE));
        progress("writing", completed, total);
        await this.command(COMMAND.write, words(address, data.length), data);
        completed++;
        progress("writing", completed, total);
      }
      await this.command(COMMAND.enterXip);
      completed = 0;
      progress("verifying", 0, total);
      for (const [address, expected] of sectors) {
        const actual = await this.command(COMMAND.read, words(address, expected.length), undefined, expected.length);
        if (actual.some((byte, index) => byte !== expected[index])) {
          throw new Error("Firmware readback did not match. The badge was not rebooted; reconnect in BOOTSEL mode and reinstall.");
        }
        progress("verifying", ++completed, total);
      }
      progress("rebooting", 0, 1);
      // RP2350 requires REBOOT2, not the legacy RP2040 REBOOT. Select Arm,
      // normal flash boot, with enough delay for its ACK to reach the browser.
      await this.command(COMMAND.reboot2, words(0x10, 500, 0, 0), undefined, 0, false);
      progress("rebooting", 1, 1);
    } finally {
      this.signal = undefined;
      this.installing = false;
      await this.close();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.device.releaseInterface(this.interfaceNumber); } catch { /* unplugged or rebooted */ }
    try { await this.device.close(); } catch { /* unplugged or rebooted */ }
  }
}

/** Call directly from a click handler so the browser's USB chooser is allowed. */
export async function connectPicoboot(usb?: UsbNavigator): Promise<PicobootConnection> {
  const api = usb ?? (typeof navigator !== "undefined"
    ? (navigator as Navigator & { usb?: UsbNavigator }).usb : undefined);
  if (!api) throw new Error("WebUSB is unavailable. Use desktop Chrome or Edge over HTTPS, or download the firmware.");
  const device = await api.requestDevice({ filters: [{ vendorId: VID, productId: PID }] });
  if (device.vendorId !== VID || device.productId !== PID) {
    throw new Error("Choose a Tufty 2350 badge in RP2350 BOOTSEL mode.");
  }
  try {
    await device.open();
    const configuration = device.configuration ?? device.configurations[0];
    if (!configuration) throw new Error("The badge has no USB configuration.");
    if (!device.configuration) await device.selectConfiguration(configuration.configurationValue);
    const candidates = configuration.interfaces.flatMap((intf) => intf.alternates
      .filter((alternate) => alternate.interfaceClass === 0xff &&
        alternate.interfaceSubclass === 0 && alternate.interfaceProtocol === 0 &&
        alternate.endpoints.length === 2 &&
        alternate.endpoints.every((endpoint) => endpoint.type === "bulk") &&
        alternate.endpoints.some((endpoint) => endpoint.direction === "in") &&
        alternate.endpoints.some((endpoint) => endpoint.direction === "out"))
      .map((alternate) => ({ intf, alternate })));
    if (candidates.length !== 1) {
      throw new Error("The RP2350 PICOBOOT interface was not found. Use BOOT + RESET, then reconnect.");
    }
    const { intf, alternate } = candidates[0];
    await device.claimInterface(intf.interfaceNumber);
    if (intf.alternate.alternateSetting !== alternate.alternateSetting) {
      await device.selectAlternateInterface(intf.interfaceNumber, alternate.alternateSetting);
    }
    const connection = new PicobootConnection(
      device, intf.interfaceNumber,
      alternate.endpoints.find((endpoint) => endpoint.direction === "in")!.endpointNumber,
      alternate.endpoints.find((endpoint) => endpoint.direction === "out")!.endpointNumber,
    );
    await connection.initialize();
    return connection;
  } catch (error) {
    try { await device.close(); } catch { /* connection may already be gone */ }
    throw error;
  }
}
