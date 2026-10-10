import express, { type NextFunction, type Request, type Response } from "express";
import Database from "better-sqlite3";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const port = Number(process.env.PORT ?? 8787);
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.resolve(here, "../data");
const uploadDirectory = path.resolve(here, "../uploads");
const databasePath = process.env.GREENWARD_DATABASE_PATH ?? path.join(dataDirectory, "trees.sqlite");
mkdirSync(dataDirectory, { recursive: true });
mkdirSync(uploadDirectory, { recursive: true });

const db = existsSync(databasePath) ? new Database(databasePath) : null;
db?.pragma("journal_mode = WAL");
db?.pragma("foreign_keys = ON");

if (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      ward TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      tree_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      claimed_by TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mission_events (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id),
      event TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      photo_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS adoptions (
      tree_id TEXT PRIMARY KEY REFERENCES trees(tree_id) ON DELETE CASCADE,
      volunteer TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS community_trees (
      tree_id TEXT PRIMARY KEY,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      species TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '{}',
      refreshed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS community_adoptions (
      tree_id TEXT PRIMARY KEY,
      volunteer TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

const now = () => new Date().toISOString();
const countTrees = db ? (db.prepare("SELECT COUNT(*) AS count FROM trees").get() as { count: number }).count : 0;
type CommunityFeature = {
  type: "Feature"; id: string;
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { treeId: string; species: string; ward: string; source: "osm"; adopted: boolean };
};
type CommunityResponse = { type: "FeatureCollection"; totalInView: number; status: "ready" | "zoom-in" | "outside-india"; features: CommunityFeature[] };
const communityCache = new Map<string, { expiresAt: number; body: CommunityResponse }>();
const communityInflight = new Map<string, Promise<CommunityResponse>>();
const COMMUNITY_CACHE_MS = 30 * 60_000;
const OVERPASS_DAILY_LIMIT = 750;
let overpassDay = new Date().toISOString().slice(0, 10);
let overpassCallsToday = 0;
let lastOverpassCall = 0;

function updateCommunityAdoptionInCache(treeId: string, adopted: boolean) {
  for (const cached of communityCache.values()) {
    const feature = cached.body.features.find((item) => item.id === treeId);
    if (feature) feature.properties.adopted = adopted;
  }
}

function queryCommunityTrees(bbox: [number, number, number, number]): Promise<CommunityResponse> {
  const [west, south, east, north] = bbox;
  const query = `[out:json][timeout:18];(node["natural"="tree"](${south},${west},${north},${east});way["natural"="tree"](${south},${west},${north},${east}););out center tags 3000;`;
  const endpoints = process.env.GREENWARD_OVERPASS_URL
    ? [process.env.GREENWARD_OVERPASS_URL]
    : ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
  const request = (async () => {
    let payload: { elements?: Array<{ type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }> } | undefined;
    let lastError: Error = new Error("OpenStreetMap tree data is temporarily unavailable");
    for (const endpoint of endpoints) {
      try {
        const upstream = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "User-Agent": "GreenWard/0.1 (local India tree map)" },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(22_000),
        });
        if (!upstream.ok) {
          lastError = new Error(`OpenStreetMap tree data returned ${upstream.status}`);
          if (upstream.status >= 500 || upstream.status === 429) continue;
          throw lastError;
        }
        payload = await upstream.json() as typeof payload;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("OpenStreetMap tree data request failed");
      }
    }
    if (!payload) throw lastError;
    const elements = payload.elements ?? [];
    const features: CommunityFeature[] = [];
    const observedAt = now();
    const save = db?.prepare(`INSERT INTO community_trees (tree_id, latitude, longitude, species, tags_json, refreshed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(tree_id) DO UPDATE SET latitude = excluded.latitude, longitude = excluded.longitude,
      species = excluded.species, tags_json = excluded.tags_json, refreshed_at = excluded.refreshed_at`);
    const persistBatch = db?.transaction((rows: Array<{ id: string; lat: number; lon: number; species: string; tags: Record<string, string> }>) => {
      for (const row of rows) save?.run(row.id, row.lat, row.lon, row.species, JSON.stringify(row.tags), observedAt);
    });
    const rows: Array<{ id: string; lat: number; lon: number; species: string; tags: Record<string, string> }> = [];
    for (const element of elements) {
      const lat = Number(element.center?.lat ?? element.lat);
      const lon = Number(element.center?.lon ?? element.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const tags = element.tags ?? {};
      const id = `osm-${element.type}-${element.id}`;
      const species = tags.species || tags.taxon || tags.genus || "Tree species not tagged";
      rows.push({ id, lat, lon, species, tags });
      features.push({
        type: "Feature", id,
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: { treeId: id, species, ward: "—", source: "osm", adopted: false },
      });
    }
    persistBatch?.(rows);
    if (db && features.length) {
      const adoptedIds = new Set((db.prepare(`SELECT tree_id FROM community_adoptions WHERE tree_id IN (${features.map(() => "?").join(",")})`)
        .all(...features.map((feature) => feature.id)) as Array<{ tree_id: string }>).map((row) => row.tree_id));
      for (const feature of features) feature.properties.adopted = adoptedIds.has(feature.id);
    }
    return { type: "FeatureCollection" as const, totalInView: features.length, status: "ready" as const, features };
  })();
  return request;
}

if (db && countTrees > 0) {
  const missionCount = (db.prepare("SELECT COUNT(*) AS count FROM missions").get() as { count: number }).count;
  if (missionCount === 0) {
    const wards = db.prepare(`
      SELECT ward, AVG(latitude) AS latitude, AVG(longitude) AS longitude, COUNT(*) AS tree_count
      FROM trees WHERE ward <> '' GROUP BY ward HAVING COUNT(*) >= 30
      ORDER BY tree_count DESC LIMIT 12
    `).all() as Array<{ ward: string; latitude: number; longitude: number; tree_count: number }>;
    const insert = db.prepare(`INSERT INTO missions
      (id, title, description, ward, latitude, longitude, tree_count, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`);
    const seedMissions = db.transaction(() => {
      for (const [index, ward] of wards.entries()) {
        const ordinal = String(index + 1).padStart(2, "0");
        insert.run(
          `route-${ordinal}`,
          `Ward ${ward.ward} · tree check`,
          "Walk a short route, inspect visible tree pits and guards, and water only when the soil is dry and rain is not expected.",
          ward.ward,
          ward.latitude,
          ward.longitude,
          ward.tree_count,
          now(),
        );
      }
    });
    seedMissions();
  }
}

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use("/uploads", express.static(uploadDirectory));

app.get("/api/health", (_request, response) => {
  response.json({
    status: "ok",
    service: "greenward-api",
    dataset: db ? { available: true, treeCount: countTrees } : { available: false, treeCount: 0 },
    timestamp: now(),
  });
});

app.get("/api/trees", (request, response) => {
  if (!db) return response.status(503).json({ error: "Tree census is not installed", setup: "npm run data:setup" });
  const bbox = String(request.query.bbox ?? "").split(",").map(Number);
  if (bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value))) {
    return response.status(400).json({ error: "bbox must be west,south,east,north" });
  }
  const [west, south, east, north] = bbox;
  const zoom = Math.max(0, Math.min(22, Number(request.query.zoom) || 12));
  const requestedLimit = Math.round(Number(request.query.limit) || (zoom < 13 ? 12_000 : 24_000));
  const limit = Math.max(500, Math.min(30_000, requestedLimit));
  const matching = db.prepare(`SELECT COUNT(*) AS count FROM tree_index AS location
    JOIN trees ON trees.rowid = location.tree_rowid
    WHERE location.min_latitude <= ? AND location.max_latitude >= ?
      AND location.min_longitude <= ? AND location.max_longitude >= ?
      AND trees.latitude BETWEEN ? AND ? AND trees.longitude BETWEEN ? AND ?`)
    .get(north, south, east, west, south, north, west, east) as { count: number };
  const stride = Math.max(1, Math.ceil(matching.count / limit));
  const rows = db.prepare(`SELECT trees.tree_id, trees.latitude, trees.longitude, trees.species, trees.ward, trees.status,
      EXISTS(SELECT 1 FROM adoptions WHERE adoptions.tree_id = trees.tree_id) AS adopted
    FROM tree_index AS location JOIN trees ON trees.rowid = location.tree_rowid
    WHERE location.min_latitude <= ? AND location.max_latitude >= ?
      AND location.min_longitude <= ? AND location.max_longitude >= ?
      AND trees.latitude BETWEEN ? AND ? AND trees.longitude BETWEEN ? AND ?
      AND (trees.rowid % ?) = 0
    ORDER BY trees.rowid LIMIT ?`).all(north, south, east, west, south, north, west, east, stride, limit) as Array<{
      tree_id: string; latitude: number; longitude: number; species: string; ward: string; status: number | null; adopted: number;
    }>;
  response.json({
    type: "FeatureCollection",
    totalInView: matching.count,
    sampled: rows.length < matching.count,
    features: rows.map((tree) => ({
      type: "Feature",
      id: tree.tree_id,
      geometry: { type: "Point", coordinates: [tree.longitude, tree.latitude] },
      properties: { treeId: tree.tree_id, species: tree.species, ward: tree.ward, status: tree.status, adopted: Boolean(tree.adopted), source: "bbmp" },
    })),
  });
});

