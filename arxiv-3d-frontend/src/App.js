// App.js — no end-of-scroll snap, no Y movement when sepGain=0, click-to-focus anchor

import React, { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import "./App.css";

/** ===== Public Controls (single source of truth) ===== */
const CFG = {
  // zoom range
  kMin: 0.5,
  kMax: 300,

  // wheel behaviour
  wheelBase: 0.0012,
  wheelSlowCoef: 0.10, // extra damping as k grows

  // separation strength
  sepGain: 0.0000000,        // separation added per log-zoom unit (0 => fully off)
  sepgainYoverX: 1.00,  // Y:X separation ratio (0 => only X; big => mostly Y)

  // acceleration when tiles get big enough
  accelfromWidth: 150,  // start accelerating separation around this rendered width (px)
  accelPow: 2,          // curve power

  // gentle decay near home zoom (prevents permanent drift)
  autoReturn: { enabled: false, kHome: 1.0, epsilonK: 0.10, halfLifeMs: 900 },
};

/** Internals derived from CFG */
const yZoomAlphaFromSep = (sepGain) => (sepGain === 0 ? 0 : 1);

// helpers
const jitterMaxLaneUnits = 0.35;
const hash32 = (s) => { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const hashUnit = (s) => hash32(String(s)) / 4294967296;
const jitterLane = (id) => (hashUnit(id) - 0.5) * 2 * jitterMaxLaneUnits;
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / Math.max(1e-6, b - a))); return t * t * (3 - 2 * t); };

