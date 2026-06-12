#!/usr/bin/env python3
"""NYC Subway speedrun planner — GTFS ingest.

Reads ingest/data/gtfs/ (MTA static subway GTFS) + ingest/data/stations.csv
(data.ny.gov "MTA Subway Stations") and produces:
  - ingest/subway.db        (SQLite, for ad-hoc queries)
  - web/public/network.json (everything the frontend/engine needs)

Layers (per spec section 7): platform stop (R14N) -> parent stop (R14)
-> official Station ID -> 472-list membership (non-SIR stations).
"""
import csv
import json
import os
import sqlite3
import statistics
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
GTFS = os.path.join(HERE, "data", "gtfs")
STATIONS_CSV = os.path.join(HERE, "data", "stations.csv")
DB_PATH = os.path.join(HERE, "subway.db")
NETWORK_JSON = os.path.join(HERE, "..", "web", "public", "network.json")

BANDS = ["overnight", "am_rush", "midday", "pm_rush", "evening"]
BAND_RANGES = [(0, 6), (6, 10), (10, 16), (16, 20), (20, 24)]
SERVICE_DAYS = ["Weekday", "Saturday", "Sunday"]


def band_of(sec):
    h = (sec // 3600) % 24
    for i, (lo, hi) in enumerate(BAND_RANGES):
        if lo <= h < hi:
            return i
    return 0


def parse_gtfs_time(s):
    h, m, sec = s.split(":")
    return int(h) * 3600 + int(m) * 60 + int(sec)


def read_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        yield from csv.DictReader(f)


def load_stations():
    """Official station list. Returns (stations dict by stationId,
    gtfs parent stop id -> stationId)."""
    stations = {}
    stop_to_station = {}
    for r in read_csv(STATIONS_CSV):
        sid = r["Station ID"]
        gtfs_id = r["GTFS Stop ID"]
        if sid not in stations:
            stations[sid] = {
                "id": sid,
                "name": r["Stop Name"],
                "borough": r["Borough"],
                "complexId": r["Complex ID"],
                "lat": float(r["GTFS Latitude"]),
                "lon": float(r["GTFS Longitude"]),
                "gtfsStopIds": [],
                "routes": sorted(set(r["Daytime Routes"].split())),
                "countsTowardRecord": r["Division"] != "SIR",
            }
        st = stations[sid]
        if gtfs_id not in st["gtfsStopIds"]:
            st["gtfsStopIds"].append(gtfs_id)
        for d in set(r["Daytime Routes"].split()):
            if d not in st["routes"]:
                st["routes"].append(d)
        stop_to_station[gtfs_id] = sid
    return stations, stop_to_station


def main():
    stations, stop_to_station = load_stations()
    n_record = sum(1 for s in stations.values() if s["countsTowardRecord"])
    print(f"stations: {len(stations)} total, {n_record} count toward record")
    if n_record != 472:
        sys.exit(f"FATAL: expected 472 record stations, got {n_record} — reconcile before continuing")

    # --- GTFS stops: platform -> parent ---
    parent_of = {}
    for r in read_csv(os.path.join(GTFS, "stops.txt")):
        if r.get("parent_station"):
            parent_of[r["stop_id"]] = r["parent_station"]
    unmapped = sorted({p for p in parent_of.values() if p not in stop_to_station})
    if unmapped:
        print(f"WARNING: {len(unmapped)} GTFS parent stops not in official list: {unmapped}")

    def station_of(platform_stop_id):
        parent = parent_of.get(platform_stop_id, platform_stop_id)
        return stop_to_station.get(parent)

    # --- routes ---
    routes = {}
    for r in read_csv(os.path.join(GTFS, "routes.txt")):
        routes[r["route_id"]] = {
            "id": r["route_id"],
            "name": r.get("route_long_name") or r["route_id"],
            "color": ("#" + r["route_color"]) if r.get("route_color") else "#888888",
        }

    # --- calendar: service_id -> set of our 3 service-day buckets ---
    svc_days = defaultdict(set)
    cal_path = os.path.join(GTFS, "calendar.txt")
    if os.path.exists(cal_path):
        for r in read_csv(cal_path):
            if any(r[d] == "1" for d in ("monday", "tuesday", "wednesday", "thursday", "friday")):
                svc_days[r["service_id"]].add("Weekday")
            if r["saturday"] == "1":
                svc_days[r["service_id"]].add("Saturday")
            if r["sunday"] == "1":
                svc_days[r["service_id"]].add("Sunday")
    # fall back to service_id naming if calendar.txt is sparse
    for r in read_csv(os.path.join(GTFS, "trips.txt")):
        sid = r["service_id"]
        if sid not in svc_days:
            for day in SERVICE_DAYS:
                if day.lower() in sid.lower():
                    svc_days[sid].add(day)

    # --- trips ---
    trips = {}  # trip_id -> (route_id, direction_id, service days, shape_id)
    for r in read_csv(os.path.join(GTFS, "trips.txt")):
        days = svc_days.get(r["service_id"], set())
        if days:
            trips[r["trip_id"]] = (r["route_id"], r.get("direction_id", ""), days, r.get("shape_id", ""))
    print(f"trips: {len(trips)}")

    # --- stop_times: stream, accumulate per-trip ordered (station, dep, arr) ---
    print("reading stop_times.txt ...")
    trip_stops = defaultdict(list)  # trip_id -> [(seq, station, arr_sec, dep_sec, platform)]
    for r in read_csv(os.path.join(GTFS, "stop_times.txt")):
        tid = r["trip_id"]
        if tid not in trips:
            continue
        st = station_of(r["stop_id"])
        if st is None:
            continue
        trip_stops[tid].append((
            int(r["stop_sequence"]), st,
            parse_gtfs_time(r["arrival_time"]), parse_gtfs_time(r["departure_time"]),
            r["stop_id"],
        ))
    print(f"trips with stops: {len(trip_stops)}")

    # --- group into service patterns ---
    # key: (route_id, direction from platform suffix, exact ordered station tuple)
    pat_key_to_id = {}
    patterns = {}  # pid -> dict
    # per pattern: hop_travel[(pid, hop_idx, day, band)] -> [deltas]
    hop_travel = defaultdict(list)
    # per pattern: first-stop departures per (day, band) for headways
    pat_departures = defaultdict(list)  # (pid, day) -> [dep_sec at first stop]
    pat_trip_count = defaultdict(int)
    pat_shapes = defaultdict(lambda: defaultdict(int))  # pid -> shape_id -> count

    for tid, stops in trip_stops.items():
        stops.sort(key=lambda x: x[0])
        seq = tuple(s[1] for s in stops)
        if len(seq) < 2:
            continue
        route_id, _dir_id, days, shape_id = trips[tid]
        suffix = stops[0][4][-1]
        direction = suffix if suffix in ("N", "S") else "?"
        key = (route_id, direction, seq)
        pid = pat_key_to_id.get(key)
        if pid is None:
            pid = f"{route_id}-{direction}-{len(pat_key_to_id):03d}"
            pat_key_to_id[key] = pid
            patterns[pid] = {
                "id": pid, "routeId": route_id, "direction": direction,
                "stations": list(seq),
            }
        pat_trip_count[pid] += 1
        if shape_id:
            pat_shapes[pid][shape_id] += 1
        for day in days:
            pat_departures[(pid, day)].append(stops[0][3])
            for i in range(len(stops) - 1):
                dep = stops[i][3]
                arr_next = stops[i + 1][2]
                if arr_next >= dep:
                    hop_travel[(pid, i, day, band_of(dep))].append(arr_next - dep)

    print(f"service patterns: {len(patterns)}")

    # --- finalize per-pattern hops + service bands ---
    for pid, pat in patterns.items():
        n_hops = len(pat["stations"]) - 1
        hops = []
        for i in range(n_hops):
            travel = {}
            for day in SERVICE_DAYS:
                vals = [int(statistics.median(hop_travel[(pid, i, day, b)]))
                        if hop_travel[(pid, i, day, b)] else None
                        for b in range(5)]
                if any(v is not None for v in vals):
                    travel[day] = vals
            hops.append(travel)
        pat["hops"] = hops

        service = {}
        for day in SERVICE_DAYS:
            deps = sorted(pat_departures.get((pid, day), []))
            bands = []
            for b in range(5):
                in_band = [d for d in deps if band_of(d) == b]
                runs = len(in_band) > 0
                if len(in_band) >= 2:
                    gaps = [in_band[j + 1] - in_band[j] for j in range(len(in_band) - 1)]
                    headway = int(statistics.median(gaps))
                elif runs:
                    headway = 1800
                else:
                    headway = None
                bands.append({"runs": runs, "headwaySec": headway, "trips": len(in_band)})
            if any(b["runs"] for b in bands):
                service[day] = bands
        pat["service"] = service
        pat["tripCount"] = pat_trip_count[pid]
        first, last = pat["stations"][0], pat["stations"][-1]
        arrow = "↑" if pat["direction"] == "N" else "↓"
        pat["label"] = (f"{pat['routeId']} {arrow} {stations[first]['name']} → "
                        f"{stations[last]['name']} ({len(pat['stations'])} stops)")
        best_shape = max(pat_shapes[pid].items(), key=lambda kv: kv[1])[0] if pat_shapes[pid] else None
        pat["shapeId"] = best_shape

    # --- transfers.txt (parent-station level) -> station-level edges ---
    transfers = []
    seen = set()
    for r in read_csv(os.path.join(GTFS, "transfers.txt")):
        a = stop_to_station.get(r["from_stop_id"])
        b = stop_to_station.get(r["to_stop_id"])
        if a is None or b is None:
            continue
        t = int(r["min_transfer_time"] or 0)
        if (a, b) in seen:
            continue
        seen.add((a, b))
        transfers.append({"from": a, "to": b, "kind": "in_system",
                          "sec": t, "notes": "same-station" if a == b else ""})

    # --- shapes: keep only shapes referenced by a pattern, downsampled ---
    used_shapes = {p["shapeId"] for p in patterns.values() if p["shapeId"]}
    shape_pts = defaultdict(list)
    for r in read_csv(os.path.join(GTFS, "shapes.txt")):
        if r["shape_id"] in used_shapes:
            shape_pts[r["shape_id"]].append(
                (int(r["shape_pt_sequence"]), float(r["shape_pt_lat"]), float(r["shape_pt_lon"])))
    shapes = {}
    for sid, pts in shape_pts.items():
        pts.sort()
        coords = [[round(lat, 5), round(lon, 5)] for _, lat, lon in pts]
        shapes[sid] = coords[::3] + ([coords[-1]] if (len(coords) - 1) % 3 else [])

    # --- sanity checks ---
    print("\n--- sanity checks ---")
    served = set()
    for p in patterns.values():
        served.update(p["stations"])
    record_ids = {s["id"] for s in stations.values() if s["countsTowardRecord"]}
    unserved = record_ids - served
    print(f"record stations served by >=1 pattern: {len(record_ids & served)}/472")
    if unserved:
        print("UNSERVED:", [stations[s]['name'] for s in sorted(unserved)])

    def find_station(name):
        return [s for s in stations.values() if s["name"] == name]

    # Times Sq -> Grand Central on the S
    def spot_check(route, from_name, to_name):
        for p in patterns.values():
            if p["routeId"] != route:
                continue
            names = [stations[s]["name"] for s in p["stations"]]
            if from_name in names and to_name in names:
                i, j = names.index(from_name), names.index(to_name)
                if i < j:
                    tot = 0
                    ok = True
                    for h in range(i, j):
                        tr = p["hops"][h].get("Weekday")
                        v = tr[2] if tr and tr[2] is not None else None
                        if v is None:
                            ok = False
                            break
                        tot += v
                    if ok:
                        print(f"  {route}: {from_name} -> {to_name} = {tot}s  [{p['label']}]")
                        return
        print(f"  {route}: {from_name} -> {to_name} — no pattern found")

    spot_check("GS", "Times Sq-42 St", "Grand Central-42 St")
    spot_check("A", "125 St", "59 St-Columbus Circle")

    # --- SQLite dump ---
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    db = sqlite3.connect(DB_PATH)
    db.executescript("""
      CREATE TABLE stations(id TEXT PRIMARY KEY, name TEXT, borough TEXT, complex_id TEXT,
        lat REAL, lon REAL, gtfs_stop_ids TEXT, routes TEXT, counts INTEGER);
      CREATE TABLE patterns(id TEXT PRIMARY KEY, route_id TEXT, direction TEXT, label TEXT,
        trip_count INTEGER, n_stops INTEGER);
      CREATE TABLE pattern_stops(pattern_id TEXT, seq INTEGER, station_id TEXT);
      CREATE TABLE ride_edges(pattern_id TEXT, hop INTEGER, from_station TEXT, to_station TEXT,
        day TEXT, band TEXT, travel_sec INTEGER);
      CREATE TABLE transfers(from_station TEXT, to_station TEXT, kind TEXT, sec INTEGER, notes TEXT);
    """)
    db.executemany("INSERT INTO stations VALUES (?,?,?,?,?,?,?,?,?)",
                   [(s["id"], s["name"], s["borough"], s["complexId"], s["lat"], s["lon"],
                     json.dumps(s["gtfsStopIds"]), json.dumps(s["routes"]),
                     int(s["countsTowardRecord"])) for s in stations.values()])
    for p in patterns.values():
        db.execute("INSERT INTO patterns VALUES (?,?,?,?,?,?)",
                   (p["id"], p["routeId"], p["direction"], p["label"], p["tripCount"],
                    len(p["stations"])))
        db.executemany("INSERT INTO pattern_stops VALUES (?,?,?)",
                       [(p["id"], i, s) for i, s in enumerate(p["stations"])])
        for i, hop in enumerate(p["hops"]):
            for day, vals in hop.items():
                for b, v in enumerate(vals):
                    if v is not None:
                        db.execute("INSERT INTO ride_edges VALUES (?,?,?,?,?,?,?)",
                                   (p["id"], i, p["stations"][i], p["stations"][i + 1],
                                    day, BANDS[b], v))
    db.executemany("INSERT INTO transfers VALUES (?,?,?,?,?)",
                   [(t["from"], t["to"], t["kind"], t["sec"], t["notes"]) for t in transfers])
    db.commit()
    db.close()
    print(f"\nwrote {DB_PATH}")

    # --- network.json ---
    network = {
        "generatedAt": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "bands": BANDS,
        "serviceDays": SERVICE_DAYS,
        "stations": sorted(stations.values(), key=lambda s: s["id"]),
        "patterns": sorted(patterns.values(), key=lambda p: (-p["tripCount"], p["id"])),
        "transfers": transfers,
        "routes": list(routes.values()),
        "shapes": shapes,
    }
    os.makedirs(os.path.dirname(NETWORK_JSON), exist_ok=True)
    with open(NETWORK_JSON, "w") as f:
        json.dump(network, f, separators=(",", ":"))
    print(f"wrote {NETWORK_JSON} ({os.path.getsize(NETWORK_JSON)//1024} KB)")


if __name__ == "__main__":
    main()
