---
kind: north-star
status: draft
updated: YYYY-MM-DD
---

# North Star — <product>

## The game

<Attention, Transaction or Productivity, and why this product plays it.>

## North Star statement

Our path to sustainable growth is a function of our ability to <customer value>.

## North Star metric

**<Pithy name>**: <the precise, measurable definition, with thresholds: "X actions within Y days">.

## Input metrics

| Key | Input | Lever | How it is measured |
|---|---|---|---|
| `<input_key>` | <name> | Breadth · Depth · Frequency · Efficiency | <the event the product sends, or "pushed from outside"> |

## Lagging indicators

<The mid- and long-term business results the North Star predicts: revenue, CLTV, retention.>

## Sync payload

The metric and its inputs in the shape the Golden Frijoles engine takes. Keep exactly one `json` block in this file.

```json
{
  "metric": {
    "key": "<metric_key>",
    "name": "<Pithy name>",
    "description": "<the precise definition from the North Star metric section>"
  },
  "inputs": [
    { "key": "<input_key>", "name": "<Input name>", "valueSource": "external_push" },
    { "key": "<other_input_key>", "name": "<Input name>", "valueSource": "telemetry_event", "sourceEvent": "<event_the_product_sends>" }
  ]
}
```
