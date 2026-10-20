import { describe, expect, it, vi } from "vitest";
import { connectPicoboot, type InstallProgress } from "../../src/installer/picoboot";
import { FIRMWARE_END, FLASH_START, parseUf2 } from "../../src/installer/uf2";
import type {
  UsbConfiguration, UsbControlSetup, UsbDevice, UsbInResult, UsbNavigator, UsbOutResult,
} from "../../src/installer/usb-types";

function firmware(): ReturnType<typeof parseUf2> {
  // Two nonadjacent sectors with partial pages; existing bytes must be preserved.
  const bytes = new Uint8Array(1024);
  [FLASH_START, FLASH_START + 8192].forEach((address, index) => {
    const view = new DataView(bytes.buffer, index * 512, 512);
    [0x0a324655, 0x9e5d5157, 0x2000, address, 256, index, 2, 0xe48bff59]
      .forEach((value, field) => view.setUint32(field * 4, value, true));
    view.setUint32(508, 0x0ab16f30, true);
    bytes.fill(index + 0x80, index * 512 + 32, index * 512 + 288);
  });
  return parseUf2(bytes);
}

class FakeUsb implements UsbDevice {
  vendorId = 0x2e8a;
  productId = 0x000f;
  productName = "RP2350";
  serialNumber = "TEST-ONLY";
  configuration?: UsbConfiguration;
  configurations: UsbConfiguration[] = [{
    configurationValue: 1,
    interfaces: [{
      interfaceNumber: 1,
      alternate: { alternateSetting: 0, interfaceClass: 255, interfaceSubclass: 0, interfaceProtocol: 0, endpoints: [
        { endpointNumber: 3, direction: "out", type: "bulk" },
        { endpointNumber: 4, direction: "in", type: "bulk" },
      ] },
      alternates: [],
    }],
  }];
  flash = new Uint8Array(16 * 1024 * 1024).fill(0x3c);
  calls: { id: number; token: number; args: Uint8Array; transferLength: number }[] = [];
  exclusive = false;
  xip = true;
  pendingWrite = false;
  pendingRead = false;
  needsAck = false;
  closeCount = 0;
  statusCode = 0;
  corruptReadback = false;
  statusMismatch = false;
  shortRead = false;
  shortWrite = false;
  stallCommand?: number;
  disconnected = false;
  open = vi.fn(async () => undefined);
  selectConfiguration = vi.fn(async (value: number) => {
    this.configuration = this.configurations.find((item) => item.configurationValue === value);
  });
  claimInterface = vi.fn(async () => undefined);
  releaseInterface = vi.fn(async () => undefined);
  selectAlternateInterface = vi.fn(async () => undefined);
  clearHalt = vi.fn(async () => undefined);