app.get("/api/community-trees", async (request, response, next) => {
  const values = String(request.query.bbox ?? "").split(",").map(Number);
  const zoom = Number(request.query.zoom) || 0;
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
    return response.status(400).json({ error: "bbox must be west,south,east,north" });
  }
  let [west, south, east, north] = values;
  if (west < -180 || east > 180 || south < -90 || north > 90 || east <= west || north <= south) {
    return response.status(400).json({ error: "bbox coordinates are out of range" });
  }

  const india = { west: 68, south: 6, east: 98, north: 37 };
  west = Math.max(west, india.west);
  south = Math.max(south, india.south);
  east = Math.min(east, india.east);
  north = Math.min(north, india.north);
  if (east <= west || north <= south) {
    return response.json({ type: "FeatureCollection", totalInView: 0, status: "outside-india", features: [] } satisfies CommunityResponse);
  }
  if (zoom < 13 || (east - west) * (north - south) > 0.12) {
    return response.json({ type: "FeatureCollection", totalInView: 0, status: "zoom-in", features: [] } satisfies CommunityResponse);
  }

  const snapped: [number, number, number, number] = [
    Math.floor(west * 100) / 100, Math.floor(south * 100) / 100,
    Math.ceil(east * 100) / 100, Math.ceil(north * 100) / 100,
  ];
  if ((snapped[2] - snapped[0]) * (snapped[3] - snapped[1]) > 0.12) {
    return response.json({ type: "FeatureCollection", totalInView: 0, status: "zoom-in", features: [] } satisfies CommunityResponse);
  }
  const key = snapped.map((value) => value.toFixed(2)).join(",");
  const cached = communityCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return response.json(cached.body);

  let pending = communityInflight.get(key);
  if (!pending) {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== overpassDay) { overpassDay = today; overpassCallsToday = 0; }
    if (overpassCallsToday >= OVERPASS_DAILY_LIMIT) {
      return response.status(429).json({ error: "The shared OpenStreetMap query budget for today has been reached. Try again tomorrow." });
    }
    if (Date.now() - lastOverpassCall < 1500) {
      response.setHeader("Retry-After", "2");
      return response.status(429).json({ error: "Please wait a moment before loading another map area." });
    }
    overpassCallsToday++;
    lastOverpassCall = Date.now();
    pending = queryCommunityTrees(snapped);
    communityInflight.set(key, pending);
    void pending.then((body) => {
      communityCache.set(key, { expiresAt: Date.now() + COMMUNITY_CACHE_MS, body });
      if (communityCache.size > 250) {
        const oldest = communityCache.keys().next().value;
        if (oldest) communityCache.delete(oldest);
      }
    }).finally(() => communityInflight.delete(key));
  }

  try {
    response.setHeader("Cache-Control", "public, max-age=300");
    response.json(await pending);
  } catch (error) {
    next(error);
  }
});

