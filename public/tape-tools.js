import { loadBasicProgramBytes } from "./basic.js";

export function tapEntries(blocks) {
  const entries = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block.header) continue;
    const dataBlock = blocks[index + 1]?.flag === 0xff ? blocks[index + 1] : null;
    entries.push({
      index: entries.length,
      headerBlock: block,
      dataBlock,
      header: block.header,
      loadable: Boolean(dataBlock && (block.header.type === 0 || block.header.type === 3))
    });
  }
  return entries;
}

export function loadTapEntry(machine, entry) {
  if (!entry?.dataBlock) throw new Error("TAP entry has no data block");
  if (!entry.headerBlock.checksumValid || !entry.dataBlock.checksumValid) {
    throw new Error("TAP checksum failed");
  }
  if (entry.header.length !== entry.dataBlock.payload.length) {
    throw new Error(`TAP data length mismatch for ${entry.header.name || "unnamed block"}`);
  }

  if (entry.header.type === 0) {
    const variablesOffset = entry.header.param2 <= entry.dataBlock.payload.length
      ? entry.header.param2
      : entry.dataBlock.payload.length;
    const result = loadBasicProgramBytes(machine, entry.dataBlock.payload, { variablesOffset });
    return {
      ...result,
      kind: "BASIC",
      name: entry.header.name,
      autoStartLine: entry.header.param1 < 0x8000 ? entry.header.param1 : null
    };
  }

  if (entry.header.type === 3) {
    const start = entry.header.param1;
    for (let offset = 0; offset < entry.dataBlock.payload.length; offset += 1) {
      machine.write8(start + offset, entry.dataBlock.payload[offset]);
    }
    return {
      kind: "CODE",
      name: entry.header.name,
      start,
      end: start + entry.dataBlock.payload.length,
      length: entry.dataBlock.payload.length
    };
  }

  throw new Error(`Unsupported TAP block type: ${entry.header.typeName}`);
}

