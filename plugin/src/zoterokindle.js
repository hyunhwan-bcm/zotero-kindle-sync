/* global Zotero, Services, ChromeUtils, IOUtils, PathUtils */
/*
 * Zotero Kindle Sync
 *
 * 1. Mirror: copy every stored PDF attachment of the selected libraries into
 *       <mirrorDir>/<Library>/<First author> <year> - <title>.pdf
 *    A manifest (state/manifest.json next to the mirror) maps attachment keys to
 *    mirror paths so renames and removals can be followed.
 * 2. Sync: run `s2k -c <generated config> mtp` which pushes new PDFs to the Kindle and,
 *    for PDFs deleted on the Kindle, deletes the mirror copy (never Zotero's own file).
 * 3. Write back: parent items whose PDF is on the device get the "synced" tag; items whose
 *    PDF vanished from the mirror after the sync get the "removed" tag and are not mirrored
 *    again until that tag is removed.
 */
ZoteroKindle = {
  id: null,
  version: null,
  rootURI: null,
  windows: new Set(),
  running: false,

  PREF: "extensions.zoterokindle.",
  MAX_NAME: 120,

  init({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
  },

  log(msg) {
    Zotero.debug(`ZoteroKindle: ${msg}`);
  },

  pref(name) {
    return Zotero.Prefs.get(this.PREF + name, true);
  },

  /* ---------------- UI ---------------- */

  addToAllWindows() {
    for (const win of Zotero.getMainWindows()) this.addToWindow(win);
  },

  removeFromAllWindows() {
    for (const win of Array.from(this.windows)) this.removeFromWindow(win);
  },

  addToWindow(win) {
    const doc = win.document;
    if (doc.getElementById("zk-menu-sync")) return;

    const toolsPopup = doc.getElementById("menu_ToolsPopup");
    if (toolsPopup) {
      const sep = doc.createXULElement("menuseparator");
      sep.id = "zk-menu-sep";
      const sync = doc.createXULElement("menuitem");
      sync.id = "zk-menu-sync";
      sync.setAttribute("label", "Sync Library to Kindle");
      sync.addEventListener("command", () => this.syncAll(win));
      const dry = doc.createXULElement("menuitem");
      dry.id = "zk-menu-dry";
      dry.setAttribute("label", "Preview Kindle Sync (dry run)");
      dry.addEventListener("command", () => this.syncAll(win, { dryRun: true }));
      toolsPopup.append(sep, sync, dry);
    }

    const itemMenu = doc.getElementById("zotero-itemmenu");
    if (itemMenu) {
      const send = doc.createXULElement("menuitem");
      send.id = "zk-item-send";
      send.setAttribute("label", "Send to Kindle");
      send.addEventListener("command", () => this.syncSelected(win));
      itemMenu.appendChild(send);
    }
    this.windows.add(win);
  },

  removeFromWindow(win) {
    for (const id of ["zk-menu-sep", "zk-menu-sync", "zk-menu-dry", "zk-item-send"]) {
      win.document.getElementById(id)?.remove();
    }
    this.windows.delete(win);
  },

  progress(win, title) {
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline(title);
    pw.addDescription("Starting…");
    pw.show();
    return {
      line(text) {
        pw.addDescription(text);
      },
      done(text, ms = 8000) {
        pw.addDescription(text);
        pw.startCloseTimer(ms);
      },
    };
  },

  alert(win, msg) {
    Services.prompt.alert(win, "Zotero Kindle Sync", msg);
  },

  /* ---------------- naming ---------------- */

  sanitize(s) {
    s = (s || "").normalize("NFC").replace(/<[^>]+>/g, "");
    s = s.replace(/[\/\\]/g, "-").replace(/:/g, " -");
    s = s.replace(/[<>"|?*\x00-\x1f]/g, "");
    return s.replace(/\s+/g, " ").replace(/^[ .]+|[ .]+$/g, "");
  },

  buildName(att) {
    const parent = att.parentItem;
    let title = parent ? parent.getField("title") : att.getField("title");
    title = title || att.key;
    let head = "";
    if (parent) {
      const creators = parent.getCreators();
      let author = creators.length ? creators[0].lastName || creators[0].firstName || "" : "";
      if (author && creators.length > 1) author += " et al.";
      const year = (parent.getField("date", true, true) || "").match(/\d{4}/)?.[0] || "";
      head = [author, year].filter(Boolean).join(" ");
    }
    let name = this.sanitize(head ? `${head} - ${title}` : title);
    if (name.length > this.MAX_NAME) name = name.slice(0, this.MAX_NAME).replace(/[ .-]+$/, "");
    return name + ".pdf";
  },

  libraryName(libraryID) {
    const lib = Zotero.Libraries.get(libraryID);
    return lib.libraryType === "user" ? "Personal" : lib.name;
  },

  /* ---------------- paths & state ---------------- */

  paths() {
    const mirrorDir = this.pref("mirrorDir");
    const s2kPath = this.pref("s2kPath");
    if (!mirrorDir || !s2kPath) {
      throw new Error("Set the s2k binary and the mirror folder in Settings → Kindle Sync first.");
    }
    // state/ next to the mirror - same layout as scripts/zk_mirror.py and s2k-zotero.yaml,
    // so the CLI and the plugin share one manifest and one s2k history
    const stateDir = PathUtils.join(PathUtils.parent(mirrorDir), "state");
    return {
      mirrorDir,
      s2kPath,
      stateDir,
      manifest: PathUtils.join(stateDir, "manifest.json"),
      config: PathUtils.join(stateDir, "s2k.yaml"),
      history: PathUtils.join(stateDir, "history"),
      log: PathUtils.join(stateDir, "s2k.log"),
    };
  },

  /* mirror-relative paths are stored with "/" (same as scripts/zk_mirror.py);
     PathUtils.join needs an absolute base and one component per argument */
  absPath(base, rel) {
    return PathUtils.join(base, ...rel.split("/").filter(Boolean));
  },

  async readJSON(path, fallback) {
    try {
      return await IOUtils.readJSON(path);
    } catch (e) {
      return fallback;
    }
  },

  async writeConfig(p, opts) {
    const yaml = [
      "# generated by Zotero Kindle Sync - edit preferences in Zotero instead",
      `source: ${JSON.stringify(p.mirrorDir)}`,
      `target: ${JSON.stringify(this.pref("target") || "documents/zotero")}`,
      `history: ${JSON.stringify(p.history)}`,
      "book_extensions: [.pdf]",
      "logging:",
      "    console: { level: normal }",
      `    file: { destination: ${JSON.stringify(p.log)}, level: debug, mode: overwrite }`,
      "",
    ].join("\n");
    await IOUtils.writeUTF8(p.config, yaml);
  },

  /* ---------------- attachments ---------------- */

  wantedLibraries() {
    const names = (this.pref("libraries") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return Zotero.Libraries.getAll().filter((lib) => {
      if (lib.libraryType === "feed") return false;
      return names.length === 0 || names.includes(this.libraryName(lib.libraryID));
    });
  },

  async pdfAttachmentsIn(libraryID) {
    const items = await Zotero.Items.getAll(libraryID, false, false);
    return items.filter(
      (it) => it.isPDFAttachment() && it.isImportedAttachment() && !it.deleted && !(it.parentItem && it.parentItem.deleted)
    );
  },

  /* attachments for the current selection (parent items expand to their PDFs) */
  selectedPdfAttachments(win) {
    const out = [];
    for (const it of win.ZoteroPane.getSelectedItems()) {
      if (it.isPDFAttachment() && it.isImportedAttachment()) out.push(it);
      else if (it.isRegularItem()) {
        for (const id of it.getAttachments()) {
          const att = Zotero.Items.get(id);
          if (att.isPDFAttachment() && att.isImportedAttachment()) out.push(att);
        }
      }
    }
    return out;
  },

  hasTag(item, tag) {
    return tag && item && item.getTags().some((t) => t.tag === tag);
  },

  async setTag(item, tag, on) {
    if (!tag || !item) return;
    if (!item.isEditable()) return; // read-only group library
    const has = this.hasTag(item, tag);
    if (on && !has) item.addTag(tag);
    else if (!on && has) item.removeTag(tag);
    else return;
    await item.saveTx({ skipSelect: true, skipDateModifiedUpdate: true });
  },

  /* ---------------- mirror ---------------- */

  async mirror(p, attachments, ui, { dryRun }) {
    const manifest = await this.readJSON(p.manifest, {});
    const removedTag = this.pref("removedTag");
    const syncedTag = this.pref("syncedTag");

    // 1. anything in the manifest that is gone from the mirror was deleted on the Kindle by the last sync
    for (const [key, rel] of Object.entries(manifest)) {
      if (await IOUtils.exists(this.absPath(p.mirrorDir, rel))) continue;
      const [libraryID, attKey] = key.split("/");
      const att = Zotero.Items.getByLibraryAndKey(Number(libraryID), attKey);
      const target = att ? att.parentItem || att : null;
      ui.line(`Removed on Kindle: ${rel}`);
      if (!dryRun) {
        await this.setTag(target, syncedTag, false);
        await this.setTag(target, removedTag, true);
        delete manifest[key];
      }
    }

    // 2. copy new / changed PDFs into the mirror
    const used = new Set(Object.values(manifest).map((v) => v.toLowerCase()));
    let copied = 0,
      kept = 0,
      skipped = 0;
    for (const att of attachments) {
      const target = att.parentItem || att;
      if (this.hasTag(target, removedTag)) {
        skipped++;
        continue;
      }
      const src = await att.getFilePathAsync();
      if (!src) continue;
      const key = `${att.libraryID}/${att.key}`;
      let rel = manifest[key];
      if (!rel) {
        rel = `${this.sanitize(this.libraryName(att.libraryID))}/${this.buildName(att)}`;
        if (used.has(rel.toLowerCase())) rel = rel.replace(/\.pdf$/, ` [${att.key}].pdf`);
      }
      used.add(rel.toLowerCase());
      const dst = this.absPath(p.mirrorDir, rel);
      let same = false;
      if (await IOUtils.exists(dst)) {
        const [a, b] = await Promise.all([IOUtils.stat(src), IOUtils.stat(dst)]);
        same = a.size === b.size;
      }
      if (same) {
        kept++;
      } else {
        copied++;
        ui.line(`${dryRun ? "Would copy" : "Copy"}: ${rel}`);
        if (!dryRun) {
          await IOUtils.makeDirectory(PathUtils.parent(dst), { ignoreExisting: true });
          await IOUtils.copy(src, dst);
        }
      }
      manifest[key] = rel;
    }
    if (!dryRun) {
      await IOUtils.makeDirectory(p.stateDir, { ignoreExisting: true });
      await IOUtils.writeJSON(p.manifest, manifest);
    }
    return { manifest, copied, kept, skipped };
  },

  /* ---------------- run s2k ---------------- */

  async runS2K(p, ui, { dryRun }) {
    const args = ["-c", p.config, "mtp"];
    if (this.pref("ignoreDeviceRemovals")) args.push("--ignore-device-removals");
    if (dryRun) args.push("--dry-run");
    this.log(`exec ${p.s2kPath} ${args.join(" ")}`);

    const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
    const proc = await Subprocess.call({
      command: p.s2kPath,
      arguments: args,
      stderr: "stdout",
    });
    let out = "";
    let chunk;
    while ((chunk = await proc.stdout.readString())) {
      out += chunk;
      for (const line of chunk.split("\n")) {
        const m = line.match(/"action":\s*"(\w+)".*?"(?:file|directory)":\s*"([^"]+)"/);
        if (m) ui.line(`${m[1]} ${m[2]}`);
        else if (/Nothing to do/.test(line)) ui.line("Device already up to date");
        else if (/ERROR/.test(line)) ui.line(line.replace(/^\S+\s+ERROR\s+\S+\s+/, ""));
      }
    }
    const { exitCode } = await proc.wait();
    return { exitCode, out };
  },

  /* ---------------- entry points ---------------- */

  async syncAll(win, opts = {}) {
    const libs = this.wantedLibraries();
    const attachments = [];
    for (const lib of libs) attachments.push(...(await this.pdfAttachmentsIn(lib.libraryID)));
    return this.run(win, attachments, opts);
  },

  async syncSelected(win) {
    const attachments = this.selectedPdfAttachments(win);
    if (!attachments.length) return this.alert(win, "No PDF attachments in the selection.");
    return this.run(win, attachments);
  },

  async run(win, attachments, { dryRun = false } = {}) {
    if (this.running) return this.alert(win, "A Kindle sync is already running.");
    this.running = true;
    const ui = this.progress(win, dryRun ? "Kindle sync preview" : "Syncing to Kindle");
    try {
      const p = this.paths();
      await IOUtils.makeDirectory(p.mirrorDir, { ignoreExisting: true });
      await IOUtils.makeDirectory(p.stateDir, { ignoreExisting: true });
      await this.writeConfig(p);

      const m = await this.mirror(p, attachments, ui, { dryRun });
      ui.line(`Mirror: ${m.copied} copied, ${m.kept} unchanged, ${m.skipped} skipped (removed tag)`);

      const r = await this.runS2K(p, ui, { dryRun });
      if (r.exitCode !== 0) {
        this.log(r.out);
        throw new Error(`s2k exited with code ${r.exitCode}. Is the Kindle connected? See ${p.log}`);
      }

      if (!dryRun) {
        // everything still in the mirror after the sync is on the device
        const syncedTag = this.pref("syncedTag");
        for (const att of attachments) {
          const rel = m.manifest[`${att.libraryID}/${att.key}`];
          if (rel && (await IOUtils.exists(this.absPath(p.mirrorDir, rel)))) {
            await this.setTag(att.parentItem || att, syncedTag, true);
          }
        }
      }
      ui.done(dryRun ? "Preview finished (nothing changed)" : "Kindle sync finished");
    } catch (e) {
      this.log(e.message);
      ui.done(`Failed: ${e.message}`, 15000);
    } finally {
      this.running = false;
    }
  },
};