app.get("/api/trees/:id", (request, response) => {
  if (!db) return response.status(503).json({ error: "Tree census is not installed" });
  if (request.params.id.startsWith("osm-")) {
    const tree = db.prepare(`SELECT community_trees.tree_id AS id, latitude, longitude, species, '' AS ward,
        EXISTS(SELECT 1 FROM community_adoptions WHERE community_adoptions.tree_id = community_trees.tree_id) AS adopted
      FROM community_trees WHERE tree_id = ?`).get(request.params.id);
    if (!tree) return response.status(404).json({ error: "Community tree not found. Reload this map area and try again." });
    return response.json({ ...tree, source: "osm" });
  }
  const tree = db.prepare(`SELECT tree_id AS id, latitude, longitude, species, ward, status,
      EXISTS(SELECT 1 FROM adoptions WHERE adoptions.tree_id = trees.tree_id) AS adopted
    FROM trees WHERE tree_id = ?`).get(request.params.id);
  if (!tree) return response.status(404).json({ error: "Tree not found" });
  response.json(tree);
});

app.post("/api/trees/:id/adoption", (request, response) => {
  if (!db) return response.status(503).json({ error: "Tree census is not installed" });
  const action = request.body?.action;
  if (action !== "adopt" && action !== "release") return response.status(400).json({ error: "action must be adopt or release" });
  if (request.params.id.startsWith("osm-")) {
    const tree = db.prepare("SELECT tree_id FROM community_trees WHERE tree_id = ?").get(request.params.id) as { tree_id: string } | undefined;
    if (!tree) return response.status(404).json({ error: "Community tree not found. Reload this map area and try again." });
    if (action === "adopt") {
      const volunteer = String(request.body?.volunteer ?? "GreenWard neighbour").trim().slice(0, 60) || "GreenWard neighbour";
      db.prepare("INSERT OR IGNORE INTO community_adoptions (tree_id, volunteer, created_at) VALUES (?, ?, ?)")
        .run(tree.tree_id, volunteer, now());
    } else {
      db.prepare("DELETE FROM community_adoptions WHERE tree_id = ?").run(tree.tree_id);
    }
    const adopted = Boolean(db.prepare("SELECT 1 AS adopted FROM community_adoptions WHERE tree_id = ?").get(tree.tree_id));
    updateCommunityAdoptionInCache(tree.tree_id, adopted);
    return response.json({ treeId: tree.tree_id, adopted });
  }
  const tree = db.prepare("SELECT tree_id FROM trees WHERE tree_id = ?").get(request.params.id) as { tree_id: string } | undefined;
  if (!tree) return response.status(404).json({ error: "Tree not found" });
  if (action === "adopt") {
    const volunteer = String(request.body?.volunteer ?? "GreenWard neighbour").trim().slice(0, 60) || "GreenWard neighbour";
    db.prepare("INSERT OR IGNORE INTO adoptions (tree_id, volunteer, created_at) VALUES (?, ?, ?)")
      .run(tree.tree_id, volunteer, now());
  } else {
    db.prepare("DELETE FROM adoptions WHERE tree_id = ?").run(tree.tree_id);
  }
  const adopted = Boolean(db.prepare("SELECT 1 AS adopted FROM adoptions WHERE tree_id = ?").get(tree.tree_id));
  response.json({ treeId: tree.tree_id, adopted });
});

