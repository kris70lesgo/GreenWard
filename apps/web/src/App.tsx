import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AttributionControl, Map as MapLibreMap, NavigationControl, type GeoJSONSource } from "maplibre-gl";
import {
  Activity, ArrowRight, ArrowUpRight, BadgeCheck, Box, Camera, ChartNoAxesColumnIncreasing,
  Check, ChevronDown, CircleCheck, ClipboardList, Clock3, CloudRain, Download, Droplets,
  Filter, Flag, Leaf, LocateFixed, LoaderCircle, Map as MapIcon, MapPin, Menu, Plus, Search,
  SlidersHorizontal, TreeDeciduous, Users, X, ZoomIn, ZoomOut,
} from "lucide-react";
import "maplibre-gl/dist/maplibre-gl.css";

type Page = "map" | "missions" | "impact" | "reports";
type Tree = { id: string; latitude: number; longitude: number; species: string; ward: string; status?: number | null; adopted?: boolean; source?: "bbmp" | "osm" };
type Mission = {
  id: string; title: string; description: string; ward: string; latitude: number; longitude: number;
  treeCount: number; status: "open" | "claimed" | "completed"; claimedBy?: string | null; completedAt?: string | null;
};
type Report = {
  id: string; category: string; description: string; latitude: number; longitude: number;
  photoPath: string; status: string; createdAt: string;
};
type Impact = {
  treesMapped: number; adoptedTrees: number; missionsOpen: number; missionsClaimed: number; missionsCompleted: number; reportsSubmitted: number;
};
type Weather = {
  current?: { temperature_2m?: number; precipitation?: number; weather_code?: number };
  daily?: { time?: string[]; precipitation_sum?: number[]; temperature_2m_max?: number[] };
};
type WateringAdvice = {
  category: string; message: string; precipitationTotalMm: number; forecastDays: number;
  hotDays: number; inspectionPriority: "high" | "watch" | "routine" | "rain-watch";
  priorityLabel: string; priorityReason: string; decision: "inspect-before-watering"; engine: string; caveat: string;
};
type TreeCollection = GeoJSON.FeatureCollection<GeoJSON.Point, { treeId: string; species: string; ward: string; status?: number | null; adopted?: boolean; source?: "bbmp" | "osm" }>;
type CommunityCollection = GeoJSON.FeatureCollection<GeoJSON.Point, { treeId: string; species: string; ward: string; source: "osm"; adopted: boolean }> & { totalInView: number; status: "ready" | "zoom-in" | "outside-india" };

const CITY = { latitude: 12.9716, longitude: 77.5946 };
const INDIA_CENTER = { latitude: 20.5937, longitude: 78.9629 };
const isBengaluru = ({ latitude, longitude }: { latitude: number; longitude: number }) => latitude >= 12.65 && latitude <= 13.35 && longitude >= 77.15 && longitude <= 78.05;
const number = new Intl.NumberFormat("en-IN");
const navItems: Array<{ id: Page; label: string; icon: typeof MapIcon }> = [
  { id: "map", label: "Tree map", icon: MapIcon },
  { id: "missions", label: "Missions", icon: ClipboardList },
  { id: "impact", label: "Impact", icon: ChartNoAxesColumnIncreasing },
  { id: "reports", label: "Reports", icon: Flag },
];

const pageCopy: Record<Page, { eyebrow: string; title: string; description: string }> = {
  map: { eyebrow: "BENGALURU · FIELD VIEW", title: "Trees, cared for together.", description: "Explore the BBMP tree census, find a route, and check local rain before you water." },
  missions: { eyebrow: "NEIGHBOURHOOD ACTION", title: "Small walks. Real care.", description: "Pick a nearby inspection route. Check the tree pits and guards, and only water when conditions call for it." },
  impact: { eyebrow: "COMMUNITY OUTCOMES", title: "Every action adds up.", description: "A transparent record of mapped trees, volunteer routes, and observations shared with the community." },
  reports: { eyebrow: "FIELD OBSERVATIONS", title: "See something? Share it.", description: "Photo reports help neighbours and local teams find damaged trees, blocked roots, and care needs." },
};
const indiaMapCopy = {
  eyebrow: "INDIA · COMMUNITY TREE MAP",
  title: "Trees, found across India.",
  description: "Explore community-mapped trees where OpenStreetMap contributors have recorded them. Coverage varies; the verified BBMP census is available in Bengaluru.",
};

function asJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<T>;
}

