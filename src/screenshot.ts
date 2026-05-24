import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import type { CaptureResult, LayerAsset, LayerCandidate } from "./types.js";
import { ensureCleanDir, sanitizeFilePart } from "./utils.js";

type ScreenshotDetail = "coarse" | "normal" | "detailed";
type ScreenshotEngine = "fast" | "advanced";

export interface ScreenshotCaptureOptions {
  imageData: string;
  fileName: string;
  outDir: string;
  engine: ScreenshotEngine;
  detail: ScreenshotDetail;
  maxLayers: number;
  minArea: number;
  cleanBackground: boolean;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Component extends Box {
  cells: number;
}

interface TrimmedPng extends Box {}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export async function captureScreenshot(options: ScreenshotCaptureOptions): Promise<CaptureResult> {
  const outDir = path.resolve(options.outDir);
  const layersDir = path.join(outDir, "layers");
  await ensureCleanDir(outDir);
  await mkdir(layersDir, { recursive: true });

  const source = PNG.sync.read(decodeImageData(options.imageData));
  await writeFile(path.join(layersDir, "000-background.png"), PNG.sync.write(source));

  const candidates = options.engine === "advanced" ? detectAdvancedCandidates(source, options) : detectCandidates(source, options);
  const layers = await writeLayerAssets(source, layersDir, candidates, options.detail);
  const cleanBackground = options.cleanBackground
    ? await writeCleanBackground(source, layersDir, layers)
    : undefined;

  return {
    url: `screenshot://${sanitizeFilePart(options.fileName || "uploaded-image")}`,
    title: options.fileName || "Uploaded Screenshot",
    capturedAt: new Date().toISOString(),
    viewport: {
      cssWidth: source.width,
      cssHeight: source.height,
      scale: 1,
      svgWidth: source.width,
      svgHeight: source.height,
      pageCssHeight: source.height
    },
    background: {
      fileName: "000-background.png",
      width: source.width,
      height: source.height
    },
    cleanBackground,
    layers
  };
}

function decodeImageData(imageData: string): Buffer {
  const match = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(imageData.trim());
  if (!match) {
    throw new Error("Screenshot upload must be converted to PNG before capture.");
  }
  return Buffer.from(match[1] ?? "", "base64");
}

function detectCandidates(source: PNG, options: ScreenshotCaptureOptions): LayerCandidate[] {
  const cellSize = options.detail === "detailed" ? 3 : options.detail === "coarse" ? 6 : 4;
  const edgeThreshold = options.detail === "detailed" ? 18 : options.detail === "coarse" ? 30 : 24;
  const dilateRadius = options.detail === "detailed" ? 3 : options.detail === "coarse" ? 8 : 5;
  const gridWidth = Math.ceil(source.width / cellSize);
  const gridHeight = Math.ceil(source.height / cellSize);
  const colors = new Uint8Array(gridWidth * gridHeight * 3);
  const edges = new Uint8Array(gridWidth * gridHeight);

  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const color = sampleCell(source, gx * cellSize, gy * cellSize, cellSize);
      const index = (gy * gridWidth + gx) * 3;
      colors[index] = color.r;
      colors[index + 1] = color.g;
      colors[index + 2] = color.b;
    }
  }

  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const current = gridColor(colors, gridWidth, gx, gy);
      const right = gx + 1 < gridWidth ? gridColor(colors, gridWidth, gx + 1, gy) : current;
      const down = gy + 1 < gridHeight ? gridColor(colors, gridWidth, gx, gy + 1) : current;
      if (colorDistance(current, right) > edgeThreshold || colorDistance(current, down) > edgeThreshold) {
        edges[gy * gridWidth + gx] = 1;
      }
    }
  }

  const mask = dilate(edges, gridWidth, gridHeight, dilateRadius);
  const components = connectedComponents(mask, gridWidth, gridHeight, cellSize, source.width, source.height);
  const boxes = pruneBoxes(components, source.width, source.height, options)
    .slice(0, options.maxLayers)
    .sort((a, b) => a.y - b.y || a.x - b.x);

  return boxes.map((box, index) => candidateFromBox(box, index, `screenshot-region-${index + 1}`));
}

