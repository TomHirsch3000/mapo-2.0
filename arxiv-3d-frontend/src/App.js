// App.js — All node movement depends on sepGain, anchored to selected node OR mouse.
// X AND Y both blended by sepGain:
// • xBlendAt(t, year)  = ((1-a)+a*k)*x(year) + t.x
// • yBlendAt(t, lane)  = ((1-a)+a*k)*yLane(lane) + t.y
// with a = yZoomAlphaFromSep(sepGain).
// Separation accumulation & display ∝ sepGain; auto-decay scaled by sepGain.
// Anchor is chosen once per gesture (selected node or mouse), removing wobble.

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
  wheelSlowCoef: 0.10,

  // separation strength (continuous)
  sepGain: 0.5,        // 0 => no X/Y zoom component; separation off; Y frozen during zoom
  sepgainYoverX: 1.00,  // relative Y weight vs X inside separation vectors

  // acceleration when tiles get big enough (smooth ramp)
  accelfromWidth: 150,
  accelPow: 2,

  // gentle decay near home zoom (prevents permanent drift)
  autoReturn: { enabled: false, kHome: 1.0, epsilonK: 0.10, halfLifeMs: 900 },
};

/** Internals derived from CFG */
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const yZoomAlphaFromSep = (g) => clamp01(g); // tie both axis zoom components to sepGain

// jitter helpers
const jitterMaxLaneUnits = 0.35;
const hash32 = (s) => { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const hashUnit = (s) => hash32(String(s)) / 4294967296;
const jitterLane = (id) => (hashUnit(id) - 0.5) * 2 * jitterMaxLaneUnits;
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / Math.max(1e-6, b - a)); return t * t * (3 - 2 * t); };

// grey palette
const GREY_FILL = "#d8dbe1";
const GREY_STROKE = "#8e96a3";

// glue epsilon scaled by sepGain to suppress micro-commits
const baseGlueEps = 0.8;
const epsGlue = () => {
  const g = clamp01(CFG.sepGain);
  return Math.max(0.6, baseGlueEps * (0.9 + 0.6 * g));
};

