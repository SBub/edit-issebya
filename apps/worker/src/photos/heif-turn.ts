import { open } from "node:fs/promises";

// How a stored picture becomes the picture on screen: mirrored left to right
// first when `mirrored`, then turned `rotation` degrees clockwise.
export interface Turn {
  mirrored: boolean;
  // 0, 90, 180 or 270.
  rotation: number;
}

export const NO_TURN: Turn = { mirrored: false, rotation: 0 };

function quarter(degrees: number): number {
  return (((Math.round(degrees / 90) * 90) % 360) + 360) % 360;
}

// The turn after one more step on screen: a clockwise turn, or a mirror left
// to right (a mirror top to bottom is that mirror and a half turn).
export function thenRotate(turn: Turn, degrees: number): Turn {
  return { mirrored: turn.mirrored, rotation: quarter(turn.rotation + degrees) };
}

export function thenMirror(turn: Turn): Turn {
  return { mirrored: !turn.mirrored, rotation: quarter(-turn.rotation) };
}

// The turn of an EXIF Orientation value (1 to 8); anything else is no turn.
export function exifTurn(orientation: number): Turn {
  switch (orientation) {
    case 2:
      return { mirrored: true, rotation: 0 };
    case 3:
      return { mirrored: false, rotation: 180 };
    case 4:
      return { mirrored: true, rotation: 180 };
    case 5:
      return { mirrored: true, rotation: 270 };
    case 6:
      return { mirrored: false, rotation: 90 };
    case 7:
      return { mirrored: true, rotation: 90 };
    case 8:
      return { mirrored: false, rotation: 270 };
    default:
      return NO_TURN;
  }
}

interface Box {
  type: string;
  // The box's content: after its header, to its end.
  start: number;
  end: number;
}

// The ISO base media boxes between `start` and `end`. A box that runs past
// `end` (the bytes read stop inside it) ends the list.
function boxes(bytes: Buffer, start: number, end: number): Box[] {
  const found: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      const large = bytes.readBigUInt64BE(at + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(large);
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) break;
    found.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return found;
}

function child(bytes: Buffer, parent: Box, type: string): Box | null {
  return boxes(bytes, parent.start, parent.end).find((box) => box.type === type) ?? null;
}

// The primary item's id (`pitm`).
function primaryItem(bytes: Buffer, pitm: Box): number | null {
  if (pitm.end - pitm.start < 6) return null;
  const version = bytes.readUInt8(pitm.start);
  if (version === 0) return bytes.readUInt16BE(pitm.start + 4);
  return pitm.end - pitm.start >= 8 ? bytes.readUInt32BE(pitm.start + 4) : null;
}

// The 1-based indexes into `ipco` of the properties of `item`, in the order
// the file applies them (`ipma`).
function propertiesOf(bytes: Buffer, ipma: Box, item: number): number[] {
  const end = ipma.end;
  let at = ipma.start;
  if (at + 8 > end) return [];
  const version = bytes.readUInt8(at);
  const wide = (bytes.readUInt8(at + 3) & 1) === 1;
  const entries = bytes.readUInt32BE(at + 4);
  at += 8;
  for (let entry = 0; entry < entries; entry += 1) {
    const idBytes = version < 1 ? 2 : 4;
    if (at + idBytes + 1 > end) return [];
    const id = version < 1 ? bytes.readUInt16BE(at) : bytes.readUInt32BE(at);
    const count = bytes.readUInt8(at + idBytes);
    at += idBytes + 1;
    const indexes: number[] = [];
    for (let n = 0; n < count; n += 1) {
      if (at + (wide ? 2 : 1) > end) return [];
      // The top bit says "essential"; the rest is the index.
      indexes.push(wide ? bytes.readUInt16BE(at) & 0x7fff : bytes.readUInt8(at) & 0x7f);
      at += wide ? 2 : 1;
    }
    if (id === item) return indexes;
  }
  return [];
}

// The turn the HEIF file asks for its primary picture: its `irot` (quarter
// turns anticlockwise) and `imir` (a mirror) properties, in the file's order.
// ffprobe 7.1 and 8.0 print neither for a tile grid, so the worker reads the
// boxes itself. Null for bytes that are not a HEIF file with a primary item
// (a JPEG, a PNG, a file cut before its `meta` box ends).
export function heifTurn(bytes: Buffer): Turn | null {
  const top = boxes(bytes, 0, bytes.length);
  const meta = top[0]?.type === "ftyp" ? top.find((box) => box.type === "meta") : undefined;
  if (!meta || meta.end - meta.start < 4) return null;
  // `meta` is a full box: four bytes of version and flags, then its boxes.
  const inner: Box = { type: "meta", start: meta.start + 4, end: meta.end };
  const pitm = child(bytes, inner, "pitm");
  const iprp = child(bytes, inner, "iprp");
  const item = pitm ? primaryItem(bytes, pitm) : null;
  if (item === null) return null;
  const ipco = iprp ? child(bytes, iprp, "ipco") : null;
  const ipma = iprp ? child(bytes, iprp, "ipma") : null;
  if (!ipco || !ipma) return NO_TURN;
  const properties = boxes(bytes, ipco.start, ipco.end);
  let turn = NO_TURN;
  for (const index of propertiesOf(bytes, ipma, item)) {
    const property = properties[index - 1];
    if (!property || property.end <= property.start) continue;
    const value = bytes.readUInt8(property.start);
    if (property.type === "irot") turn = thenRotate(turn, -90 * (value & 3));
    // Axis 1 mirrors left to right; axis 0 top to bottom.
    if (property.type === "imir") {
      turn = thenMirror(turn);
      if ((value & 1) === 0) turn = thenRotate(turn, 180);
    }
  }
  return turn;
}

// A HEIF file keeps its `meta` box at the start; an iPhone's is a few KB.
const HEAD_BYTES = 1024 * 1024;

export async function readHeifTurn(path: string): Promise<Turn | null> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the job's scratch copy of the original
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const head = Buffer.alloc(Math.min(size, HEAD_BYTES));
    const { bytesRead } = await file.read(head, 0, head.length, 0);
    return heifTurn(head.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}