function detectAdvancedCandidates(source: PNG, options: ScreenshotCaptureOptions): LayerCandidate[] {
  const normal = detectCandidates(source, { ...options, engine: "fast", detail: "normal" });
  const surfaces = detectLayoutSurfaceCandidates(source, options);
  if (options.detail !== "detailed") {
    return normalizeCandidates(rankCandidates([...surfaces, ...normal], source.width, source.height), options.maxLayers);
  }

  const detailed = detectCandidates(source, {
    ...options,
    engine: "fast",
    detail: "detailed",
    minArea: Math.max(600, Math.floor(options.minArea * 0.35)),
    maxLayers: Math.max(options.maxLayers, 180)
  });
  const largeRegions = normal.filter((candidate) => candidate.width * candidate.height >= options.minArea * 8);
  const smallDetails = detailed.filter((candidate) => {
    const area = candidate.width * candidate.height;
    if (area > options.minArea * 12) return false;
    if (candidate.width < 14 || candidate.height < 8) return false;
    return !normal.some((region) => containsBox(region, candidate) && area < region.width * region.height * 0.72);
  });

  return normalizeCandidates(rankCandidates([...surfaces, ...normal, ...smallDetails], source.width, source.height), options.maxLayers);
}

function candidateFromBox(box: Box, index: number, label: string): LayerCandidate {
  return {
    id: `shot-${index + 1}`,
    tag: "IMG",
    selector: label,
    label,
    role: null,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    zIndex: index + 1,
    domIndex: index + 1,
    depth: 0,
    position: "absolute",
    opacity: 1,
    reason: "screenshot"
  };
}

function normalizeCandidates(candidates: LayerCandidate[], maxLayers: number): LayerCandidate[] {
  return candidates
    .slice(0, maxLayers)
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((candidate, index) => ({
      ...candidate,
      id: `shot-${index + 1}`,
      selector: candidate.label || `screenshot-region-${index + 1}`,
      zIndex: index + 1,
      domIndex: index + 1
    }));
}

function detectLayoutSurfaceCandidates(source: PNG, options: ScreenshotCaptureOptions): LayerCandidate[] {
  const background = detectPageBackgroundColor(source);
  const surfaceMask = buildSurfaceMask(source, background);
  const boxes: Array<Box & { label: string }> = [];
  const sidebar = detectSidebarSurface(surfaceMask, source.width, source.height);

  if (sidebar && sidebar.width >= 120) {
    boxes.push({ ...sidebar, label: "screenshot-sidebar" });
  }

  const contentStartX = sidebar ? sidebar.x + sidebar.width : 0;
  for (const [index, band] of detectHorizontalSurfaces(surfaceMask, source.width, source.height, contentStartX).entries()) {
    boxes.push({ ...band, label: index === 0 ? "screenshot-top-bars" : `screenshot-top-bar-${index + 1}` });
  }

  const components = surfaceComponents(surfaceMask, source.width, source.height, options, boxes);
  for (const [index, box] of components.entries()) {
    boxes.push({ ...box, label: `screenshot-surface-${index + 1}` });
  }

  return boxes.map((box, index) => candidateFromBox(box, index, box.label));
}

function buildSurfaceMask(source: PNG, background: Rgba): Uint8Array {
  const mask = new Uint8Array(source.width * source.height);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const color = pixelAt(source, x, y);
      const brightness = (color.r + color.g + color.b) / 3;
      const spread = Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b);
      const lightSurface = brightness >= 246 && spread <= 18 && colorDistance(color, background) >= 8;
      if (lightSurface) mask[y * source.width + x] = 1;
    }
  }
  return mask;
}

function detectSidebarSurface(mask: Uint8Array, width: number, height: number): Box | null {
  const maxScan = Math.min(width, Math.floor(width * 0.32));
  let lastSurfaceColumn = -1;
  for (let x = 0; x < maxScan; x += 1) {
    let hits = 0;
    let bottomHits = 0;
    let bottomTotal = 0;
    for (let y = 0; y < height; y += 4) {
      hits += mask[y * width + x] ? 1 : 0;
      if (y >= height * 0.62) {
        bottomHits += mask[y * width + x] ? 1 : 0;
        bottomTotal += 1;
      }
    }
    const totalRatio = hits / Math.ceil(height / 4);
    const bottomRatio = bottomTotal > 0 ? bottomHits / bottomTotal : 0;
    if (totalRatio > 0.46 && bottomRatio > 0.42) lastSurfaceColumn = x;
    if (x > 80 && lastSurfaceColumn >= 0 && x - lastSurfaceColumn > 28) break;
  }
  if (lastSurfaceColumn < 80) return null;
  return { x: 0, y: 0, width: Math.min(width, lastSurfaceColumn + 2), height };
}

function detectHorizontalSurfaces(mask: Uint8Array, width: number, height: number, startX: number): Box[] {
  const minX = Math.max(0, Math.min(width - 1, startX));
  const scanWidth = width - minX;
  const rows = new Uint8Array(height);
  for (let y = 0; y < Math.min(height, Math.floor(height * 0.2)); y += 1) {
    let hits = 0;
    for (let x = minX; x < width; x += 4) {
      hits += mask[y * width + x] ? 1 : 0;
    }
    if (hits / Math.ceil(scanWidth / 4) > 0.5) rows[y] = 1;
  }

  const bands: Box[] = [];
  let y = 0;
  while (y < rows.length) {
    while (y < rows.length && !rows[y]) y += 1;
    const startY = y;
    while (y < rows.length && rows[y]) y += 1;
    const bandHeight = y - startY;
    if (bandHeight >= 32) {
      const padded = expandBox({ x: minX, y: startY, width: scanWidth, height: bandHeight }, 1, width, height);
      bands.push(padded);
    }
  }

  return mergeNearbyHorizontalBands(bands);
}