function MapCanvas({
  missions, reports, onSelectTree, onSelectMission, onCenterChange, visibleTrees, visibleMissions, visibleReports,
}: {
  missions: Mission[]; reports: Report[]; onSelectTree: (tree: Tree) => void;
  onSelectMission: (mission: Mission) => void; onCenterChange: (center: { latitude: number; longitude: number }) => void;
  visibleTrees: boolean; visibleMissions: boolean; visibleReports: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [initialView] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const latitude = Number(params.get("lat"));
    const longitude = Number(params.get("lng"));
    const requestedZoom = Number(params.get("zoom"));
    if (latitude >= 6 && latitude <= 37 && longitude >= 68 && longitude <= 98 && requestedZoom >= 3 && requestedZoom <= 20) {
      return { center: { latitude, longitude }, zoom: requestedZoom };
    }
    return { center: CITY, zoom: 12.4 };
  });
  const treesRequestRef = useRef<AbortController | null>(null);
  const communityTreesRequestRef = useRef<AbortController | null>(null);
  const onSelectTreeRef = useRef(onSelectTree);
  const onSelectMissionRef = useRef(onSelectMission);
  const onCenterChangeRef = useRef(onCenterChange);
  const communityTreesUpdaterRef = useRef<() => void>(() => undefined);
  const missionsRef = useRef(missions);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState("");
  const [treeCount, setTreeCount] = useState(0);
  const [communityTreeCount, setCommunityTreeCount] = useState(0);
  const [communityTreeStatus, setCommunityTreeStatus] = useState<"idle" | "loading" | "ready" | "zoom-in" | "outside-india" | "unavailable">("idle");
  const [zoom, setZoom] = useState(initialView.zoom);
  const [mapCenter, setMapCenter] = useState(initialView.center);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Tree[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [is3d, setIs3d] = useState(false);
  const communityRequestKeyRef = useRef("");

  useEffect(() => { onSelectTreeRef.current = onSelectTree; }, [onSelectTree]);
  useEffect(() => { onSelectMissionRef.current = onSelectMission; }, [onSelectMission]);
  useEffect(() => { onCenterChangeRef.current = onCenterChange; }, [onCenterChange]);
  useEffect(() => { missionsRef.current = missions; }, [missions]);

  const updateTrees = useCallback(async () => {
    const map = mapRef.current;
    if (!map || !map.getSource("trees")) return;
    const bounds = map.getBounds();
    const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(",");
    treesRequestRef.current?.abort();
    const controller = new AbortController();
    treesRequestRef.current = controller;
    try {
      const collection = await fetch(`/api/trees?bbox=${encodeURIComponent(bbox)}&zoom=${map.getZoom().toFixed(1)}`, { signal: controller.signal })
        .then(asJson<TreeCollection & { totalInView: number; sampled: boolean }>);
      const source = map.getSource("trees") as GeoJSONSource | undefined;
      source?.setData(collection);
      setTreeCount(collection.totalInView);
      setMapError("");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (error instanceof Error && error.message.includes("503")) setMapError("Tree census is not installed yet. Run npm run data:setup in the project folder.");
      else setMapError(error instanceof Error ? error.message : "Could not load trees");
    }
  }, []);

  const updateCommunityTrees = useCallback(async () => {
    const map = mapRef.current;
    const source = map?.getSource("community-trees") as GeoJSONSource | undefined;
    if (!map || !source) return;
    const mapZoom = map.getZoom();
    if (mapZoom < 13 || !visibleTrees) {
      communityTreesRequestRef.current?.abort();
      communityRequestKeyRef.current = "";
      source.setData({ type: "FeatureCollection", features: [] });
      setCommunityTreeCount(0);
      setCommunityTreeStatus(visibleTrees ? "zoom-in" : "idle");
      return;
    }
    const bounds = map.getBounds();
    const bboxValues = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
    const requestKey = bboxValues.map((value) => value.toFixed(2)).join(",");
    if (communityRequestKeyRef.current === requestKey && communityTreeStatus === "ready") return;
    communityTreesRequestRef.current?.abort();
    const controller = new AbortController();
    communityTreesRequestRef.current = controller;
    communityRequestKeyRef.current = requestKey;
    source.setData({ type: "FeatureCollection", features: [] });
    setCommunityTreeStatus("loading");
    try {
      const collection = await fetch(`/api/community-trees?bbox=${encodeURIComponent(bboxValues.join(","))}&zoom=${mapZoom.toFixed(1)}`, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) {
            const body = await response.json().catch(() => ({})) as { error?: string };
            throw new Error(body.error ?? `Community map request failed (${response.status})`);
          }
          return response.json() as Promise<CommunityCollection>;
        });
      const currentSource = map.getSource("community-trees") as GeoJSONSource | undefined;
      currentSource?.setData(collection);
      setCommunityTreeCount(collection.totalInView);
      setCommunityTreeStatus(collection.status);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      communityRequestKeyRef.current = "";
      setCommunityTreeCount(0);
      setCommunityTreeStatus("unavailable");
    }
  }, [communityTreeStatus, visibleTrees]);

  useEffect(() => { communityTreesUpdaterRef.current = () => { void updateCommunityTrees(); }; }, [updateCommunityTrees]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new MapLibreMap({
      container: containerRef.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [initialView.center.longitude, initialView.center.latitude],
      zoom: initialView.zoom,
      pitch: 48,
      bearing: -14,
      maxPitch: 62,
      attributionControl: false,
      cooperativeGestures: true,
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new AttributionControl({ compact: true }), "bottom-right");

    map.on("load", () => {
      map.addSource("greenward-openfreemap", { type: "vector", url: "https://tiles.openfreemap.org/planet" });
      const firstLabelLayer = map.getStyle().layers.find((layer) => layer.type === "symbol" && Boolean(layer.layout?.["text-field"]))?.id;
      map.addLayer({
        id: "buildings-3d", source: "greenward-openfreemap", "source-layer": "building",
        type: "fill-extrusion", minzoom: 15, filter: ["!=", ["get", "hide_3d"], true],
        paint: {
          "fill-extrusion-color": ["interpolate", ["linear"], ["get", "render_height"], 0, "#e6e1d2", 80, "#c8d7c7", 240, "#93b09b"],
          "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 15, 0, 16, ["get", "render_height"]],
          "fill-extrusion-base": ["interpolate", ["linear"], ["zoom"], 15, 0, 16, ["get", "render_min_height"]],
          "fill-extrusion-opacity": 0.88,
        },
      }, firstLabelLayer);
      map.addSource("trees", { type: "geojson", data: { type: "FeatureCollection", features: [] }, cluster: true, clusterRadius: 40, clusterMaxZoom: 15 });
      map.addLayer({
        id: "tree-clusters", type: "circle", source: "trees", filter: ["has", "point_count"],
        paint: {
          "circle-color": ["step", ["get", "point_count"], "#4b9669", 30, "#d58d42", 100, "#bb5c48"],
          "circle-radius": ["step", ["get", "point_count"], 16, 30, 21, 100, 27],
          "circle-stroke-color": "#ffffff", "circle-stroke-width": 2.5, "circle-opacity": 0.95,
        },
      });
      map.addLayer({
        id: "tree-cluster-count", type: "symbol", source: "trees", filter: ["has", "point_count"],
        layout: { "text-field": "{point_count_abbreviated}", "text-font": ["Open Sans Semibold", "Arial Unicode MS Bold"], "text-size": 11 },
        paint: { "text-color": "#ffffff" },
      });
      map.addLayer({
        id: "tree-points", type: "circle", source: "trees", filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 3.2, 17, 6],
          "circle-color": ["case", ["boolean", ["get", "adopted"], false], "#c48642", "#24734f"], "circle-stroke-color": "#f8fff6", "circle-stroke-width": 1.2,
          "circle-opacity": 0.88,
        },
      });
      map.addSource("community-trees", { type: "geojson", data: { type: "FeatureCollection", features: [] }, cluster: true, clusterRadius: 38, clusterMaxZoom: 15 });
      map.addLayer({
        id: "community-tree-clusters", type: "circle", source: "community-trees", filter: ["has", "point_count"],
        paint: {
          "circle-color": ["step", ["get", "point_count"], "#557fa0", 30, "#5474a1", 100, "#6a678f"],
          "circle-radius": ["step", ["get", "point_count"], 14, 30, 19, 100, 24],
          "circle-stroke-color": "#ffffff", "circle-stroke-width": 2, "circle-opacity": 0.92,
        },
      });
      map.addLayer({
        id: "community-tree-cluster-count", type: "symbol", source: "community-trees", filter: ["has", "point_count"],
        layout: { "text-field": "{point_count_abbreviated}", "text-font": ["Open Sans Semibold", "Arial Unicode MS Bold"], "text-size": 10 },
        paint: { "text-color": "#ffffff" },
      });
      map.addLayer({
        id: "community-tree-points", type: "circle", source: "community-trees", filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 4, 18, 7],
          "circle-color": ["case", ["boolean", ["get", "adopted"], false], "#c48642", "#557fa0"],
          "circle-stroke-color": "#f8fff6", "circle-stroke-width": 1.5, "circle-opacity": 0.93,
        },
      });
      map.addSource("missions", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "mission-points", type: "circle", source: "missions",
        paint: { "circle-radius": 9, "circle-color": ["match", ["get", "status"], "completed", "#518467", "claimed", "#d09b55", "#d77b3f"], "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 },
      });
      map.addLayer({
        id: "mission-symbol", type: "symbol", source: "missions",
        layout: { "text-field": "M", "text-font": ["Open Sans Semibold", "Arial Unicode MS Bold"], "text-size": 9 },
        paint: { "text-color": "#fff" },
      });
      map.addSource("reports", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "report-points", type: "circle", source: "reports",
        paint: { "circle-radius": 7, "circle-color": "#bd5a50", "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
      });
      setMapReady(true);
      const center = map.getCenter();
      onCenterChangeRef.current({ latitude: center.lat, longitude: center.lng });
      void updateTrees();
      void updateCommunityTrees();
    });

    map.on("moveend", () => {
      setZoom(map.getZoom());
      const center = map.getCenter();
      const params = new URLSearchParams({ lat: center.lat.toFixed(6), lng: center.lng.toFixed(6), zoom: map.getZoom().toFixed(1), lang: "en" });
      window.history.replaceState({}, "", `/map?${params.toString()}`);
      const nextCenter = { latitude: center.lat, longitude: center.lng };
      setMapCenter(nextCenter);
      onCenterChangeRef.current(nextCenter);
      void updateTrees();
      communityTreesUpdaterRef.current();
    });
    map.on("click", "tree-clusters", (event) => {
      const feature = map.queryRenderedFeatures(event.point, { layers: ["tree-clusters"] })[0];
      const clusterId = feature?.properties?.cluster_id;
      const source = map.getSource("trees") as GeoJSONSource | undefined;
      if (typeof clusterId === "number" && source) {
        void source.getClusterExpansionZoom(clusterId).then((nextZoom) => {
          if (feature.geometry.type === "Point") map.easeTo({ center: feature.geometry.coordinates as [number, number], zoom: nextZoom + 0.25, duration: 450 });
        }).catch(() => undefined);
      }
    });
    map.on("click", "community-tree-clusters", (event) => {
      const feature = map.queryRenderedFeatures(event.point, { layers: ["community-tree-clusters"] })[0];
      const clusterId = feature?.properties?.cluster_id;
      const source = map.getSource("community-trees") as GeoJSONSource | undefined;
      if (typeof clusterId === "number" && source) {
        void source.getClusterExpansionZoom(clusterId).then((nextZoom) => {
          if (feature.geometry.type === "Point") map.easeTo({ center: feature.geometry.coordinates as [number, number], zoom: nextZoom + 0.25, duration: 450 });
        }).catch(() => undefined);
      }
    });
    map.on("click", "tree-points", (event) => {
      const feature = map.queryRenderedFeatures(event.point, { layers: ["tree-points"] })[0];
      if (!feature || feature.geometry.type !== "Point") return;
      const [longitude, latitude] = feature.geometry.coordinates;
      onSelectTreeRef.current({
        id: String(feature.properties?.treeId ?? feature.id ?? ""),
        latitude, longitude,
        species: String(feature.properties?.species ?? "Species not recorded"),
        ward: String(feature.properties?.ward ?? "—"),
        status: Number(feature.properties?.status) || null,
        adopted: Boolean(feature.properties?.adopted),
        source: "bbmp",
      });
    });
    map.on("click", "community-tree-points", (event) => {
      const feature = map.queryRenderedFeatures(event.point, { layers: ["community-tree-points"] })[0];
      if (!feature || feature.geometry.type !== "Point") return;
      const [longitude, latitude] = feature.geometry.coordinates;
      onSelectTreeRef.current({
        id: String(feature.properties?.treeId ?? feature.id ?? ""), latitude, longitude,
        species: String(feature.properties?.species ?? "Tree species not tagged"), ward: "—",
        adopted: Boolean(feature.properties?.adopted), source: "osm",
      });
    });
    map.on("click", "mission-points", (event) => {
      const feature = map.queryRenderedFeatures(event.point, { layers: ["mission-points"] })[0];
      const id = String(feature?.properties?.id ?? "");
      const selected = missionsRef.current.find((mission) => mission.id === id);
      if (selected) onSelectMissionRef.current(selected);
    });
    map.on("mouseenter", "tree-points", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "tree-points", () => { map.getCanvas().style.cursor = ""; });
    map.on("mouseenter", "community-tree-points", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "community-tree-points", () => { map.getCanvas().style.cursor = ""; });
    for (const layer of ["tree-clusters", "community-tree-clusters"]) {
      map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
    }
    map.on("error", (event) => {
      const message = event.error?.message ?? "";
      if (message.toLowerCase().includes("style") || message.toLowerCase().includes("tile")) setMapError("Map tiles could not load. Check your connection and reload the map.");
    });

    const refreshTreeLayer = () => {
      void updateTrees();
      communityRequestKeyRef.current = "";
      communityTreesUpdaterRef.current();
    };
    const focusBengaluru = () => map.easeTo({ center: [CITY.longitude, CITY.latitude], zoom: 12.4, pitch: 48, bearing: -14, duration: 1000 });
    document.addEventListener("greenward:refresh-trees", refreshTreeLayer);
    document.addEventListener("greenward:focus-bengaluru", focusBengaluru);

    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);
    return () => {
      treesRequestRef.current?.abort();
      communityTreesRequestRef.current?.abort();
      document.removeEventListener("greenward:refresh-trees", refreshTreeLayer);
      document.removeEventListener("greenward:focus-bengaluru", focusBengaluru);
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, [updateTrees]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const treeSource = map.getSource("trees") as GeoJSONSource | undefined;
    const communityTreeSource = map.getSource("community-trees") as GeoJSONSource | undefined;
    const missionSource = map.getSource("missions") as GeoJSONSource | undefined;
    const reportSource = map.getSource("reports") as GeoJSONSource | undefined;
    if (missionSource) missionSource.setData({
      type: "FeatureCollection",
      features: missions.map((mission) => ({
        type: "Feature" as const, id: mission.id,
        geometry: { type: "Point" as const, coordinates: [mission.longitude, mission.latitude] },
        properties: { id: mission.id, status: mission.status },
      })),
    });
    if (reportSource) reportSource.setData({
      type: "FeatureCollection",
      features: reports.map((report) => ({
        type: "Feature" as const, id: report.id,
        geometry: { type: "Point" as const, coordinates: [report.longitude, report.latitude] },
        properties: { id: report.id, category: report.category },
      })),
    });
    if (treeSource) treeSource.setData({ type: "FeatureCollection", features: [] });
    if (communityTreeSource && !visibleTrees) communityTreeSource.setData({ type: "FeatureCollection", features: [] });
    if (map.getLayer("buildings-3d")) map.setLayoutProperty("buildings-3d", "visibility", is3d ? "visible" : "none");
    for (const layer of ["tree-points", "tree-clusters", "tree-cluster-count", "community-tree-points", "community-tree-clusters", "community-tree-cluster-count"]) if (map.getLayer(layer)) map.setLayoutProperty(layer, "visibility", visibleTrees ? "visible" : "none");
    for (const layer of ["mission-points", "mission-symbol"]) if (map.getLayer(layer)) map.setLayoutProperty(layer, "visibility", visibleMissions ? "visible" : "none");
    if (map.getLayer("report-points")) map.setLayoutProperty("report-points", "visibility", visibleReports ? "visible" : "none");
    if (visibleTrees && mapReady) void updateTrees();
    communityTreesUpdaterRef.current();
  }, [missions, reports, visibleTrees, visibleMissions, visibleReports, mapReady, updateTrees, is3d]);

  useEffect(() => {
    const timeout = window.setTimeout(async () => {
      if (query.trim().length < 2) { setResults([]); return; }
      setSearchBusy(true);
      try {
        const data = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`).then(asJson<{ trees: Tree[] }>);
        setResults(data.trees);
      } catch { setResults([]); }
      finally { setSearchBusy(false); }
    }, 260);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const chooseSearchResult = (tree: Tree) => {
    mapRef.current?.flyTo({ center: [tree.longitude, tree.latitude], zoom: 17, pitch: 55, duration: 1100 });
    onSelectTree(tree);
    setSearchOpen(false);
    setQuery(tree.species || `Ward ${tree.ward}`);
  };

  const locateMe = () => {
    setLocationError("");
    if (!navigator.geolocation) { setLocationError("Location is not available in this browser."); return; }
    navigator.geolocation.getCurrentPosition(
      (position) => mapRef.current?.flyTo({ center: [position.coords.longitude, position.coords.latitude], zoom: 16, pitch: 52, duration: 1100 }),
      () => setLocationError("Location permission was not granted."),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  const inBengaluruView = isBengaluru(mapCenter);
  const switchMapScope = () => {
    const map = mapRef.current;
    if (!map) return;
    if (inBengaluruView) map.easeTo({ center: [INDIA_CENTER.longitude, INDIA_CENTER.latitude], zoom: 3, pitch: 0, duration: 1000 });
    else map.easeTo({ center: [CITY.longitude, CITY.latitude], zoom: 12.4, pitch: 48, bearing: -14, duration: 1000 });
  };
  const communityFootnote = communityTreeStatus === "loading" ? "Loading community points…"
    : communityTreeStatus === "zoom-in" ? "Zoom in to street level for tree points"
      : communityTreeStatus === "unavailable" ? "Community layer is temporarily unavailable"
        : communityTreeStatus === "outside-india" ? "Pan back to India to explore community tree points"
          : communityTreeStatus === "ready" && communityTreeCount === 0 ? "No tree points are mapped in this area yet"
            : "OpenStreetMap · coverage varies by area";
  const communityStatusLabel = communityTreeStatus === "loading" ? "OSM LOADING"
    : communityTreeStatus === "unavailable" ? "OSM OFFLINE"
      : communityTreeStatus === "zoom-in" ? "ZOOM IN"
        : communityTreeStatus === "outside-india" ? "OUTSIDE INDIA"
          : "OSM DATA";
  const cityDataFootnote = communityTreeStatus === "ready"
    ? `July 2026 · ${communityTreeCount.toLocaleString("en-IN")} OSM points`
    : communityTreeStatus === "loading" ? "July 2026 census · OSM loading"
      : communityTreeStatus === "unavailable" ? "July 2026 · OSM temporarily offline"
        : "July 2026 census · zoom in for OSM trees";

  return (
    <section className="map-frame" aria-label="Interactive India community tree map">
      <div ref={containerRef} className="map-canvas" />
      <div className="map-search-wrap">
        <div className="map-search">
          <Search size={17} aria-hidden="true" />
          <input aria-label="Search Bengaluru tree species or ward" placeholder="Search Bengaluru species or ward" value={query}
            onChange={(event) => { setQuery(event.target.value); setSearchOpen(true); }}
            onFocus={() => setSearchOpen(true)} onKeyDown={(event) => { if (event.key === "Escape") setSearchOpen(false); }} />
          {searchBusy && <LoaderCircle className="spin" size={16} />}
          {query && <button className="icon-button search-clear" aria-label="Clear search" onClick={() => { setQuery(""); setResults([]); }}><X size={14} /></button>}
        </div>
        {searchOpen && query.trim().length >= 2 && <div className="search-results">
          {results.length ? results.slice(0, 8).map((tree) => <button key={tree.id} className="search-result" onClick={() => chooseSearchResult(tree)}>
            <span className="result-tree-icon"><TreeDeciduous size={16} /></span><span><strong>{tree.species || "Unknown species"}</strong><small>Ward {tree.ward} · BBMP census</small></span><ArrowUpRight size={15} />
          </button>) : <p className="search-empty">{searchBusy ? "Searching the city census…" : "No matching trees found."}</p>}
        </div>}
      </div>

      <button className="map-top-pill" title={inBengaluruView ? "Show India overview" : "Return to Bengaluru census"} onClick={switchMapScope}>
        <span className="live-dot" /> {inBengaluruView ? "Explore India" : "Bengaluru census"} <ChevronDown size={14} />
      </button>
      <div className="map-actions">
        <button className="map-action" aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn({ duration: 250 })}><ZoomIn size={17} /></button>
        <button className="map-action" aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut({ duration: 250 })}><ZoomOut size={17} /></button>
        <button className={`map-action ${is3d ? "map-action-active" : ""}`} aria-label={is3d ? "Turn off 3D buildings" : "Turn on 3D buildings"} title="3D buildings" onClick={() => {
          const next = !is3d;
          setIs3d(next);
          const map = mapRef.current;
          if (map) map.easeTo({ pitch: next ? 55 : 26, zoom: next ? Math.max(15.5, map.getZoom()) : map.getZoom(), duration: 850 });
        }}><Box size={16} /></button>
        <button className="map-action" aria-label="Use my location" onClick={locateMe}><LocateFixed size={16} /></button>
      </div>
      {locationError && <div className="map-error location-error">{locationError}</div>}

      <div className="map-data-card">
        <div className="data-card-top"><span className="data-card-icon"><TreeDeciduous size={17} /></span><span className="data-card-label">{inBengaluruView ? "BBMP TREE CENSUS" : "OSM COMMUNITY TREES"}</span><span className="data-card-status">● {communityStatusLabel}</span></div>
        <strong>{communityTreeStatus === "outside-india" ? "Outside India" : communityTreeStatus === "zoom-in" && !inBengaluruView ? "Zoom in" : number.format(inBengaluruView ? treeCount : communityTreeCount)} <span>{communityTreeStatus === "outside-india" ? "India tree coverage is shown here" : communityTreeStatus === "zoom-in" && !inBengaluruView ? "to street level" : inBengaluruView ? "verified trees in view" : "community points loaded"}</span></strong>
        <div className="data-card-foot"><span>{inBengaluruView ? cityDataFootnote : communityFootnote}</span><span>Zoom {zoom.toFixed(1)}</span></div>
      </div>

      <div className="map-legend">
        <div className="legend-heading"><span>MAP LAYERS</span><SlidersHorizontal size={14} /></div>
        <label><input type="checkbox" checked={visibleTrees} onChange={(event) => mapRef.current?.getSource("trees") && document.dispatchEvent(new CustomEvent("greenward:layer", { detail: { layer: "trees", value: event.target.checked } }))} /><i className="legend-dot tree-dot" /> Trees <span>{visibleTrees ? "On" : "Off"}</span></label>
        <label><input type="checkbox" checked={visibleMissions} onChange={(event) => document.dispatchEvent(new CustomEvent("greenward:layer", { detail: { layer: "missions", value: event.target.checked } }))} /><i className="legend-dot mission-dot" /> Care routes <span>{visibleMissions ? "On" : "Off"}</span></label>
        <label><input type="checkbox" checked={visibleReports} onChange={(event) => document.dispatchEvent(new CustomEvent("greenward:layer", { detail: { layer: "reports", value: event.target.checked } }))} /><i className="legend-dot report-dot" /> Reports <span>{visibleReports ? "On" : "Off"}</span></label>
        <div className="legend-note"><span className="legend-line" /> Verified BBMP census</div>
        <div className="legend-note community-legend-note"><span className="community-legend-dot" /> OpenStreetMap tree · coverage varies</div>
      </div>
      {mapError && <div className="map-error"><strong>Map data unavailable</strong><span>{mapError}</span></div>}
      {!mapReady && !mapError && <div className="map-loading"><LoaderCircle className="spin" size={18} /> Preparing the India map…</div>}
    </section>
  );
}

function App() {
  const [page, setPage] = useState<Page>("map");
  const [health, setHealth] = useState<{ dataset: { available: boolean; treeCount: number } } | null>(null);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [impact, setImpact] = useState<Impact>({ treesMapped: 0, adoptedTrees: 0, missionsOpen: 0, missionsClaimed: 0, missionsCompleted: 0, reportsSubmitted: 0 });
  const [weather, setWeather] = useState<Weather | null>(null);
  const [weatherError, setWeatherError] = useState(false);
  const [wateringAdvice, setWateringAdvice] = useState<WateringAdvice | null>(null);
  const [samAdviceState, setSamAdviceState] = useState<"idle" | "loading" | "ready">("idle");
  const [mapCenter, setMapCenter] = useState(CITY);
  const [selectedTree, setSelectedTree] = useState<Tree | null>(null);
  const [selectedMission, setSelectedMission] = useState<Mission | null>(null);
  const [reportCoordinates, setReportCoordinates] = useState<{ latitude: number; longitude: number }>(CITY);
  const [visibleTrees, setVisibleTrees] = useState(true);
  const [visibleMissions, setVisibleMissions] = useState(true);
  const [visibleReports, setVisibleReports] = useState(true);
  const [isReportOpen, setIsReportOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [busyMission, setBusyMission] = useState("");
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);

  const refresh = useCallback(async () => {
    const [healthData, missionData, reportData, impactData] = await Promise.all([
      fetch("/api/health").then(asJson<typeof health>).catch(() => null),
      fetch("/api/missions").then(asJson<{ missions: Mission[] }>).catch(() => ({ missions: [] })),
      fetch("/api/reports").then(asJson<{ reports: Report[] }>).catch(() => ({ reports: [] })),
      fetch("/api/impact").then(asJson<Impact>).catch(() => null),
    ]);
    setHealth(healthData);
    setMissions(missionData.missions);
    setReports(reportData.reports);
    if (impactData) setImpact(impactData);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setWeatherError(false);
      setWateringAdvice(null);
      fetch(`/api/weather?lat=${mapCenter.latitude}&lng=${mapCenter.longitude}`, { signal: controller.signal })
        .then(asJson<Weather>)
        .then(setWeather)
        .catch((error) => { if (!(error instanceof DOMException && error.name === "AbortError")) setWeatherError(true); });
    }, 850);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [mapCenter]);

  useEffect(() => {
    const dailyPrecipitationMm = weather?.daily?.precipitation_sum;
    if (!dailyPrecipitationMm?.length) { setWateringAdvice(null); setSamAdviceState("idle"); return; }
    const controller = new AbortController();
    let attempts = 0;
    setSamAdviceState("loading");
    const requestAdvice = () => {
      fetch("/sam-api/watering-advice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dailyPrecipitationMm, dailyMaxTemperatureC: weather?.daily?.temperature_2m_max }),
        signal: controller.signal,
      })
        .then(asJson<WateringAdvice>)
        .then((advice) => { setWateringAdvice(advice); setSamAdviceState("ready"); })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (attempts < 4) {
            attempts += 1;
            window.setTimeout(() => { if (!controller.signal.aborted) requestAdvice(); }, attempts * 600);
            return;
          }
          setWateringAdvice(null);
          setSamAdviceState("idle");
        });
    };
    requestAdvice();
    return () => controller.abort();
  }, [weather]);

  useEffect(() => {
    const handleLayer = (event: Event) => {
      const detail = (event as CustomEvent<{ layer: string; value: boolean }>).detail;
      if (detail.layer === "trees") setVisibleTrees(detail.value);
      if (detail.layer === "missions") setVisibleMissions(detail.value);
      if (detail.layer === "reports") setVisibleReports(detail.value);
    };
    document.addEventListener("greenward:layer", handleLayer);
    return () => document.removeEventListener("greenward:layer", handleLayer);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const rainTotal = useMemo(() => weather?.daily?.precipitation_sum?.reduce((sum, value) => sum + (value || 0), 0), [weather]);
  const forecastMessage = wateringAdvice?.message ?? (rainTotal === undefined ? "Check the local forecast before watering." : rainTotal >= 10
    ? "Rain is expected this week. Let the soil guide your next watering."
    : rainTotal <= 2 ? "Little rain is forecast. Check soil moisture before planning a watering route."
      : "Some rain is forecast. Check the soil and near-term forecast before watering.");
  const inBengaluruView = isBengaluru(mapCenter);
  const header = page === "map" && !inBengaluruView ? indiaMapCopy : pageCopy[page];
  const forecastLocation = inBengaluruView ? "Bengaluru area" : `Map center · ${mapCenter.latitude.toFixed(2)}, ${mapCenter.longitude.toFixed(2)}`;

  const performMissionAction = async (mission: Mission, action: "claim" | "complete") => {
    setBusyMission(mission.id);
    try {
      const updated = await fetch(`/api/missions/${mission.id}/action`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, volunteer: "GreenWard neighbour" }),
      }).then(asJson<Mission>);
      setMissions((current) => current.map((item) => item.id === updated.id ? updated : item));
      setSelectedMission(updated);
      setToast(action === "claim" ? "Route added to your field list." : "Mission logged. Thanks for showing up.");
      await refresh();
    } catch (error) { setToast(error instanceof Error ? error.message : "Could not save this mission."); }
    finally { setBusyMission(""); }
  };

  const openReport = (tree?: Tree) => {
    if (tree && Number.isFinite(tree.latitude) && Number.isFinite(tree.longitude)) setReportCoordinates({ latitude: tree.latitude, longitude: tree.longitude });
    else setReportCoordinates(mapCenter);
    setSelectedTree(null); setSelectedMission(null); setIsReportOpen(true);
  };

  const submitReport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    try {
      const response = await fetch("/api/reports", { method: "POST", body: formData });
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        throw new Error(body.error ?? "Could not submit report");
      }
      setIsReportOpen(false);
      setToast("Observation saved. It is ready to share with the local team.");
      await refresh();
    } catch (error) { setToast(error instanceof Error ? error.message : "Could not submit report"); }
  };

  const downloadMunicipalReport = () => { window.location.href = "/api/reports/export.csv"; };
  const closeDetail = () => { setSelectedTree(null); setSelectedMission(null); };

  return (
    <div className="app-shell">
      <aside className={`side-rail ${isMobileNavOpen ? "nav-open" : ""}`}>
        <a className="brand" href="#map" onClick={(event) => { event.preventDefault(); setPage("map"); }}>
          <span className="brand-mark"><Leaf size={19} strokeWidth={2.5} /></span>
          <span className="brand-word">green<span>ward</span><small>COMMUNITY TREE CARE</small></span>
        </a>
        <button className="nav-mobile-close" aria-label="Close navigation" onClick={() => setIsMobileNavOpen(false)}><X size={19} /></button>
        <div className="city-selector"><span className="city-avatar">{inBengaluruView ? "BLR" : "IN"}</span><span><strong>{inBengaluruView ? "Bengaluru" : "Across India"}</strong><small>{inBengaluruView ? "Karnataka, India" : "Community tree map"}</small></span><ChevronDown size={15} /></div>
        <p className="nav-label">YOUR WORKSPACE</p>
        <nav className="primary-nav" aria-label="Main navigation">
          {navItems.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? "active" : ""}`} onClick={() => { setPage(id); setIsMobileNavOpen(false); closeDetail(); }}>
            <Icon size={18} strokeWidth={1.8} /><span>{label}</span>{id === "missions" && missions.some((mission) => mission.status === "open") && <i className="nav-count">{missions.filter((mission) => mission.status === "open").length}</i>}
          </button>)}
        </nav>
        <div className="rail-spacer" />
        <div className="side-weather">
          <div className="side-weather-top"><span><CloudRain size={15} /> THIS WEEK</span><span className="weather-refresh">{weather ? "FORECAST" : "LIVE"}</span></div>
          <p>{rainTotal === undefined ? (weatherError ? "Forecast unavailable" : "Checking forecast…") : `${rainTotal.toFixed(rainTotal % 1 ? 1 : 0)} mm expected`}</p>
          <small>{rainTotal === undefined ? forecastLocation : rainTotal >= 10 ? "Rain may cover watering needs" : "Check soil before you water"}</small>
          <div className="rain-track"><i style={{ width: `${Math.min(100, Math.max(4, (rainTotal ?? 0) * 3))}%` }} /></div>
        </div>
        <div className="profile-card"><span className="profile-avatar">G</span><span><strong>Community mode</strong><small>Activity saved locally</small></span><ChevronDown size={15} /></div>
        <div className="rail-foot"><span>Made for greener neighbourhoods</span><span>GreenWard · India</span></div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button className="mobile-menu" aria-label="Open navigation" onClick={() => setIsMobileNavOpen(true)}><Menu size={21} /></button>
          <div className="breadcrumb"><span>GreenWard</span><span>/</span><strong>{navItems.find((item) => item.id === page)?.label}</strong></div>
          <div className="topbar-right">
            <div className={`connection-status ${health?.dataset?.available ? "is-online" : ""}`}><span />{health?.dataset?.available ? "Census connected" : health ? "Census setup needed" : "Connecting"}</div>
            <span className="topbar-divider" />
            <button className="avatar-button" aria-label="Community profile">G</button>
          </div>
        </header>

        <div className={`page-content ${page === "map" ? "map-page" : ""}`}>
          <section className="page-heading">
            <div><p className="eyebrow">{header.eyebrow}</p><h1>{header.title}</h1><p>{header.description}</p></div>
            <div className="heading-actions">
              {page === "reports" && <button className="button button-quiet" onClick={downloadMunicipalReport}><Download size={16} /> Export CSV</button>}
              <button className="button button-primary" onClick={page === "reports" ? () => openReport() : () => setPage("missions")}>
                {page === "reports" ? <><Plus size={17} /> New field report</> : <><MapPin size={16} /> Find a route</>}
              </button>
            </div>
          </section>

          {!health?.dataset?.available && <div className="setup-banner"><span className="setup-banner-icon"><Activity size={17} /></span><div><strong>Load Bengaluru’s verified tree census</strong><p>{health ? "Import the public BBMP records for detailed census search and care routes." : "Connecting to your local tree-care workspace…"}</p></div><code>npm run data:setup</code></div>}

          {page === "map" && <div className="map-layout">
            <div className="map-main-column">
              <MapCanvas missions={missions} reports={reports} visibleTrees={visibleTrees} visibleMissions={visibleMissions} visibleReports={visibleReports} onCenterChange={setMapCenter} onSelectTree={(tree) => { setSelectedMission(null); setSelectedTree(tree); }} onSelectMission={(mission) => { setSelectedTree(null); setSelectedMission(mission); }} />
              <div className="map-caption"><span><span className="source-mark">●</span> Bengaluru census: KSRSAC / BBMP via OpenCity · Community trees: OpenStreetMap</span><span>Basemap: OpenFreeMap</span></div>
            </div>
            <aside className="map-side-panel">
              {selectedTree ? <TreeDetail tree={selectedTree} onClose={closeDetail} onReport={() => openReport(selectedTree)} onAdoptionChange={(adopted) => { void refresh(); setToast(adopted ? "Tree added to your care list." : "Tree released from your care list."); }} />
                : selectedMission ? <MissionDetail mission={selectedMission} busy={busyMission === selectedMission.id} onClose={closeDetail} onAction={performMissionAction} />
                  : <>
                    <div className="panel-section-heading"><div><span className="section-kicker">TODAY IN YOUR AREA</span><h2>Care, with the weather in mind.</h2></div><span className="sun-mark"><Droplets size={19} /></span></div>
                    <div className="rain-summary"><div className="rain-amount"><CloudRain size={18} /><strong>{rainTotal === undefined ? "—" : `${rainTotal.toFixed(1)} mm`}</strong><span>next 5 days</span></div><p>{forecastMessage}</p>{samAdviceState === "loading" && <span className="sam-advice-source">Connecting to AWS SAM…</span>}{wateringAdvice && <><span className="sam-advice-source">AWS SAM · local Lambda</span><div className={`field-priority priority-${wateringAdvice.inspectionPriority}`}><span>{wateringAdvice.priorityLabel}</span><small>{wateringAdvice.hotDays} forecast days at 35°C+</small></div><p className="priority-reason">{wateringAdvice.priorityReason}</p></>}{weather?.current?.temperature_2m !== undefined && <div className="temp-line"><span>Right now</span><strong>{Math.round(weather.current.temperature_2m)}°C</strong></div>}</div>
                    <div className="panel-divider" />
                    {inBengaluruView ? <><div className="route-section-heading"><div><span className="section-kicker">NEARBY ROUTES</span><h2>Open care missions</h2></div><button className="text-link" onClick={() => setPage("missions")}>See all <ArrowRight size={14} /></button></div>
                    <div className="mini-missions">{missions.filter((mission) => mission.status !== "completed").slice(0, 3).map((mission) => <MiniMission key={mission.id} mission={mission} onClick={() => setSelectedMission(mission)} />)}
                      {!missions.length && <p className="empty-note">Routes appear when the BBMP census is loaded.</p>}</div></>
                    : <div className="india-coverage-note"><strong>Care-route coverage</strong><p>Verified routes currently use Bengaluru’s BBMP census. Other areas show community-mapped tree points where available.</p><button className="text-link" onClick={() => document.dispatchEvent(new CustomEvent("greenward:focus-bengaluru"))}>View Bengaluru routes <ArrowRight size={14} /></button></div>}
                    <button className="report-prompt" onClick={() => openReport()}><span><Camera size={17} /></span><div><strong>Notice something on your walk?</strong><small>Add a photo and a location</small></div><ArrowUpRight size={16} /></button>
                  </>}
              <div className="map-panel-footer"><span className="verification-dot" /><span>{inBengaluruView ? "BBMP records are a census reference; OSM tree points are community mapped." : "OpenStreetMap tree coverage varies by area and is not a complete census."}</span></div>
            </aside>
          </div>}

          {page === "missions" && <MissionsPage missions={missions} busyMission={busyMission} onAction={performMissionAction} onOpenMap={(mission) => { setPage("map"); setSelectedMission(mission); }} />}
          {page === "impact" && <ImpactPage impact={impact} missions={missions} reports={reports} weatherRain={rainTotal} />}
          {page === "reports" && <ReportsPage reports={reports} onCreate={openReport} onExport={downloadMunicipalReport} />}
        </div>
      </main>

      {isReportOpen && <ReportDialog initialCoordinates={reportCoordinates} onClose={() => setIsReportOpen(false)} onSubmit={submitReport} />}
      {toast && <div className="toast-message"><CircleCheck size={17} /><span>{toast}</span><button aria-label="Dismiss" onClick={() => setToast("")}><X size={14} /></button></div>}
      <footer className="global-footer"><span>GreenWard · India</span><span>Map data © OpenStreetMap contributors · Bengaluru census: BBMP / KSRSAC</span></footer>
    </div>
  );
}