app.get("/api/search", (request, response) => {
  if (!db) return response.json({ trees: [] });
  const query = String(request.query.q ?? "").trim().slice(0, 80);
  if (query.length < 2) return response.json({ trees: [] });
  const escaped = query.replace(/[\\%_]/g, "\\$&");
  const trees = db.prepare(`SELECT tree_id AS id, latitude, longitude, species, ward
    FROM trees WHERE species LIKE ? ESCAPE '\\' OR ward LIKE ? ESCAPE '\\' LIMIT 30`)
    .all(`%${escaped}%`, `%${escaped}%`) as Array<{ id: string; latitude: number; longitude: number; species: string; ward: string }>;
  response.json({ trees: trees.map((tree) => ({ ...tree, source: "bbmp" as const })) });
});

const weatherCache = new Map<string, { expiresAt: number; data: unknown }>();
app.get("/api/weather", async (request, response, next) => {
  try {
    const latitude = Number(request.query.lat ?? 12.9716);
    const longitude = Number(request.query.lng ?? 77.5946);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return response.status(400).json({ error: "lat and lng must be numbers" });
    }
    const cacheKey = `${latitude.toFixed(1)},${longitude.toFixed(1)}`;
    const cached = weatherCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return response.json(cached.data);
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.search = new URLSearchParams({
      latitude: String(latitude), longitude: String(longitude),
      current: "temperature_2m,precipitation,weather_code",
      daily: "precipitation_sum,temperature_2m_max",
      forecast_days: "5", timezone: "Asia/Kolkata",
    }).toString();
    const upstream = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!upstream.ok) throw new Error(`Weather provider returned ${upstream.status}`);
    const data = await upstream.json();
    weatherCache.set(cacheKey, { expiresAt: Date.now() + 15 * 60_000, data });
    if (weatherCache.size > 100) {
      const oldest = weatherCache.keys().next().value;
      if (oldest) weatherCache.delete(oldest);
    }
    response.set("Cache-Control", "public, max-age=300").json(data);
  } catch (error) {
    next(error);
  }
});