function mergeNearbyHorizontalBands(bands: Box[]): Box[] {
  const merged: Box[] = [];
  for (const band of bands) {
    const last = merged[merged.length - 1];
    if (last && band.y - (last.y + last.height) <= 8) {
      const union = unionBox(last, band);
      merged[merged.length - 1] = union;
    } else {
      merged.push(band);
    }
  }
  return merged.slice(0, 3);
}

function surfaceComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  options: ScreenshotCaptureOptions,
  reserved: Box[]
): Box[] {
  const cellSize = 8;
  const gridWidth = Math.ceil(width / cellSize);
  const gridHeight = Math.ceil(height / cellSize);
  const grid = new Uint8Array(gridWidth * gridHeight);

  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const x1 = gx * cellSize;
      const y1 = gy * cellSize;
      let hits = 0;
      let total = 0;
      for (let y = y1; y < Math.min(height, y1 + cellSize); y += 1) {
        for (let x = x1; x < Math.min(width, x1 + cellSize); x += 1) {
          hits += mask[y * width + x] ? 1 : 0;
          total += 1;
        }
      }
      if (total > 0 && hits / total > 0.72) grid[gy * gridWidth + gx] = 1;
    }
  }

  const components = connectedComponents(grid, gridWidth, gridHeight, cellSize, width, height);
  return components
    .map((component) => expandBox(component, 2, width, height))
    .filter((box) => {
      const area = box.width * box.height;
      if (area < Math.max(options.minArea, 5000)) return false;
      if (reserved.some((reservedBox) => intersectionOverUnion(reservedBox, box) > 0.1 || containsBox(reservedBox, box))) return false;
      return true;
    })
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .slice(0, Math.max(0, Math.min(12, options.maxLayers)));
}

function rankCandidates(candidates: LayerCandidate[], imageWidth: number, imageHeight: number): LayerCandidate[] {
  const kept: LayerCandidate[] = [];
  const sorted = candidates
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, imageWidth, imageHeight)
    }))
    .sort((a, b) => b.score - a.score);

  for (const { candidate } of sorted) {
    const duplicate = kept.some((current) => intersectionOverUnion(current, candidate) > 0.72);
    const contained = kept.some(
      (current) =>
        containsBox(current, candidate) &&
        candidate.width * candidate.height < current.width * current.height * 0.72
    );
    const aspect = candidate.width / Math.max(1, candidate.height);
    const strayRule = aspect > 8 && candidate.height < 70;
    if (!duplicate && !contained && !strayRule) kept.push(candidate);
  }

  return kept;
}

function scoreCandidate(candidate: Box, imageWidth: number, imageHeight: number): number {
  const area = candidate.width * candidate.height;
  const imageArea = imageWidth * imageHeight;
  const aspect = candidate.width / Math.max(1, candidate.height);
  const cardLike = area > imageArea * 0.025 && aspect > 0.8 && aspect < 4.5 ? 80 : 0;
  const toolbarLike = candidate.y < imageHeight * 0.22 && candidate.height < imageHeight * 0.16 ? 45 : 0;
  const sidebarLike = candidate.x < imageWidth * 0.2 && candidate.height > imageHeight * 0.08 ? 45 : 0;
  const usefulSize = Math.min(70, area / 3500);
  const tinyPenalty = area < 1200 ? -60 : 0;
  return cardLike + toolbarLike + sidebarLike + usefulSize + tinyPenalty;
}

function sampleCell(source: PNG, startX: number, startY: number, size: number): Rgba {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let count = 0;
  const endX = Math.min(source.width, startX + size);
  const endY = Math.min(source.height, startY + size);

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const index = (y * source.width + x) * 4;
      r += source.data[index] ?? 0;
      g += source.data[index + 1] ?? 0;
      b += source.data[index + 2] ?? 0;
      a += source.data[index + 3] ?? 255;
      count += 1;
    }
  }

  return {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count),
    a: Math.round(a / count)
  };
}

function gridColor(colors: Uint8Array, gridWidth: number, gx: number, gy: number): Rgba {
  const index = (gy * gridWidth + gx) * 3;
  return {
    r: colors[index] ?? 0,
    g: colors[index + 1] ?? 0,
    b: colors[index + 2] ?? 0,
    a: 255
  };
}

