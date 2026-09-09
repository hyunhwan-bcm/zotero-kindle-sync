# zotero-kindle-sync

Keeps a Kindle in sync with your Zotero libraries in both directions. The device transfer is done
by [sync2kindle](https://github.com/rupor-github/sync2kindle) (`s2k`).

```
Zotero storage  --copy-->  mirror/<Library>/<Collection>/<Author Year - Title>.pdf  --s2k mtp-->  Kindle documents/zotero
Zotero tags     <--------  manifest / removed state                    <--s2k mtp--  deleted on Kindle
```

The Kindle only ever sees a mirror folder of copies, so the device sync never touches Zotero's own
files. When you delete a paper on the Kindle, `s2k` deletes the mirror copy and the item is marked
so it is not sent again.

## Layout

| Path | Purpose |
|---|---|
| `scripts/zk_mirror.py` | CLI that builds or updates the mirror from `zotero.sqlite` (safe while Zotero runs) |
| `s2k-zotero.yaml` | `s2k` config: source `mirror/`, target `documents/zotero`, history in `state/history` |
| `plugin/` | Zotero 7+ plugin that does the same from inside Zotero and writes tags back |
| `scripts/build_xpi.sh` | packages `plugin/` into `plugin/build/zotero-kindle-sync-<ver>.xpi` |
| `mirror/`, `state/` | local data, git-ignored |

The CLI and the plugin share `state/manifest.json` and the `s2k` history, so you can use either.

## Requirements

- `s2k`, the sync2kindle binary with MTP support. The plugin downloads the matching build from the
  sync2kindle releases on first use and keeps it in the Zotero profile folder. For the CLI, download
  an `s2k-*` archive yourself or build sync2kindle with `CGO_ENABLED=1 go build -tags 'mtp usb' -o build/s2k ./cmd/s2k`.
- On macOS, libmtp: `brew install libmtp`. The s2k build loads it from Homebrew.
- A newer Kindle (Scribe, Colorsoft, Paperwhite 12) connected over USB. Do not run the standalone
  `mtp-*` tools from libmtp on macOS while the Kindle is attached. They release the device on exit
  and the Kindle drops off USB until you replug it.

## CLI use

```sh
python3 scripts/zk_mirror.py --mirror mirror --state state          # update mirror from Zotero
python3 scripts/zk_mirror.py --mirror mirror --state state --prune  # also drop PDFs gone from Zotero
/path/to/s2k -c s2k-zotero.yaml mtp --dry-run                         # preview
/path/to/s2k -c s2k-zotero.yaml mtp                                   # sync
```

When you delete a PDF on the Kindle, the next `s2k` run removes it from `mirror/`, and the next
`zk_mirror.py` run records it in `state/removed.json` and stops copying it. Delete the entry from
that file to send the paper again.

`--library "Personal"` (repeatable) limits the libraries. `--data-dir` points at a Zotero data
directory other than `~/Zotero`.

## Plugin

Download the `.xpi` from the [latest release](https://github.com/hyunhwan-bcm/zotero-kindle-sync/releases/latest),
then in Zotero open Tools > Plugins, click the gear icon and choose Install Plugin From File.
Zotero checks `updates.json` from the latest release for new versions.

To build from source, run `scripts/build_xpi.sh`. It writes `plugin/build/zotero-kindle-sync-<version>.xpi`.

Zotero's loader (Zotero 7+) rejects a plugin whose manifest lacks `applications.zotero.id`,
`update_url` or `strict_max_version`, and it silently deletes a rejected `.xpi` that was copied
into the profile's `extensions/` folder. An `.xpi` copied there by hand is installed disabled until
you enable it in the Plugins window, so installing through that window is simpler.

The plugin works without configuration: the mirror goes to `kindle-sync/mirror` inside the Zotero
data directory and s2k is downloaded on first use. Settings > Kindle Sync lets you change the s2k
path, the mirror folder, the libraries, the tags, and the background sync. The plugin adds:

- two Kindle buttons in the items toolbar, next to New Note: preview (dry run) and sync
- Tools > Sync Library to Kindle, and Tools > Preview Kindle Sync (dry run)
- Send to Kindle in the item context menu, for the selected items or their PDFs only
- background sync: every 5 minutes (configurable) the plugin refreshes the mirror and probes for the
  Kindle. Nothing is shown while no Kindle is connected. When a connected Kindle receives or loses
  papers, a short summary pops up. Turn it off in Settings or with Tools > Auto-sync to Kindle.

The plugin writes two tags back to Zotero: `on-kindle` while a PDF is on the device, and
`kindle-removed` after it was deleted on the Kindle. An item with the removed tag is skipped until
you delete the tag.

Files are named `[<Collection>] <First author>[ et al.] <year> - <title>.pdf`, truncated to 120
characters. The Kindle lists documents flat and ignores folders, so the bracketed collection tag is
what groups papers on the device: sort the library by title, or search for the collection name.
Settings (CLI: `--name-tag`) switch the tag to the full collection path or turn it off.
Folders follow the Zotero collection tree inside a folder per library (`Personal`, or the group
name): `Personal/01_AI/Sub/…`. Papers in no collection go to `Unfiled`. A paper in several
collections is copied into each of them unless you turn that off in Settings (CLI: `--one-collection`).
The alternative layout is one folder per library (Settings, or CLI `--layout library`). Changing the
layout moves every paper on the Kindle on the next sync. Duplicate names get the attachment key
appended.

## Status

- The CLI path was tested end to end on a Kindle Scribe Colorsoft: 405 PDFs from 6 libraries,
  1.5 GB, 1m40s over MTP. A deletion on the device propagated back correctly.
- The plugin installs and starts in Zotero 10.0.2 beta. A full sync from inside Zotero has not
  been confirmed yet.
- Pulling Kindle annotations back into Zotero is not implemented.
