// Synthetic UF2 bytes for parser/transport tests only. This is not executable
// firmware and is never copied to public/ or offered by the application.
export function firmwareFixture(pages = 1): Uint8Array {
  const bytes = new Uint8Array(512 * pages);
  const view = new DataView(bytes.buffer);
  for (let block = 0; block < pages; block++) {
    const offset = block * 512;
    view.setUint32(offset, 0x0a324655, true);
    view.setUint32(offset + 4, 0x9e5d5157, true);
    view.setUint32(offset + 8, 0x2000, true);
    view.setUint32(offset + 12, 0x10000000 + 256 * block, true);
    view.setUint32(offset + 16, 256, true);
    view.setUint32(offset + 20, block, true);
    view.setUint32(offset + 24, pages, true);
    view.setUint32(offset + 28, 0xe48bff59, true);
    bytes.fill(0xa5, offset + 32, offset + 288);
    view.setUint32(offset + 508, 0x0ab16f30, true);
  }
  return bytes;
}
