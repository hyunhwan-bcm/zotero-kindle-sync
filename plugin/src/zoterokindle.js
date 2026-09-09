/* global Zotero, Services, Components, ChromeUtils, IOUtils, PathUtils */
/*
 * Zotero Kindle Sync
 *
 * 1. Mirror: copy every stored PDF attachment of the selected libraries into
 *       <mirrorDir>/<Library>/<Collection>/<Subcollection>/<First author> <year> - <title>.pdf
 *    (or <mirrorDir>/<Library>/<file> with the "library" layout)
 *    A manifest (../state/manifest.json next to the mirror) maps attachment keys to
 *    mirror paths so renames and removals can be followed.
 * 2. Sync: run `s2k -c <generated config> mtp` which pushes new PDFs to the Kindle and,
 *    for PDFs deleted on the Kindle, deletes the mirror copy (never Zotero's own file).
 *    s2k is downloaded from the sync2kindle GitHub releases on first use.
 * 3. Write back: parent items whose PDF is on the device get the "synced" tag; items whose
 *    PDF vanished from the mirror after the sync get the "removed" tag and are not mirrored
 *    again until that tag is removed.
 * 4. Background: a timer runs the whole cycle quietly every few minutes. When no Kindle is
 *    connected nothing is shown; when something was transferred a summary pops up.
 */
