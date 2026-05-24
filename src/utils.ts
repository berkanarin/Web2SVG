import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

export async function ensureCleanDir(dir: string): Promise<void> {
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });
}

export function sanitizeFilePart(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return cleaned.length > 0 ? cleaned.slice(0, 80) : "layer";
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function asNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function asBooleanFlag(args: Map<string, string | boolean>, key: string, fallback: boolean): boolean {
  const raw = args.get(key);
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    return !["false", "0", "no"].includes(raw.toLowerCase());
  }
  return fallback;
}
