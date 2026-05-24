import path from "node:path";
import { captureSite } from "./capture.js";
import { writeSvgPackage } from "./svg.js";
import type { CaptureMode, CaptureOptions } from "./types.js";
import { asBooleanFlag, asNumber } from "./utils.js";

function parseArgs(argv: string[]): Map<string, string | boolean> {
  const args = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item?.startsWith("--")) continue;

    const parts = item.slice(2).split("=", 2);
    const rawKey = parts[0] ?? "";
    const inlineValue = parts[1];
    const key = rawKey.trim();
    if (!key) continue;

    if (inlineValue !== undefined) {
      args.set(key, inlineValue);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      index += 1;
    } else {
      args.set(key, true);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`
Web2SVG

Usage:
  pnpm capture -- --url https://example.com --out exports/example

Options:
  --url <url>            Capture target URL. Required.
  --out <dir>            Output directory. Default: exports/<host>
  --width <px>           Desktop CSS viewport width. Default: 1920
  --height <px>          Desktop CSS viewport height. Default: 1080
  --scale <number>       Device scale factor. Default: 2 (1920x1080 becomes 3840x2160)
  --full-page            Capture the full scroll height instead of the first viewport.
  --max-layers <count>   Maximum exported layers. Default: 80
  --min-area <px>        Minimum CSS pixel area for layer candidates. Default: 2500
  --mode <semantic|dense> Layer discovery mode. Default: semantic
  --interactive          Open a visible browser and capture when Ctrl+Shift+S is pressed.
  --profile <dir>        Persistent browser profile directory for login sessions.
  --wait <ms>            Extra wait after network idle. Default: 1000
  --timeout <ms>         Navigation/screenshot timeout. Default: 45000
  --no-embed             Kept for compatibility. Export is always embedded.
  --help                 Show this help.
`);
}

function defaultOutDir(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, "");
  return path.join("exports", host.replace(/[^a-z0-9.-]+/gi, "-"));
}

function readOptions(): CaptureOptions {
  const args = parseArgs(process.argv.slice(2));

  if (args.has("help")) {
    printHelp();
    process.exit(0);
  }

  const url = String(args.get("url") ?? "");
  if (!url) {
    printHelp();
    throw new Error("Missing required --url option.");
  }

  const mode = String(args.get("mode") ?? "semantic") as CaptureMode;
  if (!["semantic", "dense"].includes(mode)) {
    throw new Error("--mode must be semantic or dense.");
  }

  return {
    url,
    outDir: path.resolve(String(args.get("out") ?? defaultOutDir(url))),
    viewportWidth: asNumber(args.get("width")?.toString(), 1920),
    viewportHeight: asNumber(args.get("height")?.toString(), 1080),
    scale: asNumber(args.get("scale")?.toString(), 2),
    fullPage: asBooleanFlag(args, "full-page", false),
    maxLayers: asNumber(args.get("max-layers")?.toString(), 80),
    minArea: asNumber(args.get("min-area")?.toString(), 2500),
    waitMs: asNumber(args.get("wait")?.toString(), 1000),
    timeoutMs: asNumber(args.get("timeout")?.toString(), 45000),
    mode,
    embed: !args.has("no-embed"),
    interactive: asBooleanFlag(args, "interactive", false),
    profileDir: args.has("profile") ? path.resolve(String(args.get("profile"))) : null,
    flatOnly: false
  };
}

async function main(): Promise<void> {
  const options = readOptions();
  console.log(`Capturing ${options.url}`);
  console.log(`Viewport ${options.viewportWidth}x${options.viewportHeight} at ${options.scale}x`);
  console.log(`Output ${options.outDir}`);
  if (options.interactive) {
    console.log("Interactive browser will open. Press Ctrl+Shift+S in the page when the UI state is ready.");
  }

  const result = await captureSite(options);
  await writeSvgPackage(result, options.outDir, options.embed);

  console.log(`Done. Layers: ${result.layers.length}`);
  console.log(`AE JSX: ${path.join(options.outDir, "web2svg_AE.jsx")}`);
  console.log(`PPTX: ${path.join(options.outDir, "web2svg_PPTX.pptx")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
