/* global Zotero, window, document */
(function () {
  async function pick(prefName, mode, title) {
    const fp = new (ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs").FilePicker)();
    fp.init(window, title, mode);
    if (mode === fp.modeOpen) fp.appendFilters(fp.filterAll);
    if ((await fp.show()) === fp.returnOK) {
      Zotero.Prefs.set(prefName, fp.file, true);
      const input = document.querySelector(`[preference="${prefName}"]`);
      if (input) input.value = fp.file;
    }
  }
  document.getElementById("zk-pick-s2k").addEventListener("command", () => {
    pick("extensions.zoterokindle.s2kPath", 0, "Select the s2k binary");
  });
  document.getElementById("zk-pick-mirror").addEventListener("command", () => {
    pick("extensions.zoterokindle.mirrorDir", 2, "Select the mirror folder");
  });
})();