export default function App() {
  const svgRef = useRef(null);
  const wrapRef = useRef(null);
  const tooltipRef = useRef(null);

  const [rawNodes, setRawNodes] = useState([]);
  const [rawEdges, setRawEdges] = useState([]);
  const [selected, setSelected] = useState(null);

  const nodeByIdRef = useRef(new Map());
  const sepAccumRef = useRef(new Map());                 // id -> {x, y}
  const sessionRef  = useRef(null);                      // {active, mode, logK0, incNow, coeffById, vpYear, vpLane, yStart}
  const lockedIdRef = useRef(null);                      // selected node id
  const focusLockRef = useRef(null);                     // node id that anchors zoom across gestures
  const correctedTRef = useRef(null);                    // last glued/frozen transform to commit on end
  const committingRef = useRef(false);                   // re-entrancy guard for transform commit
  const isMobileRef = useRef(false);

  // cooldowns to avoid wheel/click races
  const lastWheelTsRef = useRef(0);
  const INTERACT = { CLICK_MS: 200, HOVER_MS: 140, COOLDOWN_MS: 220 };
  const now = () => performance.now();
  const inCooldown = () => (now() - lastWheelTsRef.current) < INTERACT.COOLDOWN_MS;

  /** Load data */
  useEffect(() => {
    Promise.all([
      fetch("./nodes.json").then(r => r.json()),
      fetch("./edges.json").then(r => r.json()),
    ])
      .then(([n, e]) => {
        setRawNodes(Array.isArray(n) ? n : []);
        setRawEdges(Array.isArray(e) ? e : []);
      })
      .catch(err => console.error("Failed to load:", err));
  }, []);

  /** Normalize nodes */
  const nodes = useMemo(() => {
    const ns = (rawNodes || []).map(d => {
      const yr = d.year ?? d.publication_year ?? (d.publicationDate ? new Date(d.publicationDate).getFullYear() : undefined);
      const field = d.AI_primary_field || d.field || d.primary_field || "Unassigned";
      const cites = d.citationCount ?? d.cited_by_count ?? 0;
      return {
        ...d,
        id: String(d.id),
        year: Number.isFinite(+yr) ? +yr : undefined,
        field,
        citationCount: Number.isFinite(+cites) ? +cites : 0,
        authors: d.authors || d.authors_text || d.author,
        url: d.url || d.doi_url || d.openAlexUrl || d.s2Url,
      };
    });
    nodeByIdRef.current = new Map(ns.map(n => [n.id, n]));
    return ns;
  }, [rawNodes]);

  /** Edges filtered to existing nodes */
  const edges = useMemo(() => {
    const m = nodeByIdRef.current; const out = [];
    for (const e of (rawEdges || [])) {
      const s = m.get(String(e.source)); const t = m.get(String(e.target));
      if (s && t) out.push({ source: s.id, target: t.id });
    }
    return out;
  }, [rawEdges]);

  /** adjacency */
  const edgesByNode = useMemo(() => {
    const m = new Map(); nodes.forEach(n => m.set(n.id, []));
    edges.forEach((e, i) => { m.get(e.source)?.push(i); m.get(e.target)?.push(i); });
    return m;
  }, [nodes, edges]);

  /** fields and years */
  const { fields, fieldIndex, yearsDomain } = useMemo(() => {
    const fields = Array.from(new Set(nodes.map(d => d.field))).sort();
    const fieldIndex = f => Math.max(0, fields.indexOf(f ?? "Unassigned"));
    const years = nodes.map(d => d.year).filter(v => Number.isFinite(v));
    const minY = years.length ? d3.min(years) : 1950, maxY = years.length ? d3.max(years) : 2025;
    return { fields, fieldIndex, yearsDomain: [minY - 1, maxY + 1] };
  }, [nodes]);

  /** z & sizes (presentation only) */
  useEffect(() => {
    const [minC, maxC] = d3.extent(nodes, d => d.citationCount);
    const z = d3.scaleLinear().domain([minC ?? 0, maxC ?? 1]).range([0, 1]);
    nodes.forEach(d => { d.z = z(d.citationCount); });
  }, [nodes]);

  const baseTileSize = useMemo(() => {
    const [minC, maxC] = d3.extent(nodes, d => d.citationCount);
    const s = d3.scaleSqrt().domain([Math.max(1, minC ?? 1), Math.max(2, maxC ?? 2)]).range([12, 54]);
    return d => {
      const base = s(Math.max(1, d.citationCount));
      return { w: base * 1.8, h: base * 1.1, rxBase: 8 };
    };
  }, [nodes]);

  /** keep sep map aligned with nodes */
  useEffect(() => {
    const acc = sepAccumRef.current;
    for (const n of nodes) if (!acc.has(n.id)) acc.set(n.id, { x: 0, y: 0 });
    for (const id of Array.from(acc.keys())) if (!nodeByIdRef.current.has(id)) acc.delete(id);
  }, [nodes]);

  useEffect(() => { lockedIdRef.current = selected?.id || null; }, [selected]);

  /** MAIN D3 SCENE */
  useEffect(() => {
    if (!wrapRef.current || !svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const vw = typeof window !== "undefined" ? window.innerWidth : 1400;
    const vh = typeof window !== "undefined" ? window.innerHeight : 900;
    const margin = { top: 28, right: 28, bottom: 48, left: 180 };
    const cw = Math.max(720, (wrapRef.current.clientWidth || vw * 0.96));
    const ch = Math.max(1000, (wrapRef.current.clientHeight || vh * 0.86));
    const width = cw - margin.left - margin.right;
    const height = ch - margin.top - margin.bottom;

    const updateMobileFlag = () => { isMobileRef.current = window.matchMedia("(max-width: 768px)").matches; };
    updateMobileFlag();

    svg.attr("width", cw).attr("height", ch).style("display", "block").style("background", "#f5f5f7");

    const gRoot = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
    const gPlot = gRoot.append("g").attr("class", "plot");
    const gAxes = gRoot.append("g").attr("class", "axes");

    const x = d3.scaleLinear().domain(yearsDomain).range([0, width]);
    const yLane = d3.scaleLinear().domain([0, Math.max(0, fields.length - 1)]).range([0, height]);
    const color = d3.scaleOrdinal(d3.schemeTableau10).domain(fields);

    const xAxisG = gAxes.append("g")
      .attr("transform", `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(10).tickFormat(d3.format("d")));

    const yAxisG = gAxes.append("g")
      .call(d3.axisLeft(yLane).tickValues(fields.map((_, i) => i)).tickFormat(i => fields[i]));

    const applyAxisVisibility = () => { yAxisG.style("display", isMobileRef.current ? "none" : null); };
    applyAxisVisibility();

    const edgesG = gPlot.append("g").attr("class", "edges");
    const nodesG = gPlot.append("g").attr("class", "nodes");

    const nodesSel = nodesG.selectAll("g.node").data(nodes, d => d.id).join(enter => {
      const g = enter.append("g").attr("class", "node").style("cursor", "pointer");
      g.append("rect")
        .attr("class", "node-rect")
        .attr("stroke", "#333")
        .attr("fill", d => color(d.field))
        .attr("opacity", 0.85)
        .attr("vector-effect", "non-scaling-stroke");
      return g;
    });

    let edgesSel = edgesG.selectAll("path.edge").data([], d => d ? `${d.source}->${d.target}` : undefined)
      .join("path")
      .attr("class", "edge")
      .attr("fill", "none")
      .attr("stroke", "#444")
      .attr("stroke-width", 1.2)
      .attr("vector-effect", "non-scaling-stroke")
      .style("display", "none");

    const nodeWidthAtK = (d, k) => {
      const base = baseTileSize(d);
      const sizeBoost = 0.9 + 0.4 * (d.z ?? 0.5);
      return base.w * Math.pow(k, 1.2) * sizeBoost;
    };

    // wheel delta solely from CFG
    function wheelDelta(ev) {
      const dy = -ev.deltaY;
      const mode = ev.deltaMode;
      const kNow = d3.zoomTransform(svg.node()).k;
      const base = mode === 1 ? 0.03 : mode === 2 ? 0.25 : CFG.wheelBase;
      const slow = 1 + CFG.wheelSlowCoef * Math.max(0, kNow - 1);
      const speedUp = 1 + 0.65 * ((kNow - 1) / (kNow + 1));
      const raw = (dy * base * speedUp) / slow;
      const floor = 0.0017 + 0.0007 * Math.sqrt(Math.max(1, kNow));
      return Math.sign(raw) * Math.max(Math.abs(raw), floor);
    }

    // pointer to plot coords
    function pointerInPlot(sourceEvent) {
      const [px, py] = d3.pointer(sourceEvent, gRoot.node());
      return [Math.max(0, Math.min(width, px)), Math.max(0, Math.min(height, py))];
    }

    // locality weights
    function buildFocalWeights(t, fxPlot, fyPlot) {
      const invX = t.rescaleX(x), invY = t.rescaleY(yLane);
      const yearAt = invX.invert(fxPlot), laneAt = invY.invert(fyPlot);
      const k = t.k, baseR = 360 / Math.sqrt(k);
      const wById = new Map();
      for (const d of nodes) {
        const px = x(d.year ?? yearsDomain[0]) - x(yearAt);
        const py = yLane(fieldIndex(d.field) + jitterLane(d.id)) - yLane(laneAt);
        const dd = Math.sqrt((px * px + py * py) / (baseR * baseR));
        wById.set(d.id, Math.exp(-dd * dd));
      }
      return wById;
    }

    // Y zoom blend: off when sepGain==0
    const yZoomAlpha = yZoomAlphaFromSep(CFG.sepGain);
    function yBlendAt(t, lane) {
      const yZoom = t.rescaleY(yLane)(lane);  // pan+zoom
      const yPan  = yLane(lane) + t.y;        // pan-only
      return (1 - yZoomAlpha) * yPan + yZoomAlpha * yZoom;
    }

    // auto-decay for separation
    let lastDecayTs = performance.now();
    function maybeDecay(k) {
      const ar = CFG.autoReturn; if (!ar.enabled) return;
      const within = Math.abs(k - ar.kHome) <= (ar.kHome * ar.epsilonK);
      if (!within) { lastDecayTs = performance.now(); return; }
      const tNow = performance.now(); const dt = tNow - lastDecayTs; if (dt <= 0) return; lastDecayTs = tNow;
      const decay = Math.pow(0.5, dt / Math.max(100, ar.halfLifeMs));
      const acc = sepAccumRef.current;
      for (const [id, v] of acc) acc.set(id, { x: v.x * decay, y: v.y * decay });
    }

    // rAF coalescing
    let rafId = null, pendingT = null;

    // current anchor (absolute screen + inverse coords)
    const focalRef = { fxAbs: null, fyAbs: null, vpYear: null, vpLane: null };

    const zoom = d3.zoom()
      .scaleExtent([CFG.kMin, CFG.kMax])
      .wheelDelta(wheelDelta)
      .translateExtent([[-1e7, -1e7], [width + 1e7, height + 1e7]])
      .filter(ev => !(ev.ctrlKey && ev.type === "wheel"))
      .on("start", (ev) => {
        if (committingRef.current) return; // ignore synthetic start during commit
        const se = ev?.sourceEvent;
        const isZoom = !!se && (se.type === "wheel" || se.type === "gesturechange" || se.type === "dblclick" || (se.touches && se.touches.length === 2));
        const t = d3.zoomTransform(svg.node());

        sessionRef.current = {
          active: true,
          mode: isZoom ? "zoom" : "pan",
          logK0: Math.log(Math.max(1e-6, t.k)),
          incNow: 0,
          coeffById: null,
          vpYear: null,
          vpLane: null,
          yStart: t.y, // freeze Y during zoom if sepGain == 0
        };

        if (isZoom) {
          // anchor: locked node (if any) else pointer
          let fxPlot, fyPlot, vpYear, vpLane;
          const locked = focusLockRef.current ? nodeByIdRef.current.get(focusLockRef.current) : null;

          if (locked) {
            const lane = fieldIndex(locked.field) + jitterLane(locked.id);
            fxPlot = t.rescaleX(x)(locked.year ?? yearsDomain[0]);
            fyPlot = yBlendAt(t, lane);
            vpYear = t.rescaleX(x).invert(fxPlot);
            vpLane = t.rescaleY(yLane).invert(fyPlot);
          } else {
            const [px, py] = se ? pointerInPlot(se) : [width / 2, height / 2];
            fxPlot = px; fyPlot = py;
            const invX = t.rescaleX(x), invY = t.rescaleY(yLane);
            vpYear = invX.invert(fxPlot); vpLane = invY.invert(fyPlot);
          }

          focalRef.fxAbs = margin.left + fxPlot;
          focalRef.fyAbs = margin.top + fyPlot;
          focalRef.vpYear = vpYear;
          focalRef.vpLane = vpLane;

          sessionRef.current.vpYear = vpYear;
          sessionRef.current.vpLane = vpLane;
          sessionRef.current.coeffById = buildFocalWeights(t, fxPlot, fyPlot);
        } else {
          focalRef.fxAbs = focalRef.fyAbs = null;
          focalRef.vpYear = focalRef.vpLane = null;
        }
      })
      .on("zoom", (ev) => {
        if (committingRef.current) return; // ignore synthetic zoom during commit
        const t = ev.transform;
        const s = sessionRef.current;
        if (s?.mode === "zoom") {
          lastWheelTsRef.current = now();
          s.incNow = Math.log(Math.max(1e-6, t.k)) - s.logK0;
        } else {
          s.incNow = 0;
          focalRef.fxAbs = focalRef.fyAbs = null;
          focalRef.vpYear = focalRef.vpLane = null;
        }
        pendingT = t;
        if (!rafId) {
          rafId = requestAnimationFrame(() => {
            const tr = pendingT || d3.zoomTransform(svg.node());
            pendingT = null; rafId = null;
            renderWithTransform(tr);
          });
        }
      })
      .on("end", () => {
        if (committingRef.current) return; // ignore synthetic end during commit
        const s = sessionRef.current;
        if (!s?.active) return;

        // If we produced a glued/frozen transform, commit it asynchronously
        if (correctedTRef.current) {
          const finalT = correctedTRef.current;
          correctedTRef.current = null;
          committingRef.current = true;
          setTimeout(() => {
            // This triggers a synthetic zoom+end; the guards above prevent recursion
            svg.call(zoom.transform, finalT);
            committingRef.current = false;
          }, 0);
          // do not continue with separation on this end; it will re-render next tick
          s.active = false; s.incNow = 0;
          return;
        }

        // final settle frame (no snap)
        requestAnimationFrame(() => renderWithTransform(d3.zoomTransform(svg.node())));

        const sepEnabled = (CFG.sepGain !== 0);
        if (s.mode !== "zoom" || Math.abs(s.incNow) < 0.015 || !sepEnabled) {
          s.active = false; s.incNow = 0; return;
        }

        const kNow = d3.zoomTransform(svg.node()).k;
        const addScale = CFG.sepGain * s.incNow;

        if (addScale !== 0) {
          const ratio = Math.max(0, CFG.sepgainYoverX);
          const wX = 1;
          const wY = Number.isFinite(ratio) ? ratio : 1e6; // huge => only Y
          for (const d of nodes) {
            const lane = fieldIndex(d.field) + jitterLane(d.id);
            const px = x(d.year ?? yearsDomain[0]) - x(s.vpYear ?? (d.year ?? yearsDomain[0]));
            const py = yLane(lane) - yLane(s.vpLane ?? lane);
            let vx = px * wX, vy = py * wY;
            const norm = Math.hypot(vx, vy) || 1; vx /= norm; vy /= norm;

            const w = nodeWidthAtK(d, kNow);
            const accelU = smoothstep(CFG.accelfromWidth, CFG.accelfromWidth * 1.8, w);
            const accel = w <= CFG.accelfromWidth ? 0 : Math.pow(accelU, CFG.accelPow);

            const local = s.coeffById?.get(d.id) ?? 0;
            const mag = addScale * (0.25 + 0.75 * local) * (1 + accel);

            const prev = sepAccumRef.current.get(d.id) || { x: 0, y: 0 };
            sepAccumRef.current.set(d.id, { x: prev.x + mag * vx, y: prev.y + mag * vy });
          }
        }

        s.active = false;
        s.incNow = 0;
      });

    svg.call(zoom);
    svg.on("dblclick.zoom", null);

    function renderWithTransform(rawT) {
      let t = rawT;

      // Keep anchor glued during zoom
      if (sessionRef.current?.active && sessionRef.current.mode === "zoom" &&
          focalRef.fxAbs != null && focalRef.fyAbs != null) {

        let xAbsNow = null, yAbsNow = null;

        if (focusLockRef.current) {
          const nd = nodeByIdRef.current.get(focusLockRef.current);
          if (nd) {
            const lane = fieldIndex(nd.field) + jitterLane(nd.id);
            xAbsNow = margin.left + t.rescaleX(x)(nd.year ?? yearsDomain[0]);
            yAbsNow = margin.top  + yBlendAt(t, lane);
          }
        }

        if (xAbsNow == null || yAbsNow == null) {
          const vpYear = sessionRef.current?.vpYear ?? focalRef.vpYear;
          const vpLane = sessionRef.current?.vpLane ?? focalRef.vpLane;
          if (vpYear != null && vpLane != null) {
            xAbsNow = margin.left + t.rescaleX(x)(vpYear);
            yAbsNow = margin.top  + yBlendAt(t, vpLane);
          }
        }

        if (xAbsNow != null && yAbsNow != null) {
          let dx = focalRef.fxAbs - xAbsNow;
          let dy = focalRef.fyAbs - yAbsNow;

          // Freeze Y during zoom when sepGain==0 (no vertical shift at all)
          if (CFG.sepGain === 0) {
            dy = 0;
            const yFrozen = sessionRef.current?.yStart ?? t.y;
            t = d3.zoomIdentity.translate(t.x + dx, yFrozen).scale(t.k);
          } else {
            t = d3.zoomIdentity.translate(t.x + dx, t.y + dy).scale(t.k);
          }

          correctedTRef.current = t; // remember glued (or frozen) transform for commit on end
        } else {
          correctedTRef.current = null;
        }
      } else {
        correctedTRef.current = null;
      }

      const k = t.k;
      const newX = t.rescaleX(x);
      const newY = (lane) => yBlendAt(t, lane);

      maybeDecay(k);

      const sepEnabled = (CFG.sepGain !== 0);
      const P = new Map();

      // position nodes
      nodesSel.each(function (d) {
        const lane = fieldIndex(d.field) + jitterLane(d.id);
        const baseX = newX(d.year ?? yearsDomain[0]);
        const baseY = newY(lane);

        const v = sepAccumRef.current.get(d.id) || { x: 0, y: 0 };
        const sepX = sepEnabled ? (v.x * (360 / Math.sqrt(k))) : 0;
        const sepY = sepEnabled ? (v.y * (360 / Math.sqrt(k))) : 0;

        const cx = baseX + sepX;
        const cy = baseY + sepY;

        const bs = baseTileSize(d);
        const s = Math.pow(k, 1.2) * (0.9 + 0.4 * (d.z ?? 0.5));
        const tile = { w: bs.w * s, h: bs.h * s, rx: Math.min(bs.rxBase * Math.pow(k, 0.5), 16) };

        d3.select(this).attr("transform", `translate(${cx - tile.w / 2},${cy - tile.h / 2})`);
        d3.select(this).select("rect.node-rect")
          .attr("width", tile.w)
          .attr("height", tile.h)
          .attr("rx", tile.rx)
          .attr("ry", tile.rx)
          .attr("fill", color(d.field));
        P.set(d.id, { cx, cy, w: tile.w, h: tile.h });
      });

      // edges
      const centerOf = id => { const p = P.get(id); return p ? { x: p.cx, y: p.cy } : null; };
      edgesSel.attr("d", e => {
        const sC = centerOf(e.source), tC = centerOf(e.target);
        if (!sC || !tC) return null;
        const xm = (sC.x + tC.x) / 2, ym = (sC.y + tC.y) / 2;
        return `M${sC.x},${sC.y} L${xm},${ym} L${tC.x},${tC.y}`;
      });

      // axes: X zoom follows k; Y is pan-only (and frozen during sepGain==0 zoom)
      const yForAxis = (CFG.sepGain === 0 && sessionRef.current?.active && sessionRef.current.mode === "zoom")
        ? (sessionRef.current?.yStart ?? t.y) : t.y;

      yAxisG.attr("transform", `translate(0,${yForAxis})`)
        .call(d3.axisLeft(yLane).tickValues(fields.map((_, i) => i)).tickFormat(i => fields[i]));
      xAxisG.call(d3.axisBottom(newX).ticks(10).tickFormat(d3.format("d")));
    }

    function showEdgesFor(id) {
      const idxs = edgesByNode.get(id) || [];
      const subset = idxs.map(i => edges[i]);
      edgesSel = edgesG.selectAll("path.edge")
        .data(subset, d => d ? `${d.source}->${d.target}` : undefined)
        .join("path")
        .attr("class", "edge")
        .attr("fill", "none")
        .attr("stroke", "none") // still there, but visually silent unless you want to show them
        .attr("vector-effect", "non-scaling-stroke");
      edgesSel.style("display", subset.length ? null : "none");
      edgesSel.raise();
    }

    function hideAllEdges() { edgesSel.style("display", "none"); }

    function highlightNeighborhood(id, { raise = false } = {}) {
      const idxs = edgesByNode.get(id) || [];
      const sset = new Set([id]);
      idxs.forEach(i => { const e = edges[i]; sset.add(e.source); sset.add(e.target); });
      nodesSel.selectAll("rect.node-rect").each(function (d) {
        const isN = sset.has(d.id);
        d3.select(this)
          .attr("opacity", isN ? 0.95 : 0.25)
          .attr("stroke-width", isN ? 2.2 : 1.0);
      });
      if (raise) {
        nodesSel.filter(d => sset.has(d.id)).raise();
        nodesSel.filter(d => d.id === id).raise();
      }
    }

    function resetNodeStyles() {
      nodesSel.selectAll("rect.node-rect")
        .attr("opacity", d => 0.85 * (0.6 + 0.4 * (d.z ?? 0.5)))
        .attr("stroke-width", 1.2)
        .attr("fill", d => color(d.field));
    }

    // Node events
    nodesSel
      .on("mouseover", function (_, d) {
        if (inCooldown() || focusLockRef.current) return;
        if (!lockedIdRef.current) { showEdgesFor(d.id); highlightNeighborhood(d.id, { raise: true }); renderWithTransform(d3.zoomTransform(svg.node())); }
      })
      .on("mouseout", function () {
        if (inCooldown() || focusLockRef.current) return;
        if (!lockedIdRef.current) { hideAllEdges(); resetNodeStyles(); renderWithTransform(d3.zoomTransform(svg.node())); }
      })
      .on("mousemove", (event, d) => {
        if (inCooldown()) return;
        const t = tooltipRef.current; if (!t) return;
        t.style.display = "block";
        t.style.left = `${event.pageX + 12}px`;
        t.style.top = `${event.pageY + 12}px`;
        t.innerHTML = `<strong>${d.title || "Untitled"}</strong><br/>${d.authors ? `<span>${d.authors}</span><br/>` : ""}<em>${d.field}</em> • ${d.year ?? "n/a"}<br/><strong>Citations:</strong> ${d.citationCount}${d.url ? `<br/><a href="${d.url}" target="_blank" rel="noreferrer">Open source</a>` : ""}`;
      })
      .on("mouseleave", () => { const t = tooltipRef.current; if (t) t.style.display = "none"; })
      .on("click", function (event, d) {
        if ((now() - lastWheelTsRef.current) < INTERACT.CLICK_MS) return;
        event.stopPropagation();
        if (lockedIdRef.current === d.id) {
          lockedIdRef.current = null;
          focusLockRef.current = null;
          setSelected(null);
          hideAllEdges(); resetNodeStyles();
        } else {
          lockedIdRef.current = d.id;
          focusLockRef.current = d.id;
          setSelected(d);
          showEdgesFor(d.id); highlightNeighborhood(d.id, { raise: true });

          // freeze absolute anchor on this node for immediate stability
          const tNow = d3.zoomTransform(svg.node());
          const lane = fieldIndex(d.field) + jitterLane(d.id);
          const fxPlot = tNow.rescaleX(x)(d.year ?? yearsDomain[0]);
          const fyPlot = yBlendAt(tNow, lane);
          focalRef.fxAbs = margin.left + fxPlot;
          focalRef.fyAbs = margin.top + fyPlot;
          focalRef.vpYear = tNow.rescaleX(x).invert(fxPlot);
          focalRef.vpLane = tNow.rescaleY(yLane).invert(fyPlot);
        }
        renderWithTransform(d3.zoomTransform(svg.node()));
      });

    // Background click => unlock
    svg.on("click", () => {
      if ((now() - lastWheelTsRef.current) < INTERACT.CLICK_MS) return;
      lockedIdRef.current = null;
      focusLockRef.current = null;
      setSelected(null);
      hideAllEdges(); resetNodeStyles();
      renderWithTransform(d3.zoomTransform(svg.node()));
    });

    // Responsive
    const onResize = () => { renderWithTransform(d3.zoomTransform(svg.node())); updateMobileFlag(); applyAxisVisibility(); };
    window.addEventListener("resize", onResize);
    renderWithTransform(d3.zoomTransform(svg.node()));

    return () => {
      window.removeEventListener("resize", onResize);
      svg.on(".zoom", null).on("click", null);
    };
  }, [nodes, edges, fields, yearsDomain]);

  return (
    <div className="app-wrap" ref={wrapRef} style={{ position: "relative" }}>
      <svg ref={svgRef} />
      <div
        ref={tooltipRef}
        className="tooltip"
        style={{
          position: "absolute",
          display: "none",
          background: "rgba(255,255,255,0.98)",
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: "8px 10px",
          boxShadow: "0 6px 18px rgba(0,0,0,0.12)",
          pointerEvents: "none",
          maxWidth: 380,
          zIndex: 10
        }}
      />
    </div>
  );
}