function colorDistance(a: Rgba, b: Rgba): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

function dilate(source: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const target = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!source[y * width + x]) continue;
      const minX = Math.max(0, x - radius);
      const maxX = Math.min(width - 1, x + radius);
      const minY = Math.max(0, y - radius);
      const maxY = Math.min(height - 1, y + radius);
      for (let yy = minY; yy <= maxY; yy += 1) {
        for (let xx = minX; xx <= maxX; xx += 1) {
          target[yy * width + xx] = 1;
        }
      }
    }
  }
  return target;
}

function connectedComponents(
  mask: Uint8Array,
  gridWidth: number,
  gridHeight: number,
  cellSize: number,
  imageWidth: number,
  imageHeight: number
): Component[] {
  const seen = new Uint8Array(mask.length);
  const components: Component[] = [];
  const queue: number[] = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let minX = gridWidth;
    let minY = gridHeight;
    let maxX = -1;
    let maxY = -1;
    let cells = 0;
    queue.length = 0;
    queue.push(start);
    seen[start] = 1;

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const item = queue[cursor] ?? 0;
      const x = item % gridWidth;
      const y = Math.floor(item / gridWidth);
      cells += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      for (const next of [item - 1, item + 1, item - gridWidth, item + gridWidth]) {
        if (next < 0 || next >= mask.length || seen[next] || !mask[next]) continue;
        const nx = next % gridWidth;
        const ny = Math.floor(next / gridWidth);
        if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }

    components.push({
      x: Math.max(0, minX * cellSize),
      y: Math.max(0, minY * cellSize),
      width: Math.min(imageWidth, (maxX + 1) * cellSize) - Math.max(0, minX * cellSize),
      height: Math.min(imageHeight, (maxY + 1) * cellSize) - Math.max(0, minY * cellSize),
      cells
    });
  }

  return components;
}

function pruneBoxes(
  components: Component[],
  imageWidth: number,
  imageHeight: number,
  options: ScreenshotCaptureOptions
): Box[] {
  const imageArea = imageWidth * imageHeight;
  const minSide = options.detail === "detailed" ? 18 : options.detail === "coarse" ? 42 : 28;
  const padded = components
    .map((component) => expandBox(component, options.detail === "coarse" ? 4 : 2, imageWidth, imageHeight))
    .filter((box) => {
      const area = box.width * box.height;
      if (box.width < minSide || box.height < minSide) return false;
      if (area < options.minArea) return false;
      if (area > imageArea * 0.88) return false;
      return true;
    })
    .sort((a, b) => b.width * b.height - a.width * a.height);

  const candidates = options.detail === "detailed" ? padded : mergeFragmentedBoxes(padded, imageWidth, imageHeight);
  const kept: Box[] = [];
  for (const box of candidates) {
    const duplicate = kept.some((current) => intersectionOverUnion(current, box) > 0.68);
    const swallowed =
      options.detail !== "detailed" &&
      kept.some((current) => containsBox(current, box) && box.width * box.height < current.width * current.height * 0.72);
    if (!duplicate && !swallowed) kept.push(box);
  }

  return kept;
}

