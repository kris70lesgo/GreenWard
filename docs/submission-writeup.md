# GreenWard — weather-aware community tree care

**Track:** Heat and Water

**Team:** Add the registered team name and members before submission.

## Problem

During hot, dry periods, neighbourhood volunteers need a practical way to decide where a soil check is useful and when rainfall may make extra watering unnecessary. Public tree data is uneven across Indian cities, so care suggestions need to be clear about what is verified and what is only community mapped.

## What we built

GreenWard is an India-capable tree map with Bengaluru's public BBMP/KSRSAC census, OpenStreetMap community tree points elsewhere, local volunteer inspection routes, tree adoption, photo observations, and a community activity view. The map weather panel sends the five-day precipitation and maximum-temperature forecast to a GreenWard Lambda. The Lambda returns a transparent field-check priority and reason. It does not diagnose tree health or tell volunteers to water without checking local soil.

## Where AWS fits

We use the AWS Serverless Application Model (SAM) CLI, which the Environmental Hacks page lists as an AWS open-source tool for its local Build It path. SAM maps the `/watering-advice` HTTP route to a Python 3.12 Lambda and runs it in a Lambda-compatible container. The React app calls that endpoint through its local API proxy. The video should show the response in the app and the SAM Lambda invocation in the terminal. No AWS account or cloud deployment is required for this path.

```sh
npm run dev:aws
npm run sam:validate
npm run sam:build
```

## Stack and data credits

React, TypeScript, Vite, MapLibre GL, Express, SQLite, AWS SAM CLI, Open-Meteo, and OpenStreetMap Overpass. The Bengaluru tree census is published by OpenCity with KSRSAC/BBMP listed as the source and Public Domain listed as the license. OpenStreetMap-derived map data requires ODbL attribution; the app displays attribution. Forecast and tree coverage are incomplete, and reported activities are not independently verified.

## Development tools

AI coding assistant: OpenAI Codex.

## Submission checklist

- Publish the source repository publicly.
- Record and upload a YouTube demo under three minutes. Show the working map and SAM Lambda invocation.
- Submit this writeup and the video link through the Environmental Hacks submission form before its deadline.
- Confirm each participant has checked in and completed the event's student eligibility steps.