app.get("/api/missions", (_request, response) => {
  if (!db) return response.json({ missions: [], available: false });
  const missions = db.prepare(`SELECT id, title, description, ward, latitude, longitude,
      tree_count AS treeCount, status, claimed_by AS claimedBy, completed_at AS completedAt
    FROM missions ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'claimed' THEN 1 ELSE 2 END, tree_count DESC`).all();
  response.json({ missions, available: true });
});

app.post("/api/missions/:id/action", (request, response) => {
  if (!db) return response.status(503).json({ error: "Tree census is not installed" });
  const action = request.body?.action;
  const volunteer = String(request.body?.volunteer ?? "Neighbour").trim().slice(0, 60) || "Neighbour";
  if (action !== "claim" && action !== "complete") return response.status(400).json({ error: "action must be claim or complete" });
  const mission = db.prepare("SELECT id, status FROM missions WHERE id = ?").get(request.params.id) as { id: string; status: string } | undefined;
  if (!mission) return response.status(404).json({ error: "Mission not found" });
  if (action === "claim" && mission.status === "completed") return response.status(409).json({ error: "This mission is already completed" });
  const updated = db.transaction(() => {
    if (action === "claim") {
      db.prepare("UPDATE missions SET status = 'claimed', claimed_by = ? WHERE id = ?").run(volunteer, mission.id);
    } else {
      db.prepare("UPDATE missions SET status = 'completed', claimed_by = ?, completed_at = ? WHERE id = ?")
        .run(volunteer, now(), mission.id);
    }
    db.prepare("INSERT INTO mission_events (id, mission_id, event, created_at) VALUES (?, ?, ?, ?)")
      .run(randomUUID(), mission.id, action, now());
    return db.prepare(`SELECT id, title, description, ward, latitude, longitude,
      tree_count AS treeCount, status, claimed_by AS claimedBy, completed_at AS completedAt
      FROM missions WHERE id = ?`).get(mission.id);
  });
  response.json(updated);
});

