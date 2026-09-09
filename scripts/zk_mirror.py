#!/usr/bin/env python3
"""
Mirror Zotero PDF attachments into a Kindle-friendly folder tree.

    <mirror>/<Library name>/<Collection>/<Subcollection>/<First author> <year> - <title>.pdf

or, with --layout library, <mirror>/<Library name>/<file>. Papers in no collection go to
"Unfiled"; a paper in several collections is copied into each unless --one-collection is given.
The manifest maps each attachment to the list of mirror paths holding it.

The mirror is what sync2kindle (s2k) syncs to the device, so Zotero's own
storage is never touched by the bidirectional sync. When a PDF disappears
from the mirror (because s2k removed it after it was deleted on the Kindle),
the Zotero item key is recorded in state/removed.json and is not mirrored
again until it is removed from that file.

Reads a *copy* of zotero.sqlite so it is safe while Zotero is running.
"""
import argparse, json, os, re, shutil, sqlite3, sys, tempfile, unicodedata
from pathlib import Path

DEFAULT_DATA_DIR = Path.home() / "Zotero"
MAX_NAME = 120  # keep well under filesystem/MTP limits


def sanitize(s: str) -> str:
    s = unicodedata.normalize("NFC", s or "")
    s = re.sub(r"<[^>]+>", "", s)               # strip html tags from titles
    s = s.replace("/", "-").replace("\\", "-").replace(":", " -")
    s = re.sub(r'[<>"|?*\x00-\x1f]', "", s)
    s = re.sub(r"\s+", " ", s).strip(" .")
    return s


def snapshot_db(data_dir: Path) -> Path:
    """Copy zotero.sqlite (+wal) to a temp dir so the live DB is never opened."""
    tmp = Path(tempfile.mkdtemp(prefix="zk_"))
    for name in ("zotero.sqlite", "zotero.sqlite-wal", "zotero.sqlite-shm"):
        src = data_dir / name
        if src.exists():
            shutil.copy2(src, tmp / name)
    return tmp / "zotero.sqlite"


QUERY = """
select
  i.itemID                       as attItemID,
  p.itemID                       as parentItemID,
  i.libraryID,
  l.type                         as libType,
  coalesce(g.name, 'Personal')   as libName,
  i.key                          as attKey,
  ia.path                        as attPath,
  p.key                          as parentKey,
  (select v.value from itemData d join itemDataValues v on v.valueID=d.valueID
     where d.itemID=p.itemID and d.fieldID=(select fieldID from fields where fieldName='title')) as title,
  (select v.value from itemData d join itemDataValues v on v.valueID=d.valueID
     where d.itemID=p.itemID and d.fieldID=(select fieldID from fields where fieldName='date'))  as date,
  (select c.lastName from itemCreators ic join creators c on c.creatorID=ic.creatorID
     where ic.itemID=p.itemID order by ic.orderIndex limit 1) as firstAuthor,
  (select count(*) from itemCreators ic where ic.itemID=p.itemID) as nAuthors,
  (select v.value from itemData d join itemDataValues v on v.valueID=d.valueID
     where d.itemID=ia.itemID and d.fieldID=(select fieldID from fields where fieldName='title')) as attTitle
from itemAttachments ia
join items i on i.itemID = ia.itemID
join libraries l on l.libraryID = i.libraryID
left join groups g on g.libraryID = i.libraryID
left join items p on p.itemID = ia.parentItemID
where ia.contentType = 'application/pdf'
  and ia.linkMode in (0, 1)                       -- imported file / imported url (stored in storage/<key>/)
  and i.itemID not in (select itemID from deletedItems)
  and (p.itemID is null or p.itemID not in (select itemID from deletedItems))
order by libName, firstAuthor, date
"""


COLLECTIONS_QUERY = """
select c.collectionID, c.collectionName, c.parentCollectionID, c.libraryID from collections c
"""
ITEM_COLLECTIONS_QUERY = """
select ci.itemID, ci.collectionID from collectionItems ci
"""


def load_collections(con):
    """Return {itemID: [collection path, ...]} using sanitized names joined with '/'."""
    cols = {r["collectionID"]: r for r in con.execute(COLLECTIONS_QUERY)}
    cache = {}

    def path(cid):
        if cid in cache:
            return cache[cid]
        parts, cur, seen = [], cid, set()
        while cur and cur in cols and cur not in seen:
            seen.add(cur)
            parts.append(sanitize(cols[cur]["collectionName"]) or str(cur))
            cur = cols[cur]["parentCollectionID"]
        cache[cid] = "/".join(reversed(parts))
        return cache[cid]

    by_item = {}
    for r in con.execute(ITEM_COLLECTIONS_QUERY):
        by_item.setdefault(r["itemID"], []).append(path(r["collectionID"]))
    return by_item


