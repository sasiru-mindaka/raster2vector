export type GpuBackend = 'webgpu' | 'webgl2' | 'cpu';
export type GpuPreference = 'auto' | GpuBackend;
export interface PixelImage {
    width: number;
    height: number;
    data: Uint8ClampedArray;
}
export interface GpuClassification {
    backend: GpuBackend;
    assignments: Uint16Array | null;
    edgeMask: Uint8Array | null;
    edgePixels: number;
    elapsedMs: number;
    fallbackReason?: string;
}
export declare function classifyPaletteOnGpu(image: PixelImage, labelLut: Int32Array, paletteCount: number, preference?: GpuPreference): Promise<GpuClassification>;
