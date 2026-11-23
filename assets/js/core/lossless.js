export const MAX_LOSSLESS_REGIONS = 250_000;

export class ComplexityLimitError extends Error {
  constructor() {
    super('The exact pixel geometry is too complex for a practical SVG.');
    this.name = 'ComplexityLimitError';
    this.code = 'LOSSLESS_COMPLEXITY_LIMIT';
  }
}

export function buildLosslessSvg(imageData, maxRegions = MAX_LOSSLESS_REGIONS) {
  if (!imageData || !Number.isInteger(imageData.width) || !Number.isInteger(imageData.height) ||
      imageData.width < 1 || imageData.height < 1 || !imageData.data ||
      imageData.data.length !== imageData.width * imageData.height * 4) {
    throw new TypeError('Invalid RGBA ImageData.');
  }

  const { width, height, data } = imageData;
  const active = new Map();
  const byColour = new Map();
  const colours = new Set();
  let regionCount = 0;

  const flush = (run) => {
    let paths = byColour.get(run.key);
    if (!paths) byColour.set(run.key, paths = []);
    paths.push(`M${run.x} ${run.y}h${run.width}v${run.height}h-${run.width}Z`);
  };

  for (let y = 0; y < height; y += 1) {
    const next = new Map();
    const row = y * width * 4;
    let x = 0;

    while (x < width) {
      const i = row + x * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      const key = `${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}:${a}`;
      colours.add(key);
      const start = x++;
      while (x < width) {
        const j = row + x * 4;
        if (data[j] !== r || data[j + 1] !== g || data[j + 2] !== b || data[j + 3] !== a) break;
        x += 1;
      }

      const runWidth = x - start;
      const runId = `${key}|${start}|${runWidth}`;
      const previous = active.get(runId);
      if (previous) {
        previous.height += 1;
        next.set(runId, previous);
      } else {
        regionCount += 1;
        if (regionCount > maxRegions) throw new ComplexityLimitError();
        next.set(runId, { key, x: start, y, width: runWidth, height: 1 });
      }
    }

    for (const [runId, run] of active) if (!next.has(runId)) flush(run);
    active.clear();
    for (const [runId, run] of next) active.set(runId, run);
  }
  for (const run of active.values()) flush(run);

  const paths = [];
  for (const [key, commands] of byColour) {
    const [hex, alphaText] = key.split(':');
    const alpha = Number(alphaText);
    const opacity = alpha === 255 ? '' : ` fill-opacity="${(alpha / 255).toPrecision(8)}"`;
    paths.push(`<path fill="#${hex}"${opacity} d="${commands.join('')}"/>`);
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    paths.join('') + '</svg>';
  return { svg, width, height, colorCount: colours.size, pathCount: paths.length, regionCount, mode: 'exact' };
}
