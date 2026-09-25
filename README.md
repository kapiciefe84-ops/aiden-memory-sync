# AIDEN Memory Sync for Obsidian

This is a standalone, dependency-free Obsidian community plugin. It synchronizes Markdown notes in the dedicated `AIDEN Memory/` vault folder with an AIDEN server. AIDEN's server-side PostgreSQL records are the source of truth, so memory remains available across devices even when Obsidian is offline.

## Manual installation

1. Build or download this directory as-is. It contains `manifest.json` and plain `main.js`; no npm install or build is required.
2. Copy the directory to `<vault>/.obsidian/plugins/aiden-memory-sync/`.
3. In Obsidian, reload plugins, enable **AIDEN Memory Sync**, and open its settings.
4. In AIDEN Settings, create an Obsidian sync token. Enter the server origin (for example, `https://your-aiden-host`) and the token in the plugin settings. The full token is shown only once in AIDEN; create another token if it is lost.
5. Automatic sync is enabled by default: it checks on plugin load and every five minutes while Obsidian is open. Use **Sync AIDEN Memory** from the command palette or **Sync now** in plugin settings for an immediate sync. Automatic sync can be turned off in plugin settings.

On iPhone and iPad, iOS may pause Obsidian while it is in the background. Sync resumes when Obsidian is open again; it cannot run continuously while iOS has suspended the app.

The plugin only writes below `AIDEN Memory/`. `Index.md` is generated from the server file list and linked memories; `Conflicts/` contains preserved remote copies when both local and remote versions changed. Existing local notes are preserved during first sync rather than silently overwritten. New Markdown notes can be uploaded; `Index.md` and `Conflicts/` are never uploaded. Private finance records are excluded from sync and backup exports.

Local deletion is never automatically sent to the server. To explicitly delete the active synced note, use **Delete active AIDEN Memory note (confirmation)**; it asks for confirmation and then sends the revision-checked DELETE. If a memory was deleted on the server, the local note is kept and is not re-uploaded automatically. Requests use bearer authorization and a bounded timeout; retryable reads and updates make at most three attempts, while creates are attempted once to avoid duplicate records after a timeout. Tokens and note contents are not logged.

## Smoke check

In a test vault, configure an AIDEN origin and token, create `AIDEN Memory/Example.md`, and run the command. Confirm that the server receives a POST and that a later remote edit pulls into the note. Edit both copies, sync again, and confirm a file appears under `AIDEN Memory/Conflicts/`. Remove a local note and sync; it must not issue a DELETE request.