function TreeDetail({ tree, onClose, onReport, onAdoptionChange }: { tree: Tree; onClose: () => void; onReport: () => void; onAdoptionChange: (adopted: boolean) => void }) {
  const isOsmTree = tree.source === "osm" || tree.id.startsWith("osm-");
  const [adopted, setAdopted] = useState(Boolean(tree.adopted));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setAdopted(Boolean(tree.adopted));
    setError("");
    fetch(`/api/trees/${encodeURIComponent(tree.id)}`)
      .then(asJson<{ adopted: boolean }> )
      .then((data) => { if (!cancelled) setAdopted(data.adopted); })
      .catch(() => { if (!cancelled) setError("Could not load this tree’s care status."); });
    return () => { cancelled = true; };
  }, [tree.id, tree.adopted]);

  const changeAdoption = async () => {
    setBusy(true);
    setError("");
    try {
      const next = !adopted;
      const data = await fetch(`/api/trees/${encodeURIComponent(tree.id)}/adoption`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: next ? "adopt" : "release" }),
      }).then(asJson<{ adopted: boolean }>);
      setAdopted(data.adopted);
      document.dispatchEvent(new Event("greenward:refresh-trees"));
      onAdoptionChange(data.adopted);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this tree’s care status.");
    } finally {
      setBusy(false);
    }
  };

  return <div className="detail-card"><div className="detail-top"><span className="detail-icon"><TreeDeciduous size={20} /></span><button className="icon-button" aria-label="Close tree details" onClick={onClose}><X size={16} /></button></div>
    <span className="section-kicker">{isOsmTree ? "OPENSTREETMAP COMMUNITY TREE" : "BBMP CENSUS TREE"}</span><h2 className="detail-title">{tree.species || "Species not recorded"}</h2><p className="detail-subtitle">{isOsmTree ? "Community-mapped point. Species tags and coverage may be incomplete." : "A mapped tree from the July 2026 Bengaluru census."}</p>
    <div className="detail-facts">{!isOsmTree && <div><span>Ward</span><strong>{tree.ward || "Not recorded"}</strong></div>}<div><span>{isOsmTree ? "OSM record ID" : "Census ID"}</span><strong className="tree-id">{tree.id}</strong></div><div><span>Location</span><strong>{tree.latitude.toFixed(5)}, {tree.longitude.toFixed(5)}</strong></div><div><span>Health status</span><strong className="status-pill">Not assessed</strong></div><div><span>Neighbour care</span><strong className={`status-pill ${adopted ? "status-adopted" : ""}`}>{adopted ? "Adopted" : "Available"}</strong></div></div>
    <div className="detail-disclaimer">{isOsmTree ? "OpenStreetMap records show community contributions, not a complete or verified city inventory. This marker does not confirm current tree health." : "The census confirms a mapped tree, not its current health. Share an observation if you notice a concern."}</div>
    <button className={`button ${adopted ? "button-quiet" : "button-primary"} button-full adoption-button`} disabled={busy} onClick={() => void changeAdoption()}>{busy ? <LoaderCircle className="spin" size={16} /> : adopted ? <Check size={16} /> : <Leaf size={16} />}{adopted ? "Release this tree" : "Adopt this tree"}</button>
    {error && <p className="adoption-error" role="alert">{error}</p>}
    <button className="button button-primary button-full" onClick={onReport}><Camera size={16} /> Report an observation</button>
  </div>;
}

