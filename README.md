# NYC Subway Speedrun Route Planner

Route-planning workbench for a Guinness "fastest time to travel to all 472 NYC
Subway stations" attempt. A route editor with an instant timing engine plus an
offline-first live run mode — not an auto-solver.

## Layout

- `ingest/` — Python GTFS ingest. `ingest/data/` holds the raw MTA static GTFS
  (`gtfs_subway.zip`) and the data.ny.gov stations CSV (`stations.csv`).
  Produces `ingest/subway.db` (SQLite) and `web/public/network.json`.
  `ingest/add_bus_edge.py` pulls a single route from a borough bus GTFS zip
  and emits a bus TransferEdge JSON to paste into the app (Shortcuts tab).
- `web/` — Vite + React + TypeScript single-page app (planner + live run PWA).
  - `src/engine/` — pure timing engine (`evaluatePlan`), unit-tested.
  - `src/components/` — map (MapLibre, blank offline style), plan editor,
    smart leg entry, coverage/stranded panel, segment library, plan compare,
    Shortcut Finder (Dijkstra-ranked close-but-far station pairs).
  - `src/run/` — live run mode: big-button UI, drift retiming, missed-train,
    contingency splicing, run log export.

## Refresh the data

```bash
cd ingest/data
curl -sL -o gtfs_subway.zip https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip
unzip -o -q gtfs_subway.zip -d gtfs
curl -sL -o stations.csv "https://data.ny.gov/api/views/39hk-dx4f/rows.csv?accessType=DOWNLOAD"
cd ../.. && python3 ingest/ingest.py
```

The ingest hard-fails unless exactly 472 record stations (non-SIR) come out,
and prints sanity spot-checks (42 St shuttle ≈ 90 s, etc.).

## Run

```bash
cd web
npm install
npm test        # engine unit tests + real-network spot checks
npm run dev     # planner at http://localhost:5173
npm run build   # production PWA (service worker precaches network.json)
```

## Domain rules encoded

- Coverage unit = official Station ID (data.ny.gov). Default target is the
  Guinness-official 472 (subway only); the per-plan `include SIR (493)`
  checkbox adds the 21 Staten Island Railway stations. SIR rides/patterns are
  always in the network either way.
- Network is directed; patterns are (route, direction, exact stop list).
- Travel times are per-time-band medians from `stop_times`; bands:
  overnight 00–06, am_rush 06–10, midday 10–16, pm_rush 16–20, evening 20–24.
- Service days: Weekday / Saturday / Sunday, with 6 a.m. rollover (GTFS 24:xx
  overnight times belong to the previous service day).
- `passThroughCounts` config flag (default false) — express pass-throughs
  estimated from the densest local pattern between consecutive express stops.
- Wait per ride leg: ½ headway default, overrides: full / timed-0 / manual.
- Risk per leg = headway at boarding (cost of one missed train); legs over
  10 min flagged ⚠ in the editor.
- User-added strategic walk edges (haversine-estimated) persist in the app.
  All shortcut edges start as ⚠ unconfirmed drafts until physically scouted
  (notes field records which exit / street route / bus stop to use).
- Shortcut Finder: ranks station pairs by `in-system time − est. walk time`
  (in-system via Dijkstra over ride+transfer edges with ½-headway boarding
  waits; walk = haversine × 1.35 street factor at a configurable pace,
  default 10 min/mi). "Branch tips only" filter; bus mode raises the radius
  to ~5 km. Already-connected pairs and same-complex pairs are excluded.
- Bus legs (Guinness-legal scheduled transit): timed as walk-to-stop buffer +
  FULL headway (pessimistic — buses bunch) + median ride for the time band,
  always flagged HIGH RISK; in live mode the leg card surfaces its rail
  fallback contingency unconditionally. Walk/bus only — no rideshare/bike
  mode exists on purpose.
- Contingency branches attach to a leg with a drift threshold; in live mode a
  triggered branch shows side-by-side finish times and one-tap **replaces all
  remaining legs**.