function mergeFragmentedBoxes(boxes: Box[], imageWidth: number, imageHeight: number): Box[] {
  const merged = boxes.map((box) => ({ ...box }));
  let changed = true;

  while (changed) {
    changed = false;
    outer: for (let i = 0; i < merged.length; i += 1) {
      for (let j = i + 1; j < merged.length; j += 1) {
        const a = merged[i];
        const b = merged[j];
        if (!a || !b || !shouldMergeFragments(a, b, imageWidth, imageHeight)) continue;
        merged[i] = unionBox(a, b);
        merged.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }

  return merged;
}

function shouldMergeFragments(a: Box, b: Box, imageWidth: number, imageHeight: number): boolean {
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const smallerArea = Math.min(areaA, areaB);
  const largerArea = Math.max(areaA, areaB);
  if (smallerArea < largerArea * 0.16) return false;

  const horizontalGap = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
  const verticalGap = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
  const yOverlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const xOverlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const minHeight = Math.min(a.height, b.height);
  const minWidth = Math.min(a.width, b.width);
  const heightRatio = minHeight / Math.max(a.height, b.height);
  const widthRatio = minWidth / Math.max(a.width, b.width);
  const verticalFragment =
    Math.min(a.y, b.y) > imageHeight * 0.14 &&
    yOverlap > minHeight * 0.52 &&
    horizontalGap <= 96 &&
    (heightRatio < 0.88 || Math.abs(a.y - b.y) > 32 || Math.abs(a.y + a.height - (b.y + b.height)) > 32);
  const horizontalFragment =
    Math.min(a.y, b.y) > imageHeight * 0.14 &&
    xOverlap > minWidth * 0.52 &&
    verticalGap <= 64 &&
    (widthRatio < 0.88 || Math.abs(a.x - b.x) > 32 || Math.abs(a.x + a.width - (b.x + b.width)) > 32);

  if (!verticalFragment && !horizontalFragment) return false;

  const union = unionBox(a, b);
  const unionArea = union.width * union.height;
  const imageArea = imageWidth * imageHeight;
  if (unionArea > imageArea * 0.35) return false;
  if (union.width > imageWidth * 0.52 && union.height > imageHeight * 0.24) return false;
  return true;
}

function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

function expandBox(box: Box, amount: number, imageWidth: number, imageHeight: number): Box {
  const x = Math.max(0, Math.floor(box.x - amount));
  const y = Math.max(0, Math.floor(box.y - amount));
  const right = Math.min(imageWidth, Math.ceil(box.x + box.width + amount));
  const bottom = Math.min(imageHeight, Math.ceil(box.y + box.height + amount));
  return { x, y, width: right - x, height: bottom - y };
}

function containsBox(parent: Box, child: Box): boolean {
  return (
    child.x >= parent.x &&
    child.y >= parent.y &&
    child.x + child.width <= parent.x + parent.width &&
    child.y + child.height <= parent.y + parent.height
  );
}

function intersectionOverUnion(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

async function writeLayerAssets(
  source: PNG,
  layersDir: string,
  candidates: LayerCandidate[],
  detail: ScreenshotDetail
): Promise<LayerAsset[]> {
  const layers: LayerAsset[] = [];
  const padding = detail === "detailed" ? 8 : detail === "coarse" ? 20 : 12;

  for (const [index, candidate] of candidates.entries()) {
    const box = expandBox(candidate, padding, source.width, source.height);
    const crop = cropPng(source, box);
    applyBackgroundAlpha(crop, detail);
    const fileName = `${String(index + 1).padStart(3, "0")}-${sanitizeFilePart(candidate.label)}.png`;
    const filePath = path.join(layersDir, fileName);
    await writeFile(filePath, PNG.sync.write(crop));
    const trimmed = await trimTransparentPng(filePath);
    if (!trimmed) continue;

    layers.push({
      ...candidate,
      x: box.x + trimmed.x,
      y: box.y + trimmed.y,
      width: trimmed.width,
      height: trimmed.height,
      fileName,
      imageWidth: trimmed.width,
      imageHeight: trimmed.height
    });
  }

  return layers;
}

function cropPng(source: PNG, box: Box): PNG {
  const crop = new PNG({ width: box.width, height: box.height });
  for (let y = 0; y < box.height; y += 1) {
    const sourceStart = ((box.y + y) * source.width + box.x) * 4;
    const targetStart = y * box.width * 4;
    source.data.copy(crop.data, targetStart, sourceStart, sourceStart + box.width * 4);
  }
  return crop;
}

function applyBackgroundAlpha(crop: PNG, detail: ScreenshotDetail): void {
  const borderColor = averageBorderColor(crop);
  const centerColor = averageCenterColor(crop);
  const threshold = detail === "detailed" ? 12 : detail === "coarse" ? 24 : 18;
  if (colorDistance(borderColor, centerColor) < 8) return;

  const seen = new Uint8Array(crop.width * crop.height);
  const queue: number[] = [];
  const push = (x: number, y: number) => {
    const index = y * crop.width + x;
    if (seen[index]) return;
    const color = pixelAt(crop, x, y);
    if (colorDistance(color, borderColor) > threshold) return;
    seen[index] = 1;
    queue.push(index);
  };

  for (let x = 0; x < crop.width; x += 1) {
    push(x, 0);
    push(x, crop.height - 1);
  }
  for (let y = 0; y < crop.height; y += 1) {
    push(0, y);
    push(crop.width - 1, y);
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const item = queue[cursor] ?? 0;
    const x = item % crop.width;
    const y = Math.floor(item / crop.width);
    const dataIndex = item * 4;
    crop.data[dataIndex + 3] = 0;
    if (x > 0) push(x - 1, y);
    if (x + 1 < crop.width) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y + 1 < crop.height) push(x, y + 1);
  }
}

function averageBorderColor(source: PNG): Rgba {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const add = (x: number, y: number) => {
    const color = pixelAt(source, x, y);
    r += color.r;
    g += color.g;
    b += color.b;
    count += 1;
  };

  for (let x = 0; x < source.width; x += 1) {
    add(x, 0);
    add(x, source.height - 1);
  }
  for (let y = 1; y < source.height - 1; y += 1) {
    add(0, y);
    add(source.width - 1, y);
  }

  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count), a: 255 };
}

