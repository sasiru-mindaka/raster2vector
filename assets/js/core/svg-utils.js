export function inspectSvg(svgText) {
  if (typeof svgText !== 'string' || svgText.length < 20 || !/<svg[\s>]/i.test(svgText)) {
    throw new Error('The tracing engine did not return a valid SVG document.');
  }
  if (/<(?:script|foreignObject)\b/i.test(svgText) || /\bon\w+\s*=/i.test(svgText)) {
    throw new Error('The tracing engine returned SVG containing unsupported active content.');
  }
  const pathCount = (svgText.match(/<path\b/gi) || []).length;
  const fillMatches = [...svgText.matchAll(/\bfill\s*=\s*["']([^"']+)["']/gi)];
  const colourCount = new Set(fillMatches.map((match) => match[1].toLowerCase()).filter((fill) => fill !== 'none')).size;
  const widthMatch = svgText.match(/\bwidth\s*=\s*["']([0-9.]+)/i);
  const heightMatch = svgText.match(/\bheight\s*=\s*["']([0-9.]+)/i);
  return {
    svg: svgText,
    pathCount,
    colorCount: colourCount,
    width: widthMatch ? Number(widthMatch[1]) : undefined,
    height: heightMatch ? Number(heightMatch[1]) : undefined
  };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
