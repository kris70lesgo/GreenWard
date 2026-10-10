import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import yauzl from "yauzl";
import { parser } from "stream-json";
import { pick } from "stream-json/filters/pick.js";
import { streamArray } from "stream-json/streamers/stream-array.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.resolve(here, "../data");
const archivePath = path.join(dataDirectory, "bbmp-tree-census-july-2026.zip");
const temporaryArchive = `${archivePath}.download`;
const databasePath = path.join(dataDirectory, "trees.sqlite");
const temporaryDatabase = `${databasePath}.importing`;
const archiveUrl = "https://data.opencity.in/dataset/9151032e-4423-4697-81a2-e29018a4facd/resource/368572d6-e3dc-4088-acd8-a243c440ebea/download/bbmp_tree_census_july_2026.zip";
const force = process.argv.includes("--force");

mkdirSync(dataDirectory, { recursive: true });
for (const artifact of [temporaryArchive, temporaryDatabase, `${temporaryDatabase}-wal`, `${temporaryDatabase}-shm`]) rmSync(artifact, { force: true });

if (!force && existsSync(databasePath) && statSync(databasePath).size > 0) {
  console.log(`Tree database already exists at ${databasePath}. Use --force to rebuild it.`);
  process.exit(0);
}

if (!existsSync(archivePath)) {
  console.log("Downloading the public BBMP tree census (about 16 MB)…");
  const response = await fetch(archiveUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Dataset download failed: ${response.status} ${response.statusText}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryArchive));
  renameSync(temporaryArchive, archivePath);
}

const zip = await new Promise((resolve, reject) => {
  yauzl.open(archivePath, { lazyEntries: true, autoClose: false }, (error, opened) => {
    if (error || !opened) reject(error ?? new Error("Could not open dataset ZIP"));
    else resolve(opened);
  });
});

const geojsonStream = await new Promise((resolve, reject) => {
  const fail = (error) => reject(error);
  zip.on("error", fail);
  zip.on("entry", (entry) => {
    if (entry.fileName.endsWith(".geojson")) {
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) return reject(error ?? new Error("Could not read GeoJSON in ZIP"));
        resolve(stream);
      });
    } else {
      zip.readEntry();
    }
  });
  zip.on("end", () => reject(new Error("The ZIP archive does not contain a GeoJSON file")));
  zip.readEntry();
});

const db = new Database(temporaryDatabase);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE trees (
    tree_id TEXT PRIMARY KEY,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    species TEXT NOT NULL DEFAULT '',
    ward TEXT NOT NULL DEFAULT '',
    status INTEGER
  );
  CREATE VIRTUAL TABLE tree_index USING rtree(tree_rowid, min_longitude, max_longitude, min_latitude, max_latitude);
  CREATE INDEX trees_ward_idx ON trees(ward);
  CREATE TABLE dataset_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
const insertTree = db.prepare(`INSERT OR IGNORE INTO trees (tree_id, latitude, longitude, species, ward, status)
  VALUES (?, ?, ?, ?, ?, ?)`);
const insertLocation = db.prepare(`INSERT INTO tree_index
  (tree_rowid, min_longitude, max_longitude, min_latitude, max_latitude) VALUES (?, ?, ?, ?, ?)`);
let imported = 0;
let skipped = 0;
const insertFeature = (feature) => {
  const coordinates = feature?.geometry?.coordinates;
  const properties = feature?.properties ?? {};
  const longitude = Number(coordinates?.[0]);
  const latitude = Number(coordinates?.[1]);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    skipped++;
    return;
  }
  // KGISCode can be the shared placeholder ending in 0000 on load-test rows;
  // OBJECTID is the unique row key in the census export.
  const treeId = String(properties.OBJECTID ?? properties.KGISTreeID ?? properties.KGISCode ?? `${latitude},${longitude}`);
  const result = insertTree.run(
    treeId,
    latitude,
    longitude,
    String(properties.TreeName ?? "").trim(),
    String(properties.WardNumber ?? "").trim(),
    Number.isFinite(Number(properties.Status)) ? Number(properties.Status) : null,
  );
  if (result.changes) {
    insertLocation.run(Number(result.lastInsertRowid), longitude, longitude, latitude, latitude);
    imported++;
  }
};
const insertBatch = db.transaction((features) => { for (const feature of features) insertFeature(feature); });

console.log("Streaming census features into the local spatial database…");
const featureObjects = geojsonStream.pipe(parser.asStream()).pipe(pick.asStream({ filter: "features" })).pipe(streamArray.asStream());
let batch = [];
for await (const item of featureObjects) {
  batch.push(item.value);
  if (batch.length >= 5000) { insertBatch(batch); batch = []; }
}
if (batch.length) insertBatch(batch);
zip.close();

db.prepare("INSERT INTO dataset_metadata (key, value) VALUES (?, ?)").run("source", "BBMP Tree Census via OpenCity; July 2026");
db.prepare("INSERT INTO dataset_metadata (key, value) VALUES (?, ?)").run("source_url", "https://data.opencity.in/dataset/bengaluru-tree-census-data");
db.close();
renameSync(temporaryDatabase, databasePath);

console.log(`Imported ${imported.toLocaleString()} trees${skipped ? `; skipped ${skipped.toLocaleString()} invalid records` : ""}.`);
console.log(`Local database: ${databasePath}`);
