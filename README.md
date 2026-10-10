# GreenWard

GreenWard lets people explore community-mapped trees across India and adds a verified Bengaluru tree census, local care routes, weather context, and photo observations where those city records are available.

## Start locally

Requirements: Node.js 22.12+ and npm. No Mapbox, AWS, weather, or database credentials are needed for the local app.

```sh
npm install
npm run data:setup
npm run dev
```

Open <http://localhost:5173>. The first data setup downloads the July 2026 BBMP census archive (about 16 MB compressed), streams its roughly 702,000 point records into a local SQLite database, and builds a spatial index. The database and source archive are stored under `apps/api/data/` and ignored by Git. Refresh from the catalog with `npm run data:refresh`.

The API listens on <http://localhost:8787>. Photos, reports, and mission actions are stored locally in `apps/api/uploads/` and the local SQLite database. They are not synced to other devices and the demo has no sign-in.

To build the frontend and API bundles:

```sh
npm run build
```

To run the AWS-enabled local demo, install the AWS SAM CLI and have Docker Desktop or OrbStack running, then use:

```sh
npm run dev:aws
```

This starts the React app, local API, and an AWS Lambda through SAM. The Lambda turns the current five-day rainfall and heat forecast into an explainable soil-inspection priority. SAM runs the handler in a Lambda-compatible container behind a local API Gateway-style HTTP endpoint. This local mode does not deploy resources or require an AWS account or credentials; `npm run dev` still works without SAM.

To check the AWS template and package the Lambda:

```sh
npm run sam:validate
npm run sam:build
```

See [the AWS demo guide](docs/aws-demo.md) for the feature flow, what to show in the hackathon video, and the optional AWS deployment path.

## Included features

- Interactive India map with clustered, clickable OpenStreetMap tree points where mapped, plus Bengaluru's verified census layer, 3D buildings, search, report layers, zoom, and location controls.
- Ward-based inspection routes with claim and completion actions persisted locally.
- Tree adoption commitments recorded locally, shown on the map, and counted on the impact page.
- Five-day precipitation/temperature context for the map center, cached by the local API for 15 minutes. A Python Lambda, run with AWS SAM, combines low-rainfall and hot-day signals into an explainable field-inspection priority. It never diagnoses tree health or recommends watering without a local soil check.
- Photo observations for damaged trees, blocked roots, tree guards, and dry soil. JPG, PNG, and WebP uploads are limited to 8 MB and stay local.
- Impact totals from logged data, a recent activity view, and CSV export for municipal follow-up.

Verified Bengaluru tree coordinates and attributes come from the [BBMP Tree Census catalogued by OpenCity](https://data.opencity.in/dataset/bengaluru-tree-census-data), whose catalog lists KSRSAC/BBMP as the source and the license as Public Domain. Outside the Bengaluru census, GreenWard queries community-mapped `natural=tree` points from OpenStreetMap through Overpass when the map is zoomed to a small India viewport. OSM coverage varies and is not a complete or verified census. The local API caches area results for 30 minutes and limits itself to 750 Overpass calls per day. OSM data is under the [ODbL](https://www.openstreetmap.org/copyright); attribution is displayed on the map. OpenStreetMap-derived basemap tiles are served by [OpenFreeMap](https://openfreemap.org/). Forecast context comes from [Open-Meteo](https://open-meteo.com/en/docs), whose free API is for non-commercial use.

## Project structure

```text
apps/
  api/             Express API, local SQLite store, census import, photo uploads
  web/             React + TypeScript + Vite + MapLibre GL
sam/               AWS SAM HTTP API and Lambda for weather-aware field guidance
docs/
  integrations.md  Runtime service and credential inventory
```

This is a fresh India-capable implementation inspired by [Gieß den Kiez](https://github.com/technologiestiftung/giessdenkiez-de). Detailed verified census search and generated care routes currently cover Bengaluru; other regions use community-mapped OSM trees until verified local inventories are added.

## Boundaries

This local demo has a shared-machine SQLite store rather than multi-user authentication or cloud storage. Mission routes are generated from tree-dense census wards and are inspection suggestions, not diagnoses. Weather is a forecast, not a measurement of soil moisture. CSV export provides a handoff format; the app does not submit reports to BBMP. AWS hosting and a production multi-user backend are not configured yet.
