/* global Zotero, Services, ChromeUtils */
var ZoteroKindle;

function log(msg) { Zotero.debug("ZoteroKindle: " + msg); }

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
  Services.scriptloader.loadSubScript(rootURI + "src/zoterokindle.js");
  ZoteroKindle.init({ id, version, rootURI });
  Zotero.PreferencePanes.register({
    pluginID: id,
    src: rootURI + "prefs/prefs.xhtml",
    scripts: [rootURI + "prefs/prefs.js"],
    label: "Kindle Sync",
    image: rootURI + "icon.svg",
  });
  ZoteroKindle.addToAllWindows();
  log("started " + version);
}

function onMainWindowLoad({ window }) { ZoteroKindle.addToWindow(window); }
function onMainWindowUnload({ window }) { ZoteroKindle.removeFromWindow(window); }

function shutdown() {
  ZoteroKindle.removeFromAllWindows();
  ZoteroKindle.shutdown();
  ZoteroKindle = undefined;
}
