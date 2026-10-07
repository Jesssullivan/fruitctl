// This kernel is also embedded verbatim in the self-contained browser fixture.
export function sceneKernel() {
  const format = 'fruitctl.scene.v1', version = 1, cells = 20, cellSize = 6;
  const size = (cells + 2) * cellSize, margin = 16;
  const colors = { background: [64, 64, 64, 255], black: [0, 0, 0, 255],
    white: [255, 255, 255, 255], cyan: [0, 240, 240, 255] };
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function geometry(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 960 || height < 640 ||
        width > 16384 || height > 16384 || width * height > 32 * 1024 * 1024) {
      throw new Error('Fixture requires native dimensions >=960x640 and <=32 megapixels');
    }
    const centered = (x, y) => ({ x: Math.floor(x - size / 2), y: Math.floor(y - size / 2), width: size, height: size });
    const markers = [
      { x: margin, y: margin, width: size, height: size },
      { x: width - margin - size, y: margin, width: size, height: size },
      { x: margin, y: height - margin - size, width: size, height: size },
      { x: width - margin - size, y: height - margin - size, width: size, height: size },
      centered(width / 2, height / 2), centered(width / 4, height * 0.3), centered(width * 0.75, height * 0.7),
    ];
    const pointerZone = { x: Math.floor(width / 2) - 48, y: Math.floor(height * 0.82) - 48, width: 96, height: 96 };
    const intersects = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    if (markers.some((a, i) => markers.slice(i + 1).some(b => intersects(a, b))) || markers.some(a => intersects(a, pointerZone))) {
      throw new Error('Fixture geometry overlaps');
    }
    return { width, height, markers, pointerZone };
  }
  function markerBytes({ runId, sequence, width, height, markerId }) {
    if (!/^[0-9a-f]{32}$/.test(runId)) throw new Error('runId must be 32 lowercase hexadecimal characters');
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff) throw new Error('Invalid sequence');
    if (!Number.isInteger(markerId) || markerId < 0 || markerId > 6) throw new Error('Invalid markerId');
    geometry(width, height);
    const bytes = new Uint8Array(cells * cells / 8), view = new DataView(bytes.buffer);
    bytes.set([0x46, 0x51, 0x53, 0x31, version, markerId]); // FQS1
    for (let i = 0; i < 16; i++) bytes[6 + i] = parseInt(runId.slice(i * 2, i * 2 + 2), 16);
    view.setUint32(22, sequence); view.setUint16(26, width); view.setUint16(28, height);
    // The CRC binds padding as well as identity, sequence and geometry.
    view.setUint32(46, crc32(bytes.subarray(0, 46)));
    return bytes;
  }
  function draw({ width, height, runId, sequence }, fill) {
    const layout = geometry(width, height);
    fill(0, 0, width, height, colors.background);
    layout.markers.forEach((rect, markerId) => {
      fill(rect.x, rect.y, size, size, colors.cyan);
      const bytes = markerBytes({ width, height, runId, sequence, markerId });
      for (let bit = 0; bit < cells * cells; bit++) {
        const color = bytes[bit >>> 3] & (1 << (7 - (bit & 7))) ? colors.white : colors.black;
        fill(rect.x + (bit % cells + 1) * cellSize, rect.y + (Math.floor(bit / cells) + 1) * cellSize, cellSize, cellSize, color);
      }
    });
    return layout;
  }
  function renderPixels(options) {
    const { width, height } = geometry(options.width, options.height);
    const pixels = new Uint8Array(width * height * 4);
    draw(options, (x, y, w, h, color) => {
      const row = new Uint8Array(w * 4);
      for (let i = 0; i < w; i++) row.set(color, i * 4);
      for (let iy = y; iy < y + h; iy++) pixels.set(row, (iy * width + x) * 4);
    });
    return pixels;
  }
  return { format, version, cells, cellSize, size, margin, colors, crc32, geometry, markerBytes, draw, renderPixels };
}

export const scene = sceneKernel();