export default function App() {
  const svgRef = useRef(null);
  const wrapRef = useRef(null);
  const tooltipRef = useRef(null);

  const [rawNodes, setRawNodes] = useState([]);
  const [rawEdges, setRawEdges] = useState([]);
  const [selected, setSelected] = useState(null);

  const nodeByIdRef = useRef(new Map());
  const sepAccumRef = useRef(new Map());                 // id -> {x, y}
  const sessionRef  = useRef(null);                      // gesture session info
  const lockedIdRef = useRef(null);                      // selected node id
  const focusLockRef = useRef(null);                     // selected id used for anchoring
  const correctedTRef = useRef(null);                    // glued transform to commit
  const glueDeltaRef = useRef({ dx: 0, dy: 0 });         // latest glue delta
  const committingRef = useRef(false);
  const isMobileRef = useRef(false);

  // highlight state
  const highlightSetRef = useRef(null);
  const highlightRootRef = useRef(null);

  // live mouse (plot coords) — only used to pick the anchor at zoom.start
  const mousePlotRef = useRef({ x: null, y: null });

  // zoom/anchor state (frozen per-gesture)
  // vpYear/vpLane: canonical anchor in data coords; fxAbs/fyAbs: absolute screen anchor (pixels)
  const zStateRef = useRef({ fxAbs: null, fyAbs: null, vpYear: null, vpLane: null });

  // cooldowns
  const lastWheelTsRef = useRef(0);
  const INTERACT = { CLICK_MS: 200, HOVER_MS: 140, COOLDOWN_MS: 220 };

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
        title: d.title || d.display_name || "Untitled",
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

      // Base rectangle
      g.append("rect")
        .attr("class", "node-rect")
        .attr("stroke", "#333")
        .attr("fill", d => color(d.field))
        .attr("opacity", 0.85)
        .attr("vector-effect", "non-scaling-stroke");

      // Thin top border/line (shown only when label visible)
      g.append("line")
        .attr("class", "node-header")
        .attr("x1", 0).attr("y1", 0)
        .attr("x2", 0).attr("y2", 0)
        .attr("stroke", "#1f2937")
        .attr("stroke-opacity", 0.25)
        .attr("vector-effect", "non-scaling-stroke")
        .style("display", "none");

      // Wrapped label via foreignObject (only for selected & neighbours)
      const fo = g.append("foreignObject")
        .attr("class", "node-label")
        .attr("x", 0).attr("y", 0)
        .attr("width", 0).attr("height", 0)
        .style("display", "none")
        .style("pointer-events", "none");

      fo.append("xhtml:div")
        .attr("class", "label-div")
        .style("width", "100%")
        .style("height", "100%")
        .style("overflow", "hidden")
        .style("word-wrap", "break-word")
        .style("text-overflow", "ellipsis")
        .style("line-height", "1.15")
        .style("font-weight", "600")
        .style("font-family", "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial")
        .style("color", "#111827")
        .text(d => d.title || "Untitled");

      return g;
    });

    // edges path selection (bound dynamically to current highlight)
    let edgesSel = edgesG.selectAll("path.edge").data([], d => d ? `${d.source}->${d.target}` : undefined)
      .join("path")
      .attr("class", "edge")
      .attr("fill", "none")
      .attr("stroke", "#5b6573")
      .attr("stroke-opacity", 0.7)
      .attr("stroke-width", 1.6)
      .attr("vector-effect", "non-scaling-stroke")
      .style("display", "none");

    const nodeWidthAtK = (d, k) => {
      const base = baseTileSize(d);
      const sizeBoost = 0.9 + 0.4 * (d.z ?? 0.5);
      return base.w * Math.pow(k, 1.2) * sizeBoost;
    };

    // wheel delta independent of sepGain; anchor glue removes perceived jump.
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

    // pointer to plot coords, clamped
    function pointerInPlot(sourceEvent) {
      const [px0, py0] = d3.pointer(sourceEvent, gRoot.node());
      const px = Math.max(0, Math.min(width, px0));
      const py = Math.max(0, Math.min(height, py0));
      return [px, py];
    }

    // track mouse (used only to choose anchor at gesture start)
    svg.on("pointermove", (ev) => {
      const [px, py] = pointerInPlot(ev);
      mousePlotRef.current = { x: px, y: py };
    });

    // ----- Blended X & Y (forward and inverse) -----
    const a = yZoomAlphaFromSep(CFG.sepGain); // 0..1 based on sepGain

    function xBlendAt(t, year) {
      // xBlend = [(1-a) + a*k] * x(year) + t.x
      const kx = (1 - a) + a * t.k;
      return kx * x(year) + t.x;
    }
    function invXBlendYear(t, fx) {
      const kx = (1 - a) + a * t.k;
      return x.invert((fx - t.x) / Math.max(1e-6, kx));
    }

    function yBlendAt(t, lane) {
      // yBlend = [(1-a) + a*k] * yLane(lane) + t.y
      const ky = (1 - a) + a * t.k;
      return ky * yLane(lane) + t.y;
    }
    function invYBlendLane(t, fy) {
      const ky = (1 - a) + a * t.k;
      return yLane.invert((fy - t.y) / Math.max(1e-6, ky));
    }

    // locality weights around anchor (anchorYear, anchorLane) using blended coords
    function buildFocalWeightsUsingAnchor(t, anchorYear, anchorLane) {
      const k = t.k;
      const baseR = 360 / Math.sqrt(k);
      const wById = new Map();
      for (const d of nodes) {
        const lane = fieldIndex(d.field) + jitterLane(d.id);
        const px = xBlendAt(t, d.year ?? yearsDomain[0]) - xBlendAt(t, anchorYear);
        const py = yBlendAt(t, lane) - yBlendAt(t, anchorLane);
        const dd = Math.sqrt((px * px + py * py) / (baseR * baseR));
        wById.set(d.id, Math.exp(-dd * dd));
      }
      return wById;
    }

    // auto-decay for separation — depends on sepGain
    let lastDecayTs = performance.now();
    function maybeDecay(k) {
      const ar = CFG.autoReturn;
      const gain = Math.max(0, CFG.sepGain);
      if (!ar.enabled || gain === 0) return;  // no decay motion if sepGain==0

      const within = Math.abs(k - ar.kHome) <= (ar.kHome * ar.epsilonK);
      if (!within) { lastDecayTs = performance.now(); return; }
      const tNow = performance.now(); const dt = tNow - lastDecayTs; if (dt <= 0) return; lastDecayTs = tNow;

      // decay rate scaled by sepGain (small gain => slower decay => less visible motion)
      const scaledHalfLife = Math.max(80, ar.halfLifeMs) / Math.max(1e-6, gain);
      const decay = Math.pow(0.5, dt / scaledHalfLife);

      const acc = sepAccumRef.current;
      for (const [id, v] of acc) acc.set(id, { x: v.x * decay, y: v.y * decay });
    }

    // rAF coalescing
    let rafId = null, pendingT = null;

    const zoom = d3.zoom()
      .scaleExtent([CFG.kMin, CFG.kMax])
      .wheelDelta(wheelDelta)
      .translateExtent([[-1e7, -1e7], [width + 1e7, height + 1e7]])
      .filter(ev => !(ev.ctrlKey && ev.type === "wheel"))
      .on("start", (ev) => {
        if (committingRef.current) return;
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
          fxAbs: null,
          fyAbs: null,
          yStart: t.y, // used to freeze Y during zoom when sepGain==0
        };

        // ----- Choose ONE canonical anchor for the whole gesture -----
        let fxPlot, fyPlot, vpYear, vpLane;

        const locked = focusLockRef.current ? nodeByIdRef.current.get(focusLockRef.current) : null;
        if (locked) {
          // anchor = selected node (year + laneWithJitter)
          const lane = fieldIndex(locked.field) + jitterLane(locked.id);
          fxPlot = xBlendAt(t, locked.year ?? yearsDomain[0]);
          fyPlot = yBlendAt(t, lane);
          vpYear = locked.year ?? yearsDomain[0];
          vpLane = lane;
        } else {
          // anchor = mouse pointer converted to (year,lane) at gesture start (not live-updated)
          const [px, py] = se ? pointerInPlot(se) :
            (mousePlotRef.current.x != null ? [mousePlotRef.current.x, mousePlotRef.current.y] : [width / 2, height / 2]);
          fxPlot = px;
          fyPlot = py;
          vpYear = invXBlendYear(t, fxPlot);
          vpLane = invYBlendLane(t, fyPlot);
        }

        // store absolute screen anchor and data anchor
        const fxAbs = margin.left + fxPlot;
        const fyAbs = margin.top  + fyPlot;

        zStateRef.current = { fxAbs, fyAbs, vpYear, vpLane };

        sessionRef.current.vpYear = vpYear;
        sessionRef.current.vpLane = vpLane;
        sessionRef.current.fxAbs  = fxAbs;
        sessionRef.current.fyAbs  = fyAbs;
        sessionRef.current.coeffById = buildFocalWeightsUsingAnchor(t, vpYear, vpLane);
      })
      .on("zoom", (ev) => {
        if (committingRef.current) return;
        const t = ev.transform;
        const s = sessionRef.current;
        if (s?.mode === "zoom") {
          lastWheelTsRef.current = performance.now();
          s.incNow = Math.log(Math.max(1e-6, t.k)) - s.logK0;
        } else {
          s.incNow = 0;
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
        if (committingRef.current) return;
        const s = sessionRef.current;
        if (!s?.active) return;

        // Commit glued transform only if visible correction
        if (correctedTRef.current) {
          const { dx, dy } = glueDeltaRef.current || { dx: 0, dy: 0 };
          const delta = Math.hypot(dx, dy);
          const finalT = correctedTRef.current;
          correctedTRef.current = null;

          if (delta >= epsGlue()) {
            committingRef.current = true;
            setTimeout(() => {
              d3.select(svg.node()).call(zoom.transform, finalT); // synthetic zoom+end
              committingRef.current = false;
            }, 0);
            s.active = false; s.incNow = 0;
            return;
          }
        }

        requestAnimationFrame(() => renderWithTransform(d3.zoomTransform(svg.node())));

        // --------- Separation accumulation (∝ sepGain), anchored to s.vpYear/s.vpLane ---------
        const gSep = Math.max(0, CFG.sepGain);
        if (s.mode !== "zoom" || Math.abs(s.incNow) < 0.015 || gSep === 0) {
          s.active = false; s.incNow = 0; return;
        }

        const tNow = d3.zoomTransform(svg.node());
        const kNow = tNow.k;
        const addScale = gSep * s.incNow; // scaled by sepGain

        const anchorYear = s.vpYear;
        const anchorLane = s.vpLane;

        if (addScale !== 0) {
          const ratio = Math.max(0, CFG.sepgainYoverX);
          const wX = 1;
          const wY = Number.isFinite(ratio) ? ratio : 1e6;

          for (const d of nodes) {
            const lane = fieldIndex(d.field) + jitterLane(d.id);

            // Pixel-space vectors using SAME math as selected-node case (blended X & Y)
            const px = xBlendAt(tNow, d.year ?? yearsDomain[0]) - xBlendAt(tNow, anchorYear);
            const py = yBlendAt(tNow, lane) - yBlendAt(tNow, anchorLane);

            let vx = px * wX, vy = py * wY;
            const norm = Math.hypot(vx, vy) || 1; vx /= norm; vy /= norm;

            // acceleration with size
            const w = nodeWidthAtK(d, kNow);
            const accelU = smoothstep(CFG.accelfromWidth * 0.6, CFG.accelfromWidth * 1.8, w);
            const accel = 1 + Math.pow(accelU, CFG.accelPow);

            // locality weight
            const local = s.coeffById?.get(d.id) ?? 0;
            const mag = addScale * (0.25 + 0.75 * local) * accel;

            const prev = sepAccumRef.current.get(d.id) || { x: 0, y: 0 };
            sepAccumRef.current.set(d.id, { x: prev.x + mag * vx, y: prev.y + mag * vy });
          }
        }

        s.active = false;
        s.incNow = 0;
      });

    svg.call(zoom);
    svg.on("dblclick.zoom", null);

    // ---- Highlight helpers ----
    function resetHighlight() {
      highlightSetRef.current = null;
      highlightRootRef.current = null;
      edgesSel.style("display", "none");
    }

    function highlightNeighborhood(id, { raise = false } = {}) {
      if (!id) { resetHighlight(); return; }
      const idxs = edgesByNode.get(id) || [];
      const sset = new Set([id]);
      idxs.forEach(i => { const e = edges[i]; sset.add(e.source); sset.add(e.target); });

      highlightSetRef.current = sset;
      highlightRootRef.current = id;

      const subset = idxs.map(i => edges[i]);
      edgesSel = edgesG.selectAll("path.edge")
        .data(subset, d => d ? `${d.source}->${d.target}` : undefined)
        .join("path")
        .attr("class", "edge")
        .attr("fill", "none")
        .attr("stroke", "#5b6573")
        .attr("stroke-opacity", 0.7)
        .attr("stroke-width", 1.6)
        .attr("vector-effect", "non-scaling-stroke")
        .style("display", subset.length ? null : "none");

      if (raise) {
        const nodesSelLocal = d3.select(gPlot.node()).selectAll("g.node");
        nodesSelLocal.filter(d => sset.has(d.id)).raise();
        nodesSelLocal.filter(d => d.id === id).raise();
      }
    }

    // ------- RENDER -------
    function renderWithTransform(rawT) {
      let t = rawT;

      // Anchor glue (works the same for selected or mouse anchor).
      if (sessionRef.current?.active && sessionRef.current.mode === "zoom") {
        const { fxAbs, fyAbs, vpYear, vpLane } = zStateRef.current || {};
        if (fxAbs != null && fyAbs != null && vpYear != null && vpLane != null) {
          // Where is the anchor under the *current* raw transform (blended X & Y)?
          const ax = margin.left + xBlendAt(t, vpYear);
          const ay = margin.top  + yBlendAt(t, vpLane);

          // delta needed to keep the anchor fixed at its absolute screen position
          const dx = fxAbs - ax;
          const dy = fyAbs - ay;

          if (CFG.sepGain === 0) {
            const yFrozen = sessionRef.current?.yStart ?? t.y; // freeze Y during zoom when sepGain==0
            t = d3.zoomIdentity.translate(t.x + dx, yFrozen).scale(t.k);
            glueDeltaRef.current = { dx, dy: 0 };
          } else {
            t = d3.zoomIdentity.translate(t.x + dx, t.y + dy).scale(t.k);
            glueDeltaRef.current = { dx, dy };
          }

          correctedTRef.current = t; // remember glued transform for commit-on-end decision
        } else {
          correctedTRef.current = null;
          glueDeltaRef.current = { dx: 0, dy: 0 };
        }
      } else {
        correctedTRef.current = null;
        glueDeltaRef.current = { dx: 0, dy: 0 };
      }

      const k = t.k;

      // Blended base positions
      const newX = (year) => xBlendAt(t, year);
      const newY = (lane) => yBlendAt(t, lane);

      // All passive motion (auto-decay) gated by sepGain
      maybeDecay(k);

      const P = new Map();

      // position nodes + apply highlight styling
      const gSep = Math.max(0, CFG.sepGain);
      const sepFactor = 360 / Math.sqrt(k); // display scaling over zoom

      nodesSel.each(function (d) {
        const lane = fieldIndex(d.field) + jitterLane(d.id);
        const baseX = newX(d.year ?? yearsDomain[0]);
        const baseY = newY(lane);

        const v = sepAccumRef.current.get(d.id) || { x: 0, y: 0 };

        // Display-time separation depends on sepGain
        const sepX = v.x * gSep * sepFactor;
        const sepY = v.y * gSep * sepFactor;

        const cx = baseX + sepX;
        const cy = baseY + sepY;

        const bs = baseTileSize(d);
        const s = Math.pow(k, 1.2) * (0.9 + 0.4 * (d.z ?? 0.5));
        const tile = { w: bs.w * s, h: bs.h * s, rx: Math.min(bs.rxBase * Math.pow(k, 0.5), 16) };

        const g = d3.select(this);
        g.attr("transform", `translate(${cx - tile.w / 2},${cy - tile.h / 2})`);

        // highlight logic
        const inHighlight = !!highlightSetRef.current;
        const isHighlighted = inHighlight && highlightSetRef.current.has(d.id);
        const isRoot = inHighlight && highlightRootRef.current === d.id;

        g.select("rect.node-rect")
          .attr("width", tile.w)
          .attr("height", tile.h)
          .attr("rx", tile.rx)
          .attr("ry", tile.rx)
          .attr("fill", inHighlight ? (isHighlighted ? color(d.field) : GREY_FILL) : color(d.field))
          .attr("opacity", inHighlight ? (isHighlighted ? 0.95 : 0.55) : 0.85 * (0.6 + 0.4 * (d.z ?? 0.5)))
          .attr("stroke", inHighlight ? (isHighlighted ? "#1f2937" : GREY_STROKE) : "#333")
          .attr("stroke-width", inHighlight ? (isRoot ? 2.6 : (isHighlighted ? 2.0 : 1.2)) : 1.2);

        g.select("line.node-header")
          .style("display", inHighlight && isHighlighted ? null : "none")
          .attr("x1", 0).attr("y1", 0)
          .attr("x2", tile.w).attr("y2", 0);

        const padX = Math.max(6, tile.w * 0.05);
        const padTop = Math.max(6, tile.h * 0.06) + 2;
        const padBottom = Math.max(4, tile.h * 0.04);
        const labelW = Math.max(0, tile.w - padX * 2);
        const labelH = Math.max(0, tile.h - padTop - padBottom);
        const fontPx = Math.max(9, Math.min(22, Math.floor(tile.h * 0.14)));

        const fo = g.select("foreignObject.node-label")
          .style("display", inHighlight && isHighlighted ? null : "none")
          .attr("x", padX)
          .attr("y", padTop)
          .attr("width", labelW)
          .attr("height", labelH);

        fo.select("div.label-div")
          .style("font-size", `${fontPx}px`)
          .text(d.title || "Untitled");

        P.set(d.id, { cx, cy, w: tile.w, h: tile.h });
      });

      // edges (selected↔neighbours only)
      const centerOf = id => { const p = P.get(id); return p ? { x: p.cx, y: p.cy } : null; };
      edgesSel
        .style("display", highlightSetRef.current ? null : "none")
        .attr("d", e => {
          const sC = centerOf(e.source), tC = centerOf(e.target);
          if (!sC || !tC) return null;
          const xm = (sC.x + tC.x) / 2, ym = (sC.y + tC.y) / 2;
          return `M${sC.x},${sC.y} L${xm},${ym} L${tC.x},${tC.y}`;
        });

      // axes: X and Y axes follow the same blended affine transforms
      const kx = (1 - a) + a * t.k;
      const xAxisScale = x.copy().range(x.range().map(v => kx * v + t.x));
      const yAxisOffset = (CFG.sepGain === 0 && sessionRef.current?.active && sessionRef.current.mode === "zoom")
        ? (sessionRef.current?.yStart ?? t.y) : t.y;

      yAxisG.attr("transform", `translate(0,${yAxisOffset})`)
        .call(d3.axisLeft(yLane).tickValues(fields.map((_, i) => i)).tickFormat(i => fields[i]));
      xAxisG.call(d3.axisBottom(xAxisScale).ticks(10).tickFormat(d3.format("d")));
    }

    // Node events
    const inCooldown = () => (performance.now() - lastWheelTsRef.current) < INTERACT.COOLDOWN_MS;

    nodesSel
      .on("mouseover", function (_, d) {
        if (inCooldown() || focusLockRef.current) return;
        if (!lockedIdRef.current) {
          highlightNeighborhood(d.id, { raise: true });
          renderWithTransform(d3.zoomTransform(svg.node()));
        }
      })
      .on("mouseout", function () {
        if (inCooldown() || focusLockRef.current) return;
        if (!lockedIdRef.current) {
          resetHighlight();
          renderWithTransform(d3.zoomTransform(svg.node()));
        }
      })
      .on("mousemove", (event, d) => {
        if (inCooldown()) return;
        const t = tooltipRef.current; if (!t) return;
        t.style.display = "block";
        t.style.left = `${event.pageX + 12}px`;
        t.style.top = `${event.pageY + 12}px`;
        t.innerHTML = `<strong>${d.title || "Untitled"}</strong><br/>${d.authors ? `<span>${d.authors}</span><br/>` : ""}<em>${d.field}</em> • ${d.year ?? "n/a"}<br/><strong>Citations:</strong> ${d.citationCount}${d.url ? `<br/><a href="${d.url}" target="_blank" rel="noreferrer">Open source</a>` : ""}`;
      })
      .on("mouseleave", () => { const t = tooltipRef.current; if (!t) t.style.display = "none"; })
      .on("click", function (event, d) {
        if ((performance.now() - lastWheelTsRef.current) < INTERACT.CLICK_MS) return;
        event.stopPropagation();
        if (lockedIdRef.current === d.id) {
          lockedIdRef.current = null;
          focusLockRef.current = null;
          setSelected(null);
          resetHighlight();
        } else {
          lockedIdRef.current = d.id;
          focusLockRef.current = d.id;
          setSelected(d);
          highlightNeighborhood(d.id, { raise: true });

          // rebuild gesture anchor to selected node (year+lane), for next gesture start
          const tNow = d3.zoomTransform(svg.node());
          const lane = fieldIndex(d.field) + jitterLane(d.id);
          const fxAbs = margin.left + xBlendAt(tNow, d.year ?? yearsDomain[0]);
          const fyAbs = margin.top  + yBlendAt(tNow, lane);

          zStateRef.current = { fxAbs, fyAbs, vpYear: d.year ?? yearsDomain[0], vpLane: lane };
        }
        renderWithTransform(d3.zoomTransform(svg.node()));
      });

    // Background click => unlock
    svg.on("click", () => {
      if ((performance.now() - lastWheelTsRef.current) < INTERACT.CLICK_MS) return;
      lockedIdRef.current = null;
      focusLockRef.current = null;
      setSelected(null);
      resetHighlight();
      renderWithTransform(d3.zoomTransform(svg.node()));
    });

    // Responsive
    const onResize = () => { renderWithTransform(d3.zoomTransform(svg.node())); updateMobileFlag(); applyAxisVisibility(); };
    window.addEventListener("resize", onResize);
    renderWithTransform(d3.zoomTransform(svg.node()));

    return () => {
      window.removeEventListener("resize", onResize);
      svg.on(".zoom", null).on("click", null).on("pointermove", null);
    };
  // deps for everything referenced from outside the effect:
  }, [nodes, edges, fields, yearsDomain, baseTileSize, edgesByNode, fieldIndex]);

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
