# Responses Upstream Compatibility Notes

Observations from live upstream testing against the Copilot API.

## Vision Gaps (March 11, 2026)

Live upstream verification matters here. On March 11, 2026, a full local scan across every Copilot model that advertised `/responses` support still showed two stable vision gaps:

- External image URLs were rejected uniformly enough that the proxy now rejects them locally with a clearer capability error.
- The current 1x1 PNG data URL probe was rejected upstream as invalid image data even though the fixture itself decodes as a valid PNG locally.

The proxy does not currently disable Responses vision wholesale because the same models still advertise vision capability in Copilot model metadata. Treat Responses vision as upstream-contract-sensitive and verify it with `matrix:live` before relying on it.

## Stateful Routes (March 11, 2026)

On March 11, 2026, `POST /responses` succeeded against the current enterprise Copilot endpoint, but `POST /responses/input_tokens`, `GET /responses/{id}`, `GET /responses/{id}/input_items`, and `DELETE /responses/{id}` all returned upstream `404`. The proxy exposes those routes because they are part of the official Responses surface, but current Copilot upstream support is not there yet. The same live matrix also showed `previous_response_id` returning upstream `400 previous_response_id is not supported` on the tested model.