  constructor() {
    const config = this.configurations[0];
    const intf = config.interfaces[0];
    this.configurations[0] = { ...config, interfaces: [{ ...intf, alternates: [intf.alternate] }] };
  }
  async close(): Promise<void> { this.closeCount++; }
  async controlTransferOut(setup: UsbControlSetup): Promise<UsbOutResult> {
    expect(setup).toEqual({ requestType: "vendor", recipient: "interface", request: 0x41, value: 0, index: 1 });
    return { status: "ok", bytesWritten: 0 };
  }
  async controlTransferIn(setup: UsbControlSetup, length: number): Promise<UsbInResult> {
    expect(setup.request).toBe(0x42);
    expect(length).toBe(16);
    const last = this.calls[this.calls.length - 1];
    const data = new DataView(new ArrayBuffer(16));
    data.setUint32(0, last.token + (this.statusMismatch ? 1 : 0), true);
    data.setUint32(4, this.statusCode, true);
    data.setUint8(8, last.id);
    return { status: "ok", data };
  }
  async transferOut(endpoint: number, bytes: Uint8Array): Promise<UsbOutResult> {
    if (this.disconnected) throw new DOMException("Device disconnected", "NetworkError");
    expect(endpoint).toBe(3); // Discovered endpoints, not hardcoded 1/2.
    if (this.needsAck) {
      expect(bytes.length).toBe(1);
      this.needsAck = false;
    } else if (this.pendingWrite) {
      const last = this.calls[this.calls.length - 1];
      const args = new DataView(last.args.buffer);
      const offset = args.getUint32(0, true) - FLASH_START;
      expect(bytes.length).toBe(args.getUint32(4, true));
      this.flash.set(bytes, offset);
      this.pendingWrite = false;
      if (this.shortWrite) return { status: "ok", bytesWritten: bytes.length - 1 };
    } else {
      expect(bytes.length).toBe(32);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(view.getUint32(0, true)).toBe(0x431fd10b);
      expect(view.getUint16(10, true)).toBe(0);
      const id = view.getUint8(8);
      const args = bytes.slice(16, 16 + view.getUint8(9));
      const transferLength = view.getUint32(12, true);
      this.calls.push({ id, args, transferLength, token: view.getUint32(4, true) });
      if (id === this.stallCommand) return { status: "stall", bytesWritten: 0 };
      const data = new DataView(args.buffer);
      if (id === 1) {
        expect(args).toEqual(new Uint8Array([2]));
        this.exclusive = true;
      } else if (id === 6) this.xip = false;
      else if (id === 7) this.xip = true;
      else if (id === 3 || id === 5 || id === 0x84) {
        expect(this.exclusive).toBe(true);
        const address = data.getUint32(0, true);
        const size = data.getUint32(4, true);
        expect(address).toBeGreaterThanOrEqual(FLASH_START);
        expect(address + size).toBeLessThanOrEqual(FIRMWARE_END);
        if (id === 3) {
          expect(this.xip).toBe(false);
          expect(address % 4096).toBe(0);
          expect(size).toBe(4096);
          this.flash.fill(0xff, address - FLASH_START, address - FLASH_START + size);
        } else if (id === 5) {
          expect(this.xip).toBe(false);
          this.pendingWrite = true;
        } else {
          expect(this.xip).toBe(true);
          this.pendingRead = true;
        }
      }
    }
    return { status: "ok", bytesWritten: bytes.length };
  }
  async transferIn(endpoint: number, length: number): Promise<UsbInResult> {
    expect(endpoint).toBe(4);
    if (this.pendingRead) {
      const last = this.calls[this.calls.length - 1];
      const args = new DataView(last.args.buffer);
      const offset = args.getUint32(0, true) - FLASH_START;
      const data = this.flash.slice(offset, offset + length - (this.shortRead ? 1 : 0));
      if (this.corruptReadback && this.calls.some((command) => command.id === 5)) data[0] ^= 1;
      this.pendingRead = false;
      this.needsAck = true;
      return { status: "ok", data: new DataView(data.buffer) };
    }
    expect(length).toBe(1);
    return { status: "ok", data: new DataView(new ArrayBuffer(0)) };
  }
}

async function connect(device = new FakeUsb()) {
  const requestDevice = vi.fn(async () => device);
  const connection = await connectPicoboot({ requestDevice });
  return { device, connection, requestDevice };
}