function averageCenterColor(source: PNG): Rgba {
  const x1 = Math.floor(source.width * 0.3);
  const x2 = Math.max(x1 + 1, Math.floor(source.width * 0.7));
  const y1 = Math.floor(source.height * 0.3);
  const y2 = Math.max(y1 + 1, Math.floor(source.height * 0.7));
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (let y = y1; y < y2; y += 1) {
    for (let x = x1; x < x2; x += 1) {
      const color = pixelAt(source, x, y);
      r += color.r;
      g += color.g;
      b += color.b;
      count += 1;
    }
  }

  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count), a: 255 };
}

function pixelAt(source: PNG, x: number, y: number): Rgba {
  const index = (y * source.width + x) * 4;
  return {
    r: source.data[index] ?? 0,
    g: source.data[index + 1] ?? 0,
    b: source.data[index + 2] ?? 0,
    a: source.data[index + 3] ?? 255
  };
}

async function trimTransparentPng(filePath: string): Promise<TrimmedPng | null> {
  const source = PNG.sync.read(await readFile(filePath));
  let minX = source.width;
  let minY = source.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const alpha = source.data[(source.width * y + x) * 4 + 3] ?? 0;
      if (alpha === 0) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) return null;

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const cropped = new PNG({ width, height });

  for (let y = 0; y < height; y += 1) {
    const sourceStart = ((minY + y) * source.width + minX) * 4;
    const targetStart = y * width * 4;
    source.data.copy(cropped.data, targetStart, sourceStart, sourceStart + width * 4);
  }

  await writeFile(filePath, PNG.sync.write(cropped));
  return { x: minX, y: minY, width, height };
}

async function writeCleanBackground(
  source: PNG,
  layersDir: string,
  layers: LayerAsset[]
): Promise<{ fileName: string; width: number; height: number }> {
  const clean = createSegmentCleanBackground(source, layers);
  const fileName = "000-background-clean.png";
  await writeFile(path.join(layersDir, fileName), PNG.sync.write(clean));
  return { fileName, width: source.width, height: source.height };
}

function buildInpaintMask(source: PNG, layers: LayerAsset[]): Uint8Array {
  const mask = new Uint8Array(source.width * source.height);
  for (const layer of layers) {
    const box = expandBox(layer, cleanPadding(layer, source.width, source.height), source.width, source.height);
    const x1 = Math.max(0, Math.floor(box.x));
    const y1 = Math.max(0, Math.floor(box.y));
    const x2 = Math.min(source.width, Math.ceil(box.x + box.width));
    const y2 = Math.min(source.height, Math.ceil(box.y + box.height));
    for (let y = y1; y < y2; y += 1) {
      const rowStart = y * source.width;
      for (let x = x1; x < x2; x += 1) {
        mask[rowStart + x] = 255;
      }
    }
  }
  return mask;
}

function createSegmentCleanBackground(source: PNG, layers: LayerAsset[]): PNG {
  const layerMask = buildInpaintMask(source, layers);
  const pageBackground = detectCanvasBackgroundColor(source, layerMask) ?? detectPageBackgroundColor(source);
  const clean = new PNG({ width: source.width, height: source.height });

  for (let y = 0; y < clean.height; y += 1) {
    for (let x = 0; x < clean.width; x += 1) {
      const index = (y * clean.width + x) * 4;
      clean.data[index] = pageBackground.r;
      clean.data[index + 1] = pageBackground.g;
      clean.data[index + 2] = pageBackground.b;
      clean.data[index + 3] = 255;
    }
  }

  return clean;
}

function shouldUsePageBackground(layer: LayerAsset, imageWidth: number, imageHeight: number): boolean {
  const area = layer.width * layer.height;
  return layer.y > imageHeight * 0.16 && area > imageWidth * imageHeight * 0.012;
}

function detectPageBackgroundColor(source: PNG): Rgba {
  const samples: Rgba[] = [];
  const yStart = Math.floor(source.height * 0.14);
  const xStart = Math.floor(source.width * 0.14);

  for (let y = yStart; y < source.height; y += 12) {
    for (let x = xStart; x < source.width; x += 12) {
      const color = pixelAt(source, x, y);
      const brightness = (color.r + color.g + color.b) / 3;
      const spread = Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b);
      if (brightness >= 220 && brightness <= 248 && spread <= 10) {
        samples.push(color);
      }
    }
  }

  return dominantColor(samples, true) ?? { r: 241, g: 242, b: 247, a: 255 };
}

