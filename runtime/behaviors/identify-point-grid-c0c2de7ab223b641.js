export default async function install(app) {
  const mount = app.getMount("identify-results");
  const cfg = app.config;
  const pointLayer = app.layers[cfg.pointLayerId];
  const countryLayer = app.layers[cfg.countryLayerId];
  app.assert(pointLayer, "The OpenWeather point layer is missing.");
  app.assert(countryLayer, "The Colombia boundary source layer is missing.");

  const [Graphic, Polygon, Point, unionOperator, containsOperator, intersectsOperator] = await Promise.all([
    app.import("esri/Graphic"), app.import("esri/geometry/Polygon"), app.import("esri/geometry/Point"),
    app.import("esri/geometry/operators/unionOperator"), app.import("esri/geometry/operators/containsOperator"),
    app.import("esri/geometry/operators/intersectsOperator")
  ]);

  function clearAndMessage(text) {
    const root = document.createElement("div");
    root.style.font = "13px/1.45 system-ui, sans-serif";
    root.style.color = "var(--calcite-color-text-1, #f3f4f6)";
    const p = document.createElement("p"); p.textContent = text; root.appendChild(p);
    mount.replaceChildren(root);
  }
  function row(label, value) {
    const dt = document.createElement("dt"); dt.textContent = label; dt.style.fontWeight = "600"; dt.style.marginTop = "8px";
    const dd = document.createElement("dd"); dd.textContent = value == null || value === "" ? "—" : String(value); dd.style.margin = "2px 0 0 0";
    return [dt, dd];
  }
  function renderResult(data) {
    const root = document.createElement("div");
    root.style.font = "13px/1.45 system-ui, sans-serif"; root.style.color = "var(--calcite-color-text-1, #f3f4f6)"; root.style.display = "grid"; root.style.gap = "12px";
    const title = document.createElement("p"); title.textContent = data.title; title.style.fontWeight = "700"; title.style.margin = "0"; root.appendChild(title);
    for (const section of data.sections) {
      const box = document.createElement("section"); box.style.border = "1px solid var(--calcite-color-border-2, #4b5563)"; box.style.borderRadius = "8px"; box.style.padding = "10px"; box.style.background = "rgba(0,0,0,0.18)";
      const h = document.createElement("h3"); h.textContent = section.heading; h.style.margin = "0 0 6px 0"; h.style.fontSize = "14px"; box.appendChild(h);
      const dl = document.createElement("dl"); dl.style.margin = "0";
      for (const item of section.rows) { const [dt, dd] = row(item[0], item[1]); dl.append(dt, dd); }
      box.appendChild(dl); root.appendChild(box);
    }
    mount.replaceChildren(root);
  }

  clearAndMessage("Building the 10-km hex grid. Then click the map to identify the weather point and grid cell.");
  await Promise.all([pointLayer.load(), countryLayer.load()]);
  countryLayer.visible = false;

  const countryQuery = countryLayer.createQuery();
  countryQuery.where = "COUNTRY = 'Colombia'"; countryQuery.outFields = ["COUNTRY", "ISO_CC"]; countryQuery.returnGeometry = true;
  const countryResult = await countryLayer.queryFeatures(countryQuery);
  app.assert(countryResult.features.length > 0, "Could not query the Colombia boundary.");
  const country = countryResult.features.length === 1 ? countryResult.features[0].geometry : unionOperator.executeMany(countryResult.features.map((f) => f.geometry));
  containsOperator.accelerateGeometry(country); intersectsOperator.accelerateGeometry(country);

  async function queryPointRange(where) {
    const q = pointLayer.createQuery(); q.where = where;
    q.outFields = ["ObjectId", "Municipio", "Departamento", "Código_DIVIPOL", cfg.probabilityField];
    q.orderByFields = ["ObjectId ASC"]; q.returnGeometry = true; q.num = 1000;
    return (await pointLayer.queryFeatures(q)).features;
  }
  const pointFeatures = [
    ...(await queryPointRange("ObjectId <= 1000")),
    ...(await queryPointRange("ObjectId > 1000 AND ObjectId <= 1128"))
  ];
  const points = pointFeatures.filter((f) => f.geometry && Number.isFinite(Number(f.attributes[cfg.probabilityField]))).map((f) => ({
    x: f.geometry.x, y: f.geometry.y, p: Number(f.attributes[cfg.probabilityField]), oid: f.attributes.ObjectId,
    municipio: f.attributes.Municipio ?? "", departamento: f.attributes.Departamento ?? "", divipol: f.attributes["Código_DIVIPOL"] ?? ""
  }));
  app.assert(points.length > 0, "No precipitation probability points were available.");

  const gridHandle = await app.createResultLayer({
    id: cfg.gridLayerId, title: "Colombia 10-km Hex Precipitation Probability Grid", geometryType: "polygon",
    fields: [
      { name: "ObjectID", alias: "ObjectID", type: "oid" }, { name: "hex_id", alias: "Hex ID", type: "string" },
      { name: "precip_prob_pct", alias: "Precipitation probability (%)", type: "double" }, { name: "precip_binary", alias: "Binary precipitation class", type: "integer" },
      { name: "precip_class", alias: "Precipitation class", type: "string" }, { name: "threshold_pct", alias: "Threshold (%)", type: "double" },
      { name: "nearest_municipio", alias: "Nearest municipality", type: "string" }, { name: "nearest_departamento", alias: "Nearest department", type: "string" },
      { name: "nearest_distance_km", alias: "Distance to source point (km)", type: "double" }
    ],
    renderer: { type: "unique-value", field: "precip_binary", uniqueValueInfos: [
      { value: 0, label: "Low probability (<50%)", symbol: { type: "simple-fill", color: [255, 213, 79, 0.72], outline: { color: [55, 55, 55, 0.18], width: 0.25 } } },
      { value: 1, label: "High probability (>=50%)", symbol: { type: "simple-fill", color: [30, 136, 229, 0.76], outline: { color: [55, 55, 55, 0.18], width: 0.25 } } }
    ]},
    popupTemplate: { title: "{hex_id}", content: "Precipitation probability: {precip_prob_pct}%<br/>Class: {precip_class}" }
  });
  const gridLayer = gridHandle.layer || gridHandle;
  const replaceFeatures = gridHandle.replaceFeatures || (async (features) => {
    if (gridLayer.applyEdits) await gridLayer.applyEdits({ addFeatures: features });
    else throw new Error("The result layer cannot accept features in this runtime.");
  });

  function nearestPoint(x, y) { let best = null, bestD2 = Infinity; for (const pt of points) { const ddx = pt.x - x, ddy = pt.y - y, d2 = ddx * ddx + ddy * ddy; if (d2 < bestD2) { bestD2 = d2; best = pt; } } return { point: best, distanceMeters: Math.sqrt(bestD2) }; }
  const sr = country.spatialReference, extent = country.extent, flatToFlat = Number(cfg.cellKm) * 1000, side = flatToFlat / Math.sqrt(3), dx = 1.5 * side, dy = flatToFlat, threshold = Number(cfg.threshold);
  function hexRing(cx, cy) { const ring = []; for (let i = 0; i < 6; i++) { const a = Math.PI / 180 * (60 * i); ring.push([cx + side * Math.cos(a), cy + side * Math.sin(a)]); } ring.push(ring[0]); return ring; }
  const features = []; let oid = 1, col = 0;
  for (let x = extent.xmin - side; x <= extent.xmax + side; x += dx, col++) {
    const offsetY = (col % 2) * (dy / 2); let r = 0;
    for (let y = extent.ymin - dy + offsetY; y <= extent.ymax + dy; y += dy, r++) {
      const center = new Point({ x, y, spatialReference: sr }); if (!containsOperator.execute(country, center)) continue;
      const polygon = new Polygon({ rings: [hexRing(x, y)], spatialReference: sr }); if (!intersectsOperator.execute(country, polygon)) continue;
      const nearest = nearestPoint(x, y), prob = Math.max(0, Math.min(100, nearest.point.p)), binary = prob >= threshold ? 1 : 0;
      features.push(new Graphic({ geometry: polygon, attributes: { ObjectID: oid++, hex_id: `COL10K_${col}_${r}`, precip_prob_pct: Math.round(prob * 10) / 10, precip_binary: binary, precip_class: binary ? `High (>=${threshold}%)` : `Low (<${threshold}%)`, threshold_pct: threshold, nearest_municipio: nearest.point.municipio, nearest_departamento: nearest.point.departamento, nearest_distance_km: Math.round((nearest.distanceMeters / 1000) * 100) / 100 }}));
    }
  }
  await replaceFeatures(features); gridLayer.opacity = 0.72; app.map.layers.reorder(gridLayer, 0); pointLayer.visible = true; app.map.layers.reorder(pointLayer, app.map.layers.length - 1);

  let request = 0;
  async function identify(payload = {}) {
    const current = ++request; const mapPoint = payload.mapPoint || payload.event?.mapPoint || payload.event;
    if (!mapPoint) { clearAndMessage("Click the map to identify the weather point and 10-km hex grid cell."); return { ok: false, reason: "no-map-point" }; }
    clearAndMessage("Identifying…");
    const gridQuery = gridLayer.createQuery(); gridQuery.geometry = mapPoint; gridQuery.spatialRelationship = "intersects"; gridQuery.outFields = ["*"]; gridQuery.returnGeometry = false; gridQuery.num = 1;
    const near = nearestPoint(mapPoint.x, mapPoint.y); const gridResult = await gridLayer.queryFeatures(gridQuery);
    if (current !== request) return { ok: false, reason: "superseded" };
    const gridAttrs = gridResult.features[0]?.attributes || null, point = near.point;
    const sections = [
      { heading: "OpenWeather point layer", rows: [["Municipio", point.municipio], ["Departamento", point.departamento], ["Precipitation probability", `${Math.round(point.p * 10) / 10}%`], ["Distance from click", `${Math.round((near.distanceMeters / 1000) * 100) / 100} km`]] },
      { heading: "10-km precipitation grid", rows: gridAttrs ? [["Hex ID", gridAttrs.hex_id], ["Binary class", gridAttrs.precip_class], ["Grid probability", `${gridAttrs.precip_prob_pct}%`], ["Nearest municipality", gridAttrs.nearest_municipio]] : [["Grid cell", "No grid cell at this location"]] }
    ];
    renderResult({ title: "Identify results", sections });
    return { ok: true, pointMunicipio: point.municipio, pointProbability: point.p, gridHexId: gridAttrs?.hex_id ?? null, gridClass: gridAttrs?.precip_class ?? null };
  }
  app.actions.register("identify-at-location", identify);
  clearAndMessage(`Ready. Click the map to identify the OpenWeather point layer and the ${features.length.toLocaleString()}-cell 10-km grid.`);
  app.onCleanup(() => mount.replaceChildren());
}