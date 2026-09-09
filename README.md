# zotero-kindle-sync

Keeps a Kindle in sync with your Zotero libraries in both directions. The device transfer is done
by [sync2kindle](https://github.com/rupor-github/sync2kindle) (`s2k`).

```
Zotero storage  --copy-->  mirror/<Library>/<Collection>/<Author Year - Title>.pdf  --s2k mtp-->  Kindle documents/zotero
Zotero tags     <--------  manifest / removed state                                <--s2k mtp--  deleted on Kindle
```

The Kindle only ever sees a mirror folder of copies, so the device sync never touches Zotero's own
files. When you delete a paper on the Kindle, `s2k` deletes the mirror copy and the item is tagged
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

Options: `--library "Personal"` (repeatable) limits the libraries. `--data-dir` points at a Zotero
data directory other than `~/Zotero`. `--layout library` uses one folder per library instead of the
collection tree. `--one-collection` copies a paper into its first collection only. `--name-tag leaf`
or `path` puts the collection name in brackets at the front of each file name.

## Plugin

Download the `.xpi` from the [latest release](https://github.com/hyunhwan-bcm/zotero-kindle-sync/releases/latest),
then in Zotero open Tools > Plugins, click the gear icon and choose Install Plugin From File.
Zotero checks `updates.json` from the latest release for new versions.

To build from source, run `scripts/build_xpi.sh`. It writes `plugin/build/zotero-kindle-sync-<version>.xpi`.

Zotero's loader (Zotero 7+) rejects a plugin whose manifest lacks `applications.zotero.id`,
`update_url` or `strict_max_version`, and it silently deletes a rejected `.xpi` that was copied
into the profile's `extensions/` folder. An `.xpi` copied there by hand is installed disabled until
you enable it in the Plugins window, so installing through that window is simpler.

The plugin works without configuration. The mirror goes to `kindle-sync/mirror` inside the Zotero
data directory and s2k is downloaded on first use. Settings > Kindle Sync lets you change the s2k
path, the mirror folder, the libraries, the folder layout, the tags, and the background sync.

What the plugin adds to Zotero:

- Two Kindle buttons in the items toolbar, next to New Note: preview (dry run) and sync.
- Tools > Sync Library to Kindle, Tools > Preview Kindle Sync (dry run), and Tools > Undo Kindle
  Removals, which clears the `kindle-removed` tag from every item.
- Send to Kindle in the item context menu, for the selected items or their PDFs only.
- Background sync. Every 5 minutes (configurable) the plugin refreshes the mirror and probes for the
  Kindle. Nothing is shown while no Kindle is connected. When a connected Kindle receives or loses
  papers, a short summary pops up. Turn it off in Settings or with Tools > Auto-sync to Kindle.

Before every real sync the plugin runs a preview and refuses to continue if the result would delete
more than a fifth of the mirror. This guards against an incomplete device listing, which happened
once while the Kindle was busy indexing new files and made s2k believe every paper had been deleted
on the device. Each run is logged as one line in `state/runs.log`.

The plugin writes two tags back to Zotero: `on-kindle` while a PDF is on the device, and
`kindle-removed` after it was deleted on the Kindle. An item with the removed tag is skipped until
you delete the tag, or use Tools > Undo Kindle Removals.

### Folders and names

Folders follow the Zotero collection tree inside a folder per library (`Personal`, or the group
name), for example `Personal/01_AI/Sub/`. Papers in no collection go to `Unfiled`. A paper in
several collections is copied into each of them unless you turn that off in Settings. The
alternative layout is one folder per library. Changing the layout moves every paper on the Kindle
on the next sync.

Files are named `<First author>[ et al.] <year> - <title>.pdf`, truncated to 120 characters. When
two papers in one folder would get the same name, both get their Zotero attachment key appended.

The Kindle lists documents as a flat list and ignores folders. The folders are real on the device
and visible from a computer, but the Kindle's Home and Library screens do not show them. As an
option, Settings can put the collection name in brackets at the front of each file name so that
sorting by title groups papers by collection. This only helps for PDFs without an embedded title,
because the Kindle prefers the embedded title over the file name.

## Status

- Tested end to end on a Kindle Scribe Colorsoft with Zotero 10.0.2 beta: 406 PDFs from 6
  libraries, about 1.5 GB, 1m40s for the first transfer over MTP, 2.5 minutes for a layout change.
  Deletions on the device propagate back, and the background sync, the toolbar buttons, and the
  s2k download all work from inside Zotero.
- The current s2k release reports a failed folder listing as an empty folder. A driver fix that
  aborts the sync instead, and skips the Kindle's `.sdr` sidecar folders while listing, is prepared
  for sync2kindle. Until it ships, the plugin's preview guard is the protection.
- Not implemented: writing the collection into the PDF title metadata, and pulling Kindle
  annotations back into Zotero.
