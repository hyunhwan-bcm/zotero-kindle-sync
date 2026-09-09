# zotero-kindle-sync

Keep a Kindle in sync with your Zotero libraries, in both directions, using
[sync2kindle](https://github.com/rupor-github/sync2kindle) (`s2k`) for the device transfer.

```
Zotero storage  --copy-->  mirror/<Library>/<Author Year - Title>.pdf  --s2k mtp-->  Kindle documents/zotero
Zotero tags     <--------  manifest / removed state                    <--s2k mtp--  deleted on Kindle
```

Zotero's own files are never touched by the device sync: the Kindle sees a *mirror*
folder of copies. When you delete a paper on the Kindle, `s2k` deletes the mirror copy and
the item is marked so it is not sent again. Nothing is removed from Zotero.

## Layout

| Path | Purpose |
|---|---|
| `scripts/zk_mirror.py` | CLI: build/update the mirror from `zotero.sqlite` (safe while Zotero runs) |
| `s2k-zotero.yaml` | `s2k` config: `mirror/` → `documents/zotero`, history in `state/history` |
| `plugin/` | Zotero 7+ plugin doing the same from inside Zotero, with tags written back |
| `scripts/build_xpi.sh` | packages `plugin/` into `plugin/build/zotero-kindle-sync-<ver>.xpi` |
| `mirror/`, `state/` | local data, git-ignored |

The CLI and the plugin share `state/manifest.json` and the `s2k` history, so you can use either.

## Requirements

- `s2k` full build (mtp) for your platform. On macOS: `brew install libmtp`, then build sync2kindle
  with `CGO_ENABLED=1 go build -tags 'mtp usb' -o build/s2k ./cmd/s2k`.
- Newer Kindle (Scribe, Colorsoft, Paperwhite 12) connected over USB. Do not run the standalone
  `mtp-*` tools from libmtp on macOS while the Kindle is attached: they release the device on exit
  and the Kindle drops off USB until replugged.

## CLI use

```sh
python3 scripts/zk_mirror.py --mirror mirror --state state          # update mirror from Zotero
python3 scripts/zk_mirror.py --mirror mirror --state state --prune  # also drop PDFs gone from Zotero
/path/to/s2k -c s2k-zotero.yaml mtp --dry-run                         # preview
/path/to/s2k -c s2k-zotero.yaml mtp                                   # sync
```

Deleting a PDF on the Kindle → next `s2k` run removes it from `mirror/` → next `zk_mirror.py`
run records it in `state/removed.json` and will not copy it again. Delete the entry from that
file to send the paper again.

Options: `--library "Personal"` (repeatable) limits libraries; `--data-dir` if Zotero data is not in `~/Zotero`.

## Plugin

Install: download the `.xpi` from the [latest release](https://github.com/hyunhwan-bcm/zotero-kindle-sync/releases/latest),
then Zotero → Tools → Plugins → gear icon → Install Plugin From File…. Zotero checks `updates.json`
from the latest release for new versions.

Build from source: `scripts/build_xpi.sh` writes `plugin/build/zotero-kindle-sync-<version>.xpi`.

Zotero's loader (Zotero 7+) rejects a plugin whose manifest lacks `applications.zotero.id`,
`update_url` or `strict_max_version`; a rejected sideloaded `.xpi` is silently deleted from the
profile's `extensions/` folder. Installing through the Plugins window avoids the second surprise;
copying the `.xpi` into `extensions/` by hand installs it *disabled* until enabled in that window.

Then in Settings → Kindle Sync set the path to `s2k` and the mirror folder (e.g. this repo's
`mirror/`). The plugin adds:

- a **Kindle button** in the items toolbar (next to New Note). Click to sync, Shift-click for a dry run
- **Tools → Sync Library to Kindle** and **Preview Kindle Sync (dry run)**
- **Send to Kindle** in the item context menu (selected items or their PDFs only)

Tags written back to Zotero: `on-kindle` while a PDF is on the device, `kindle-removed` after it
was deleted on the Kindle. An item with the removed tag is skipped until you delete the tag.

Naming: `<First author>[ et al.] <year> - <title>.pdf`, truncated to 120 characters, inside a folder
per library (`Personal`, or the group name). Duplicate names get the attachment key appended.

## Status

- CLI path tested end to end on a Kindle Scribe Colorsoft: 405 PDFs from 6 libraries, 1.5 GB,
  1m40s over MTP. Device-side deletion propagated back correctly.
- Plugin is scaffolded against the Zotero 7 bootstrap API and syntax-checked, not yet exercised
  inside Zotero.
- Not done: pulling Kindle annotations back into Zotero.
