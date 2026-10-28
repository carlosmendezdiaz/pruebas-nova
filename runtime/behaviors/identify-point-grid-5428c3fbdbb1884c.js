export default async function install(app) {
  const mount = app.getMount("identify-results");
  const cfg = app.config;
  const pointLayer = app.layers[cfg.pointLayerId];
  const countryLayer = app.layers[cfg.countryLayerId];
  app.assert(pointLayer, "No se encontró la capa de puntos OpenWeather.");
  app.assert(countryLayer, "No se encontró la capa de límites de Colombia.");

  const [Graphic, Polygon, Point, unionOperator, containsOperator, intersectsOperator] = await Promise.all([
    app.import("esri/Graphic"), app.import("esri/geometry/Polygon"), app.import("esri/geometry/Point"),
    app.import("esri/geometry/operators/unionOperator"), app.import("esri/geometry/operators/containsOperator"), app.import("esri/geometry/operators/intersectsOperator")
  ]);

  function mensaje(texto) {
    const root = document.createElement("div");
    root.style.font = "13px/1.45 system-ui, sans-serif";
    root.style.color = "var(--calcite-color-text-1, #f3f4f6)";
    const p = document.createElement("p"); p.textContent = texto; root.appendChild(p);
    mount.replaceChildren(root);
  }
  function fila(etiqueta, valor) {
    const dt = document.createElement("dt"); dt.textContent = etiqueta; dt.style.fontWeight = "600"; dt.style.marginTop = "8px";
    const dd = document.createElement("dd"); dd.textContent = valor == null || valor === "" ? "—" : String(valor); dd.style.margin = "2px 0 0 0";
    return [dt, dd];
  }
  function mostrarResultado(data) {
    const root = document.createElement("div");
    root.style.font = "13px/1.45 system-ui, sans-serif"; root.style.color = "var(--calcite-color-text-1, #f3f4f6)"; root.style.display = "grid"; root.style.gap = "12px";
    const title = document.createElement("p"); title.textContent = data.titulo; title.style.fontWeight = "700"; title.style.margin = "0"; root.appendChild(title);
    for (const section of data.secciones) {
      const box = document.createElement("section"); box.style.border = "1px solid var(--calcite-color-border-2, #4b5563)"; box.style.borderRadius = "8px"; box.style.padding = "10px"; box.style.background = "rgba(0,0,0,0.18)";
      const h = document.createElement("h3"); h.textContent = section.encabezado; h.style.margin = "0 0 6px 0"; h.style.fontSize = "14px"; box.appendChild(h);
      const dl = document.createElement("dl"); dl.style.margin = "0";
      for (const item of section.filas) { const [dt, dd] = fila(item[0], item[1]); dl.append(dt, dd); }
      box.appendChild(dl); root.appendChild(box);
    }
    mount.replaceChildren(root);
  }

  mensaje("Construyendo la cuadrícula hexagonal de 10 km. Después haz clic en el mapa para identificar el punto meteorológico y la celda de cuadrícula.");
  await Promise.all([pointLayer.load(), countryLayer.load()]);
  countryLayer.visible = false;

  const countryQuery = countryLayer.createQuery();
  countryQuery.where = "COUNTRY = 'Colombia'"; countryQuery.outFields = ["COUNTRY", "ISO_CC"]; countryQuery.returnGeometry = true;
  const countryResult = await countryLayer.queryFeatures(countryQuery);
  app.assert(countryResult.features.length > 0, "No se pudo consultar el límite de Colombia.");
  const country = countryResult.features.length === 1 ? countryResult.features[0].geometry : unionOperator.executeMany(countryResult.features.map((f) => f.geometry));
  containsOperator.accelerateGeometry(country); intersectsOperator.accelerateGeometry(country);

  async function consultarRango(where) {
    const q = pointLayer.createQuery(); q.where = where;
    q.outFields = ["ObjectId", "Municipio", "Departamento", "Código_DIVIPOL", cfg.probabilityField];
    q.orderByFields = ["ObjectId ASC"]; q.returnGeometry = true; q.num = 1000;
    return (await pointLayer.queryFeatures(q)).features;
  }
  const pointFeatures = [ ...(await consultarRango("ObjectId <= 1000")), ...(await consultarRango("ObjectId > 1000 AND ObjectId <= 1128")) ];
  const points = pointFeatures.filter((f) => f.geometry && Number.isFinite(Number(f.attributes[cfg.probabilityField]))).map((f) => ({
    x: f.geometry.x, y: f.geometry.y, p: Number(f.attributes[cfg.probabilityField]), oid: f.attributes.ObjectId,
    municipio: f.attributes.Municipio ?? "", departamento: f.attributes.Departamento ?? "", divipol: f.attributes["Código_DIVIPOL"] ?? ""
  }));
  app.assert(points.length > 0, "No hay puntos con probabilidad de precipitación disponible.");

  const gridHandle = await app.createResultLayer({
    id: cfg.gridLayerId, title: "Cuadrícula hexagonal de probabilidad de precipitación de Colombia — 10 km", geometryType: "polygon",
    fields: [
      { name: "ObjectID", alias: "ObjectID", type: "oid" }, { name: "hex_id", alias: "ID de hexágono", type: "string" },
      { name: "precip_prob_pct", alias: "Probabilidad de precipitación (%)", type: "double" }, { name: "precip_binary", alias: "Clase binaria de precipitación", type: "integer" },
      { name: "precip_class", alias: "Clase de precipitación", type: "string" }, { name: "threshold_pct", alias: "Umbral (%)", type: "double" },
      { name: "nearest_municipio", alias: "Municipio más cercano", type: "string" }, { name: "nearest_departamento", alias: "Departamento más cercano", type: "string" },
      { name: "nearest_distance_km", alias: "Distancia al punto fuente (km)", type: "double" }
    ],
    renderer: { type: "unique-value", field: "precip_binary", uniqueValueInfos: [
      { value: 0, label: "Probabilidad baja (<50%)", symbol: { type: "simple-fill", color: [255, 213, 79, 0.72], outline: { color: [55, 55, 55, 0.18], width: 0.25 } } },
      { value: 1, label: "Probabilidad alta (>=50%)", symbol: { type: "simple-fill", color: [30, 136, 229, 0.76], outline: { color: [55, 55, 55, 0.18], width: 0.25 } } }
    ]},
    popupTemplate: { title: "{hex_id}", content: "Probabilidad de precipitación: {precip_prob_pct}%<br/>Clase: {precip_class}" }
  });
  const gridLayer = gridHandle.layer || gridHandle;
  const replaceFeatures = gridHandle.replaceFeatures || (async (features) => {
    if (gridLayer.applyEdits) await gridLayer.applyEdits({ addFeatures: features });
    else throw new Error("La capa de resultados no puede recibir entidades en este entorno.");
  });

  function puntoMasCercano(x, y) { let best = null, bestD2 = Infinity; for (const pt of points) { const dx = pt.x - x, dy = pt.y - y, d2 = dx * dx + dy * dy; if (d2 < bestD2) { bestD2 = d2; best = pt; } } return { point: best, distanceMeters: Math.sqrt(bestD2) }; }
  const sr = country.spatialReference, extent = country.extent, flatToFlat = Number(cfg.cellKm) * 1000, side = flatToFlat / Math.sqrt(3), dx = 1.5 * side, dy = flatToFlat, threshold = Number(cfg.threshold);
  function hexRing(cx, cy) { const ring = []; for (let i = 0; i < 6; i++) { const a = Math.PI / 180 * (60 * i); ring.push([cx + side * Math.cos(a), cy + side * Math.sin(a)]); } ring.push(ring[0]); return ring; }
  const features = []; let oid = 1, col = 0;
  for (let x = extent.xmin - side; x <= extent.xmax + side; x += dx, col++) {
    const offsetY = (col % 2) * (dy / 2); let r = 0;
    for (let y = extent.ymin - dy + offsetY; y <= extent.ymax + dy; y += dy, r++) {
      const center = new Point({ x, y, spatialReference: sr }); if (!containsOperator.execute(country, center)) continue;
      const polygon = new Polygon({ rings: [hexRing(x, y)], spatialReference: sr }); if (!intersectsOperator.execute(country, polygon)) continue;
      const nearest = puntoMasCercano(x, y), prob = Math.max(0, Math.min(100, nearest.point.p)), binary = prob >= threshold ? 1 : 0;
      features.push(new Graphic({ geometry: polygon, attributes: { ObjectID: oid++, hex_id: `COL10K_${col}_${r}`, precip_prob_pct: Math.round(prob * 10) / 10, precip_binary: binary, precip_class: binary ? `Alta (>=${threshold}%)` : `Baja (<${threshold}%)`, threshold_pct: threshold, nearest_municipio: nearest.point.municipio, nearest_departamento: nearest.point.departamento, nearest_distance_km: Math.round((nearest.distanceMeters / 1000) * 100) / 100 }}));
    }
  }
  await replaceFeatures(features); gridLayer.opacity = 0.72; app.map.layers.reorder(gridLayer, 0); pointLayer.visible = true; app.map.layers.reorder(pointLayer, app.map.layers.length - 1);

  let request = 0;
  async function identificar(payload = {}) {
    const current = ++request; const mapPoint = payload.mapPoint || payload.event?.mapPoint || payload.event;
    if (!mapPoint) { mensaje("Haz clic en el mapa para identificar el punto meteorológico y la celda de cuadrícula de 10 km."); return { ok: false, motivo: "sin-punto-de-mapa" }; }
    mensaje("Identificando…");
    const gridQuery = gridLayer.createQuery(); gridQuery.geometry = mapPoint; gridQuery.spatialRelationship = "intersects"; gridQuery.outFields = ["*"]; gridQuery.returnGeometry = false; gridQuery.num = 1;
    const near = puntoMasCercano(mapPoint.x, mapPoint.y); const gridResult = await gridLayer.queryFeatures(gridQuery);
    if (current !== request) return { ok: false, motivo: "reemplazado" };
    const gridAttrs = gridResult.features[0]?.attributes || null, point = near.point;
    const secciones = [
      { encabezado: "Capa de puntos OpenWeather", filas: [["Municipio", point.municipio], ["Departamento", point.departamento], ["Probabilidad de precipitación", `${Math.round(point.p * 10) / 10}%`], ["Distancia desde el clic", `${Math.round((near.distanceMeters / 1000) * 100) / 100} km`]] },
      { encabezado: "Cuadrícula de precipitación de 10 km", filas: gridAttrs ? [["ID de hexágono", gridAttrs.hex_id], ["Clase binaria", gridAttrs.precip_class], ["Probabilidad de la celda", `${gridAttrs.precip_prob_pct}%`], ["Municipio más cercano", gridAttrs.nearest_municipio]] : [["Celda de cuadrícula", "No hay celda en esta ubicación"]] }
    ];
    mostrarResultado({ titulo: "Resultados de identificación", secciones });
    return { ok: true, municipio: point.municipio, probabilidad: point.p, hexagono: gridAttrs?.hex_id ?? null, clase: gridAttrs?.precip_class ?? null };
  }
  app.actions.register("identificar-en-ubicacion", identificar);
  mensaje(`Listo. Haz clic en el mapa para identificar la capa de puntos OpenWeather y la cuadrícula de 10 km con ${features.length.toLocaleString()} celdas.`);
  app.onCleanup(() => mount.replaceChildren());
}