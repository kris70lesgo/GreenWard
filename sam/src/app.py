import json
import math


def _response(status_code, payload):
    return {
        "statusCode": status_code,
        "headers": {"content-type": "application/json; charset=utf-8"},
        "body": json.dumps(payload),
    }


def lambda_handler(event, _context):
    """Turn a short weather forecast into explainable tree-care field guidance."""
    try:
        raw_body = event.get("body") or "{}"
        body = json.loads(raw_body) if isinstance(raw_body, str) else raw_body
    except (TypeError, json.JSONDecodeError):
        return _response(400, {"error": "Request body must be valid JSON."})

    daily_rain = body.get("dailyPrecipitationMm") if isinstance(body, dict) else None
    if not isinstance(daily_rain, list) or not daily_rain:
        return _response(400, {"error": "Provide dailyPrecipitationMm as a non-empty array."})
    if len(daily_rain) > 14:
        return _response(400, {"error": "Provide no more than 14 forecast days."})

    values = []
    for amount in daily_rain:
        if isinstance(amount, bool) or not isinstance(amount, (int, float)):
            return _response(400, {"error": "Rainfall values must be non-negative numbers."})
        amount = float(amount)
        if not math.isfinite(amount) or amount < 0 or amount > 1000:
            return _response(400, {"error": "Rainfall values must be numbers between 0 and 1000 mm."})
        values.append(amount)

    daily_max = body.get("dailyMaxTemperatureC") if isinstance(body, dict) else None
    if daily_max is not None:
        if not isinstance(daily_max, list) or len(daily_max) != len(values):
            return _response(400, {"error": "dailyMaxTemperatureC must match the rainfall forecast length."})
        temperatures = []
        for temperature in daily_max:
            if isinstance(temperature, bool) or not isinstance(temperature, (int, float)):
                return _response(400, {"error": "Temperature values must be numbers between -20 and 70 °C."})
            temperature = float(temperature)
            if not math.isfinite(temperature) or temperature < -20 or temperature > 70:
                return _response(400, {"error": "Temperature values must be numbers between -20 and 70 °C."})
            temperatures.append(temperature)
    else:
        temperatures = []

    total_mm = round(sum(values), 1)
    hot_days = sum(temperature >= 35 for temperature in temperatures)
    if total_mm >= 10:
        category = "rain-likely"
        inspection_priority = "rain-watch"
        priority_label = "Rain watch"
        priority_reason = "Rain may cover near-term watering needs; check soil after rainfall before adding water."
        message = "Rain is expected. Pause planned watering and check soil moisture after the rainfall."
    elif total_mm <= 2:
        category = "little-rain"
        inspection_priority = "high" if hot_days >= 3 else "watch"
        priority_label = "High soil check priority" if inspection_priority == "high" else "Soil check suggested"
        priority_reason = (
            f"{hot_days} forecast days reach 35 °C with little rain. Prioritize a soil check, especially for young or newly planted trees."
            if hot_days >= 3 else "Little rain is forecast. Check soil moisture before planning a watering route."
        )
        message = "Little rain is forecast. Check soil moisture before planning a watering route."
    else:
        category = "some-rain"
        inspection_priority = "watch" if hot_days >= 1 else "routine"
        priority_label = "Weather watch" if hot_days >= 1 else "Routine check"
        priority_reason = (
            f"Some rain is forecast, with {hot_days} hot forecast days. Check local soil conditions before choosing a route."
            if hot_days >= 1 else "Some rain is forecast. Check local soil conditions before choosing a route."
        )
        message = "Some rain is forecast. Check the soil and near-term forecast before watering."

    return _response(200, {
        "category": category,
        "message": message,
        "precipitationTotalMm": total_mm,
        "forecastDays": len(values),
        "hotDays": hot_days,
        "inspectionPriority": inspection_priority,
        "priorityLabel": priority_label,
        "priorityReason": priority_reason,
        "decision": "inspect-before-watering",
        "engine": "GreenWard Lambda · Python 3.12",
        "caveat": "Weather is an area forecast, not a soil-moisture reading or a tree-health diagnosis. Inspect local conditions before acting.",
    })
