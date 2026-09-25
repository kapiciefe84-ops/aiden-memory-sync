import { Plugin, PluginSettingTab, Setting, Notice, requestUrl } from "obsidian";

const FOLDER = "AIDEN Memory";
const INDEX = `${FOLDER}/Index.md`;
const SETTINGS = { origin: "", token: "", autoSync: true };
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 12000;
const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_SYNC_ERROR_NOTICE_INTERVAL_MS = 15 * 60 * 1000;

async function hash(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await window.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function withTimeout(promise, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("AIDEN request timed out")), milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function validPath(path) {
  if (typeof path !== "string" || !path.startsWith(`${FOLDER}/`) ||
      path.includes("\\") || path.includes("\0") || path.includes("..")) return false;
  const parts = path.split("/");
  return parts.length > 1 && parts.every((part) => part && part !== "." && part !== "..");
}

function isSyncable(path) {
  return validPath(path) && path.endsWith(".md") && path !== INDEX &&
    !path.startsWith(`${FOLDER}/Conflicts/`);
}

function errorText(error) {
  return error && error.message ? error.message : "Request failed";
}

export default class AidenMemorySync extends Plugin {
  async onload() {
    this.settings = Object.assign({}, SETTINGS, await this.loadData());
    this.state = this.settings.state || { files: {} };
    delete this.settings.state;
    await this.saveSettings();

    this.addSettingTab(new AidenSettingTab(this.app, this));
    this.addCommand({
      id: "sync-aiden-memory",
      name: "Sync AIDEN Memory",
      callback: () => void this.sync()
    });
    this.addCommand({
      id: "delete-active-aiden-memory",
      name: "Delete active AIDEN Memory note (confirmation)",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const entry = file && Object.values(this.state.files).find((item) => item.path === file.path);
        if (!entry) return false;
        if (!checking) void this.deleteRemote(entry, file);
        return true;
      }
    });

    this.registerInterval(window.setInterval(() => {
      if (document.visibilityState === "visible" && this.settings.autoSync && this.hasSyncConfig()) {
        void this.sync({ silent: true });
      }
    }, AUTO_SYNC_INTERVAL_MS));
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible" && this.settings.autoSync && this.hasSyncConfig()) {
        void this.sync({ silent: true });
      }
    });
    if (this.settings.autoSync && this.hasSyncConfig()) void this.sync({ silent: true });
  }

  async saveSettings() {
    await this.saveData({ ...this.settings, state: this.state });
  }

  hasSyncConfig() {
    return Boolean(this.settings.origin.trim() && this.settings.token.trim());
  }

  async request(method, path, body) {
    let origin;
    try {
      const parsed = new URL(this.settings.origin.trim());
      const localDevelopment = parsed.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
      if (parsed.protocol !== "https:" && !localDevelopment) {
        throw new Error("Use HTTPS for the AIDEN server origin.");
      }
      if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
        throw new Error("Enter only the AIDEN server origin, without credentials or a path.");
      }
      origin = parsed.origin;
    } catch (error) {
      throw new Error(errorText(error) || "Enter a valid AIDEN server origin.");
    }
    if (!origin || !this.settings.token) throw new Error("Configure the AIDEN server origin and token first.");
    let last;
    const attempts = method === "POST" ? 1 : MAX_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const request = requestUrl({
          url: `${origin}${path}`,
          method,
          headers: {
            Authorization: `Bearer ${this.settings.token}`,
            "Content-Type": "application/json"
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          throw: false
        });
        const response = await withTimeout(request, TIMEOUT_MS);
        if (response.status >= 200 && response.status < 300) return response;
        const result = response.json || {};
        const failure = new Error(result.error || `AIDEN returned HTTP ${response.status}`);
        failure.status = response.status;
        failure.payload = result;
        if (response.status === 409 ||
            (response.status >= 400 && response.status < 500 && response.status !== 429)) throw failure;
        last = failure;
      } catch (error) {
        last = error;
        if (error.status === 409 ||
            (error.status >= 400 && error.status < 500 && error.status !== 429)) throw error;
      }
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
    throw last || new Error("AIDEN request failed");
  }

  async readLocal(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file && "content" in file ? { file, content: await this.app.vault.read(file) } : null;
  }

  async ensureFolder(path) {
    const parts = path.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        try { await this.app.vault.createFolder(current); } catch (e) { /* created concurrently */ }
      }
    }
  }

  async writeLocal(path, content) {
    await this.ensureFolder(path.split("/").slice(0, -1).join("/"));
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing && "extension" in existing) await this.app.vault.modify(existing, content);
    else await this.app.vault.create(path, content);
  }

  async moveLocal(file, targetPath) {
    if (file.path === targetPath) return file;
    await this.ensureFolder(targetPath.split("/").slice(0, -1).join("/"));
    if (this.app.vault.getAbstractFileByPath(targetPath)) {
      new Notice(`AIDEN changed this memory's category, but ${targetPath} already exists. Both local notes were preserved.`);
      return file;
    }
    await this.app.vault.rename(file, targetPath);
    return this.app.vault.getAbstractFileByPath(targetPath) || file;
  }

  async conflict(remote, localContent) {
    if (!remote || !validPath(remote.path)) throw new Error("AIDEN returned an unsafe conflict path.");
    const leaf = remote.path.split("/").pop().replace(/\.md$/i, "");
    const safe = leaf.replace(/[^a-zA-Z0-9 _-]/g, "_").slice(0, 80) || "note";
    const path = `${FOLDER}/Conflicts/${safe} (conflict-${Date.now()}).md`;
    const text = `# Remote copy of ${remote.path}\n\n> Preserved by AIDEN Memory Sync because both copies changed.\n\n${remote.content}`;
    await this.writeLocal(path, text);
    new Notice(`AIDEN conflict preserved in ${path}`);
  }

  async deleteRemote(entry, localFile) {
    const question = entry.remoteDeleted
      ? `Delete the remaining local copy of "${entry.path}"? AIDEN has already deleted the server copy.`
      : `Delete "${entry.path}" from AIDEN and this vault? This cannot be undone.`;
    if (!window.confirm(question)) return;
    try {
      if (!entry.remoteDeleted) {
        await this.request("DELETE", `/api/memory-sync/files/${encodeURIComponent(entry.id)}`, {
          expectedRevision: entry.revision
        });
      }
      await this.app.vault.delete(localFile);
      delete this.state.files[String(entry.id)];
      await this.saveSettings();
      new Notice("AIDEN memory deleted after confirmation.");
    } catch (error) {
      new Notice(`AIDEN delete failed: ${errorText(error)}`);
    }
  }

  async sync({ silent = false } = {}) {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const response = await this.request("GET", "/api/memory-sync/files");
      const payload = response.json || {};
      const remoteFiles = Array.isArray(payload.files) ? payload.files : [];
      const remote = remoteFiles.filter((file) => validPath(file.path) && Number.isFinite(file.id));
      const remoteByPath = new Map(remote.map((file) => [file.path, file]));
      const remoteById = new Map(remote.map((file) => [String(file.id), file]));
      const localFiles = this.app.vault.getMarkdownFiles().filter((file) => isSyncable(file.path));
      const localByPath = new Map(localFiles.map((file) => [file.path, file]));
      const next = {};
      let conflicts = 0;

      for (const item of remote) {
        const key = String(item.id);
        const old = this.state.files[key] || Object.values(this.state.files).find((entry) => entry.path === item.path);
        const local = localByPath.get(item.path) || (old ? localByPath.get(old.path) : undefined);
        const remoteHash = await hash(item.content);
        if (!local) {
          if (old) {
            // A local deletion is never sent to AIDEN, and is not silently undone.
            next[key] = { path: item.path, id: item.id, hash: old.hash, remoteHash, revision: item.revision };
            continue;
          }
          await this.writeLocal(item.path, item.content);
          next[key] = { path: item.path, id: item.id, hash: remoteHash, remoteHash, revision: item.revision };
          continue;
        }

        const localContent = await this.app.vault.read(local);
        const localHash = await hash(localContent);
        if (!old) {
          // First sync protects an existing note instead of overwriting it.
          await this.conflict(item, localContent);
          conflicts++;
          next[key] = { path: item.path, id: item.id, hash: localHash, remoteHash, revision: item.revision };
          continue;
        }
        const localChanged = localHash !== old.hash;
        const remoteChanged = remoteHash !== old.remoteHash;
        let revision = item.revision;
        if (remoteChanged && !localChanged) {
          await this.app.vault.modify(local, item.content);
          await this.moveLocal(local, item.path);
          next[key] = { path: item.path, id: item.id, hash: remoteHash, remoteHash, revision };
        } else if (localChanged && !remoteChanged) {
          try {
            const result = await this.request("PUT", `/api/memory-sync/files/${encodeURIComponent(item.id)}`, {
              content: localContent, expectedRevision: item.revision
            });
            const saved = result.json.file;
            await this.moveLocal(local, saved.path);
            const savedHash = await hash(saved.content);
            next[String(saved.id)] = { path: saved.path, id: saved.id, hash: savedHash, remoteHash: savedHash, revision: saved.revision };
          } catch (error) {
            if (error.status !== 409) throw error;
            await this.conflict(error.payload.current, localContent);
            conflicts++;
            const current = error.payload.current;
            next[key] = { path: current.path, id: current.id, hash: localHash, remoteHash: await hash(current.content), revision: current.revision };
          }
        } else if (localChanged && remoteChanged) {
          await this.conflict(item, localContent);
          conflicts++;
          await this.moveLocal(local, item.path);
          next[key] = { path: item.path, id: item.id, hash: localHash, remoteHash, revision };
        } else {
          await this.moveLocal(local, item.path);
          next[key] = { path: item.path, id: item.id, hash: localHash, remoteHash, revision };
        }
      }

      for (const file of localFiles) {
        if (remoteByPath.has(file.path)) continue;
        const content = await this.app.vault.read(file);
        const old = Object.values(this.state.files).find((entry) => entry.path === file.path);
        if (old) {
          const currentRemote = remoteById.get(String(old.id));
          if (!currentRemote) {
            next[String(old.id)] = { ...old, remoteDeleted: true };
            if (!old.remoteDeleted) {
              new Notice(`AIDEN deleted this memory remotely. The local note was kept and will not be re-uploaded automatically.`);
            }
          }
          // Server-side deletion never removes a local note or silently recreates the memory.
          continue;
        }
        const result = await this.request("POST", "/api/memory-sync/files", { content });
        const saved = result.json.file;
        if (saved && validPath(saved.path)) {
          await this.moveLocal(file, saved.path);
          const savedHash = await hash(saved.content);
          next[String(saved.id)] = { path: saved.path, id: saved.id, hash: savedHash, remoteHash: savedHash, revision: saved.revision };
        }
      }

      const refreshed = await this.request("GET", "/api/memory-sync/files");
      const refreshedFiles = Array.isArray(refreshed.json?.files) ? refreshed.json.files : remote;
      this.state = { files: next };
      await this.saveSettings();
      await this.updateIndex(refreshedFiles);
      this.lastAutoSyncErrorAt = 0;
      if (conflicts) new Notice(`AIDEN sync complete: ${conflicts} conflict(s) preserved.`);
      else if (!silent) new Notice("AIDEN Memory synced.");
    } catch (error) {
      const now = Date.now();
      if (!silent || !this.lastAutoSyncErrorAt || now - this.lastAutoSyncErrorAt >= AUTO_SYNC_ERROR_NOTICE_INTERVAL_MS) {
        new Notice(`AIDEN sync failed: ${errorText(error)}`);
        this.lastAutoSyncErrorAt = now;
      }
    } finally {
      this.syncing = false;
    }
  }

  async updateIndex(files) {
    const safeFiles = files.filter((file) => validPath(file.path));
    const pathById = new Map(safeFiles.map((file) => [String(file.id), file.path.replace(/\.md$/i, "")]));
    const rows = safeFiles.map((file) => {
      const path = file.path.replace(/\.md$/i, "");
      const linksMatch = /^relatedMemoryIds:\s*(.*)$/m.exec(file.content || "");
      let related = [];
      try {
        const raw = linksMatch?.[1]?.trim() || "[]";
        related = raw.startsWith("[") ? JSON.parse(raw) : raw.split(",").map((value) => Number(value.trim())).filter(Number.isFinite);
      } catch { related = []; }
      const relatedLinks = related
        .map((id) => pathById.get(String(id)))
        .filter(Boolean)
        .map((target) => `[[${target}]]`)
        .join(", ");
      return `- [[${path}|${file.id}: ${file.path}]]${relatedLinks ? `\n  - Related: ${relatedLinks}` : ""}`;
    }).join("\n");
    const content = `# AIDEN Memory\n\n${rows || "_No memories synced yet._"}\n`;
    const existing = this.app.vault.getAbstractFileByPath(INDEX);
    if (existing && "extension" in existing) await this.app.vault.modify(existing, content);
    else await this.writeLocal(INDEX, content);
  }
}

class AidenSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "AIDEN Memory Sync" });
    new Setting(containerEl).setName("AIDEN server origin").setDesc("For example https://aiden.example.com (no trailing slash).")
      .addText((text) => {
        text.setPlaceholder("https://...").setValue(this.plugin.settings.origin);
        text.onChange(async (value) => { this.plugin.settings.origin = value.trim(); await this.plugin.saveSettings(); });
        text.inputEl.addEventListener("blur", () => {
          if (this.plugin.settings.autoSync && this.plugin.hasSyncConfig()) void this.plugin.sync({ silent: true });
        });
      });
    new Setting(containerEl).setName("Scoped bearer token").setDesc("Stored only in Obsidian plugin data; never written to notes.")
      .addText((text) => {
        text.setPlaceholder("Bearer token").setValue(this.plugin.settings.token);
        text.inputEl.type = "password";
        text.onChange(async (value) => { this.plugin.settings.token = value.trim(); await this.plugin.saveSettings(); });
        text.inputEl.addEventListener("blur", () => {
          if (this.plugin.settings.autoSync && this.plugin.hasSyncConfig()) void this.plugin.sync({ silent: true });
        });
      });
    new Setting(containerEl).setName("Automatic sync").setDesc("Check for new AIDEN memories and local changes every 5 minutes while Obsidian is open.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
        this.plugin.settings.autoSync = value;
        await this.plugin.saveSettings();
        if (value && this.plugin.hasSyncConfig()) void this.plugin.sync({ silent: true });
      }));
    new Setting(containerEl).setName("Sync now").setDesc("Run an immediate sync. Local deletions are never sent automatically.")
      .addButton((button) => button.setButtonText("Sync now").setCta().onClick(() => void this.plugin.sync()));
  }
}