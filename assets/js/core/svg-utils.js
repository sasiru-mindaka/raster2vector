const ALLOWED_ELEMENTS = new Set(['svg', 'defs', 'lineargradient', 'stop', 'path', 'image']);
const ACTIVE_CONTENT = /<(?:script|foreignObject|iframe|object|embed|audio|video|use|style|a|text|filter|animate|set)\b/i;
const EXTERNAL_REFERENCE = /(?:javascript\s*:|vbscript\s*:|data\s*:\s*text\/html|https?:\/\/|file\s*:|\/\/)/i;

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';

const ALLOWED_SVG_ATTRIBUTES = Object.freeze({
  svg: new Set(['xmlns', 'xmlns:xlink', 'version', 'width', 'height', 'viewBox', 'shape-rendering']),
  defs: new Set(),
  linearGradient: new Set(['id', 'gradientUnits', 'x1', 'y1', 'x2', 'y2']),
  stop: new Set(['offset', 'stop-color']),
  path: new Set(['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linejoin', 'd']),
  image: new Set(['x', 'y', 'width', 'height', 'href', 'preserveAspectRatio'])
});

export function isAllowedSvgAttribute(elementName, attributeName) {
  return ALLOWED_SVG_ATTRIBUTES[elementName]?.has(attributeName) === true;
}

/**
 * Returns true when an SVG attribute value contains an active or external URL.
 * The two exact namespace declarations on the root <svg> element are trusted
 * XML metadata, not resource loads, and must not be treated as unsafe URLs.
 */
export function hasUnsafeSvgAttributeValue(element, attribute, root) {
  const trustedNamespace = element === root && (
    (attribute.name === 'xmlns' && attribute.value === SVG_NAMESPACE) ||
    (attribute.name === 'xmlns:xlink' && attribute.value === XLINK_NAMESPACE)
  );
  if (trustedNamespace) return false;
  return /^on/i.test(attribute.name) || /javascript:|vbscript:|https?:|file:|data:text\/html/i.test(attribute.value);
}

export function inspectSvg(svgText) {
  if (typeof svgText !== 'string' || svgText.length < 20 || svgText.length > 200 * 1024 * 1024 || !/<svg[\s>]/i.test(svgText)) {
    throw new Error('The tracing engine did not return a valid SVG document.');
  }
  if (ACTIVE_CONTENT.test(svgText) || /<!DOCTYPE|<!ENTITY|<\s*!/i.test(svgText) || /<\?(?!xml\s)/i.test(svgText) || /\bon[a-z][\w:-]*\s*=|\bstyle\s*=/i.test(svgText)) {
    throw new Error('The tracing engine returned SVG containing unsupported active content.');
  }
  const tags = [...svgText.matchAll(/<\/?([a-z][\w:-]*)\b/gi)].map((match) => match[1].toLowerCase());
  if (!tags.length || tags[0] !== 'svg' || tags.some((tag) => !ALLOWED_ELEMENTS.has(tag))) {
    throw new Error('The SVG contains an unsupported element.');
  }
  const hrefs = [...svgText.matchAll(/\b(?:href|xlink:href)\s*=\s*["']([^"']*)["']/gi)].map((match) => match[1]);
  if (hrefs.some((href) => !/^data:image\/png;base64,[a-z0-9+/=]+$/i.test(href))) {
    throw new Error('The SVG contains an external or unsupported resource reference.');
  }
  const urlValues = [...svgText.matchAll(/\b(?:fill|stroke)\s*=\s*["']([^"']*)["']/gi)].map((match) => match[1]);
  if (urlValues.some((value) => value.startsWith('url(') && !/^url\(#g\d+\)$/.test(value))) {
    throw new Error('The SVG contains an unsafe paint reference.');
  }
  const withoutNamespaces = svgText.replace(/\sxmlns(?::[a-z-]+)?\s*=\s*[\"'][^\"']+[\"']/gi, '');
  if (EXTERNAL_REFERENCE.test(withoutNamespaces.replace(/data:image\/png;base64,[a-z0-9+/=]+/gi, ''))) {
    throw new Error('The SVG contains an external resource reference.');
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
