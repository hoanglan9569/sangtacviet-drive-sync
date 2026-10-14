/**
 * Builds the extension's scripts and pages into dist/. The repo root is the
 * unpacked extension: manifest.json there points into dist/. dist/ is committed,
 * so a fresh clone loads without building; rebuild after changing src/.
 *
 *   bun run build
 */
import { cpSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SRC = join(ROOT, "src");
const OUT = join(ROOT, "dist");

const ENTRIES: { src: string; out: string; format: "esm" | "iife" }[] = [
  { src: "background/main.ts", out: "background", format: "esm" },
  { src: "ui/popup.ts", out: "popup", format: "esm" },
  { src: "ui/options.ts", out: "options", format: "esm" },
  // Classic scripts: content scripts, and theme-init (render-blocking in <head>).
  { src: "ui/theme-init.ts", out: "theme-init", format: "iife" },
  { src: "content/hook.ts", out: "hook", format: "iife" },
  { src: "content/bridge.ts", out: "bridge", format: "iife" },
];
const STATIC = ["ui/popup.html", "ui/options.html", "ui/styles.css"];

rmSync(OUT, { recursive: true, force: true });
for (const e of ENTRIES) {
  const result = await Bun.build({
    entrypoints: [join(SRC, e.src)],
    outdir: OUT,
    target: "browser",
    format: e.format,
    naming: `${e.out}.[ext]`,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`build failed: ${e.src}`);
  }
}
for (const f of STATIC) cpSync(join(SRC, f), join(OUT, f.split("/").pop()!));
cpSync(join(SRC, "icons"), join(OUT, "icons"), { recursive: true });

const { version } = (await Bun.file(join(ROOT, "package.json")).json()) as { version: string };
const manifest = (await Bun.file(join(ROOT, "manifest.json")).json()) as { version: string };
if (manifest.version !== version) throw new Error(`manifest.json version ${manifest.version} != package.json ${version}`);
console.log(`extension -> ${OUT} (load unpacked: ${ROOT})`);