function detectCanvasBackgroundColor(source: PNG, layerMask: Uint8Array): Rgba | null {
  const allSamples: Rgba[] = [];
  const neutralSamples: Rgba[] = [];
  const yStart = Math.floor(source.height * 0.12);
  const xStart = Math.floor(source.width * 0.08);

  for (let y = yStart; y < source.height; y += 10) {
    for (let x = xStart; x < source.width; x += 10) {
      if (isMasked(layerMask, source, x, y)) continue;
      const color = pixelAt(source, x, y);
      const brightness = (color.r + color.g + color.b) / 3;
      const spread = Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b);
      allSamples.push(color);
      if (brightness >= 208 && brightness <= 248 && spread <= 14) {
        neutralSamples.push(color);
      }
    }
  }

  return dominantColor(neutralSamples, true) ?? dominantColor(allSamples, true);
}

interface ColorSegments {
  cellSize: number;
  width: number;
  height: number;
  ids: Int32Array;
  colors: Rgba[];
  counts: number[];
}

function buildColorSegments(source: PNG): ColorSegments {
  const cellSize = 8;
  const gridWidth = Math.ceil(source.width / cellSize);
  const gridHeight = Math.ceil(source.height / cellSize);
  const colors: Rgba[] = [];
  const ids = new Int32Array(gridWidth * gridHeight).fill(-1);
  const cellColors = new Uint8Array(gridWidth * gridHeight * 3);

  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const color = sampleCell(source, gx * cellSize, gy * cellSize, cellSize);
      const index = (gy * gridWidth + gx) * 3;
      cellColors[index] = color.r;
      cellColors[index + 1] = color.g;
      cellColors[index + 2] = color.b;
    }
  }

  const counts: number[] = [];
  const queue: number[] = [];
  let nextId = 0;

  for (let start = 0; start < ids.length; start += 1) {
    if (ids[start] !== -1) continue;
    const sx = start % gridWidth;
    const sy = Math.floor(start / gridWidth);
    const seed = gridColor(cellColors, gridWidth, sx, sy);
    const id = nextId;
    nextId += 1;
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    queue.length = 0;
    queue.push(start);
    ids[start] = id;

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const item = queue[cursor] ?? 0;
      const x = item % gridWidth;
      const y = Math.floor(item / gridWidth);
      const color = gridColor(cellColors, gridWidth, x, y);
      r += color.r;
      g += color.g;
      b += color.b;
      count += 1;

      for (const next of [item - 1, item + 1, item - gridWidth, item + gridWidth]) {
        if (next < 0 || next >= ids.length || ids[next] !== -1) continue;
        const nx = next % gridWidth;
        const ny = Math.floor(next / gridWidth);
        if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
        const nextColor = gridColor(cellColors, gridWidth, nx, ny);
        if (colorDistance(seed, nextColor) > 10 && colorDistance(color, nextColor) > 8) continue;
        ids[next] = id;
        queue.push(next);
      }
    }

    colors[id] = {
      r: Math.round(r / count),
      g: Math.round(g / count),
      b: Math.round(b / count),
      a: 255
    };
    counts[id] = count;
  }

  return { cellSize, width: gridWidth, height: gridHeight, ids, colors, counts };
}

function segmentFillColor(source: PNG, segments: ColorSegments, box: Box, layerMask?: Uint8Array): Rgba | null {
  const histogram = new Map<number, number>();
  const margin = Math.max(16, Math.min(96, Math.round(Math.max(box.width, box.height) * 0.08)));
  const outer = expandBox(box, margin, source.width, source.height);
  const inner = expandBox(box, 2, source.width, source.height);
  const step = Math.max(4, segments.cellSize);

  for (let y = outer.y; y < outer.y + outer.height; y += step) {
    for (let x = outer.x; x < outer.x + outer.width; x += step) {
      if (x >= inner.x && x <= inner.x + inner.width && y >= inner.y && y <= inner.y + inner.height) continue;
      if (layerMask && isMasked(layerMask, source, x, y)) continue;
      const id = segmentIdAt(segments, x, y);
      if (id < 0) continue;
      histogram.set(id, (histogram.get(id) ?? 0) + 1);
    }
  }

  const candidates = Array.from(histogram.entries())
    .map(([id, hits]) => ({
      id,
      hits,
      color: segments.colors[id],
      count: segments.counts[id] ?? 0
    }))
    .filter((item) => item.color && item.hits >= 2)
    .sort((a, b) => {
      const aScore = segmentBackgroundScore(a.color!, a.hits, a.count);
      const bScore = segmentBackgroundScore(b.color!, b.hits, b.count);
      return bScore - aScore;
    });

  return candidates[0]?.color ?? null;
}

function segmentIdAt(segments: ColorSegments, x: number, y: number): number {
  const gx = Math.max(0, Math.min(segments.width - 1, Math.floor(x / segments.cellSize)));
  const gy = Math.max(0, Math.min(segments.height - 1, Math.floor(y / segments.cellSize)));
  return segments.ids[gy * segments.width + gx] ?? -1;
}

