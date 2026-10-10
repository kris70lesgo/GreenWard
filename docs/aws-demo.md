# GreenWard AWS demo

## What AWS does in the app

GreenWard uses the AWS Serverless Application Model (SAM) CLI, an AWS open-source tool named by the Environmental Hacks page for its local Build It path. SAM serves an API Gateway-compatible HTTP endpoint and runs the weather-guidance handler inside the AWS Lambda Python 3.12 runtime container. The React map calls this endpoint with the five-day Open-Meteo rainfall and maximum-temperature forecast for the map center.

The Lambda returns rainfall totals, the number of forecast days at or above 35 °C, an inspection-priority label, a reason, and a conservative next step. It never claims a tree is unhealthy and never tells volunteers to water without checking local soil. The 35 °C and rainfall thresholds are transparent heuristics for prioritizing inspections, not a tree-health model.

## Run and show it

1. Start OrbStack or Docker Desktop.
2. Run `npm run dev:aws` from the project root.
3. Open <http://localhost:5173>, keep the map in Bengaluru, and show the weather panel. It displays the forecast, the priority, and `AWS SAM · local Lambda` when the Lambda response arrives.
4. Keep the terminal visible while the panel refreshes. SAM logs the `/watering-advice` request and the Lambda container invocation.
5. Show the AWS implementation in `sam/template.yaml` and `sam/src/app.py`, then run `npm run sam:validate` and `npm run sam:build` if there is time.

No AWS account, credentials, or cloud deployment are needed for this local demo. Docker Desktop or OrbStack is required to run the Lambda-compatible container.

## Suggested three-minute video

- **0:00–0:25:** Explain Bengaluru's heat and water problem and why volunteers should avoid unnecessary watering.
- **0:25–1:30:** Show the map, a tree record, a nearby inspection route, and the forecast panel's SAM-generated priority.
- **1:30–2:20:** Show the terminal request and Lambda container log, then the SAM template and handler that connect the app to the Lambda.
- **2:20–2:50:** Explain the conservation guardrail: weather prioritizes a soil check; it does not diagnose tree health or trigger watering automatically.

## Optional AWS deployment

The SAM template defines an HTTP API and Lambda and can be deployed after AWS account access is configured. Deployment is not part of the current local setup. With an AWS account and SAM CLI configured, build and deploy using:

```sh
npm run sam:build
sam deploy --guided --template-file .aws-sam/build/template.yaml --region ap-south-1
```

The current React development proxy points at local port `8788`; a deployed front end would need its API base URL configured for the deployed API Gateway endpoint. Do not commit AWS credentials or put them in a `VITE_` variable.

## Submission reminders

The official rules also require an eligible registered participant, a public source repository, a YouTube demo under three minutes, a short writeup, and submission before the deadline. The schedule page currently lists October 11, 2026 as the submission day and says the final deadline hours are still being set. Check the [event schedule](https://www.wemakedevs.org/aws/env/schedule) before submitting. The demo needs to show the running SAM Lambda; mentioning AWS only in the writeup is not enough.