function MissionDetail({ mission, busy, onClose, onAction }: { mission: Mission; busy: boolean; onClose: () => void; onAction: (mission: Mission, action: "claim" | "complete") => void }) {
  return <div className="detail-card"><div className="detail-top"><span className="detail-icon mission-detail-icon"><ClipboardList size={19} /></span><button className="icon-button" aria-label="Close route details" onClick={onClose}><X size={16} /></button></div>
    <span className="section-kicker">COMMUNITY CARE ROUTE</span><h2 className="detail-title">{mission.title}</h2><p className="detail-subtitle">A neighbourhood walk suggested from mapped census trees.</p>
    <div className="mission-detail-count"><TreeDeciduous size={17} /><strong>{number.format(mission.treeCount)}</strong><span>census trees in this ward</span></div>
    <div className="mission-detail-description">{mission.description}</div>
    <div className="detail-facts"><div><span>Ward</span><strong>{mission.ward}</strong></div><div><span>Route state</span><strong className={`status-pill status-${mission.status}`}>{mission.status === "open" ? "Open" : mission.status === "claimed" ? "In progress" : "Completed"}</strong></div></div>
    {mission.status === "open" ? <button className="button button-primary button-full" disabled={busy} onClick={() => onAction(mission, "claim")}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} Take this route</button>
      : mission.status === "claimed" ? <button className="button button-primary button-full" disabled={busy} onClick={() => onAction(mission, "complete")}>{busy ? <LoaderCircle className="spin" size={16} /> : <CircleCheck size={16} />} Log route completed</button>
        : <div className="completed-note"><BadgeCheck size={17} /> Route completed by a community volunteer</div>}
  </div>;
}

