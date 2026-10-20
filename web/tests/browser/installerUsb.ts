import type { Page } from "@playwright/test";

/**
 * Browser-side PICOBOOT double. Actual application code parses the UF2, opens
 * this device and sends real command packets; no physical USB device is used.
 */
export async function mockUsb(
  page: Page,
  failure: "none" | "cancel" | "readback" | "disconnect" = "none",
) {
  await page.addInitScript(({ failure }) => {
    const log: number[] = [];
    Object.assign(window, { __usbCommands: log, __usbChoosers: 0 });
    const flash = new Uint8Array(4096).fill(0x5a);
    let command = { id: 0, token: 0, address: 0, size: 0 };
    let written = false;
    const alternate = {
      alternateSetting: 0, interfaceClass: 0xff, interfaceSubclass: 0,
      interfaceProtocol: 0,
      endpoints: [
        { endpointNumber: 3, direction: "out", type: "bulk" },
        { endpointNumber: 4, direction: "in", type: "bulk" },
      ],
    };
    const configuration = {
      configurationValue: 1,
      interfaces: [{ interfaceNumber: 1, alternate, alternates: [alternate] }],
    };
    const device = {
      vendorId: 0x2e8a, productId: 0x000f,
      productName: "RP2350", serialNumber: "browser-test",
      configuration, configurations: [configuration],
      async open() {}, async close() {}, async selectConfiguration() {},
      async claimInterface() {}, async releaseInterface() {},
      async selectAlternateInterface() {}, async clearHalt() {},
      async controlTransferOut() { return { status: "ok", bytesWritten: 0 }; },
      async controlTransferIn() {
        const bytes = new ArrayBuffer(16);
        const status = new DataView(bytes);
        status.setUint32(0, command.token, true);
        status.setUint8(8, command.id);
        return { status: "ok", data: status };
      },
      async transferOut(_endpoint: number, bytes: Uint8Array) {
        if (bytes.length === 32) {
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          if (view.getUint32(0, true) !== 0x431fd10b) throw new Error("Bad PICOBOOT magic");
          command = {
            id: view.getUint8(8), token: view.getUint32(4, true),
            address: view.getUint32(16, true), size: view.getUint32(20, true),
          };
          log.push(command.id);
          if (command.id === 3) flash.fill(0xff);
        } else if (bytes.length === 4096 && command.id === 5) {
          if (failure === "disconnect") throw new DOMException("Device disconnected", "NetworkError");
          flash.set(bytes);
          written = true;
        } else if (bytes.length !== 1) {
          throw new Error("Unexpected USB payload");
        }
        return { status: "ok", bytesWritten: bytes.length };
      },
      async transferIn(_endpoint: number, length: number) {
        if (length === 1) return { status: "ok", data: new DataView(new ArrayBuffer(0)) };
        if (command.id !== 0x84 || length !== 4096 || command.address !== 0x10000000) {
          throw new Error("Unexpected flash read");
        }
        const bytes = flash.slice();
        if (failure === "readback" && written) bytes[0] ^= 0xff;
        return { status: "ok", data: new DataView(bytes.buffer) };
      },
    };
    const usb = new EventTarget();
    Object.assign(usb, {
      async requestDevice(options: { filters: unknown[] }) {
        Object.assign(window, { __usbChoosers: (window as unknown as { __usbChoosers: number }).__usbChoosers + 1 });
        if (JSON.stringify(options.filters) !== '[{"vendorId":11914,"productId":15}]') {
          throw new Error("Wrong USB filter");
        }
        if (failure === "cancel") throw new DOMException("No device selected", "NotFoundError");
        return device;
      },
    });
    Object.defineProperty(navigator, "usb", { value: usb, configurable: true });
  }, { failure });
}

export async function usbCommands(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as unknown as { __usbCommands: number[] }).__usbCommands);
}
