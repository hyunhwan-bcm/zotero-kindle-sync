# zotero-kindle-sync

Keeps a Kindle in sync with your Zotero libraries in both directions. The device transfer is done
by [sync2kindle](https://github.com/rupor-github/sync2kindle) (`s2k`).

```
Zotero storage  --copy-->  mirror/<Library>/<Author Year - Title>.pdf  --s2k mtp-->  Kindle documents/zotero
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

- A full `s2k` build with MTP support for your platform. On macOS: `brew install libmtp`, then build
  sync2kindle with `CGO_ENABLED=1 go build -tags 'mtp usb' -o build/s2k ./cmd/s2k`.
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

In Settings > Kindle Sync, set the path to `s2k` and the mirror folder (for example this repo's
`mirror/`). The plugin adds:

- two Kindle buttons in the items toolbar, next to New Note: preview (dry run) and sync
- Tools > Sync Library to Kindle, and Tools > Preview Kindle Sync (dry run)
- Send to Kindle in the item context menu, for the selected items or their PDFs only

The plugin writes two tags back to Zotero: `on-kindle` while a PDF is on the device, and
`kindle-removed` after it was deleted on the Kindle. An item with the removed tag is skipped until
you delete the tag.

Files are named `<First author>[ et al.] <year> - <title>.pdf`, truncated to 120 characters,
inside a folder per library (`Personal`, or the group name). Duplicate names get the attachment
key appended.

## Status

- The CLI path was tested end to end on a Kindle Scribe Colorsoft: 405 PDFs from 6 libraries,
  1.5 GB, 1m40s over MTP. A deletion on the device propagated back correctly.
- The plugin installs and starts in Zotero 10.0.2 beta. A full sync from inside Zotero has not
  been confirmed yet.
- Pulling Kindle annotations back into Zotero is not implemented.
