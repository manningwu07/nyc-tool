import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { NetworkIndex } from '../engine/engine';
import type { Plan, PlanResult } from '../engine/types';
import { fmtClock } from '../engine/time';

interface Props {
  idx: NetworkIndex;
  plan: Plan;
  result: PlanResult | null;
  onSelect: (stationId: string) => void;
}

// blank offline style: our shapes ARE the map
const BLANK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b0e14' } }],
};

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

// the whole trip plays back in this many wall-clock seconds at 1× speed,
// regardless of how many hours the real route takes
const PLAYBACK_SECONDS = 22;

// a time-stamped point on the route: clock seconds -> lon/lat, tagged with the
// leg it belongs to so the scrubber can name the current leg
interface Keyframe { t: number; lng: number; lat: number; leg: number; }

/** interpolated [lng, lat] at clock second t along the keyframe track */
function posAt(kfs: Keyframe[], t: number): [number, number] | null {
  if (kfs.length === 0) return null;
  if (t <= kfs[0].t) return [kfs[0].lng, kfs[0].lat];
  const last = kfs[kfs.length - 1];
  if (t >= last.t) return [last.lng, last.lat];
  for (let i = 1; i < kfs.length; i++) {
    if (t <= kfs[i].t) {
      const a = kfs[i - 1], b = kfs[i];
      const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
      return [a.lng + (b.lng - a.lng) * f, a.lat + (b.lat - a.lat) * f];
    }
  }
  return null;
}

/** the route polyline travelled so far, up to and including the live point */
function trailAt(kfs: Keyframe[], t: number): [number, number][] {
  const out: [number, number][] = [];
  for (const k of kfs) {
    if (k.t <= t) out.push([k.lng, k.lat]);
    else break;
  }
  const p = posAt(kfs, t);
  const tail = out[out.length - 1];
  if (p && (!tail || tail[0] !== p[0] || tail[1] !== p[1])) out.push(p);
  return out;
}

