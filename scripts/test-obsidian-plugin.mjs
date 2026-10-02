import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const bundle = await readFile(path.join(packageRoot, "public", "obsidian-plugin", "main.js"), "utf8");

function harness(response, externalToken = "") {
  const requests = [];
  const module = { exports: {} };
  const obsidian = {
    Plugin: class {},
    PluginSettingTab: class {},
    Setting: class {},
    Notice: class {},
    requestUrl: async (options) => {
      requests.push(options);
      return typeof response === "function" ? response(options) : response;
    }
  };
  vm.runInNewContext(bundle, {
    module,
    exports: module.exports,
    require: (name) => {
      assert.equal(name, "obsidian");
      return obsidian;
    },
    URL,
    TextEncoder,
    window: { crypto: webcrypto },
    setTimeout,
    clearTimeout
  }, { filename: "obsidian-main.cjs" });
  assert.equal(typeof module.exports.default, "function");
  const plugin = new module.exports.default();
  plugin.settings = {
    origin: "https://aiden.example.com",
    token: "dummy-aiden-token",
    replitAccessToken: externalToken
  };
  return { plugin, requests };
}

function response(status, payload) {
  return { status, text: JSON.stringify(payload) };
}

function makeVault(entries = []) {
  const files = new Map();
  const folders = new Set();
  for (const { path: filePath, content } of entries) {
    files.set(filePath, { path: filePath, extension: "md", content });
  }
  return {
    files,
    getMarkdownFiles: () => [...files.values()],
    getAbstractFileByPath: (filePath) => files.get(filePath) || (folders.has(filePath) ? { path: filePath } : null),
    read: async (file) => files.get(file.path)?.content,
    modify: async (file, content) => {
      const stored = files.get(file.path);
      assert.ok(stored, `Expected existing file at ${file.path}`);
      stored.content = content;
    },
    create: async (filePath, content) => {
      assert.ok(!files.has(filePath), `Unexpected duplicate file at ${filePath}`);
      const file = { path: filePath, extension: "md", content };
      files.set(filePath, file);
      return file;
    },
    createFolder: async (folderPath) => { folders.add(folderPath); },
    rename: async (file, targetPath) => {
      const stored = files.get(file.path);
      assert.ok(stored, `Expected existing file at ${file.path}`);
      assert.ok(!files.has(targetPath), `Unexpected occupied path ${targetPath}`);
      files.delete(file.path);
      stored.path = targetPath;
      files.set(targetPath, stored);
    }
  };
}

async function sha256(value) {
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("plain-text token rejection gives guidance without attempting JSON getter", async () => {
  const { plugin, requests } = harness({
    status: 401,
    text: "Unrecognized token",
    get json() { throw new SyntaxError("Unrecognized token"); }
  });
  await assert.rejects(plugin.request("GET", "/api/memory-sync/files"), /Replit external access token/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.Authorization, "Bearer dummy-aiden-token");
  assert.equal(requests[0].headers["X-AIDEN-Sync-Token"], undefined);
});

test("private endpoint keeps Replit bearer separate from AIDEN scoped token", async () => {
  const { plugin, requests } = harness({
    status: 403,
    text: JSON.stringify({ message: "Unrecognized token" })
  }, "dummy-replit-token");
  await assert.rejects(plugin.request("GET", "/api/memory-sync/files"), /AIDEN server environment/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.Authorization, "Bearer dummy-replit-token");
  assert.equal(requests[0].headers["X-AIDEN-Sync-Token"], "dummy-aiden-token");
});

test("HTML login page with HTTP 200 is rejected before sync sees it", async () => {
  const { plugin, requests } = harness({
    status: 200,
    text: "<!DOCTYPE html><html><body>Sign in</body></html>",
    get json() { throw new SyntaxError("JSON Parse error: Unrecognized token '<'"); }
  });
  await assert.rejects(plugin.request("GET", "/api/memory-sync/files"), /HTML\/login page/);
  assert.equal(requests.length, 1);
});

test("successful JSON list remains available to the sync caller", async () => {
  const { plugin } = harness({ status: 200, text: JSON.stringify({ files: [] }) });
  const result = await plugin.request("GET", "/api/memory-sync/files");
  assert.equal(result.status, 200);
  assert.equal(result.json.files.length, 0);
});

test("successful JSON without the required files list is rejected", async () => {
  const { plugin, requests } = harness({ status: 200, text: "{}" });
  await assert.rejects(plugin.request("GET", "/api/memory-sync/files"), /missing the sync files list/);
  assert.equal(requests.length, 1);
});

test("empty 204 deletion response does not need JSON decoding", async () => {
  const { plugin } = harness({
    status: 204,
    text: "",
    get json() { throw new SyntaxError("Empty body"); }
  });
  const result = await plugin.request("DELETE", "/api/memory-sync/files/1", { revision: 1 });
  assert.equal(result.status, 204);
});

test("an unavailable JSON getter becomes a clear response error", async () => {
  const { plugin, requests } = harness({
    status: 200,
    get json() { throw new SyntaxError("Unrecognized token"); }
  });
  await assert.rejects(plugin.request("GET", "/api/memory-sync/files"), /invalid JSON response/);
  assert.equal(requests.length, 1);
});

test("revision conflict status and payload are preserved without retry", async () => {
  const { plugin, requests } = harness({
    status: 409,
    text: JSON.stringify({ error: "revision_conflict", current: { revision: 2 } })
  });
  await assert.rejects(plugin.request("PUT", "/api/memory-sync/files/1", { revision: 1 }), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.payload.current.revision, 2);
    return true;
  });
  assert.equal(requests.length, 1);
});

