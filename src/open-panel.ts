import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = process.argv[2] ?? "http://127.0.0.1:4782";
const profileDir = path.resolve(rootDir, "profiles", "__web2svg-panel");

await mkdir(profileDir, { recursive: true });

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: {
    width: 1280,
    height: 820
  },
  deviceScaleFactor: 1,
  colorScheme: "light",
  args: ["--window-size=1280,820"]
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(url);

context.on("close", () => process.exit(0));