ZoteroKindle = {
  id: null,
  version: null,
  rootURI: null,
  windows: new Set(),
  running: false,

  PREF: "extensions.zoterokindle.",
  MAX_NAME: 120,
  S2K_REPO: "rupor-github/sync2kindle",
  S2K_BUILDS: ["darwin-arm64", "darwin-amd64", "linux-amd64", "windows-amd64"],

  timer: null,
  firstTimer: null,
  timerWin: null,
  lastAutoError: null,
  currentUI: null,
  prefObservers: [],

  init({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    Zotero.ZoteroKindle = this; // reachable from the preference pane
    for (const name of ["autoSync", "autoSyncMinutes"]) {
      this.prefObservers.push(
        Zotero.Prefs.registerObserver(this.PREF + name, () => this.restartScheduler(), true)
      );
    }
  },

  shutdown() {
    this.stopScheduler();
    for (const o of this.prefObservers) Zotero.Prefs.unregisterObserver(o);
    this.prefObservers = [];
    delete Zotero.ZoteroKindle;
  },

  log(msg) {
    Zotero.debug(`ZoteroKindle: ${msg}`);
  },

  pref(name) {
    return Zotero.Prefs.get(this.PREF + name, true);
  },

  setPref(name, value) {
    Zotero.Prefs.set(this.PREF + name, value, true);
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
      const auto = doc.createXULElement("menuitem");
      auto.id = "zk-menu-auto";
      auto.setAttribute("type", "checkbox");
      auto.setAttribute("label", "Auto-sync to Kindle in the background");
      auto.setAttribute("checked", this.pref("autoSync") ? "true" : "false");
      auto.addEventListener("command", () => {
        const on = !this.pref("autoSync");
        this.setPref("autoSync", on);
        auto.setAttribute("checked", on ? "true" : "false");
      });
      const undo = doc.createXULElement("menuitem");
      undo.id = "zk-menu-undo";
      undo.setAttribute("label", "Undo Kindle Removals (clear kindle-removed tags)");
      undo.addEventListener("command", () => this.clearRemovedTags(win));
      toolsPopup.append(sep, sync, dry, auto, undo);
      toolsPopup.addEventListener("popupshowing", () => {
        auto.setAttribute("checked", this.pref("autoSync") ? "true" : "false");
      });
    }

    // toolbar buttons in the items pane, after "New Note"; same 20px context-fill icons Zotero uses
    const anchor = doc.getElementById("zotero-tb-note-add");
    if (anchor && !doc.getElementById("zk-tb-sync")) {
      const make = (id, icon, tip, dryRun) => {
        const btn = doc.createXULElement("toolbarbutton");
        btn.id = id;
        btn.className = "zotero-tb-button";
        btn.setAttribute("tabindex", "-1");
        btn.setAttribute("tooltiptext", tip);
        btn.style.cssText =
          `list-style-image: url("${this.rootURI}icons/${icon}.svg"); ` +
          "-moz-context-properties: fill, fill-opacity; fill: currentColor;";
        btn.addEventListener("command", () => this.syncAll(win, { dryRun }));
        return btn;
      };
      const dry = make("zk-tb-dry", "kindle-preview", "Preview Kindle sync (dry run, changes nothing)", true);
      const sync = make("zk-tb-sync", "kindle-sync", "Sync library to Kindle", false);
      anchor.insertAdjacentElement("afterend", sync);
      anchor.insertAdjacentElement("afterend", dry);
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
    if (this.pref("pendingRepair")) {
      this.setPref("pendingRepair", false);
      win.setTimeout(() => this.clearRemovedTags(win), 15 * 1000);
    }
    if (!this.timerWin) this.startScheduler(win);
  },

  removeFromWindow(win) {
    for (const id of ["zk-menu-sep", "zk-menu-sync", "zk-menu-dry", "zk-menu-auto", "zk-menu-undo", "zk-item-send", "zk-tb-sync", "zk-tb-dry"]) {
      win.document.getElementById(id)?.remove();
    }
    this.windows.delete(win);
    if (this.timerWin === win) {
      this.stopScheduler();
      const other = Array.from(this.windows)[0];
      if (other) this.startScheduler(other);
    }
  },

  /* visible progress window, used for user-triggered runs */
  progress(win, title) {
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline(title);
    pw.addDescription("Starting…");
    pw.show();
    return {
      quiet: false,
      line(text) {
        pw.addDescription(text);
      },
      done(text, ms = 8000) {
        pw.addDescription(text);
        pw.startCloseTimer(ms);
      },
      discard() {
        pw.close();
      },
    };
  },

  /* buffered progress for background runs: only shown when something happened */
  buffered(win, title) {
    const lines = [];
    let pw = null; // created when the run is promoted to visible, or at the end if there is news
    const open = () => {
      pw = new Zotero.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline(title);
      for (const l of lines.slice(-12)) pw.addDescription(l);
      pw.show();
    };
    return {
      quiet: true,
      line(text) {
        lines.push(text);
        if (pw) pw.addDescription(text);
      },
      done(text, ms = 10000) {
        if (!pw) open();
        pw.addDescription(text);
        pw.startCloseTimer(ms);
      },
      discard() {
        if (pw) {
          pw.addDescription("Kindle already up to date");
          pw.startCloseTimer(5000);
        }
      },
      /* a user asked for a sync while this background run is going: show it instead of refusing */
      promote() {
        if (this.quiet) {
          this.quiet = false;
          lines.unshift("(background sync already in progress, showing it)");
          open();
        }
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

  /* tag = collection name shown at the front of the file name, so the Kindle library groups by it */
  buildName(att, tag = "") {
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
    const prefix = tag ? `[${this.sanitize(tag).replace(/[\[\]]/g, "")}] ` : "";
    const room = this.MAX_NAME - prefix.length;
    if (name.length > room) name = name.slice(0, Math.max(20, room)).replace(/[ .-]+$/, "");
    return prefix + name + ".pdf";
  },

  libraryName(libraryID) {
    const lib = Zotero.Libraries.get(libraryID);
    return lib.libraryType === "user" ? "Personal" : lib.name;
  },

  /* "Parent/Child/Grandchild" for a Zotero collection */
  collectionPath(coll) {
    const parts = [];
    for (let c = coll; c; c = c.parentID ? Zotero.Collections.get(c.parentID) : null) {
      parts.unshift(this.sanitize(c.name) || c.key);
    }
    return parts.join("/");
  },

  /* mirror-relative paths (with "/") where this attachment belongs */
  relPaths(att) {
    const lib = this.sanitize(this.libraryName(att.libraryID));
    if (this.pref("layout") !== "collections") return [`${lib}/${this.buildName(att)}`];
    const tagMode = this.pref("nameTag") || "leaf"; // none | leaf | path
    const tagFor = (dir) => (tagMode === "none" ? "" : tagMode === "path" ? dir.replace(/\//g, " / ") : dir.split("/").pop());
    const parent = att.parentItem || att;
    let dirs = parent
      .getCollections()
      .map((id) => Zotero.Collections.get(id))
      .filter(Boolean)
      .map((c) => this.collectionPath(c))
      .filter(Boolean)
      .sort();
    dirs = Array.from(new Set(dirs));
    if (!dirs.length) dirs = ["Unfiled"];
    if (!this.pref("allCollections")) dirs = dirs.slice(0, 1);
    return dirs.map((d) => `${lib}/${d}/${this.buildName(att, tagFor(d))}`);
  },

  /* delete directories left empty after files were moved or removed */
  async pruneEmptyDirs(dir, isRoot = true) {
    let children;
    try {
      children = await IOUtils.getChildren(dir);
    } catch (e) {
      return false;
    }
    let remaining = 0;
    for (const child of children) {
      const st = await IOUtils.stat(child);
      if (st.type === "directory") {
        if (!(await this.pruneEmptyDirs(child, false))) remaining++;
      } else if (PathUtils.filename(child) !== ".DS_Store") {
        remaining++;
      }
    }
    if (remaining === 0 && !isRoot) {
      await IOUtils.remove(dir, { recursive: true });
      return true;
    }
    return false;
  },

  /* ---------------- s2k binary ---------------- */

  s2kBinaryName() {
    return Zotero.isWin ? "s2k.exe" : "s2k";
  },

  s2kInstallDir() {
    return PathUtils.join(Zotero.Profile.dir, "zotero-kindle-sync", "s2k");
  },

  s2kAssetName() {
    const os = Zotero.isMac ? "darwin" : Zotero.isWin ? "windows" : Zotero.isLinux ? "linux" : "unknown";
    const raw = Services.sysinfo.getProperty("arch");
    const arch = raw === "aarch64" ? "arm64" : raw === "x86-64" ? "amd64" : raw;
    const key = `${os}-${arch}`;
    if (!this.S2K_BUILDS.includes(key)) {
      throw new Error(
        `sync2kindle has no MTP build for ${key}. Install s2k yourself and set its path in Settings → Kindle Sync.`
      );
    }
    return `s2k-${key}.zip`;
  },

  /* returns a usable s2k path, downloading the latest release if needed */
  async ensureS2K(ui, { force = false } = {}) {
    const configured = this.pref("s2kPath");
    if (!force && configured && (await IOUtils.exists(configured))) return configured;

    const dir = this.s2kInstallDir();
    const bin = PathUtils.join(dir, this.s2kBinaryName());
    if (!force && (await IOUtils.exists(bin))) {
      this.setPref("s2kPath", bin);
      return bin;
    }

    const asset = this.s2kAssetName();
    const url = `https://github.com/${this.S2K_REPO}/releases/latest/download/${asset}`;
    ui.line(`Downloading ${asset} from sync2kindle releases…`);
    this.log(`downloading ${url}`);
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    const zipPath = PathUtils.join(Zotero.getTempDirectory().path, asset);
    await Zotero.HTTP.download(url, zipPath);

    const zr = Components.classes["@mozilla.org/libjar/zip-reader;1"].createInstance(
      Components.interfaces.nsIZipReader
    );
    zr.open(Zotero.File.pathToFile(zipPath));
    let found = false;
    try {
      const entries = zr.findEntries("*");
      while (entries.hasMore()) {
        const entry = entries.getNext();
        if (entry.endsWith("/")) continue;
        const dest = PathUtils.join(dir, ...entry.split("/"));
        await IOUtils.makeDirectory(PathUtils.parent(dest), { ignoreExisting: true });
        zr.extract(entry, Zotero.File.pathToFile(dest));
        if (PathUtils.filename(dest) === this.s2kBinaryName()) found = true;
      }
    } finally {
      zr.close();
      await IOUtils.remove(zipPath, { ignoreAbsent: true });
    }
    if (!found) throw new Error(`${asset} did not contain ${this.s2kBinaryName()}`);
    if (!Zotero.isWin) await IOUtils.setPermissions(bin, 0o755);
    this.setPref("s2kPath", bin);
    ui.line(`Installed s2k to ${bin}`);
    return bin;
  },

  /* the macOS s2k builds load libmtp from Homebrew */
  async checkLibmtp() {
    if (!Zotero.isMac) return;
    for (const p of ["/opt/homebrew/opt/libmtp/lib/libmtp.9.dylib", "/usr/local/opt/libmtp/lib/libmtp.9.dylib"]) {
      if (await IOUtils.exists(p)) return;
    }
    throw new Error("libmtp is not installed. Run:  brew install libmtp  and sync again.");
  },

  /* ---------------- paths & state ---------------- */

  async paths(ui) {
    let mirrorDir = this.pref("mirrorDir");
    if (!mirrorDir) {
      mirrorDir = PathUtils.join(Zotero.DataDirectory.dir, "kindle-sync", "mirror");
      this.setPref("mirrorDir", mirrorDir);
    }
    // state/ next to the mirror - same layout as scripts/zk_mirror.py and s2k-zotero.yaml,
    // so the CLI and the plugin share one manifest and one s2k history
    const stateDir = PathUtils.join(PathUtils.parent(mirrorDir), "state");
    const s2kPath = await this.ensureS2K(ui);
    await this.checkLibmtp();
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

  async writeConfig(p) {
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

  async collectAll() {
    const out = [];
    for (const lib of this.wantedLibraries()) out.push(...(await this.pdfAttachmentsIn(lib.libraryID)));
    return out;
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
    const raw = await this.readJSON(p.manifest, {});
    // manifest: "<libraryID>/<attachmentKey>" -> [mirror-relative paths]; older files stored a single string
    const manifest = {};
    for (const [k, v] of Object.entries(raw)) manifest[k] = Array.isArray(v) ? v : [v];
    const removedTag = this.pref("removedTag");
    const syncedTag = this.pref("syncedTag");
    const exists = (rel) => IOUtils.exists(this.absPath(p.mirrorDir, rel));

    // 1. a copy missing from the mirror was deleted on the Kindle by the last sync:
    //    tag the item and drop its other copies too, so the device loses them as well
    for (const [key, rels] of Object.entries(manifest)) {
      const missing = [];
      for (const rel of rels) if (!(await exists(rel))) missing.push(rel);
      if (!missing.length) continue;
      const [libraryID, attKey] = key.split("/");
      const att = Zotero.Items.getByLibraryAndKey(Number(libraryID), attKey);
      const target = att ? att.parentItem || att : null;
      ui.line(`Removed on Kindle: ${missing[0]}`);
      if (!dryRun) {
        await this.setTag(target, syncedTag, false);
        await this.setTag(target, removedTag, true);
        for (const rel of rels) {
          if (!missing.includes(rel)) await IOUtils.remove(this.absPath(p.mirrorDir, rel), { ignoreAbsent: true });
        }
        delete manifest[key];
      }
    }

    // 2. copy new / changed PDFs into the mirror, move copies whose folder changed
    // name clashes (same author/year/title in one folder): every clashing file gets its attachment
    // key appended, decided from the whole set so the result does not depend on iteration order
    const active = [];
    const nameCount = new Map();
    let skipped = 0;
    for (const att of attachments) {
      if (this.hasTag(att.parentItem || att, removedTag)) {
        skipped++;
        continue;
      }
      const rels = this.relPaths(att);
      active.push([att, rels]);
      for (const rel of rels) nameCount.set(rel.toLowerCase(), (nameCount.get(rel.toLowerCase()) || 0) + 1);
    }
    let copied = 0,
      moved = 0,
      kept = 0;
    for (const [att, rels] of active) {
      const src = await att.getFilePathAsync();
      if (!src) continue;
      const key = `${att.libraryID}/${att.key}`;
      const previous = manifest[key] || [];
      const wanted = rels.map((rel) =>
        nameCount.get(rel.toLowerCase()) > 1 ? rel.replace(/\.pdf$/, ` [${att.key}].pdf`) : rel
      );
      const stale = previous.filter((rel) => !wanted.includes(rel));
      const srcSize = (await IOUtils.stat(src)).size;
      for (const rel of wanted) {
        const dst = this.absPath(p.mirrorDir, rel);
        if ((await IOUtils.exists(dst)) && (await IOUtils.stat(dst)).size === srcSize) {
          kept++;
          continue;
        }
        const from = stale.length ? stale.shift() : null;
        if (from && (await exists(from))) {
          moved++;
          ui.line(`${dryRun ? "Would move" : "Move"}: ${from} -> ${rel}`);
          if (!dryRun) {
            await IOUtils.makeDirectory(PathUtils.parent(dst), { ignoreExisting: true });
            await IOUtils.move(this.absPath(p.mirrorDir, from), dst);
          }
        } else {
          copied++;
          ui.line(`${dryRun ? "Would copy" : "Copy"}: ${rel}`);
          if (!dryRun) {
            await IOUtils.makeDirectory(PathUtils.parent(dst), { ignoreExisting: true });
            await IOUtils.copy(src, dst);
          }
        }
      }
      for (const rel of stale) {
        ui.line(`${dryRun ? "Would remove" : "Remove"} extra copy: ${rel}`);
        if (!dryRun) await IOUtils.remove(this.absPath(p.mirrorDir, rel), { ignoreAbsent: true });
      }
      manifest[key] = wanted;
    }
    if (!dryRun) {
      await this.pruneEmptyDirs(p.mirrorDir);
      await IOUtils.makeDirectory(p.stateDir, { ignoreExisting: true });
      await IOUtils.writeJSON(p.manifest, manifest);
    }
    return { manifest, copied, moved, kept, skipped };
  },

  /* ---------------- run s2k ---------------- */

  async runS2K(p, ui, { dryRun }) {
    const args = ["-c", p.config, "mtp"];
    if (this.pref("ignoreDeviceRemovals")) args.push("--ignore-device-removals");
    if (dryRun) args.push("--dry-run");
    this.log(`exec ${p.s2kPath} ${args.join(" ")}`);

    const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
    const proc = await Subprocess.call({ command: p.s2kPath, arguments: args, stderr: "stdout" });
    let out = "";
    let chunk;
    while ((chunk = await proc.stdout.readString())) out += chunk;
    const { exitCode } = await proc.wait();

    const result = { exitCode, out, actions: 0, localRemovals: 0, noDevice: false, noBooks: false, nothing: false, error: null };
    for (const line of out.split("\n")) {
      const m = line.match(/"action":\s*"(\w+)".*?"(?:file|directory)":\s*"([^"]+)"/);
      if (m) {
        result.actions++;
        if (m[1] === "Remove" && /s2k\.sync\.file-system/.test(line)) result.localRemovals++;
        ui.line(`${dryRun ? "Would " : ""}${m[1]} ${m[2]}`);
      } else if (/Nothing to do/.test(line)) {
        result.nothing = true;
      } else if (/no available device found|unable to connect to device/.test(line)) {
        result.noDevice = true;
      } else if (/no books in the source path/.test(line)) {
        result.noBooks = true;
      } else if (/\tERROR\t/.test(line)) {
        result.error = line.replace(/^.*\tERROR\t\S+\t/, "");
      }
    }
    return result;
  },

  /* ---------------- entry points ---------------- */

  async syncAll(win, opts = {}) {
    return this.run(win, await this.collectAll(), opts);
  },

  async syncSelected(win) {
    const attachments = this.selectedPdfAttachments(win);
    if (!attachments.length) return this.alert(win, "No PDF attachments in the selection.");
    return this.run(win, attachments);
  },

  async run(win, attachments, { dryRun = false, quiet = false } = {}) {
    if (this.running) {
      if (!quiet && this.currentUI) this.currentUI.promote?.(); // reveal the silent background run
      return;
    }
    this.running = true;
    const title = quiet ? "Kindle auto-sync" : dryRun ? "Kindle sync preview" : "Syncing to Kindle";
    const ui = quiet ? this.buffered(win, title) : this.progress(win, title);
    this.currentUI = ui;
    try {
      const p = await this.paths(ui);
      await IOUtils.makeDirectory(p.mirrorDir, { ignoreExisting: true });
      await IOUtils.makeDirectory(p.stateDir, { ignoreExisting: true });
      await this.writeConfig(p);

      const m = await this.mirror(p, attachments, ui, { dryRun });
      ui.line(`Mirror: ${m.copied} copied, ${m.moved} moved, ${m.kept} unchanged, ${m.skipped} skipped (removed tag)`);

      if (!dryRun) {
        // Safety net: preview first and refuse a run that would wipe a large part of the mirror.
        // A flaky device listing once made s2k believe every paper had been deleted on the Kindle.
        const preview = await this.runS2K(p, { line() {} }, { dryRun: true });
        const total = Object.keys(m.manifest).length;
        if (preview.localRemovals > 5 && preview.localRemovals > total * 0.2) {
          await this.appendRunLog(p, `REFUSED: would delete ${preview.localRemovals} of ${total} local files`);
          throw new Error(
            `Refusing to sync: the Kindle listing would delete ${preview.localRemovals} of ${total} papers ` +
              `from the mirror. If you really removed them on the Kindle, run Tools → Sync Library to Kindle ` +
              `again after unplugging and replugging the device.`
          );
        }
      }

      const r = await this.runS2K(p, ui, { dryRun });
      await this.appendRunLog(
        p,
        `${dryRun ? "dry-run" : "sync"} exit=${r.exitCode} actions=${r.actions} localRemovals=${r.localRemovals} ` +
          `noDevice=${r.noDevice} mirror(copied=${m.copied},moved=${m.moved},kept=${m.kept},skipped=${m.skipped})`
      );
      if (r.noDevice) {
        if (ui.quiet) {
          ui.discard(); // no Kindle plugged in: stay silent
          return;
        }
        throw new Error("No Kindle connected. Plug it in over USB and try again.");
      }
      if (r.noBooks) throw new Error("The mirror folder has no PDFs to sync.");
      if (r.exitCode !== 0) {
        this.log(r.out);
        throw new Error(r.error || `s2k exited with code ${r.exitCode}. See ${p.log}`);
      }

      if (!dryRun) {
        // everything still in the mirror after the sync is on the device
        const syncedTag = this.pref("syncedTag");
        for (const att of attachments) {
          const rels = m.manifest[`${att.libraryID}/${att.key}`] || [];
          for (const rel of rels) {
            if (await IOUtils.exists(this.absPath(p.mirrorDir, rel))) {
              await this.setTag(att.parentItem || att, syncedTag, true);
              break;
            }
          }
        }
      }
      this.lastAutoError = null;
      if (ui.quiet && r.actions === 0) {
        ui.discard(); // device present, already in sync: nothing to report
        return;
      }
      const summary = r.actions
        ? `${r.actions} change${r.actions === 1 ? "" : "s"} ${dryRun ? "pending" : "applied"} on the Kindle`
        : "Kindle already up to date";
      ui.done(dryRun ? `Preview finished: ${summary}` : summary);
    } catch (e) {
      this.log(e.message);
      if (ui.quiet && this.lastAutoError === e.message) return; // do not nag every tick with the same error
      this.lastAutoError = e.message;
      ui.done(`Failed: ${e.message}`, 15000);
    } finally {
      this.running = false;
      this.currentUI = null;
    }
  },

  async appendRunLog(p, text) {
    try {
      const line = `${new Date().toISOString()} ${text}\n`;
      await IOUtils.writeUTF8(PathUtils.join(p.stateDir, "runs.log"), line, { mode: "append" });
    } catch (e) {
      this.log(`runs.log: ${e.message}`);
    }
  },

  /* Undo: remove the "removed on Kindle" tag from every item so the papers are mirrored again */
  async clearRemovedTags(win, { silent = false } = {}) {
    const tag = this.pref("removedTag");
    let n = 0;
    for (const lib of this.wantedLibraries()) {
      const items = await Zotero.Items.getAll(lib.libraryID, false, false);
      for (const it of items) {
        if (!this.hasTag(it, tag)) continue;
        await this.setTag(it, tag, false);
        n++;
      }
    }
    this.log(`cleared "${tag}" from ${n} items`);
    if (!silent) {
      const pw = new Zotero.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline("Kindle Sync");
      pw.addDescription(`Removed the "${tag}" tag from ${n} item${n === 1 ? "" : "s"}. They will be sent to the Kindle again on the next sync.`);
      pw.show();
      pw.startCloseTimer(8000);
    }
    return n;
  },

  /* ---------------- background scheduler ---------------- */

  intervalMs() {
    const minutes = Math.max(1, Number(this.pref("autoSyncMinutes")) || 5);
    return minutes * 60 * 1000;
  },

  startScheduler(win) {
    this.stopScheduler();
    this.timerWin = win;
    this.timer = win.setInterval(() => this.autoTick(), this.intervalMs());
    this.firstTimer = win.setTimeout(() => this.autoTick(), 45 * 1000);
    this.log(`scheduler started, every ${this.intervalMs() / 60000} min`);
  },

  stopScheduler() {
    if (this.timerWin) {
      this.timerWin.clearInterval(this.timer);
      this.timerWin.clearTimeout(this.firstTimer);
    }
    this.timer = this.firstTimer = this.timerWin = null;
  },

  restartScheduler() {
    const win = this.timerWin || Array.from(this.windows)[0];
    if (win) this.startScheduler(win);
  },

  async autoTick() {
    if (!this.pref("autoSync") || this.running) return;
    const win = this.timerWin || Zotero.getMainWindow();
    if (!win) return;
    try {
      await this.run(win, await this.collectAll(), { quiet: true });
    } catch (e) {
      this.log(`auto-sync: ${e.message}`);
    }
  },

  /* used by the preference pane */
  async installS2KFromPrefs(win) {
    const ui = this.progress(win, "Installing s2k");
    try {
      const bin = await this.ensureS2K(ui, { force: true });
      await this.checkLibmtp();
      ui.done(`Ready: ${bin}`);
      return bin;
    } catch (e) {
      ui.done(`Failed: ${e.message}`, 15000);
      return null;
    }
  },
};