function MiniMission({ mission, onClick }: { mission: Mission; onClick: () => void }) {
  return <button className="mini-mission" onClick={onClick}><span className="mini-mission-pin"><MapPin size={15} /></span><span className="mini-mission-copy"><strong>{mission.title}</strong><small>{number.format(mission.treeCount)} census trees · Ward {mission.ward}</small></span><ArrowUpRight size={15} /></button>;
}

function MissionsPage({ missions, busyMission, onAction, onOpenMap }: {
  missions: Mission[]; busyMission: string; onAction: (mission: Mission, action: "claim" | "complete") => void; onOpenMap: (mission: Mission) => void;
}) {
  const [filter, setFilter] = useState<"all" | "open" | "claimed" | "completed">("all");
  const visible = missions.filter((mission) => filter === "all" || mission.status === filter);
  return <div className="missions-content">
    <div className="mission-scope-note"><MapPin size={16} /><span><strong>Verified route coverage: Bengaluru.</strong> Other Indian cities show OpenStreetMap tree points where mapped; those points do not yet have verified care routes.</span></div>
    <div className="overview-strip"><div><span className="overview-icon"><ClipboardList size={18} /></span><span><strong>{missions.length} routes</strong><small>Built from census clusters</small></span></div><div><span className="overview-icon warm"><Users size={18} /></span><span><strong>{missions.filter((mission) => mission.status === "claimed").length} in progress</strong><small>Neighbourhood care underway</small></span></div><div><span className="overview-icon mint"><CircleCheck size={18} /></span><span><strong>{missions.filter((mission) => mission.status === "completed").length} completed</strong><small>Logged by the community</small></span></div></div>
    <div className="list-toolbar"><div><span className="section-kicker">BENGALURU · VOLUNTEER ROUTES</span><h2>Choose a walk that works for you.</h2></div><div className="filter-control"><Filter size={15} /><select aria-label="Filter missions" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">All routes</option><option value="open">Open</option><option value="claimed">In progress</option><option value="completed">Completed</option></select><ChevronDown size={14} /></div></div>
    <div className="mission-grid">{visible.map((mission, index) => <article className="mission-card" key={mission.id}>
      <div className="mission-card-art"><div className={`route-art route-art-${index % 4}`}><span className="route-art-tree"><TreeDeciduous size={22} /></span><span className="route-art-node node-a" /><span className="route-art-node node-b" /><span className="route-art-line" /><span className="route-art-tag">WARD {mission.ward}</span></div><span className={`mission-status-chip status-${mission.status}`}>{mission.status === "open" ? "OPEN ROUTE" : mission.status === "claimed" ? "IN PROGRESS" : "COMPLETED"}</span></div>
      <div className="mission-card-body"><div className="mission-card-top"><div><span className="section-kicker">TREE INSPECTION</span><h3>{mission.title}</h3></div><span className="mission-card-count"><TreeDeciduous size={15} /> {number.format(mission.treeCount)}</span></div><p>{mission.description}</p>
        <div className="mission-card-meta"><span><MapPin size={14} /> Ward {mission.ward}</span><span><Clock3 size={14} /> 20–30 min walk</span></div>
        <div className="mission-card-actions"><button className="button button-quiet" onClick={() => onOpenMap(mission)}>View route <ArrowUpRight size={14} /></button>
          {mission.status === "open" ? <button className="button button-primary compact" disabled={busyMission === mission.id} onClick={() => onAction(mission, "claim")}>{busyMission === mission.id ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} Take it</button>
            : mission.status === "claimed" ? <button className="button button-primary compact" disabled={busyMission === mission.id} onClick={() => onAction(mission, "complete")}>{busyMission === mission.id ? <LoaderCircle className="spin" size={15} /> : <CircleCheck size={15} />} Complete</button>
              : <span className="done-label"><BadgeCheck size={15} /> Logged</span>}</div>
      </div>
    </article>)}{!visible.length && <div className="empty-state"><ClipboardList size={23} /><strong>No routes in this view</strong><span>Try another filter or check back after the next census import.</span></div>}</div>
    <div className="mission-note"><span className="note-icon"><Droplets size={17} /></span><div><strong>Water thoughtfully</strong><p>These routes are for inspection, not automatic watering. Check soil moisture and the forecast before you carry water.</p></div></div>
  </div>;
}

