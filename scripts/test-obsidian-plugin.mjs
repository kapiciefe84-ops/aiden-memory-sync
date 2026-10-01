import assert from "node:assert/strict";
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
      return response;
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