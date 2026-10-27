export const SANDBOX_CSP: string;
export const DEFAULT_LIMITS: { callsPerWindow: number; windowMs: number; maxRequestBytes: number; maxResultBytes: number };
export function needsMermaid(source: string): boolean;
export function buildSandboxDoc(o: { kind?: string; html?: string; source?: string; tokensCss: string; bootstrapSource: string; uiKitSource: string; vdocSource?: string; docRenderSource?: string; mermaidSource?: string; theme?: string; nonce?: string }): string;
export function mountArtifact(cfg: any): { iframe: HTMLIFrameElement; footer: HTMLElement; reads: unknown[]; destroy(): void };
