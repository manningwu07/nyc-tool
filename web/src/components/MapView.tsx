import { useEffect, useMemo, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { NetworkIndex } from '../engine/engine';
import type { Plan, PlanResult } from '../engine/types';

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

  return <div className="map" ref={divRef} />;
}
