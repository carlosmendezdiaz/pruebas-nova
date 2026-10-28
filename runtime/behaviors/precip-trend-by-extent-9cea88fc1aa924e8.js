export default async function install(app) {
  const mount = app.getMount("precip-trend-chart");
  const layer = app.layers[app.config.pointLayerId];
  app.assert(layer, "No se encontró la capa de puntos OpenWeather.");
  const reactiveUtils = await app.import("esri/core/reactiveUtils");
  await layer.load();

  const cfg = app.config;
  const probField = cfg.probabilityField;
  const stepSize = Number(cfg.featuresPerForecastStep || 1128);
  const shortPeriods = Number(cfg.shortWindowPeriods || 2);
  const longPeriods = Number(cfg.longWindowPeriods || 32);
  let runId = 0;
  let timer = null;

  function rootBase() {
    const root = document.createElement("div");
    root.style.font = "12px/1.35 system-ui, sans-serif";
    root.style.color = "var(--calcite-color-text-1, #f3f4f6)";
    root.style.display = "grid";
    root.style.gap = "8px";
    return root;
  }
  function setMessage(text) {
    const root = rootBase();
    const p = document.createElement("p");
    p.textContent = text;
    p.style.margin = "0";
    root.appendChild(p);
    mount.replaceChildren(root);
  }
  function mean(values) {
    const nums = values.filter((v) => Number.isFinite(v));
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  }
  function regression(points) {
    const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pts.length < 2) return null;
    const mx = mean(pts.map((p) => p.x));
    const my = mean(pts.map((p) => p.y));
    let num = 0, den = 0;
    for (const p of pts) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) * (p.x - mx); }
    if (!den) return null;
    return { slope: num / den, intercept: my - (num / den) * mx };
  }

  async function fetchSeries(extent) {
    const series = [];
    for (let period = 0; period <= longPeriods; period++) {
      const q = layer.createQuery();
      q.geometry = extent;
      q.spatialRelationship = "intersects";
      const minOid = period * stepSize + 1;
      const maxOid = (period + 1) * stepSize;
      q.where = `ObjectId >= ${minOid} AND ObjectId <= ${maxOid}`;
      q.returnGeometry = false;
      q.outStatistics = [
        { statisticType: "avg", onStatisticField: probField, outStatisticFieldName: "avg_prob" },
        { statisticType: "count", onStatisticField: probField, outStatisticFieldName: "n" }
      ];
      const r = await layer.queryFeatures(q);
      const a = r.features[0]?.attributes || {};
      const avg = Number(a.avg_prob);
      const n = Number(a.n || 0);
      if (Number.isFinite(avg) && n > 0) series.push({ period, label: `P${period}`, avg, n });
    }
    return series;
  }

  function addSvgText(svg, x, y, text, size = "11") {
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", String(x));
    t.setAttribute("y", String(y));
    t.setAttribute("fill", "currentColor");
    t.setAttribute("font-size", size);
    t.textContent = text;
    svg.appendChild(t);
  }
  function addLine(svg, x1, y1, x2, y2, stroke, width = "1", dash = "") {
    const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
    l.setAttribute("x1", String(x1)); l.setAttribute("y1", String(y1)); l.setAttribute("x2", String(x2)); l.setAttribute("y2", String(y2));
    l.setAttribute("stroke", stroke); l.setAttribute("stroke-width", width); if (dash) l.setAttribute("stroke-dasharray", dash);
    svg.appendChild(l);
  }
  function addPath(svg, d, stroke, width, dash = "") {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d); p.setAttribute("fill", "none"); p.setAttribute("stroke", stroke); p.setAttribute("stroke-width", width); p.setAttribute("stroke-linejoin", "round"); p.setAttribute("stroke-linecap", "round"); if (dash) p.setAttribute("stroke-dasharray", dash);
    svg.appendChild(p);
  }
  function statBox(label, value) {
    const box = document.createElement("div");
    box.style.border = "1px solid var(--calcite-color-border-2, #4b5563)";
    box.style.borderRadius = "8px";
    box.style.padding = "8px";
    box.style.background = "rgba(0,0,0,0.14)";
    const a = document.createElement("div"); a.textContent = label; a.style.opacity = ".75";
    const b = document.createElement("div"); b.textContent = value; b.style.fontSize = "18px"; b.style.fontWeight = "700";
    box.append(a, b);
    return box;
  }

  function draw(series) {
    if (!series.length) { setMessage("No hay puntos de pronóstico en la extensión actual del mapa."); return; }
    const root = rootBase();
    const title = document.createElement("div");
    title.textContent = "Probabilidad de lluvia — promedio en la vista";
    title.style.fontWeight = "700";
    root.appendChild(title);
    const note = document.createElement("div");
    note.textContent = "Eje temporal expresado en periodos de pronóstico (P0, P1, P2…). Se recalcula cuando cambia la extensión del mapa.";
    note.style.opacity = ".78";
    root.appendChild(note);

    const w = Math.max(300, mount.clientWidth || 320);
    const h = 220, padL = 38, padR = 12, padT = 18, padB = 34;
    const maxX = Math.max(...series.map((d) => d.period));
    const minX = Math.min(...series.map((d) => d.period));
    const x = (v) => padL + ((v - minX) / Math.max(1, maxX - minX)) * (w - padL - padR);
    const y = (v) => padT + (1 - Math.max(0, Math.min(100, v)) / 100) * (h - padT - padB);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.style.width = "100%"; svg.style.height = `${h}px`; svg.style.background = "rgba(0,0,0,0.18)"; svg.style.border = "1px solid var(--calcite-color-border-2, #4b5563)"; svg.style.borderRadius = "8px";
    addLine(svg, padL, y(100), w - padR, y(100), "rgba(255,255,255,.18)");
    addLine(svg, padL, y(50), w - padR, y(50), "rgba(255,255,255,.18)");
    addLine(svg, padL, y(0), w - padR, y(0), "rgba(255,255,255,.28)");
    addSvgText(svg, 6, y(100) + 4, "100%"); addSvgText(svg, 12, y(50) + 4, "50%"); addSvgText(svg, 18, y(0) + 4, "0%");
    const path = series.map((d, i) => `${i ? "L" : "M"}${x(d.period).toFixed(1)},${y(d.avg).toFixed(1)}`).join(" ");
    addPath(svg, path, "#4FC3F7", "3");
    const reg = regression(series.map((d) => ({ x: d.period, y: d.avg })));
    if (reg) addPath(svg, `M${x(minX).toFixed(1)},${y(reg.intercept + reg.slope * minX).toFixed(1)} L${x(maxX).toFixed(1)},${y(reg.intercept + reg.slope * maxX).toFixed(1)}`, "#FFD54F", "2", "6 5");
    for (const d of series) {
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", x(d.period).toFixed(1)); c.setAttribute("cy", y(d.avg).toFixed(1)); c.setAttribute("r", "3.2"); c.setAttribute("fill", "#4FC3F7");
      const tt = document.createElementNS("http://www.w3.org/2000/svg", "title"); tt.textContent = `${d.label}: ${d.avg.toFixed(1)}% (${d.n} puntos)`; c.appendChild(tt); svg.appendChild(c);
    }
    addSvgText(svg, padL, h - 10, series[0].label);
    addSvgText(svg, Math.max(padL, w - 78), h - 10, series[series.length - 1].label);
    root.appendChild(svg);

    const shortAvg = mean(series.filter((d) => d.period <= shortPeriods).map((d) => d.avg));
    const longAvg = mean(series.filter((d) => d.period <= longPeriods).map((d) => d.avg));
    const stats = document.createElement("div");
    stats.style.display = "grid"; stats.style.gridTemplateColumns = "1fr 1fr"; stats.style.gap = "8px";
    stats.appendChild(statBox(`Primeros ${shortPeriods + 1} periodos`, shortAvg == null ? "—" : `${shortAvg.toFixed(1)}%`));
    stats.appendChild(statBox(`Hasta P${longPeriods}`, longAvg == null ? "—" : `${longAvg.toFixed(1)}%`));
    root.appendChild(stats);
    const count = document.createElement("div");
    const total = series.reduce((a, b) => a + b.n, 0);
    count.textContent = `${total.toLocaleString()} registros usados en la extensión actual; ${series.length} periodos de pronóstico.`;
    count.style.opacity = ".75";
    root.appendChild(count);
    mount.replaceChildren(root);
  }

  async function update() {
    const id = ++runId;
    const extent = app.view?.extent;
    if (!extent) { setMessage("La vista del mapa aún no está lista."); return; }
    setMessage("Calculando tendencia por periodos de pronóstico…");
    try {
      const series = await fetchSeries(extent);
      if (id !== runId) return;
      draw(series);
    } catch (error) {
      if (id !== runId) return;
      setMessage(`No se pudo calcular la tendencia: ${error?.message || error}`);
    }
  }
  function schedule() { if (timer) clearTimeout(timer); timer = setTimeout(update, 450); }
  const handle = reactiveUtils.watch(() => app.view?.stationary && app.view?.extent, () => schedule(), { initial: true });
  app.onCleanup(() => { if (timer) clearTimeout(timer); handle?.remove?.(); mount.replaceChildren(); });
}