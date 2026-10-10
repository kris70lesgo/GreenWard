# GreenWard integrations and credentials

## Local app credential count

- **Required third-party API keys/tokens: 0.**
- **Optional third-party API keys/tokens: 0.**
- The Mapbox token previously supplied for the Berlin reference clone is not used here. GreenWard uses MapLibre and OpenFreeMap so the Bengaluru map has no vendor token.
- Local development needs Node.js and npm, but no cloud account, database service, login, or API key.

## Services used by the local application

| Service / data | Purpose | Credentials | Cost and limits | Setup |
| --- | --- | --- | --- | --- |
| [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) + [OpenFreeMap](https://openfreemap.org/) | Interactive India-wide vector basemap, camera pitch, and map controls | No key or registration | OpenFreeMap's public instance is free and permits commercial use; it has no SLA. Attribution is required. | Already configured in the app. MapLibre displays `© OpenMapTiles · OpenStreetMap`. |
| [Bengaluru Tree Census](https://data.opencity.in/dataset/bengaluru-tree-census-data) | July 2026 BBMP/KSRSAC tree coordinates, species, wards, and IDs | No key or account | Catalog license is listed as Public Domain. The archive is about 16 MB compressed. | `npm run data:setup` downloads and imports it locally; no live data API is provided. |
| [Open-Meteo Forecast API](https://open-meteo.com/en/docs) | Five-day precipitation and temperature context for watering decisions | No key or account for the free non-commercial endpoint | Free API is non-commercial, limited to fair use (the provider asks users above 10,000 calls/day to contact them), and has no uptime guarantee. | App requests a forecast for the current map center through the local API and caches each area for 15 minutes. See [pricing and terms](https://open-meteo.com/en/pricing). |
| [OpenStreetMap Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) | Small India viewport queries for community-mapped `natural=tree` points, alongside the Bengaluru census where available | No key | OSM data is ODbL and requires attribution; public Overpass instances are shared community resources with no uptime guarantee. GreenWard caches map cells for 30 minutes and caps this local API at 750 requests per UTC day. | Requests only run inside India at street-level zoom for a small viewport. Sparse results mean unrecorded trees may still exist. |
| [AWS Serverless Application Model (SAM) CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html) | Runs GreenWard's Python Lambda behind a local API Gateway-compatible HTTP endpoint. The Lambda combines forecast rainfall and hot days into an explainable soil-inspection priority. | No AWS account or credentials for local mode | SAM CLI is explicitly listed as a qualifying AWS open-source tool on the hackathon page. Docker Desktop or OrbStack must be running for `sam local`. | Install SAM CLI, start the container runtime, and run `npm run dev:aws`. The map weather panel shows the Lambda priority and the `AWS SAM · local Lambda` source label. |
| Local SQLite + Express | Spatial tree queries, mission actions, impact totals, and report metadata | No credentials | Local disk only; no remote sync, backups, or user accounts. | Created at `apps/api/data/trees.sqlite` when the census is imported. |
| Local photo storage | Photo attachments for field observations | No credentials | JPG/PNG/WebP, maximum 8 MB per image; files stay on this machine. | Stored in ignored `apps/api/uploads/`. |

### Running locally

```sh
npm install
npm run data:setup
npm run dev
```

The web app runs on port `5173`; the API defaults to port `8787`. `PORT` and `GREENWARD_DATABASE_PATH` are local settings, not secrets. The Vite development server proxies `/api` to the local API.

## Future shared deployment

The local app is functional without AWS credentials. The Environmental Hacks page accepts either a qualifying AWS open-source tool or an AWS deployment; SAM CLI is listed for the local Build It path. A shared hosted product would still need an AWS account, a deployment role/short-lived credentials, and a production persistence/auth/storage design. Those are account credentials and resource configuration, not third-party API keys. AWS services can incur charges outside the account's current free allowances; check the current [AWS pricing](https://aws.amazon.com/pricing/) before deploying. No AWS cloud resources have been created by this local setup.

Optional future services such as Cognito, S3, and Bedrock are not called by the current code and therefore do not require credentials now. If those are added, use IAM roles/Identity Center for AWS access; do not store long-lived AWS access keys in `.env` or expose server secrets through a `VITE_` variable.
