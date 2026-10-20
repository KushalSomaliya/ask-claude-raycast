/**
 * Images you paste into Ask Claude. Each one is shrunk to Claude's standard size with macOS's
 * built-in `sips` and kept as a file in Ask Claude's support folder; chats only store file names.
 * No Raycast imports, so it can be tested with plain Node.
 */
import { execFile } from "child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from "fs";
import { basename, join } from "path";
import { fileURLToPath } from "url";

/** Claude's standard image size; anything larger is scaled down before it's sent. */
export const MAX_EDGE = 1568;
/** Base64 adds a third, and the API takes up to 10 MB per image. */
const MAX_BYTES = 7 * 1024 * 1024;

export const imagesDir = (supportPath: string) => join(supportPath, "images");

export type ImageKind = "png" | "jpeg" | "gif" | "webp" | "tiff" | "heic" | "bmp";

/** Recognises an image by its first bytes (clipboard files often have no extension). */
export function sniffImage(path: string): ImageKind | null {
  const head = Buffer.alloc(16);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    readSync(fd, head, 0, 16, 0);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const ascii = (from: number, to: number) => head.toString("latin1", from, to);
  if (head[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (ascii(0, 4) === "GIF8") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a) || (head[0] === 0x4d && head[1] === 0x4d && head[3] === 0x2a)) return "tiff";
  if (ascii(4, 8) === "ftyp" && /^(hei|hev|mif|msf|avi)/.test(ascii(8, 12))) return "heic";
  if (ascii(0, 2) === "BM") return "bmp";
  return null;
}

/** Raycast reports clipboard files as plain paths or file:// URLs. */
export function clipboardPath(file: string): string {
  const value = file.trim();
  if (!value.startsWith("file://")) return value;
  try {
    return fileURLToPath(value);
  } catch {
    return decodeURIComponent(value.slice("file://".length));
  }
}

function run(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000 }, (err, stdout) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });
}

/**
 * Copies the clipboard's raw image (a screenshot copied with ⌘⌃⇧4, an image copied from an app)
 * into a PNG file, using macOS itself. Used when Raycast doesn't hand the image over as a file.
 */
const CLIPBOARD_TO_PNG = `
ObjC.import("AppKit");
function isNil(o) { return !o || (typeof o.isNil === "function" && o.isNil()); }
function pngData(data) {
  if (isNil(data)) return null;
  var rep = $.NSBitmapImageRep.imageRepWithData(data);
  if (isNil(rep)) return null;
  var type = $.NSBitmapImageFileTypePNG === undefined ? $.NSPNGFileType : $.NSBitmapImageFileTypePNG;
  return rep.representationUsingTypeProperties(type, $());
}
function run(argv) {
  var pb = $.NSPasteboard.generalPasteboard;
  var data = pb.dataForType("public.png");
  if (isNil(data)) data = pngData(pb.dataForType("public.tiff"));
  if (isNil(data)) {
    var images = pb.readObjectsForClassesOptions($([$.NSImage.class()]), $());
    if (!isNil(images) && images.count > 0) data = pngData(images.objectAtIndex(0).TIFFRepresentation);
  }
  if (isNil(data) || !data.writeToFileAtomically($(argv[0]), true)) throw new Error("no image");
  return argv[0];
}`;

export async function saveClipboardImage(outPath: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const res = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", CLIPBOARD_TO_PNG, outPath]);
  return res.code === 0 && existsSync(outPath) && sniffImage(outPath) === "png";
}

async function pixelSize(path: string, sips: string): Promise<{ width: number; height: number } | null> {
  const res = await run(sips, ["-g", "pixelWidth", "-g", "pixelHeight", path]);
  const width = Number(res.stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(res.stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
  return res.code === 0 && width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Saves a copy of an image for sending: at most MAX_EDGE pixels on its long side, as PNG (or JPEG
 * for photos that were JPEG already). Returns the new file's name inside `dir`.
 */
export async function prepareImage(source: string, dir: string, id: string, sips = "/usr/bin/sips"): Promise<string> {
  const kind = sniffImage(source);
  if (!kind) throw new Error("That isn't an image Claude can read.");
  mkdirSync(dir, { recursive: true });
  const jpeg = kind === "jpeg";
  let name = `${id}.${jpeg ? "jpg" : "png"}`;
  let out = join(dir, name);

  const size = await pixelSize(source, sips);
  const tooBig = !size || Math.max(size.width, size.height) > MAX_EDGE;
  if (!tooBig && (kind === "png" || jpeg)) {
    copyFileSync(source, out);
  } else {
    const resize = tooBig ? ["-Z", String(MAX_EDGE)] : [];
    const res = await run(sips, [...resize, "-s", "format", jpeg ? "jpeg" : "png", source, "--out", out]);
    if (res.code !== 0 || !existsSync(out)) throw new Error("Couldn't read that image.");
  }

  if (statSync(out).size > MAX_BYTES && !jpeg) {
    // A detailed photo can still be a very large PNG at this size; JPEG keeps it well under the limit.
    const smaller = join(dir, `${id}.jpg`);
    const res = await run(sips, ["-s", "format", "jpeg", "-s", "formatOptions", "80", out, "--out", smaller]);
    if (res.code === 0 && existsSync(smaller)) {
      rmSync(out, { force: true });
      out = smaller;
      name = basename(smaller);
    }
  }
  return name;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Block = Record<string, any>;

/** The image as a Messages API content block, or null if its file is gone. */
export function imageBlock(dir: string, name: string): Block | null {
  const path = join(dir, name);
  if (!existsSync(path)) return null;
  const mediaType = name.endsWith(".jpg") ? "image/jpeg" : "image/png";
  return { type: "image", source: { type: "base64", media_type: mediaType, data: readFileSync(path).toString("base64") } };
}

/** A small thumbnail for the chat pane (Raycast scales markdown images with these parameters). */
export function thumbnails(dir: string, names: string[] | undefined, height: number): string {
  return (names ?? [])
    .filter((name) => existsSync(join(dir, name)))
    .map((name) => `![](file://${encodeURI(join(dir, name))}?raycast-height=${height})`)
    .join(" ");
}

export function removeImages(dir: string, names: string[]): void {
  for (const name of names) rmSync(join(dir, basename(name)), { force: true });
}

/** When an image was pasted: its file name starts with that time (see prepareImage's id). */
export function pastedAt(dir: string, name: string): number {
  const stamp = Number(name.match(/^(\d{12,})-/)?.[1]);
  if (stamp > 0) return stamp;
  try {
    return statSync(join(dir, name)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Deletes image files no chat refers to (left behind by a deleted chat or an unsent paste), and,
 * when `maxAgeDays` is set, images pasted longer ago than that.
 */
export function pruneImages(dir: string, keep: Set<string>, maxAgeDays = 0, now = Date.now()): void {
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = maxAgeDays > 0 ? now - maxAgeDays * 24 * 60 * 60 * 1000 : -Infinity;
  for (const file of files) {
    if (!keep.has(file) || pastedAt(dir, file) < cutoff) rmSync(join(dir, file), { force: true });
  }
}
