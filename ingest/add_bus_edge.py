#!/usr/bin/env python3
"""Lightweight bus shortcut-edge ingest (spec 5.7).

Pulls ONE route out of a borough bus GTFS zip and emits a TransferEdge JSON
blob (median rideSec + headwaySec per service day / time band) to paste into
the app: Shortcuts tab -> "Import bus edge JSON". We never ingest full bus
GTFS — expect to define maybe 5-15 of these total.

Borough bus GTFS zips (mta.info/developers):
  https://rrgtfsfeeds.s3.amazonaws.com/gtfs_busco.zip   (Bronx MTA Bus)
  https://rrgtfsfeeds.s3.amazonaws.com/gtfs_b.zip       (Brooklyn)
  https://rrgtfsfeeds.s3.amazonaws.com/gtfs_m.zip       (Manhattan)
  https://rrgtfsfeeds.s3.amazonaws.com/gtfs_q.zip       (Queens)
  https://rrgtfsfeeds.s3.amazonaws.com/gtfs_bx.zip      (Bronx NYCT)
  https://rrgtfsfeeds.s3.amazonaws.com/gtfs_si.zip      (Staten Island)

Usage:
  python3 ingest/add_bus_edge.py Q52+ "Woodhaven Blvd/Liberty Av" "Cross Bay Blvd/Rockaway" \\
      --gtfs ingest/data/gtfs_q.zip \\
      --from-station <stationId> --to-station <stationId> [--access-min 2]

Stop names are case-insensitive substrings; the script lists near-misses if a
name matches zero or multiple stops. Station ids are the planner's official
Station IDs (hover a station in the app, or see web/public/network.json).
"""
import argparse
import csv
import io
import json
import statistics
import sys
import zipfile
from collections import defaultdict

BAND_RANGES = [(0, 6), (6, 10), (10, 16), (16, 20), (20, 24)]
SERVICE_DAYS = ["Weekday", "Saturday", "Sunday"]


