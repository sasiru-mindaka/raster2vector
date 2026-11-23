export type OutputMode = 'hybrid' | 'exact' | 'photo';
export type GpuPreference = 'auto' | 'webgpu' | 'webgl2' | 'cpu';
export type ArtworkProfile = 'auto' | 'photo' | 'illustration' | 'poster' | 'logo';
export type CurveMode = 'bezier' | 'quad';
export type UnderlayMode = 'full' | 'masked';
export type TileMode = 'auto' | '0' | '512' | '1024' | '2048';
export interface SafeTraceSettings {
    mode: OutputMode;
    profile: ArtworkProfile;
    colors: number;
    smoothness: number;
    speckle: number;
    detailProtection: number;
    minVectorArea: number;
    edgeOverlap: number;
    maxDimension: number;
    underlay: UnderlayMode;
    curve: CurveMode;
    gradients: boolean;
    tileSize: TileMode;
    gpuBackend: GpuPreference;
    edgeProtection: boolean;
}
export interface SafeWorkerPayload {
    requestId: number;
    buffer: ArrayBuffer;
    width: number;
    height: number;
    settings: SafeTraceSettings;
}
export declare function sanitizeTraceSettings(value: unknown): SafeTraceSettings;
export declare function validateWorkerPayload(value: unknown): SafeWorkerPayload;
