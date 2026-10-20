// Format and family IDs: Raspberry Pi pico-sdk boot/uf2.h.
// Canonical RP2350-E10 prefix: picotool elf2uf2/elf2uf2.cpp gen_abs_block().
// https://github.com/raspberrypi/pico-sdk/blob/master/src/common/boot_uf2_headers/include/boot/uf2.h
export const FLASH_START = 0x10000000;
export const FIRMWARE_END = 0x10f00000; // Final 1 MiB of Tufty's 16 MiB flash is reserved.
export const FLASH_SECTOR_SIZE = 4096;
export const FLASH_PAGE_SIZE = 256;
export const RP2350_ARM_SECURE_FAMILY = 0xe48bff59;
export const MAX_UF2_BYTES = ((FIRMWARE_END - FLASH_START) / FLASH_PAGE_SIZE + 1) * 512;

export interface Uf2Image {
  readonly blockCount: number;
  readonly payloadBytes: number;
  readonly flashStart: number;
  readonly flashEnd: number;
  readonly familyId: number;
}

interface Uf2Page {
  address: number;
  data: Uint8Array;
}

// Keep validated addresses and payloads private. A fabricated or changed summary
// cannot become a flash plan, and changes to the download buffer have no effect.
const validatedPages = new WeakMap<Uf2Image, Uf2Page[]>();

export function parseUf2(bytes: Uint8Array): Uf2Image {
  if (!bytes.length || bytes.length % 512 !== 0 || bytes.length > MAX_UF2_BYTES) {
    throw new Error("Firmware must be a complete UF2 file within the badge's firmware size limit.");
  }
  const pages: Uf2Page[] = [];
  const blockNumbers = new Set<number>();
  const addresses = new Set<number>();
  let declaredCount: number | undefined;
  for (let offset = 0; offset < bytes.length; offset += 512) {
    const block = new DataView(bytes.buffer, bytes.byteOffset + offset, 512);
    if (block.getUint32(0, true) !== 0x0a324655 ||
        block.getUint32(4, true) !== 0x9e5d5157 ||
        block.getUint32(508, true) !== 0x0ab16f30) {
      throw new Error(`Invalid UF2 block at byte ${offset}.`);
    }
    const flags = block.getUint32(8, true);
    const address = block.getUint32(12, true);
    const size = block.getUint32(16, true);
    const number = block.getUint32(20, true);
    const count = block.getUint32(24, true);
    const family = block.getUint32(28, true);
    const payload = bytes.subarray(offset + 32, offset + 288);

    // This optional, ignored erratum workaround is NOT a flash page. Its own
    // numbering is unrelated to the real image. Recognize only the exact modern
    // form; accepting general absolute-family blocks could overwrite user data.
    if (offset === 0 && flags === 0xa000 && family === 0xe48bff57 &&
        size === 256 && number === 0 && count === 2 &&
        address >= FLASH_START && address < 0x11000000 && address % 256 === 0 &&
        payload.every((byte) => byte === 0xef) &&
        block.getUint32(288, true) === 0x9957e304 &&
        bytes.subarray(offset + 292, offset + 508).every((byte) => byte === 0)) {
      continue;
    }

    if (flags !== 0x2000) {
      throw new Error("Unsupported UF2 flags: only ordinary flash firmware blocks are accepted.");
    }
    if (family !== RP2350_ARM_SECURE_FAMILY) {
      throw new Error("Firmware must target RP2350 Arm secure, as used by Tufty 2350.");
    }
    if (size !== FLASH_PAGE_SIZE || address % FLASH_PAGE_SIZE !== 0) {
      throw new Error("Firmware pages must be 256 bytes and aligned to a flash page.");
    }
    if (address < FLASH_START || address + size > FIRMWARE_END) {
      throw new Error("Firmware targets RAM or reserved storage outside the allowed badge firmware area.");
    }
    if (count === 0 || number >= count ||
        (declaredCount !== undefined && declaredCount !== count) ||
        blockNumbers.has(number)) {
      throw new Error("UF2 block numbering is inconsistent or duplicated.");
    }
    if (addresses.has(address)) {
      throw new Error("UF2 contains overlapping flash pages.");
    }
    declaredCount = count;
    blockNumbers.add(number);
    addresses.add(address);
    pages.push({ address, data: payload.slice() });
  }
  if (!pages.length || pages.length !== declaredCount) {
    throw new Error("UF2 is incomplete: one or more firmware blocks are missing.");
  }
  pages.sort((left, right) => left.address - right.address);
  if (pages[0].address !== FLASH_START) {
    throw new Error("Badge firmware must start at the beginning of flash.");
  }
  const image = Object.freeze({
    blockCount: pages.length,
    payloadBytes: pages.length * FLASH_PAGE_SIZE,
    flashStart: pages[0].address,
    flashEnd: pages[pages.length - 1].address + FLASH_PAGE_SIZE,
    familyId: RP2350_ARM_SECURE_FAMILY,
  });
  validatedPages.set(image, pages);
  return image;
}

/** Internal transport boundary. Copies prevent mutation while installation runs. */
export function copyFirmwarePages(image: Uf2Image): Uf2Page[] {
  const pages = validatedPages.get(image);
  if (!pages) throw new Error("Firmware has not passed UF2 validation.");
  return pages.map(({ address, data }) => ({ address, data: data.slice() }));
}
