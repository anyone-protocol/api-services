const BLOCK_SIZE = 512;

function field(header: Uint8Array, start: number, length: number): string {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}

export function findTarEntry(archive: Uint8Array, matches: (path: string) => boolean): Uint8Array | undefined {
  let offset = 0;
  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    const name = field(header, 0, 100);
    if (name === '') return undefined;

    const prefix = field(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(field(header, 124, 12).trim() || '0', 8);
    const type = field(header, 156, 1);
    const dataStart = offset + BLOCK_SIZE;

    if ((type === '0' || type === '') && matches(path)) {
      return archive.subarray(dataStart, dataStart + size);
    }
    offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  return undefined;
}