test("a new local note is replaced with the server's canonical metadata after upload", async () => {
  const original = "# AIDEN Memory\n\nA newly imported note";
  const canonical = "---\nid: 1208\ncategory: \"knowledge\"\nscope: \"global\"\npriority: 3\nsource: \"imported\"\nexpiresAt: null\narchivedAt: null\nrevision: 1\nrelatedMemoryIds: []\n---\n# AIDEN Memory\n\nA newly imported note";
  const serverFile = {
    id: 1208,
    path: "AIDEN Memory/knowledge/1208.md",
    content: canonical,
    revision: 1
  };
  let created = false;
  const { plugin, requests } = harness(async (options) => {
    const pathname = new URL(options.url).pathname;
    if (options.method === "GET" && pathname === "/api/memory-sync/files") {
      return response(200, { files: created ? [serverFile] : [] });
    }
    if (options.method === "POST" && pathname === "/api/memory-sync/files") {
      assert.equal(JSON.parse(options.body).content, original);
      created = true;
      return response(201, { file: serverFile });
    }
    assert.fail(`Unexpected ${options.method} ${pathname}`);
  });
  const vault = makeVault([{ path: "AIDEN Memory/knowledge/import.md", content: original }]);
  plugin.app = { vault };
  plugin.state = { files: {} };
  plugin.saveSettings = async () => {};
  plugin.updateIndex = async () => {};

  await plugin.sync({ silent: true });
  assert.equal(vault.files.get(serverFile.path)?.content, canonical);
  assert.equal(plugin.state.files["1208"].hash, await sha256(canonical));

  await plugin.sync({ silent: true });
  assert.equal(requests.filter((request) => request.method === "POST").length, 1);
  assert.equal(requests.filter((request) => request.method === "PUT").length, 0);
});

test("an ID mismatch preserves the local note and restores the current server copy", async () => {
  const localContent = "# AIDEN Memory\n\nA locally preserved copy";
  const canonical = "---\nid: 1208\ncategory: \"knowledge\"\nscope: \"global\"\npriority: 3\nsource: \"imported\"\nexpiresAt: null\narchivedAt: null\nrevision: 1\nrelatedMemoryIds: []\n---\n# AIDEN Memory\n\nA locally preserved copy";
  const serverFile = {
    id: 1208,
    path: "AIDEN Memory/knowledge/1208.md",
    content: canonical,
    revision: 1
  };
  const { plugin, requests } = harness(async (options) => {
    const pathname = new URL(options.url).pathname;
    if (options.method === "GET" && pathname === "/api/memory-sync/files") {
      return response(200, { files: [serverFile] });
    }
    if (options.method === "PUT" && pathname === "/api/memory-sync/files/1208") {
      return response(400, { error: "memory_id_mismatch" });
    }
    assert.fail(`Unexpected ${options.method} ${pathname}`);
  });
  const vault = makeVault([{ path: serverFile.path, content: localContent }]);
  const canonicalHash = await sha256(canonical);
  plugin.app = { vault };
  plugin.state = {
    files: {
      "1208": {
        path: serverFile.path,
        id: 1208,
        hash: canonicalHash,
        remoteHash: canonicalHash,
        revision: 1
      }
    }
  };
  plugin.saveSettings = async () => {};
  plugin.updateIndex = async () => {};

  await plugin.sync({ silent: true });

  assert.equal(vault.files.get(serverFile.path)?.content, canonical);
  const localBackup = [...vault.files.values()].find((file) => file.path.startsWith("AIDEN Memory/Conflicts/"));
  assert.ok(localBackup);
  assert.ok(localBackup.content.includes(localContent));
  assert.equal(plugin.state.files["1208"].hash, canonicalHash);
  assert.equal(requests.filter((request) => request.method === "PUT").length, 1);
});
