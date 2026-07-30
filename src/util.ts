import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export const isoNow = (): string => new Date().toISOString();

export async function fileReceipt(path: string): Promise<{ path: string; size: number; hash: string }> {
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0) throw new Error(`artifact is missing or empty: ${path}`);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolve);
  });
  return { path, size: info.size, hash: hash.digest("hex") };
}

export function walk(value: unknown): unknown[] {
  const values: unknown[] = [value];
  if (Array.isArray(value)) for (const item of value) values.push(...walk(item));
  else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) values.push(...walk(item));
  }
  return values;
}

export function findString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  for (const key of keys) if (typeof object[key] === "string") return object[key];
  for (const child of Object.values(object)) {
    const found = findString(child, keys);
    if (found) return found;
  }
  return undefined;
}

export function hasText(value: unknown, needle: string): boolean {
  return walk(value).some((item) => typeof item === "string" && item.includes(needle));
}
