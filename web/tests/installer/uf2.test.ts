import { describe, expect, it } from "vitest";
import { copyFirmwarePages, FIRMWARE_END, FLASH_START, parseUf2 } from "../../src/installer/uf2";

function block(address: number, number = 0, count = 1): Uint8Array {
  const bytes = new Uint8Array(512);
  const view = new DataView(bytes.buffer);
  [0x0a324655, 0x9e5d5157, 0x2000, address, 256, number, count, 0xe48bff59]
    .forEach((value, index) => view.setUint32(index * 4, value, true));
  view.setUint32(508, 0x0ab16f30, true);
  bytes.fill(0xa5, 32, 288);
  return bytes;
}
function change(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
  return bytes;
}
function join(...blocks: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(blocks.length * 512);
  blocks.forEach((item, index) => bytes.set(item, index * 512));
  return bytes;
}

describe("strict Tufty firmware UF2 parsing", () => {
  it("sorts complete sparse pages and retains copies independent of downloaded bytes", () => {
    const bytes = join(block(FLASH_START + 8192, 1, 2), block(FLASH_START, 0, 2));
    const image = parseUf2(bytes);
    expect(image).toEqual({
      blockCount: 2, payloadBytes: 512, flashStart: FLASH_START,
      flashEnd: FLASH_START + 8192 + 256, familyId: 0xe48bff59,
    });
    bytes.fill(0);
    const pages = copyFirmwarePages(image);
    expect(pages.map((page) => page.address)).toEqual([FLASH_START, FLASH_START + 8192]);
    expect(pages[0].data[0]).toBe(0xa5);
    pages[0].data.fill(0);
    expect(copyFirmwarePages(image)[0].data[0]).toBe(0xa5);
    expect(Object.isFrozen(image)).toBe(true);
  });

  it("does not allow a forged summary to bypass validation", () => {
    const valid = parseUf2(block(FLASH_START));
    expect(() => copyFirmwarePages({ ...valid })).toThrow("has not passed");
  });

  it.each([
    ["empty", new Uint8Array()],
    ["truncated", block(FLASH_START).subarray(0, 511)],
    ["wrong start magic", change(block(FLASH_START), 0, 0)],
    ["wrong second magic", change(block(FLASH_START), 4, 0)],
    ["wrong end magic", change(block(FLASH_START), 508, 0)],
    ["missing family", change(block(FLASH_START), 8, 0)],
    ["file container", change(block(FLASH_START), 8, 0x3000)],
    ["not main flash", change(block(FLASH_START), 8, 0x2001)],
    ["unsupported extension", change(block(FLASH_START), 8, 0xa000)],
    ["RP2040", change(block(FLASH_START), 28, 0xe48bff56)],
    ["RISC-V", change(block(FLASH_START), 28, 0xe48bff5a)],
    ["nonsecure", change(block(FLASH_START), 28, 0xe48bff5b)],
    ["absolute family", change(block(FLASH_START), 28, 0xe48bff57)],
    ["RAM prototype", block(0x20000000)],
    ["reserved filesystem", block(FIRMWARE_END)],
    ["outside flash", block(0x11000000)],
    ["unaligned", block(FLASH_START + 1)],
    ["short payload", change(block(FLASH_START), 16, 128)],
    ["oversized payload", change(block(FLASH_START), 16, 476)],
    ["missing final block", block(FLASH_START, 0, 2)],
    ["zero count", block(FLASH_START, 0, 0)],
    ["out-of-range block number", block(FLASH_START, 1, 1)],
    ["no boot start", block(FLASH_START + 256)],
    ["inconsistent count", join(block(FLASH_START, 0, 2), block(FLASH_START + 256, 1, 3))],
    ["duplicate number", join(block(FLASH_START, 0, 2), block(FLASH_START + 256, 0, 2))],
    ["overlap", join(block(FLASH_START, 0, 2), block(FLASH_START, 1, 2))],
  ])("rejects %s", (_, bytes) => {
    expect(() => parseUf2(bytes)).toThrow();
  });

  it("skips only the canonical picotool RP2350-E10 ignored prefix", () => {
    const prefix = block(0x10ffff00, 0, 2);
    change(prefix, 8, 0xa000);
    change(prefix, 28, 0xe48bff57);
    change(prefix, 288, 0x9957e304);
    prefix.fill(0xef, 32, 288);
    const image = parseUf2(join(prefix, block(FLASH_START)));
    expect(image.blockCount).toBe(1);
    expect(copyFirmwarePages(image).map((page) => page.address)).toEqual([FLASH_START]);
    expect(() => parseUf2(prefix)).toThrow("incomplete");
    prefix[33] = 0;
    expect(() => parseUf2(join(prefix, block(FLASH_START)))).toThrow("Unsupported UF2 flags");
  });

  it("supports Uint8Array views without reading surrounding bytes", () => {
    const backing = new Uint8Array(1024);
    backing.set(block(FLASH_START), 128);
    expect(parseUf2(backing.subarray(128, 640)).blockCount).toBe(1);
  });
});