def build_name(row, tag: str = "") -> str:
    """'[tag] Author et al. 2024 - Title.pdf'; the tag is the collection name shown by the Kindle."""
    title = row["title"] or row["attTitle"] or row["attKey"]
    year = ""
    if row["date"]:
        m = re.search(r"\d{4}", row["date"])
        year = m.group(0) if m else ""
    author = row["firstAuthor"] or ""
    if author and (row["nAuthors"] or 0) > 1:
        author += " et al."
    head = " ".join(x for x in (author, year) if x)
    name = f"{head} - {title}" if head else title
    name = sanitize(name)
    prefix = f"[{sanitize(tag).replace('[', '').replace(']', '')}] " if tag else ""
    room = MAX_NAME - len(prefix)
    if len(name) > room:
        name = name[:max(20, room)].rstrip(" .-")
    return prefix + name + ".pdf"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR, help="Zotero data directory")
    ap.add_argument("--mirror", type=Path, required=True, help="output folder that s2k syncs from")
    ap.add_argument("--state", type=Path, required=True, help="folder for manifest.json / removed.json")
    ap.add_argument("--library", action="append", help="only these library names (repeatable)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--prune", action="store_true", help="delete mirror files that are no longer in Zotero")
    ap.add_argument("--layout", choices=["collections", "library"], default="collections",
                    help="folder tree per Zotero collection (default) or one folder per library")
    ap.add_argument("--name-tag", choices=["leaf", "path", "none"], default="none",
                    help="collection tag at the front of the file name: innermost collection (default), full path, or none")
    ap.add_argument("--one-collection", action="store_true",
                    help="copy a paper into its first collection only instead of every collection")
    args = ap.parse_args()

    args.state.mkdir(parents=True, exist_ok=True)
    manifest_path = args.state / "manifest.json"
    removed_path = args.state / "removed.json"
    raw = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    manifest = {k: (v if isinstance(v, list) else [v]) for k, v in raw.items()}
    removed = json.loads(removed_path.read_text()) if removed_path.exists() else {}

    # 1. Detect copies that s2k removed from the mirror since last run (deleted on Kindle).
    #    The item is retired and its other copies are dropped too, so the device loses them as well.
    for key, rels in list(manifest.items()):
        missing = [r for r in rels if not (args.mirror / r).exists()]
        if missing and key not in removed:
            removed[key] = missing[0]
            print(f"removed on device -> will not re-mirror: {missing[0]}")
            for r in rels:
                if r not in missing and not args.dry_run:
                    (args.mirror / r).unlink(missing_ok=True)
            del manifest[key]

    db = snapshot_db(args.data_dir)
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute(QUERY).fetchall()
    item_collections = load_collections(con) if args.layout == "collections" else {}
    con.close()
    shutil.rmtree(db.parent, ignore_errors=True)

    def tag_for(d):
        if args.name_tag == "none":
            return ""
        return d.replace("/", " / ") if args.name_tag == "path" else d.split("/")[-1]

    # pass 1: where does every attachment go; count clashing names per folder
    planned, name_count = [], {}
    stats = dict(copied=0, moved=0, kept=0, skipped_removed=0, missing=0)
    for r in rows:
        if args.library and r["libName"] not in args.library:
            continue
        key = f'{r["libraryID"]}/{r["attKey"]}'
        if key in removed:
            stats["skipped_removed"] += 1
            continue
        if not r["attPath"] or not r["attPath"].startswith("storage:"):
            continue
        src = args.data_dir / "storage" / r["attKey"] / r["attPath"][len("storage:"):]
        if not src.exists():
            stats["missing"] += 1
            continue
        lib = sanitize(r["libName"])
        if args.layout == "collections":
            dirs = sorted(set(item_collections.get(r["parentItemID"] or r["attItemID"], []))) or ["Unfiled"]
            if args.one_collection:
                dirs = dirs[:1]
            wanted = [f"{lib}/{d}/{build_name(r, tag_for(d))}" for d in dirs]
        else:
            wanted = [f"{lib}/{build_name(r)}"]
        planned.append((r, key, src, wanted))
        for rel in wanted:
            name_count[rel.lower()] = name_count.get(rel.lower(), 0) + 1

    # pass 2: copy / move. Every file whose name clashes inside a folder gets its attachment key,
    # decided from the whole set so the result matches the plugin regardless of ordering.
    new_manifest = {}
    for r, key, src, wanted in planned:
        previous = manifest.get(key, [])
        rels = [rel[:-4] + f" [{r['attKey']}].pdf" if name_count[rel.lower()] > 1 else rel for rel in wanted]
        stale = [x for x in previous if x not in rels]
        for rel in rels:
            dst = args.mirror / rel
            if dst.exists() and dst.stat().st_size == src.stat().st_size:
                stats["kept"] += 1
                continue
            old = None
            while stale and old is None:
                cand = stale.pop(0)
                if (args.mirror / cand).exists():
                    old = cand
            if old:
                stats["moved"] += 1
                print(f"{'would move' if args.dry_run else 'move'}: {old} -> {rel}")
                if not args.dry_run:
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    (args.mirror / old).rename(dst)
            else:
                stats["copied"] += 1
                print(f"{'would copy' if args.dry_run else 'copy'}: {rel}")
                if not args.dry_run:
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, dst)
        for rel in stale:
            print(f"{'would remove' if args.dry_run else 'remove'} extra copy: {rel}")
            if not args.dry_run:
                (args.mirror / rel).unlink(missing_ok=True)
        new_manifest[key] = rels

    if args.prune:
        for key, rels in manifest.items():
            if key in new_manifest:
                continue
            for rel in rels:
                if (args.mirror / rel).exists():
                    print(f"{'would prune' if args.dry_run else 'prune'} (gone from Zotero): {rel}")
                    if not args.dry_run:
                        (args.mirror / rel).unlink()

    if not args.dry_run:
        # drop directories left empty by moves
        for d in sorted((x for x in args.mirror.rglob("*") if x.is_dir()), key=lambda x: -len(x.parts)):
            if not any(f.name != ".DS_Store" for f in d.iterdir()):
                shutil.rmtree(d)

    if not args.dry_run:
        manifest_path.write_text(json.dumps(new_manifest, indent=1, ensure_ascii=False))
        removed_path.write_text(json.dumps(removed, indent=1, ensure_ascii=False))
    print(f"\n{len(new_manifest)} PDFs, {sum(len(v) for v in new_manifest.values())} copies in mirror: {stats}")


if __name__ == "__main__":
    main()
