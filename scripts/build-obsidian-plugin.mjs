import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoot = path.join(packageRoot, "src", "obsidian-plugin");
const outputRoot = path.join(packageRoot, "public", "obsidian-plugin");
const manifest = JSON.parse(await readFile(path.join(sourceRoot, "manifest.json"), "utf8"));

if (manifest.id !== "aiden-memory-sync" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error("The Obsidian plugin manifest must have the expected ID and a semantic version.");
}

await build({
  configFile: false,
  root: packageRoot,
  publicDir: false,
  logLevel: "warn",
  build: {
    target: "es2020",
    minify: true,
    sourcemap: false,
    lib: {
      entry: path.join(sourceRoot, "main.js"),
      formats: ["cjs"],
      fileName: () => "main.js"
    },
    outDir: outputRoot,
    emptyOutDir: false,
    rollupOptions: {
      external: ["obsidian"],
      output: { exports: "named" }
    }
  }
});

const mainPath = path.join(outputRoot, "main.js");
const manifestPath = path.join(outputRoot, "manifest.json");
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(manifestPath, manifestText);

const syntaxCheck = spawnSync(process.execPath, ["--check", mainPath], { encoding: "utf8" });
if (syntaxCheck.status !== 0) {
  throw new Error(`Generated main.js failed syntax validation:\n${syntaxCheck.stderr || syntaxCheck.stdout}`);
}

const bundle = await readFile(mainPath, "utf8");
if (!/require\(["']obsidian["']\)/.test(bundle) || !/exports\.default\s*=/.test(bundle)) {
  throw new Error("Generated main.js must be a CommonJS bundle exposing the plugin's default class and leaving Obsidian external.");
}

const releaseDirectory = path.join(outputRoot, `release-v${manifest.version}`);
await mkdir(releaseDirectory, { recursive: true });
await copyFile(mainPath, path.join(releaseDirectory, "main.js"));
await copyFile(manifestPath, path.join(releaseDirectory, "manifest.json"));

const stagingRoot = await mkdtemp(path.join(tmpdir(), "aiden-memory-sync-"));
try {
  const pluginDirectory = path.join(stagingRoot, "aiden-memory-sync");
  await mkdir(pluginDirectory);
  await copyFile(mainPath, path.join(pluginDirectory, "main.js"));
  await copyFile(manifestPath, path.join(pluginDirectory, "manifest.json"));

  const archivePath = path.join(outputRoot, `aiden-memory-sync-v${manifest.version}.zip`);
  const zip = spawnSync("zip", ["-X", "-q", "-r", archivePath, "aiden-memory-sync"], {
    cwd: stagingRoot,
    encoding: "utf8"
  });
  if (zip.status !== 0) {
    throw new Error(`Could not create plugin archive:\n${zip.stderr || zip.stdout}`);
  }
  await copyFile(archivePath, path.join(outputRoot, "aiden-memory-sync.zip"));
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}

console.log(`Built AIDEN Memory Sync ${manifest.version} (${bundle.length} bytes).`);