export default function MapView({ idx, plan, result, onSelect }: Props) {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);

  const routeLines = useMemo(() => {
    const routeColor = new Map(idx.net.routes.map((r) => [r.id, r.color]));
    const features: GeoJSON.Feature[] = [];
    const seen = new Set<string>();
    for (const p of idx.net.patterns) {
      if (!p.shapeId || seen.has(p.shapeId)) continue;
      seen.add(p.shapeId);
      const coords = idx.net.shapes[p.shapeId];
      if (!coords) continue;
      features.push({
        type: 'Feature',
        properties: { color: routeColor.get(p.routeId) ?? '#555' },
        geometry: { type: 'LineString', coordinates: coords.map(([lat, lon]) => [lon, lat]) },
      });
    }
    return { type: 'FeatureCollection', features } as GeoJSON.FeatureCollection;
  }, [idx]);

  // a station is "dead-end flavored" if it's a terminus of a frequent pattern
  const terminals = useMemo(() => {
    const t = new Set<string>();
    for (const p of idx.net.patterns) {
      if (p.tripCount < 20) continue;
      t.add(p.stations[0]);
      t.add(p.stations[p.stations.length - 1]);
    }
    return t;
  }, [idx]);

  const stationPoints = useMemo(() => {
    const covered = new Set(result?.covered ?? []);
    const features: GeoJSON.Feature[] = idx.net.stations
      .filter((s) => s.countsTowardRecord || plan.config.includeSIR)
      .map((s) => ({
        type: 'Feature',
        properties: {
          id: s.id,
          name: `${s.name} (${s.routes.join(' ')})`,
          status: covered.has(s.id) ? 'covered' : terminals.has(s.id) ? 'deadend' : 'todo',
        },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      }));
    return { type: 'FeatureCollection', features } as GeoJSON.FeatureCollection;
  }, [idx, result, terminals, plan.config.includeSIR]);

  const planLine = useMemo(() => {
    const features: GeoJSON.Feature[] = [];
    if (result) {
      let n = 0;
      for (let i = 0; i < plan.legs.length; i++) {
        const leg = plan.legs[i];
        const lr = result.legs[i];
        if (!lr) continue;
        n++;
        if (leg.type === 'ride' && lr.perStop.length > 1) {
          const coords = lr.perStop
            .map((ps) => idx.stationById.get(ps.stationId))
            .filter((x) => x != null)
            .map((st) => [st.lon, st.lat]);
          features.push({
            type: 'Feature',
            properties: { n, dashed: 0 },
            geometry: { type: 'LineString', coordinates: coords },
          });
        } else if (leg.type === 'walk' || leg.type === 'bus') {
          const a = idx.stationById.get(leg.fromStationId);
          const b = idx.stationById.get(leg.toStationId);
          if (a && b) {
            features.push({
              type: 'Feature',
              properties: { n, dashed: 1 },
              geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [b.lon, b.lat]] },
            });
          }
        }
      }
    }
    return { type: 'FeatureCollection', features } as GeoJSON.FeatureCollection;
  }, [idx, plan, result]);

  // time-stamped track for the playback marker: each station's actual clock
  // arrival becomes a keyframe, so the dot moves fast on long express hops and
  // lingers through transfers/waits exactly as the schedule predicts
  const keyframes = useMemo<Keyframe[]>(() => {
    const kfs: Keyframe[] = [];
    if (!result) return kfs;
    const push = (t: number, sid: string | null | undefined, leg: number) => {
      if (!sid) return;
      const st = idx.stationById.get(sid);
      if (!st) return;
      const last = kfs[kfs.length - 1];
      const tt = last ? Math.max(t, last.t) : t;
      if (last && last.lng === st.lon && last.lat === st.lat && tt === last.t) return;
      kfs.push({ t: tt, lng: st.lon, lat: st.lat, leg });
    };
    for (let i = 0; i < plan.legs.length; i++) {
      const leg = plan.legs[i];
      const lr = result.legs[i];
      if (!lr) continue;
      if (leg.type === 'ride') {
        // the gap before perStop[0] (board @ departSec) plays as the transfer +
        // platform wait — the dot slides into the boarding station and holds
        for (const ps of lr.perStop) push(ps.arriveSec, ps.stationId, i);
      } else if (leg.type === 'walk' || leg.type === 'bus') {
        if (kfs.length === 0) push(lr.startSec, leg.fromStationId, i);
        push(lr.arriveSec, leg.toStationId, i);
      } else {
        push(lr.arriveSec, lr.endStationId, i); // 'wait' leg: hold in place
      }
    }
    return kfs;
  }, [idx, plan, result]);

  const animStart = keyframes[0]?.t ?? 0;
  const animEnd = keyframes[keyframes.length - 1]?.t ?? 0;
  const animSpan = Math.max(1, animEnd - animStart);
  const hasAnim = keyframes.length > 1;

  const [playing, setPlaying] = useState(false);
  const [animT, setAnimT] = useState(animStart);
  const [speed, setSpeed] = useState(1);
  const tRef = useRef(animStart);

  const draw = useCallback((t: number) => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const pt = posAt(keyframes, t);
    (map.getSource('anim-point') as maplibregl.GeoJSONSource | undefined)?.setData(
      pt ? { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: pt } } : EMPTY_FC,
    );
    (map.getSource('anim-trail') as maplibregl.GeoJSONSource | undefined)?.setData(
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: trailAt(keyframes, t) } },
    );
  }, [keyframes]);

  // playback loop — advances the clock so the whole trip lasts PLAYBACK_SECONDS
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      let t = tRef.current + dt * (animSpan / PLAYBACK_SECONDS) * speed;
      if (t >= animEnd) {
        t = animEnd;
        tRef.current = t; setAnimT(t); draw(t); setPlaying(false);
        return;
      }
      tRef.current = t; setAnimT(t); draw(t);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, animSpan, animEnd, draw]);

  // editing the plan rebuilds the track: rewind to the start
  useEffect(() => {
    setPlaying(false);
    tRef.current = animStart;
    setAnimT(animStart);
    draw(animStart);
  }, [keyframes, animStart, draw]);

  const togglePlay = () => {
    if (!playing && tRef.current >= animEnd - 0.01) {
      tRef.current = animStart; setAnimT(animStart); draw(animStart);
    }
    setPlaying((p) => !p);
  };
  const scrub = (v: number) => {
    setPlaying(false);
    tRef.current = v; setAnimT(v); draw(v);
  };

  const curLeg = useMemo(() => {
    let leg = -1;
    for (const k of keyframes) {
      if (k.t <= animT) leg = k.leg;
      else break;
    }
    return leg;
  }, [keyframes, animT]);

  useEffect(() => {
    if (!divRef.current || mapRef.current) return;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: divRef.current,
        style: BLANK_STYLE,
        center: [-73.95, 40.73],
        zoom: 10.3,
        attributionControl: false,
      });
    } catch (e) {
      // no WebGL (old browser / headless): the planner still works without the map
      console.error('map unavailable:', e);
      divRef.current.innerHTML =
        '<div style="padding:20px;color:#8b93a7">Map unavailable (WebGL not supported). The plan editor still works.</div>';
      return;
    }
    mapRef.current = map;
    map.on('load', () => {
      map.addSource('routes', { type: 'geojson', data: routeLines });
      map.addSource('plan', { type: 'geojson', data: planLine });
      map.addSource('stations', { type: 'geojson', data: stationPoints });
      map.addSource('anim-trail', { type: 'geojson', data: EMPTY_FC });
      map.addSource('anim-point', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: 'routes', type: 'line', source: 'routes',
        paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.55 },
      });
      map.addLayer({
        id: 'plan-line', type: 'line', source: 'plan',
        paint: {
          'line-color': '#ffffff', 'line-width': 3,
          'line-opacity': 0.9,
          'line-dasharray': ['case', ['==', ['get', 'dashed'], 1], ['literal', [1, 1.5]], ['literal', [1, 0]]],
        },
      });
      map.addLayer({
        id: 'anim-trail', type: 'line', source: 'anim-trail',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#fbbf24', 'line-width': 4.5, 'line-opacity': 0.95 },
      });
      map.addLayer({
        id: 'stations', type: 'circle', source: 'stations',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2.5, 13, 6],
          'circle-color': [
            'match', ['get', 'status'],
            'covered', '#34d399',
            'deadend', '#f87171',
            '#6b7280',
          ],
          'circle-stroke-width': 1,
          'circle-stroke-color': '#0b0e14',
        },
      });
      map.addLayer({
        id: 'plan-numbers', type: 'symbol', source: 'plan',
        layout: {
          'symbol-placement': 'line-center',
          'text-field': ['to-string', ['get', 'n']],
          'text-size': 11,
          'text-font': ['Noto Sans Regular'],
        },
        paint: { 'text-color': '#fff', 'text-halo-color': '#000', 'text-halo-width': 1.5 },
      });
      map.addLayer({
        id: 'anim-glow', type: 'circle', source: 'anim-point',
        paint: { 'circle-radius': 13, 'circle-color': '#fbbf24', 'circle-opacity': 0.25, 'circle-blur': 0.6 },
      });
      map.addLayer({
        id: 'anim-dot', type: 'circle', source: 'anim-point',
        paint: {
          'circle-radius': 7, 'circle-color': '#fbbf24',
          'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff',
        },
      });
      map.on('click', 'stations', (e) => {
        const f = e.features?.[0];
        if (f) onSelect(String(f.properties.id));
      });
      map.on('mouseenter', 'stations', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'stations', () => { map.getCanvas().style.cursor = ''; });
      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
      map.on('mousemove', 'stations', (e) => {
        const f = e.features?.[0];
        if (f && f.geometry.type === 'Point') {
          popup.setLngLat(f.geometry.coordinates as [number, number])
            .setText(String(f.properties.name)).addTo(map);
        }
      });
      map.on('mouseleave', 'stations', () => popup.remove());
      readyRef.current = true;
      draw(tRef.current);
    });
    return () => { map.remove(); mapRef.current = null; readyRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    (map.getSource('stations') as maplibregl.GeoJSONSource | undefined)?.setData(stationPoints);
    (map.getSource('plan') as maplibregl.GeoJSONSource | undefined)?.setData(planLine);
    (map.getSource('routes') as maplibregl.GeoJSONSource | undefined)?.setData(routeLines);
  }, [stationPoints, planLine, routeLines]);

  return (
    <div className="map-wrap">
      <div className="map" ref={divRef} />
      {hasAnim && (
        <div className="map-anim">
          <button className="play" onClick={togglePlay}>{playing ? '⏸ pause' : '▶ play'}</button>
          <input
            type="range"
            min={animStart}
            max={animEnd}
            step={1}
            value={animT}
            onChange={(e) => scrub(Number(e.target.value))}
          />
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="playback speed">
            <option value={0.5}>0.5×</option>
            <option value={1}>1×</option>
            <option value={2}>2×</option>
            <option value={4}>4×</option>
          </select>
          <span className="lbl">
            {fmtClock(animT)}{curLeg >= 0 ? ` · leg ${curLeg + 1}/${plan.legs.length}` : ''}
          </span>
        </div>
      )}
    </div>
  );
}