function segmentBackgroundScore(color: Rgba, hits: number, count: number): number {
  const brightness = (color.r + color.g + color.b) / 3;
  const neutrality = 255 - (Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b));
  const avoidPureWhite = brightness > 248 ? -120 : 0;
  const preferLightNeutral = brightness >= 216 && brightness <= 246 ? 90 : 0;
  return hits * 8 + Math.min(120, count) + neutrality * 0.4 + preferLightNeutral + avoidPureWhite;
}

function cleanPadding(layer: LayerAsset, imageWidth: number, imageHeight: number): number {
  const area = layer.width * layer.height;
  const imageArea = imageWidth * imageHeight;
  if (area > imageArea * 0.02) return 24;
  if (area > imageArea * 0.006) return 14;
  return 6;
}

function sampleOutsideBox(source: PNG, box: Box, layerMask?: Uint8Array): Rgba {
  const area = box.width * box.height;
  const largeLayer = area > source.width * source.height * 0.015;
  const gaps = largeLayer ? [24, 48, 84] : [6, 14, 28];
  const samples: Rgba[] = [];

  for (const gap of gaps) {
    const x1 = Math.max(0, Math.floor(box.x) - gap);
    const y1 = Math.max(0, Math.floor(box.y) - gap);
    const x2 = Math.min(source.width - 1, Math.ceil(box.x + box.width) + gap);
    const y2 = Math.min(source.height - 1, Math.ceil(box.y + box.height) + gap);
    const stepX = Math.max(1, Math.floor((x2 - x1) / 32));
    const stepY = Math.max(1, Math.floor((y2 - y1) / 32));

    for (let x = x1; x <= x2; x += stepX) {
      if (!layerMask || !isMasked(layerMask, source, x, y1)) samples.push(pixelAt(source, x, y1));
      if (!layerMask || !isMasked(layerMask, source, x, y2)) samples.push(pixelAt(source, x, y2));
    }
    for (let y = y1; y <= y2; y += stepY) {
      if (!layerMask || !isMasked(layerMask, source, x1, y)) samples.push(pixelAt(source, x1, y));
      if (!layerMask || !isMasked(layerMask, source, x2, y)) samples.push(pixelAt(source, x2, y));
    }
  }

  const clustered = dominantColor(samples, largeLayer);
  if (clustered) return clustered;
  if (samples.length === 0) return detectPageBackgroundColor(source);

  const total = samples.reduce(
    (acc, color) => {
      acc.r += color.r;
      acc.g += color.g;
      acc.b += color.b;
      return acc;
    },
    { r: 0, g: 0, b: 0 }
  );

  return {
    r: Math.round(total.r / samples.length),
    g: Math.round(total.g / samples.length),
    b: Math.round(total.b / samples.length),
    a: 255
  };
}

function isMasked(mask: Uint8Array, source: PNG, x: number, y: number): boolean {
  return (mask[Math.max(0, Math.min(source.height - 1, Math.floor(y))) * source.width + Math.max(0, Math.min(source.width - 1, Math.floor(x)))] ?? 0) > 0;
}

function dominantColor(samples: Rgba[], preferMutedBackground = false): Rgba | null {
  if (samples.length === 0) return null;
  const clusters = new Map<string, { r: number; g: number; b: number; count: number }>();

  for (const color of samples) {
    const key = [
      Math.round(color.r / 10),
      Math.round(color.g / 10),
      Math.round(color.b / 10)
    ].join(":");
    const cluster = clusters.get(key) ?? { r: 0, g: 0, b: 0, count: 0 };
    cluster.r += color.r;
    cluster.g += color.g;
    cluster.b += color.b;
    cluster.count += 1;
    clusters.set(key, cluster);
  }

  const sorted = Array.from(clusters.values()).sort((a, b) => b.count - a.count);
  let best = sorted[0];
  if (preferMutedBackground && best) {
    const alternative = sorted
      .slice(0, 8)
      .filter((cluster) => cluster.count >= Math.max(3, samples.length * 0.045))
      .map((cluster) => ({
        cluster,
        brightness: (cluster.r + cluster.g + cluster.b) / (cluster.count * 3),
        spread:
          Math.max(cluster.r, cluster.g, cluster.b) / cluster.count -
          Math.min(cluster.r, cluster.g, cluster.b) / cluster.count
      }))
      .filter((item) => item.brightness >= 210 && item.brightness <= 248 && item.spread <= 12)
      .sort((a, b) => a.brightness - b.brightness || b.cluster.count - a.cluster.count)[0];
    if (alternative) best = alternative.cluster;
  }
  if (!best) return null;

  return {
    r: Math.round(best.r / best.count),
    g: Math.round(best.g / best.count),
    b: Math.round(best.b / best.count),
    a: 255
  };
}
