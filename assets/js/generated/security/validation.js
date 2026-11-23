const enumValues = {
    mode: ['hybrid', 'exact', 'photo'],
    profile: ['auto', 'photo', 'illustration', 'poster', 'logo'],
    underlay: ['full', 'masked'],
    curve: ['bezier', 'quad'],
    tileSize: ['auto', '0', '512', '1024', '2048'],
    gpuBackend: ['auto', 'webgpu', 'webgl2', 'cpu']
};
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function enumValue(value, allowed, fallback, key) {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new Error(`Invalid ${key} setting.`);
    }
    return value;
}
function numericValue(value, fallback, min, max, key) {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error(`Invalid ${key} setting.`);
    return Math.min(max, Math.max(min, value));
}
function booleanValue(value, fallback, key) {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'boolean')
        throw new Error(`Invalid ${key} setting.`);
    return value;
}
export function sanitizeTraceSettings(value) {
    if (!isRecord(value))
        throw new Error('Trace settings are missing or malformed.');
    return {
        mode: enumValue(value.mode, enumValues.mode, 'hybrid', 'mode'),
        profile: enumValue(value.profile, enumValues.profile, 'auto', 'profile'),
        colors: Math.round(numericValue(value.colors, 256, 8, 512, 'colors')),
        smoothness: numericValue(value.smoothness, 1, 0, 3, 'smoothness'),
        speckle: numericValue(value.speckle, 0, 0, 16, 'speckle'),
        detailProtection: numericValue(value.detailProtection, 90, 0, 100, 'detailProtection'),
        minVectorArea: Math.round(numericValue(value.minVectorArea, 48, 1, 2048, 'minVectorArea')),
        edgeOverlap: Math.round(numericValue(value.edgeOverlap, 2, 0, 8, 'edgeOverlap')),
        maxDimension: Math.round(numericValue(value.maxDimension, 6000, 1000, 6000, 'maxDimension')),
        underlay: enumValue(value.underlay, enumValues.underlay, 'full', 'underlay'),
        curve: enumValue(value.curve, enumValues.curve, 'bezier', 'curve'),
        gradients: booleanValue(value.gradients, true, 'gradients'),
        tileSize: enumValue(value.tileSize, enumValues.tileSize, 'auto', 'tileSize'),
        gpuBackend: enumValue(value.gpuBackend, enumValues.gpuBackend, 'auto', 'gpuBackend'),
        edgeProtection: booleanValue(value.edgeProtection, true, 'edgeProtection')
    };
}
export function validateWorkerPayload(value) {
    if (!isRecord(value))
        throw new Error('Malformed tracing request.');
    const { requestId, buffer, width, height, settings } = value;
    if (typeof requestId !== 'number' || !Number.isSafeInteger(requestId) || requestId < 1) {
        throw new Error('Invalid tracing request identifier.');
    }
    if (!(buffer instanceof ArrayBuffer))
        throw new Error('Image data buffer is invalid.');
    if (typeof width !== 'number' || !Number.isSafeInteger(width) || width < 1 || width > 12000) {
        throw new Error('Image width is outside the supported range.');
    }
    if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 1 || height > 12000) {
        throw new Error('Image height is outside the supported range.');
    }
    const pixels = width * height;
    if (!Number.isSafeInteger(pixels) || pixels > 12_000_000)
        throw new Error('The image exceeds the 12-megapixel processing limit.');
    if (buffer.byteLength !== pixels * 4)
        throw new Error('Image pixel data length does not match its dimensions.');
    return { requestId, buffer, width, height, settings: sanitizeTraceSettings(settings) };
}
//# sourceMappingURL=validation.js.map