const storage = multer.diskStorage({
  destination: (_request, _file, callback) => callback(null, uploadDirectory),
  filename: (_request, file, callback) => {
    const extension = ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" } as Record<string, string>)[file.mimetype];
    callback(null, `${randomUUID()}${extension ?? ".img"}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => callback(null, ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)),
});

app.get("/api/reports", (_request, response) => {
  if (!db) return response.json({ reports: [] });
  const reports = db.prepare(`SELECT id, category, description, latitude, longitude,
      photo_path AS photoPath, status, created_at AS createdAt FROM reports ORDER BY created_at DESC LIMIT 100`).all();
  response.json({ reports });
});

app.post("/api/reports", upload.single("photo"), (request, response) => {
  if (!db) return response.status(503).json({ error: "Tree census is not installed" });
  if (!request.file) return response.status(400).json({ error: "Add a JPG, PNG, or WebP photo up to 8 MB" });
  const category = String(request.body?.category ?? "other");
  const categories = ["damaged", "blocked-root", "tree-guard", "dry-soil", "other"];
  const latitude = Number(request.body?.latitude);
  const longitude = Number(request.body?.longitude);
  const description = String(request.body?.description ?? "").trim().slice(0, 1000);
  if (!categories.includes(category) || !Number.isFinite(latitude) || !Number.isFinite(longitude) || !description) {
    return response.status(400).json({ error: "Choose a report type, enter a note, and share a valid location" });
  }
  const report = {
    id: randomUUID(), category, description, latitude, longitude,
    photoPath: `/uploads/${request.file.filename}`, status: "submitted", createdAt: now(),
  };
  db.prepare(`INSERT INTO reports (id, category, description, latitude, longitude, photo_path, status, created_at)
    VALUES (@id, @category, @description, @latitude, @longitude, @photoPath, @status, @createdAt)`).run(report);
  response.status(201).json(report);
});

app.get("/api/reports/export.csv", (_request, response) => {
  if (!db) return response.status(503).json({ error: "Tree census is not installed" });
  const reports = db.prepare(`SELECT id, category, description, latitude, longitude, status, created_at AS createdAt
    FROM reports ORDER BY created_at DESC`).all() as Array<Record<string, string | number>>;
  const quote = (value: string | number) => `"${String(value).replace(/[\r\n]+/g, " ").replace(/"/g, '""')}"`;
  const rows = ["id,category,description,latitude,longitude,status,created_at", ...reports.map((report) =>
    ["id", "category", "description", "latitude", "longitude", "status", "createdAt"]
      .map((key) => quote(report[key] ?? "")).join(","))];
  response.setHeader("Content-Type", "text/csv; charset=utf-8");
  response.setHeader("Content-Disposition", `attachment; filename="greenward-municipal-reports-${new Date().toISOString().slice(0, 10)}.csv"`);
  response.send(`\uFEFF${rows.join("\n")}`);
});

app.get("/api/impact", (_request, response) => {
  if (!db) return response.json({ treesMapped: 0, adoptedTrees: 0, missionsOpen: 0, missionsClaimed: 0, missionsCompleted: 0, reportsSubmitted: 0 });
  const scalar = (sql: string) => (db.prepare(sql).get() as { count: number }).count;
  response.json({
    treesMapped: countTrees,
    missionsOpen: scalar("SELECT COUNT(*) AS count FROM missions WHERE status = 'open'"),
    missionsClaimed: scalar("SELECT COUNT(*) AS count FROM missions WHERE status = 'claimed'"),
    missionsCompleted: scalar("SELECT COUNT(*) AS count FROM missions WHERE status = 'completed'"),
    reportsSubmitted: scalar("SELECT COUNT(*) AS count FROM reports"),
    adoptedTrees: scalar("SELECT COUNT(*) AS count FROM adoptions") + scalar("SELECT COUNT(*) AS count FROM community_adoptions"),
  });
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : "Unexpected API error";
  const status = message.includes("File too large") ? 413 : 500;
  response.status(status).json({ error: status === 413 ? "Photo is over the 8 MB limit" : message });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`GreenWard API listening on http://localhost:${port}${db ? ` · ${countTrees.toLocaleString()} trees loaded` : " · run npm run data:setup to load trees"}`);
});
