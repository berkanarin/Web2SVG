export type CaptureMode = "semantic" | "dense";

export interface CaptureOptions {
  url: string;
  outDir: string;
  viewportWidth: number;
  viewportHeight: number;
  scale: number;
  fullPage: boolean;
  maxLayers: number;
  minArea: number;
  waitMs: number;
  timeoutMs: number;
  mode: CaptureMode;
  embed: boolean;
  interactive: boolean;
  profileDir: string | null;
  flatOnly: boolean;
}

export interface LayerCandidate {
  id: string;
  tag: string;
  selector: string;
  label: string;
  role: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  domIndex: number;
  depth: number;
  position: string;
  opacity: number;
  reason: string;
}

export interface LayerAsset extends LayerCandidate {
  fileName: string;
  imageWidth: number;
  imageHeight: number;
}

export interface CaptureResult {
  url: string;
  title: string;
  capturedAt: string;
  viewport: {
    cssWidth: number;
    cssHeight: number;
    scale: number;
    svgWidth: number;
    svgHeight: number;
    pageCssHeight: number;
  };
  background: {
    fileName: string;
    width: number;
    height: number;
  };
  cleanBackground?: {
    fileName: string;
    width: number;
    height: number;
  };
  layers: LayerAsset[];
}