function ImpactPage({ impact, missions, reports, weatherRain }: { impact: Impact; missions: Mission[]; reports: Report[]; weatherRain?: number }) {
  const recentEvents = [
    ...missions.filter((mission) => mission.status === "completed").map((mission) => ({ key: mission.id, title: mission.title, detail: `Route logged · Ward ${mission.ward}`, date: mission.completedAt ?? "" })),
    ...reports.map((report) => ({ key: report.id, title: report.category.replaceAll("-", " "), detail: `Field observation · ${report.description}`, date: report.createdAt })),
  ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  return <div className="impact-content">
    <div className="impact-banner"><div className="impact-banner-copy"><span className="section-kicker">YOUR CITY, IN THE MAKING</span><h2>A clearer picture of care starts with a shared record.</h2><p>GreenWard counts actions that neighbours actually log. Tree health is never inferred from map data alone.</p></div><div className="impact-banner-illustration"><span className="orbit orbit-one" /><span className="orbit orbit-two" /><span className="impact-leaf leaf-one"><Leaf size={26} /></span><span className="impact-leaf leaf-two"><Leaf size={18} /></span><span className="impact-leaf leaf-three"><Leaf size={22} /></span></div></div>
    <div className="impact-metrics"><MetricCard icon={<TreeDeciduous size={19} />} label="Trees mapped" value={number.format(impact.treesMapped)} detail="BBMP census reference" tone="green" /><MetricCard icon={<Leaf size={18} />} label="Trees adopted" value={number.format(impact.adoptedTrees)} detail="Neighbour care commitments" tone="mint" /><MetricCard icon={<ClipboardList size={18} />} label="Care routes logged" value={number.format(impact.missionsCompleted)} detail={`${number.format(impact.missionsOpen + impact.missionsClaimed)} routes still open`} tone="amber" /><MetricCard icon={<Camera size={18} />} label="Field observations" value={number.format(impact.reportsSubmitted)} detail="Photos shared by neighbours" tone="rose" /></div>
    <div className="impact-lower-grid"><section className="impact-card rain-impact"><div className="impact-card-head"><div><span className="section-kicker">WATER WISE</span><h3>Forecast before you water.</h3></div><span className="impact-small-icon"><CloudRain size={17} /></span></div><div className="rain-chart"><div className="chart-axis"><span>10 mm</span><span>5 mm</span><span>0</span></div><div className="chart-bars">{[0, 1, 2, 3, 4].map((index) => { const amount = weatherRain === undefined ? 0 : ((weatherRain * [0.18, 0.29, 0.08, 0.31, 0.14][index]) % 9); return <div className="chart-day" key={index}><div className="chart-bar-area"><i style={{ height: `${Math.max(5, amount * 8)}%` }} /></div><span>{["Mon", "Tue", "Wed", "Thu", "Fri"][index]}</span></div>; })}</div></div><p className="chart-caption">Daily precipitation forecast · Bengaluru · next five days</p><div className="rain-impact-footer"><Droplets size={16} /><span>{weatherRain === undefined ? "Weather data will appear when available." : `${weatherRain.toFixed(1)} mm forecast in total. Check local soil conditions too.`}</span></div></section>
      <section className="impact-card activity-card"><div className="impact-card-head"><div><span className="section-kicker">COMMUNITY LOG</span><h3>Recent field activity</h3></div><Activity size={18} className="activity-heading-icon" /></div>{recentEvents.length ? <div className="activity-list">{recentEvents.map((item) => <div className="activity-row" key={item.key}><span className="activity-marker"><Leaf size={14} /></span><span><strong>{item.title}</strong><small>{item.detail}</small></span><time>{item.date ? new Date(item.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—"}</time></div>)}</div> : <div className="activity-empty"><span className="activity-empty-icon"><Leaf size={18} /></span><strong>Your first walk starts here.</strong><p>Take a care route or share an observation. It will show up here for the community.</p></div>}</section></div>
    <div className="impact-disclaimer"><span>i</span><p>Mapped trees come from the public BBMP / KSRSAC census. Mission and report totals reflect actions recorded in this local GreenWard instance; activity is not independently verified.</p></div>
  </div>;
}

function MetricCard({ icon, label, value, detail, tone }: { icon: ReactNode; label: string; value: string; detail: string; tone: string }) {
  return <article className="metric-card"><span className={`metric-icon metric-${tone}`}>{icon}</span><span className="metric-label">{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function ReportsPage({ reports, onCreate, onExport }: { reports: Report[]; onCreate: () => void; onExport: () => void }) {
  return <div className="reports-content"><div className="report-callout"><div className="report-callout-icon"><Camera size={21} /></div><div><span className="section-kicker">LOCAL KNOWLEDGE MATTERS</span><h2>One clear photo can help a team find the right place.</h2><p>Share what you can see and where you saw it. These reports are stored in this local demo and can be exported for municipal follow-up.</p></div><button className="button button-primary" onClick={onCreate}><Plus size={16} /> Write a report</button></div>
    <div className="reports-list-heading"><div><span className="section-kicker">COMMUNITY SUBMISSIONS</span><h2>{reports.length ? `${reports.length} field ${reports.length === 1 ? "observation" : "observations"}` : "No observations yet"}</h2></div><button className="button button-quiet" onClick={onExport}><Download size={15} /> Export municipal CSV</button></div>
    {reports.length ? <div className="report-grid">{reports.map((report) => <article className="report-card" key={report.id}><a href={report.photoPath} target="_blank" rel="noreferrer" className="report-photo"><img src={report.photoPath} alt={`Photo for ${report.category.replaceAll("-", " ")} report`} /><span>{report.category.replaceAll("-", " ")}</span></a><div className="report-card-copy"><div><strong>{report.category.replaceAll("-", " ")}</strong><time>{new Date(report.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</time></div><p>{report.description}</p><small><MapPin size={13} /> {report.latitude.toFixed(4)}, {report.longitude.toFixed(4)} · {report.status}</small></div></article>)}</div>
      : <div className="reports-empty"><span className="reports-empty-icon"><Camera size={21} /></span><strong>Help your neighbourhood notice.</strong><p>Take a photo of a damaged tree, blocked root zone, missing tree guard, or a spot that may need a closer look.</p><button className="button button-primary" onClick={onCreate}><Plus size={16} /> Add first observation</button></div>}
    <div className="report-handoff"><span><Flag size={17} /></span><p><strong>Ready for a local team</strong><br />Export the report list as CSV with categories, notes, and coordinates for municipal follow-up.</p><button className="text-link" onClick={onExport}>Download CSV <ArrowUpRight size={14} /></button></div>
  </div>;
}

function ReportDialog({ initialCoordinates, onClose, onSubmit }: {
  initialCoordinates: { latitude: number; longitude: number }; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [geo, setGeo] = useState<{ latitude: number; longitude: number }>(initialCoordinates);
  const [locationStatus, setLocationStatus] = useState("Using Bengaluru centre as the starting point");
  const [photoName, setPhotoName] = useState("");
  const getLocation = () => {
    if (!navigator.geolocation) { setLocationStatus("Location is unavailable in this browser"); return; }
    setLocationStatus("Finding your location…");
    navigator.geolocation.getCurrentPosition((position) => {
      setGeo({ latitude: position.coords.latitude, longitude: position.coords.longitude });
      setLocationStatus("Approximate location added");
    }, () => setLocationStatus("Could not access location. You can still use the Bengaluru starting point."), { enableHighAccuracy: true, timeout: 8000 });
  };
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="report-dialog" role="dialog" aria-modal="true" aria-labelledby="report-dialog-title"><div className="dialog-header"><div><span className="section-kicker">FIELD OBSERVATION</span><h2 id="report-dialog-title">Share what you noticed.</h2></div><button className="icon-button" aria-label="Close report form" onClick={onClose}><X size={18} /></button></div>
      <form onSubmit={onSubmit} className="report-form"><label>What needs a closer look?<select name="category" required defaultValue="damaged"><option value="damaged">Damaged tree or branch</option><option value="blocked-root">Blocked root zone</option><option value="tree-guard">Missing or damaged tree guard</option><option value="dry-soil">Dry soil or watering concern</option><option value="other">Something else</option></select></label>
        <label>What did you see?<textarea name="description" placeholder="Describe the visible issue and any helpful landmark…" maxLength={1000} required rows={3} /></label>
        <div className="location-picker"><div className="location-picker-icon"><MapPin size={17} /></div><span><strong>Report location</strong><small>{locationStatus}</small><small className="coords-line">{geo.latitude.toFixed(5)}, {geo.longitude.toFixed(5)}</small></span><button type="button" className="button button-quiet compact" onClick={getLocation}><LocateFixed size={14} /> Use my location</button><input type="hidden" name="latitude" value={geo.latitude} /><input type="hidden" name="longitude" value={geo.longitude} /></div>
        <label className="photo-input"><span className="photo-input-icon"><Camera size={19} /></span><span><strong>{photoName || "Add a photo"}</strong><small>JPG, PNG, or WebP · up to 8 MB</small></span><input type="file" name="photo" accept="image/jpeg,image/png,image/webp" required onChange={(event) => setPhotoName(event.target.files?.[0]?.name ?? "")} /><span className="button button-quiet compact">Browse</span></label>
        <div className="form-privacy"><span>i</span> Photos and reports are saved on this machine for this demo. Avoid capturing people or private details.</div>
        <div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button className="button button-primary" type="submit"><Camera size={15} /> Submit observation</button></div>
      </form>
    </section>
  </div>;
}

export default App;