describe("RP2350 WebUSB transport", () => {
  it("filters RP2350 BOOTSEL and discovers/claims its vendor bulk interface without writes", async () => {
    const { device, connection, requestDevice } = await connect();
    expect(requestDevice).toHaveBeenCalledWith({ filters: [{ vendorId: 0x2e8a, productId: 0x000f }] });
    expect(device.claimInterface).toHaveBeenCalledWith(1);
    expect(device.calls).toEqual([]);
    expect(connection.deviceName).toBe("RP2350");
    expect(connection.serialNumber).toBe("TEST-ONLY");
    expect(connection.matchesDevice(device)).toBe(true);
    expect(connection.matchesDevice({ vendorId: 0x2e8a, productId: 0x000f })).toBe(false);
    await connection.close();
    expect(device.releaseInterface).toHaveBeenCalledWith(1);
  });

  it("erases/writes only target sectors, preserves sparse bytes, verifies every byte, then reboots with REBOOT2", async () => {
    const { device, connection } = await connect();
    const reports: InstallProgress[] = [];
    await connection.install(firmware(), { onProgress: (p) => reports.push(p) });
    expect(device.flash.slice(0, 256).every((byte) => byte === 0x80)).toBe(true);
    expect(device.flash.slice(8192, 8448).every((byte) => byte === 0x81)).toBe(true);
    expect(device.flash.slice(256, 8192).every((byte) => byte === 0x3c)).toBe(true);
    expect(device.flash.slice(8448).every((byte) => byte === 0x3c)).toBe(true);
    const commands = device.calls.map(({ id }) => id);
    expect(commands).toEqual([1, 7, 0x84, 0x84, 6, 3, 5, 3, 5, 7, 0x84, 0x84, 0x0a]);
    const reboot = new DataView(device.calls.at(-1)!.args.buffer);
    expect([0, 4, 8, 12].map((offset) => reboot.getUint32(offset, true))).toEqual([0x10, 500, 0, 0]);
    expect(reports.at(-1)).toEqual({ phase: "rebooting", completed: 1, total: 1 });
    expect(device.closeCount).toBe(1);
  });

  it("stops on readback mismatch without rebooting", async () => {
    const { device, connection } = await connect();
    device.corruptReadback = true;
    await expect(connection.install(firmware())).rejects.toThrow("readback did not match");
    expect(device.calls.some(({ id }) => id === 0x0a)).toBe(false);
    expect(device.closeCount).toBe(1);
    await expect(connection.install(firmware())).rejects.toThrow("connection is closed");
  });

  it.each(["shortRead", "statusMismatch", "statusCode"] as const)("fails closed on %s before any erase", async (fault) => {
    const { device, connection } = await connect();
    if (fault === "statusCode") device.statusCode = 10;
    else device[fault] = true;
    await expect(connection.install(firmware())).rejects.toThrow();
    expect(device.calls.some(({ id }) => [3, 5, 0x0a].includes(id))).toBe(false);
    expect(device.closeCount).toBe(1);
  });

  it("stops after a short write rather than proceeding to another sector or reboot", async () => {
    const { device, connection } = await connect();
    device.shortWrite = true;
    await expect(connection.install(firmware())).rejects.toThrow("complete USB transfer");
    expect(device.calls.filter(({ id }) => id === 3)).toHaveLength(1);
    expect(device.calls.some(({ id }) => id === 0x0a)).toBe(false);
  });

  it("rejects wrong chips before opening, and missing interfaces before flashing", async () => {
    const wrong = new FakeUsb();
    wrong.productId = 3;
    await expect(connect(wrong)).rejects.toThrow("RP2350 BOOTSEL");
    expect(wrong.open).not.toHaveBeenCalled();
    const missing = new FakeUsb();
    missing.configurations[0] = { ...missing.configurations[0], interfaces: [] };
    await expect(connect(missing)).rejects.toThrow("interface was not found");
    expect(missing.calls).toEqual([]);
    expect(missing.closeCount).toBe(1);
  });

  it("preserves chooser cancellation so the UI can treat it as cancellation", async () => {
    const api: UsbNavigator = {
      requestDevice: async () => { throw new DOMException("No device selected", "NotFoundError"); },
    };
    await expect(connectPicoboot(api)).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("allows abort before install without issuing any command", async () => {
    const { device, connection } = await connect();
    const abort = new AbortController();
    abort.abort();
    await expect(connection.install(firmware(), { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(device.calls).toEqual([]);
    expect(device.closeCount).toBe(1);
  });

  it("rejects overlapping installs and unplugged devices", async () => {
    const { device, connection } = await connect();
    const first = connection.install(firmware());
    await expect(connection.install(firmware())).rejects.toThrow("already running");
    await first;
    const other = await connect();
    other.device.disconnected = true;
    await expect(other.connection.install(firmware())).rejects.toMatchObject({ name: "NetworkError" });
    expect(other.device.calls).toEqual([]);
    expect(device.closeCount).toBe(1);
  });

  it("does not touch USB for forged firmware summaries", async () => {
    const { device, connection } = await connect();
    await expect(connection.install({ ...firmware() })).rejects.toThrow("has not passed");
    expect(device.calls).toEqual([]);
    await connection.close();
  });

  it("stops and closes a stalled command without trying a fallback flash path", async () => {
    const { device, connection } = await connect();
    device.stallCommand = 3;
    await expect(connection.install(firmware())).rejects.toThrow("complete USB transfer");
    expect(device.calls.filter(({ id }) => id === 3)).toHaveLength(1);
    expect(device.calls.some(({ id }) => id === 5 || id === 0x0a)).toBe(false);
    expect(device.closeCount).toBe(1);
  });

  it("closes on a timed-out transfer and never retries a command that might still be running", async () => {
    const { device, connection } = await connect();
    vi.useFakeTimers();
    try {
      const pending = vi.fn(() => new Promise<UsbOutResult>(() => undefined));
      device.transferOut = pending;
      const result = expect(connection.install(firmware())).rejects.toThrow("stopped responding");
      await vi.advanceTimersByTimeAsync(15001);
      await result;
      expect(pending).toHaveBeenCalledTimes(1);
      expect(device.closeCount).toBe(1);
      await expect(connection.install(firmware())).rejects.toThrow("connection is closed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes an in-flight transfer when aborted without waiting for its timeout", async () => {
    const { device, connection } = await connect();
    const controller = new AbortController();
    device.transferOut = () => new Promise<UsbOutResult>(() => undefined);
    const result = expect(connection.install(firmware(), { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await result;
    expect(device.closeCount).toBe(1);
    expect(device.calls).toEqual([]);
  });
});
