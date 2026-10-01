import "./build-obsidian-plugin.mjs";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
for (const name of ["main.js", "manifest.json"]) {
  await copyFile(path.join(root, "public", "obsidian-plugin", name), path.join(root, name));
}