def band_of(sec):
    h = (sec // 3600) % 24
    for i, (lo, hi) in enumerate(BAND_RANGES):
        if lo <= h < hi:
            return i
    return 0


def parse_time(s):
    h, m, sec = s.split(":")
    return int(h) * 3600 + int(m) * 60 + int(sec)


def read_zip_csv(zf, name):
    with zf.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("route", help="bus route_id or route_short_name (e.g. Q52+)")
    ap.add_argument("from_stop", help="boarding stop name substring")
    ap.add_argument("to_stop", help="alighting stop name substring")
    ap.add_argument("--gtfs", required=True, help="borough bus GTFS zip")
    ap.add_argument("--from-station", required=True, help="planner Station ID at the boarding end")
    ap.add_argument("--to-station", required=True, help="planner Station ID at the alighting end")
    ap.add_argument("--access-min", type=float, default=2.0, help="walk-to-stop buffer minutes (default 2)")
    args = ap.parse_args()

    zf = zipfile.ZipFile(args.gtfs)

    routes = {r["route_id"]: r for r in read_zip_csv(zf, "routes.txt")}
    route_ids = {rid for rid, r in routes.items()
                 if args.route.lower() in (rid.lower(), r.get("route_short_name", "").lower())}
    if not route_ids:
        sys.exit(f"route {args.route!r} not in {args.gtfs}; routes: "
                 + ", ".join(sorted(r.get("route_short_name") or rid for rid, r in routes.items())))

    # service_id -> our day buckets
    svc_days = defaultdict(set)
    if "calendar.txt" in zf.namelist():
        for r in read_zip_csv(zf, "calendar.txt"):
            if any(r[d] == "1" for d in ("monday", "tuesday", "wednesday", "thursday", "friday")):
                svc_days[r["service_id"]].add("Weekday")
            if r["saturday"] == "1":
                svc_days[r["service_id"]].add("Saturday")
            if r["sunday"] == "1":
                svc_days[r["service_id"]].add("Sunday")

    trips = {}  # trip_id -> set of day buckets
    for r in read_zip_csv(zf, "trips.txt"):
        if r["route_id"] in route_ids:
            days = svc_days.get(r["service_id"], set())
            if not days:  # MTA bus service_ids encode the day when calendar is sparse
                sid = r["service_id"].lower()
                days = ({"Saturday"} if "saturday" in sid else
                        {"Sunday"} if "sunday" in sid else {"Weekday"})
            trips[r["trip_id"]] = days
    if not trips:
        sys.exit(f"route {args.route!r} has no trips")

    # resolve stop name substrings against stops this route actually serves
    stop_names = {r["stop_id"]: r["stop_name"] for r in read_zip_csv(zf, "stops.txt")}

    def resolve(sub, served_ids):
        hits = {sid for sid in served_ids if sub.lower() in stop_names.get(sid, "").lower()}
        names = {stop_names[s] for s in hits}
        if not hits:
            sys.exit(f"no stop on {args.route} matches {sub!r}; served stops:\n  "
                     + "\n  ".join(sorted({stop_names[s] for s in served_ids})))
        if len(names) > 1:
            sys.exit(f"{sub!r} is ambiguous on {args.route}: {sorted(names)}")
        return hits, names.pop()

    # one pass over stop_times for just our trips
    by_trip = defaultdict(list)  # trip_id -> [(seq, stop_id, dep_sec)]
    for r in read_zip_csv(zf, "stop_times.txt"):
        if r["trip_id"] in trips and r["departure_time"]:
            by_trip[r["trip_id"]].append(
                (int(r["stop_sequence"]), r["stop_id"], parse_time(r["departure_time"])))

    served = {sid for stops in by_trip.values() for _, sid, _ in stops}
    from_ids, from_name = resolve(args.from_stop, served)
    to_ids, to_name = resolve(args.to_stop, served)

    rides = defaultdict(list)  # (day, band) -> ride secs
    deps = defaultdict(list)   # (day, band) -> departure secs at from_stop
    for trip_id, stops in by_trip.items():
        stops.sort()
        f = next(((i, t) for i, (_, sid, t) in enumerate(stops) if sid in from_ids), None)
        if f is None:
            continue
        t_to = next((t for _, sid, t in stops[f[0] + 1:] if sid in to_ids), None)
        if t_to is None:
            continue
        dep = f[1]
        for day in trips[trip_id]:
            rides[(day, band_of(dep))].append(t_to - dep)
            deps[(day, band_of(dep))].append(dep)

    if not rides:
        sys.exit(f"no {args.route} trip serves {from_name!r} then {to_name!r} in that order "
                 "(wrong direction? swap the stops)")

    bus_service = {}
    for day in SERVICE_DAYS:
        ride_b, head_b = [None] * 5, [None] * 5
        for b in range(5):
            r = rides.get((day, b))
            if r:
                ride_b[b] = round(statistics.median(r))
                # dedupe: several service_ids can carry identical trips
                d = sorted(set(deps[(day, b)]))
                if len(d) >= 2:
                    head_b[b] = round(statistics.median(
                        d[i + 1] - d[i] for i in range(len(d) - 1)))
        if any(v is not None for v in ride_b):
            bus_service[day] = {"rideSec": ride_b, "headwaySec": head_b}

    all_rides = [s for v in rides.values() for s in v]
    edge = {
        "from": args.from_station,
        "to": args.to_station,
        "kind": "bus",
        "sec": round(statistics.median(all_rides)),
        "notes": f"{from_name} -> {to_name}",
        "confirmed": False,
        "routeLabel": args.route,
        "accessSec": round(args.access_min * 60),
        "busService": bus_service,
    }
    print(json.dumps(edge, indent=2))
    print(f"\n^ paste into the app: Shortcuts tab -> Import bus edge JSON "
          f"({len(all_rides)} trips matched)", file=sys.stderr)


if __name__ == "__main__":
    main()
