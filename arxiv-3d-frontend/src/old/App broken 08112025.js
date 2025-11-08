// App.js — radial accel from real anchor (MOUSE POINTER ONLY); X scales with sepGain*sepgainYoverX, Y with sepGain; clean snap-back
// ---------------------------------------------------------------------------------
// Refactor goals:
// 1) Keep ALL functionality + dependencies intact.
// 2) Add clear headers and function docs (inputs/outputs).
// 3) Reduce complexity where safe: fewer deeply-nested helpers; keep constants centralized.
// 4) No behavioral changes unless explicitly simplifying redundant code paths.
// ---------------------------------------------------------------------------------

import React, { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import "./App.css";

/* =================================================================================
 * CONFIG (Single Source of Truth)
 * ---------------------------------------------------------------------------------
 * Public Controls you are likely to tweak. Values are unchanged from the user's
 * version to preserve behavior. Grouped for readability; still accessed via CFG.
 * ================================================================================= */
const CFG = {
  // Zoom
  kMin: 0.5,
  kMax: 300,

  // Wheel behavior
  wheelBase: 0.0012,
  wheelSlowCoef: 0.10, // extra damping as k grows

  // Separation strength
  sepGain: 0.001, // Y baseline rate
  sepgainYoverX: 20.0, // X uses sepGain * sepgainYoverX

  // Acceleration / gating by size (px at current zoom)
  accelfromWidth: 100, // tiles smaller than this => no acceleration
  accelPow: 8, // ramp sharpness after the gate

  // Growth control
  sizeGrowthExp: 0.3,
  sizeScale: 1.0,

  // Snap-back (return) control on zoom-out
  returnRate: 0.85, // 0..1 per |log k| step (higher = faster return)

  // Optional gentle decay near home zoom (independent of scroll)
  autoReturn: { enabled: false, kHome: 1.0, epsilonK: 0.10, halfLifeMs: 900 },
};

/* =================================================================================
 * SMALL HELPERS (Pure functions)
 * ================================================================================= */

/** Convert a gain into a [0..1] alpha for blending zoom vs pan. */
const zoomAlphaFromGain = (g) => {
  const half = 0.15; // where half influence sits vs gain
  return Math.max(0, Math.min(1, g / (g + half)));
};

// Stable jitter per id (lane jitter)
const jitterMaxLaneUnits = 0.35;
const hash32 = (s) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const hashUnit = (s) => hash32(String(s)) / 4294967296;
const jitterLane = (id) => (hashUnit(id) - 0.5) * 2 * jitterMaxLaneUnits;

export default function App() {
  /* ===============================================================================
   * REFS & STATE
   * =============================================================================== */
  const svgRef = useRef(null);
  const wrapRef = useRef(null);
  const tooltipRef = useRef(null);

  const [rawNodes, setRawNodes] = useState([]);
  const [rawEdges, setRawEdges] = useState([]);
  const [selected, setSelected] = useState(null);

  const nodeByIdRef = useRef(new Map());
  const sepAccumRef = useRef(new Map()); // id -> {x, y} accumulated sep (logical units)

  const sessionRef = useRef(null); // gesture/session state
  const lockedIdRef = useRef(null);
  const focusLockRef = useRef(null);
  const correctedTRef = useRef(null);
  const committingRef = useRef(false);
  const isMobileRef = useRef(false);
  const lastWheelTsRef = useRef(0);

  const INTERACT = { CLICK_MS: 200, HOVER_MS: 140, COOLDOWN_MS: 220 };
  const now = () => performance.now();
  const inCooldown = () => (now() - lastWheelTsRef.current) < INTERACT.COOLDOWN_MS;

  /* ===============================================================================
   * DATA LOADING
   * =============================================================================== */
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

  /* ===============================================================================
   * NORMALIZATION (pure-ish, memoized)
   * =============================================================================== */
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
        title: d.title || d.name || "Untitled",
      };
    });
    nodeByIdRef.current = new Map(ns.map(n => [n.id, n]));
    return ns;
  }, [rawNodes]);

  const edges = useMemo(() => {
    const m = nodeByIdRef.current;
    const out = [];
    for (const e of (rawEdges || [])) {
      const s = m.get(String(e.source));
      const t = m.get(String(e.target));
      if (s && t) out.push({ source: s.id, target: t.id });
    }
    return out;
  }, [rawEdges]);

  const edgesByNode = useMemo(() => {
    const m = new Map();
    nodes.forEach(n => m.set(n.id, []));
    edges.forEach((e, i) => {
      m.get(e.source)?.push(i);
      m.get(e.target)?.push(i);
    });
    return m;
  }, [nodes, edges]);

  const { fields, fieldIndex, yearsDomain } = useMemo(() => {
    const fields = Array.from(new Set(nodes.map(d => d.field))).sort();
    const fieldIndex = f => Math.max(0, fields.indexOf(f ?? "Unassigned"));
    const years = nodes.map(d => d.year).filter(v => Number.isFinite(v));
    const minY = years.length ? d3.min(years) : 1950, maxY = years.length ? d3.max(years) : 2025;
    return { fields, fieldIndex, yearsDomain: [minY - 1, maxY + 1] };
  }, [nodes]);

  // z & presentation size helpers
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

  // Keep sep map aligned to current node set
  useEffect(() => {
    const acc = sepAccumRef.current;
    for (const n of nodes) if (!acc.has(n.id)) acc.set(n.id, { x: 0, y: 0 });
    for (const id of Array.from(acc.keys())) if (!nodeByIdRef.current.has(id)) acc.delete(id);
  }, [nodes]);

  useEffect(() => {
    lockedIdRef.current = selected?.id || null;
  }, [selected]);

  /* ===============================================================================
   * D3 SCENE
   * =============================================================================== */
  useEffect(() => {
    if (!wrapRef.current || !svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    // Viewport & margins
    const vw = typeof window !== "undefined" ? window.innerWidth : 1400;
    const vh = typeof window !== "undefined" ? window.innerHeight : 900;
    const margin = { top: 28, right: 28, bottom: 48, left: 180 };

    const cw = Math.max(720, (wrapRef.current.clientWidth || vw * 0.96));
    const ch = Math.max(1000, (wrapRef.current.clientHeight || vh * 0.86));

    const width = cw - margin.left - margin.right;
    const height = ch - margin.top - margin.bottom;

    const updateMobileFlag = () => {
      isMobileRef.current = window.matchMedia("(max-width: 768px)").matches;
    };
    updateMobileFlag();

    svg
      .attr("width", cw)
      .attr("height", ch)
      .style("display", "block")
      .style("background", "#f5f5f7");

    // Root groups
    const gRoot = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
    const gPlot = gRoot.append("g").attr("class", "plot");
    const gAxes = gRoot.append("g").attr("class", "axes");

    // Scales & axes
    const x = d3.scaleLinear().domain(yearsDomain).range([0, width]);
    const yLane = d3.scaleLinear().domain([0, Math.max(0, fields.length - 1)]).range([0, height]);
    const color = d3.scaleOrdinal(d3.schemeTableau10).domain(fields);

    const xAxisG = gAxes
      .append("g")
      .attr("transform", `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(10).tickFormat(d3.format("d")));

    const yAxisG = gAxes
      .append("g")
      .call(
        d3.axisLeft(yLane)
          .tickValues(fields.map((_, i) => i))
          .tickFormat(i => fields[i])
      );

    const applyAxisVisibility = () => {
      yAxisG.style("display", isMobileRef.current ? "none" : null);
    };
    applyAxisVisibility();

    // Layers
    const edgesG = gPlot.append("g").attr("class", "edges");
    const nodesG = gPlot.append("g").attr("class", "nodes");

    // Nodes enter
    const nodesSel = nodesG
      .selectAll("g.node")
      .data(nodes, d => d.id)
      .join(enter => {
        const g = enter
          .append("g")
          .attr("class", "node")
          .style("cursor", "pointer");
        g.append("rect")
          .attr("class", "node-rect")
          .attr("stroke", "#333")
          .attr("fill", d => color(d.field))
          .attr("opacity", 0.85)
          .attr("vector-effect", "non-scaling-stroke");
        g.append("text")
          .attr("class", "node-label")
          .attr("text-anchor", "start")
          .style("font-weight", 600)
          .style("pointer-events", "none")
          .style("opacity", 0);
        return g;
      });

    // Edges (hidden until selection)
    let edgesSel = edgesG
      .selectAll("path.edge")
      .data([], d => (d ? `${d.source}->${d.target}` : undefined))
      .join("path")
      .attr("class", "edge")
      .attr("fill", "none")
      .attr("stroke", "#444")
      .attr("stroke-width", 1.2)
      .attr("vector-effect", "non-scaling-stroke")
      .style("display", "none");

    /* ---------------------------------------------------------------------------
     * SIZE: width at current zoom (for gating separation)
     * Inputs: (d: node, k: number)
     * Output: number (pixel width)
     * --------------------------------------------------------------------------- */
    const nodeWidthAtK = (d, k) => {
      const base = baseTileSize(d);
      const sizeBoost = 0.9 + 0.4 * (d.z ?? 0.5);
      return base.w * CFG.sizeScale * Math.pow(k, CFG.sizeGrowthExp) * sizeBoost;
    };

    /* ---------------------------------------------------------------------------
     * WHEEL DELTA MODEL (smooth + bounded)
     * Inputs: WheelEvent
     * Output: signed scalar delta for d3-zoom
     * --------------------------------------------------------------------------- */
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

    /* ---------------------------------------------------------------------------
     * POINTER in plot space (clamped)
     * Inputs: native sourceEvent
     * Output: [x,y] within the plot rect
     * --------------------------------------------------------------------------- */
    function pointerInPlot(sourceEvent) {
      const [px, py] = d3.pointer(sourceEvent, gRoot.node());
      return [Math.max(0, Math.min(width, px)), Math.max(0, Math.min(height, py))];
    }

    // Axis-specific alphas (how strongly zoom contributes vs pan in render coords)
    const yZoomAlpha = zoomAlphaFromGain(CFG.sepGain);
    const xZoomAlpha = zoomAlphaFromGain(CFG.sepGain * CFG.sepgainYoverX);

    /* ---------------------------------------------------------------------------
     * BLENDED COORDINATES in render space
     * Inputs: (t: d3.ZoomTransform, year|lane: number)
     * Output: pixel coordinate
     * --------------------------------------------------------------------------- */
    function xBlendAt(t, year) {
      const xZoom = t.rescaleX(x)(year); // pan+zoom
      const xPan = x(year) + t.x;        // pan-only
      return (1 - xZoomAlpha) * xPan + xZoomAlpha * xZoom;
    }
    function yBlendAt(t, lane) {
      const yZoom = t.rescaleY(yLane)(lane); // pan+zoom
      const yPan  = yLane(lane) + t.y;       // pan-only
      return (1 - yZoomAlpha) * yPan + yZoomAlpha * yZoom;
    }

    /* ---------------------------------------------------------------------------
     * FOCAL WEIGHTS around the anchor (render space)
     * Inputs: (t: ZoomTransform, fxPlot: px, fyPlot: px)
     * Output: Map(nodeId => weight 0..1)
     * --------------------------------------------------------------------------- */
    function buildFocalWeights(t, fxPlot, fyPlot) {
      const laneAtApprox = t.rescaleY(yLane).invert(fyPlot);
      const k = t.k;
      const baseR = 360 / Math.sqrt(k);
      const wById = new Map();

      const yAtLane = (lane) => yBlendAt(t, lane);
      const yAtAnchor = yAtLane(laneAtApprox);

      for (const d of nodes) {
        const lane = fieldIndex(d.field) + jitterLane(d.id);
        const px = xBlendAt(t, d.year ?? yearsDomain[0]) - fxPlot;
        const py = yAtLane(lane) - yAtAnchor;
        const dd = Math.sqrt((px * px + py * py) / (baseR * baseR));
        wById.set(d.id, Math.exp(-dd * dd));
      }
      return wById;
    }

    /* ---------------------------------------------------------------------------
     * OPTIONAL AUTODECAY near home zoom
     * Inputs: current k
     * Output: mutates sepAccumRef toward zero (decay)
     * --------------------------------------------------------------------------- */
    let lastDecayTs = performance.now();
    function maybeDecay(k) {
      const ar = CFG.autoReturn;
      if (!ar.enabled) return;
      const within = Math.abs(k - ar.kHome) <= (ar.kHome * ar.epsilonK);
      if (!within) {
        lastDecayTs = performance.now();
        return;
      }
      const tNow = performance.now();
      const dt = tNow - lastDecayTs;
      if (dt <= 0) return;
      lastDecayTs = tNow;
      const decay = Math.pow(0.5, dt / Math.max(100, ar.halfLifeMs));
      const acc = sepAccumRef.current;
      for (const [id, v] of acc) acc.set(id, { x: v.x * decay, y: v.y * decay });
    }

    // rAF coalescing
    let rafId = null;
    let pendingT = null;

    // Gesture anchor (absolute screen + inverse coords)
    const focalRef = { fxAbs: null, fyAbs: null, vpYear: null, vpLane: null };

    /* ---------------------------------------------------------------------------
     * ACCUMULATE SEPARATION (per frame; size-gated; radial from real anchor)
     * Inputs: deltaInc (log k step), t (ZoomTransform), s (session state)
     * Output: mutates sepAccumRef for each node
     * --------------------------------------------------------------------------- */
    function accumulateSeparation(deltaInc, t, s) {
      if (!deltaInc) return;
      const step = Math.abs(deltaInc);
      if (step < 1e-7) return;

      const gY = Math.max(0, CFG.sepGain);
      const gX = Math.max(0, CFG.sepGain * CFG.sepgainYoverX);

      for (const d of nodes) {
        const lane = fieldIndex(d.field) + jitterLane(d.id);

        // Real anchor pixels captured at gesture start (MOUSE POINTER ONLY)
        const anchorX = s.fxPlot ?? xBlendAt(t, s.vpYear ?? (d.year ?? yearsDomain[0]));
        const anchorY = s.fyPlot ?? yBlendAt(t, s.vpLane ?? lane);

        const px = xBlendAt(t, d.year ?? yearsDomain[0]) - anchorX;
        const py = yBlendAt(t, lane) - anchorY;

        const rIso = Math.hypot(px, py) || 1;
        const ux = px / rIso;
        const uy = py / rIso;

        // Locality weighting
        const falloff = 1 - Math.exp(-(rIso / 260));
        const local = s.coeffById?.get(d.id) ?? 0; // [0..1]
        const locality = 0.25 + 0.75 * local;

        // Size-gated acceleration
        const widthPx = nodeWidthAtK(d, t.k);
        const over = Math.max(0, (widthPx / Math.max(1e-6, CFG.accelfromWidth)) - 1);
        const accelMult = 1 + Math.pow(over, CFG.accelPow); // 1 at threshold, >1 beyond

        const prev = sepAccumRef.current.get(d.id) || { x: 0, y: 0 };

        if (deltaInc > 0) {
          // ZOOM IN: accelerate AWAY from anchor (radial). Per-axis gains then renormalize.
          let wx = gX * ux, wy = gY * uy;
          const wn = Math.hypot(wx, wy) || 1;
          wx /= wn; wy /= wn;

          const mag = step * accelMult * falloff * locality;
          sepAccumRef.current.set(d.id, { x: prev.x + mag * wx, y: prev.y + mag * wy });
        } else {
          // ZOOM OUT: snap-back toward root (kill stored separation)
          const pull = Math.min(1, step * CFG.returnRate);
          sepAccumRef.current.set(d.id, { x: prev.x * (1 - pull), y: prev.y * (1 - pull) });
        }
      }
    }

    /* ---------------------------------------------------------------------------
     * ZOOM/PAN BEHAVIOR
     * --------------------------------------------------------------------------- */
    const zoom = d3.zoom()
      .scaleExtent([CFG.kMin, CFG.kMax])
      .wheelDelta(wheelDelta)
      .translateExtent([[-1e-7, -1e-7], [width + 1e7, height + 1e7]])
      .filter(ev => !(ev.ctrlKey && ev.type === "wheel"))
      .on("start", (ev) => {
        if (committingRef.current) return;
        const se = ev?.sourceEvent;
        const isZoom = !!se && (se.type === "wheel" || se.type === "gesturechange" || se.type === "dblclick" || (se.touches && se.touches.length === 2));
        const t = d3.zoomTransform(svg.node());

        // Session init
        sessionRef.current = {
          active: true,
          mode: isZoom ? "zoom" : "pan",
          logK0: Math.log(Math.max(1e-6, t.k)),
          incNow: 0,
          incPrev: 0,
          coeffById: null,
          vpYear: null,
          vpLane: null,
          yStart: t.y, // freeze Y during zoom if sepGain == 0
          fxPlot: null,
          fyPlot: null,
        };

        // ------------------------------------------
        // ANCHOR: ALWAYS USE MOUSE POINTER (changed)
        // ------------------------------------------
        if (isZoom) {
          const [px, py] = se ? pointerInPlot(se) : [width / 2, height / 2];
          const invX = t.rescaleX(x);
          const invY = t.rescaleY(yLane);
          const fxPlot = px;
          const fyPlot = py;
          const vpYear = invX.invert(fxPlot);
          const vpLane = invY.invert(fyPlot);

          (focalRef.fxAbs = margin.left + fxPlot);
          (focalRef.fyAbs = margin.top + fyPlot);
          (focalRef.vpYear = vpYear);
          (focalRef.vpLane = vpLane);

          sessionRef.current.vpYear = vpYear;
          sessionRef.current.vpLane = vpLane;
          sessionRef.current.coeffById = buildFocalWeights(t, fxPlot, fyPlot);
          sessionRef.current.fxPlot = fxPlot; // REAL anchor pixels
          sessionRef.current.fyPlot = fyPlot;
        } else {
          focalRef.fxAbs = null;
          focalRef.fyAbs = null;
          focalRef.vpYear = null;
          focalRef.vpLane = null;
        }
      })
      .on("zoom", (ev) => {
        if (committingRef.current) return;
        const t = ev.transform;
        const s = sessionRef.current;

        if (s?.mode === "zoom") {
          lastWheelTsRef.current = now();
          s.incNow = Math.log(Math.max(1e-6, t.k)) - s.logK0;
          const deltaInc = s.incNow - (s.incPrev ?? 0);
          if (Math.abs(deltaInc) > 1e-6) {
            accumulateSeparation(deltaInc, t, s);
            s.incPrev = s.incNow;
          }
        } else {
          s.incNow = 0;
          s.incPrev = 0;
          focalRef.fxAbs = null;
          focalRef.fyAbs = null;
          focalRef.vpYear = null;
          focalRef.vpLane = null;
        }

        pendingT = t;
        if (!rafId) {
          rafId = requestAnimationFrame(() => {
            const tr = pendingT || d3.zoomTransform(svg.node());
            pendingT = null;
            rafId = null;
            renderWithTransform(tr);
          });
        }
      })
      .on("end", () => {
        if (committingRef.current) return;
        const s = sessionRef.current;
        if (!s?.active) return;

        if (correctedTRef.current) {
          const finalT = correctedTRef.current;
          correctedTRef.current = null;
          committingRef.current = true;
          setTimeout(() => {
            d3.select(svgRef.current).call(zoom.transform, finalT);
            committingRef.current = false;
          }, 0);
          s.active = false;
          s.incNow = 0;
          s.incPrev = 0;
          return;
        }

        requestAnimationFrame(() => renderWithTransform(d3.zoomTransform(svg.node())));
        s.active = false;
        s.incNow = 0;
        s.incPrev = 0;
      });

    svg.call(zoom);
    svg.on("dblclick.zoom", null); // we manage anchor/selection ourselves

    /* ---------------------------------------------------------------------------
     * LABEL WRAP (SVG tspans)
     * Inputs: textSel (d3 selection), boxW/H, padX/Y, content (string), k
     * Output: mutates selection to show lines of text inside the box
     * --------------------------------------------------------------------------- */
    function layoutLabel(textSel, boxW, boxH, padX, padY, content, k) {
      const fontSize = Math.max(10, Math.min(18, boxH * 0.18));
      const lineHeight = fontSize * 1.2;
      const maxLines = Math.max(1, Math.floor((boxH - padY * 2) / lineHeight));
      const estCharW = fontSize * 0.6;
      const maxCharsPerLine = Math.max(6, Math.floor((boxW - padX * 2) / estCharW));
      const words = String(content || "").split(/\s+/).filter(Boolean);

      const lines = [];
      let cur = "";
      for (const w of words) {
        const candidate = (cur ? cur + " " : "") + w;
        if (candidate.length <= maxCharsPerLine) cur = candidate;
        else {
          if (cur) lines.push(cur);
          cur = w;
          if (lines.length >= maxLines - 1) break;
        }
      }
      if (cur && lines.length < maxLines) lines.push(cur);
      if (words.length && lines.length === maxLines) {
        if (lines[lines.length - 1].length > maxCharsPerLine) {
          lines[lines.length - 1] =
            lines[lines.length - 1].slice(0, Math.max(3, maxCharsPerLine - 1)) + "…";
        }
      }

      textSel
        .style("font-size", `${fontSize}px`)
        .attr("x", padX)
        .attr("y", padY + fontSize)
        .selectAll("tspan")
        .data(lines)
        .join("tspan")
        .attr("x", padX)
        .attr("dy", (d, i) => (i === 0 ? 0 : lineHeight))
        .text(d => d);
    }

    // Utility: neighbors set
    const neighborSetOf = (id) => {
      if (!id) return null;
      const idxs = edgesByNode.get(id) || [];
      const s = new Set([id]);
      for (const i of idxs) {
        const e = edges[i];
        s.add(e.source);
        s.add(e.target);
      }
      return s;
    };

    /* ---------------------------------------------------------------------------
     * RENDER with transform (single place updating nodes, edges, axes)
     * Inputs: rawT (ZoomTransform)
     * Output: DOM mutations
     * --------------------------------------------------------------------------- */
    function renderWithTransform(rawT) {
      let t = rawT;

      // Keep anchor glued (and optionally freeze Y when sepGain==0)
      if (sessionRef.current?.active && sessionRef.current.mode === "zoom" && focalRef.fxAbs != null && focalRef.fyAbs != null) {
        // ALWAYS track the anchor captured from POINTER (changed)
        let xAbsNow = null;
        let yAbsNow = null;

        const vpYear = sessionRef.current?.vpYear ?? focalRef.vpYear;
        const vpLane = sessionRef.current?.vpLane ?? focalRef.vpLane;
        if (vpYear != null && vpLane != null) {
          xAbsNow = margin.left + (xBlendAt(t, vpYear));
          yAbsNow = margin.top + (yBlendAt(t, vpLane));
        }

        if (xAbsNow != null && yAbsNow != null) {
          const dx = focalRef.fxAbs - xAbsNow;
          const dy = focalRef.fyAbs - yAbsNow;

          // No lock-based override of scaling; always use alpha (changed)
          const xAlpha = zoomAlphaFromGain(CFG.sepGain * CFG.sepgainYoverX);
          const yAlpha = zoomAlphaFromGain(CFG.sepGain);
          const dxScaled = dx * xAlpha;
          const dyScaled = dy * yAlpha;

          if (CFG.sepGain === 0) {
            const yFrozen = sessionRef.current?.yStart ?? t.y;
            t = d3.zoomIdentity.translate(t.x + dxScaled, yFrozen).scale(t.k);
          } else {
            t = d3.zoomIdentity.translate(t.x + dxScaled, t.y + dyScaled).scale(t.k);
          }
          correctedTRef.current = t;
        } else {
          correctedTRef.current = null;
        }
      } else {
        correctedTRef.current = null;
      }

      const k = t.k;
      const newX = t.rescaleX(x); // for axis ticks
      const newYForLane = (lane) => yBlendAt(t, lane);

      const selId = lockedIdRef.current;
      const neighbors = selId ? neighborSetOf(selId) : null;

      const gainScale = 360 / Math.sqrt(k);
      const P = new Map();

      nodesSel.each(function (d) {
        const lane = fieldIndex(d.field) + jitterLane(d.id);

        const baseX = xBlendAt(t, d.year ?? yearsDomain[0]);
        const baseY = newYForLane(lane);

        const v = sepAccumRef.current.get(d.id) || { x: 0, y: 0 };
        const sepX = v.x * gainScale;
        const sepY = v.y * gainScale;

        const cx = baseX + sepX;
        const cy = baseY + sepY;

        const bs = baseTileSize(d);
        const sizeBoost = 0.9 + 0.4 * (d.z ?? 0.5);
        const s = CFG.sizeScale * Math.pow(k, CFG.sizeGrowthExp) * sizeBoost;
        const tile = { w: bs.w * s, h: bs.h * s, rx: Math.min(bs.rxBase * Math.pow(k, 0.5), 16) };

        const g = d3.select(this);
        g.attr("transform", `translate(${cx - tile.w / 2},${cy - tile.h / 2})`);

        const isFocus = !!selId;
        const isNeighbor = isFocus && neighbors?.has(d.id);
        const isSelected = isFocus && d.id === selId;
        const active = !isFocus || isNeighbor || isSelected;

        g.select("rect.node-rect")
          .attr("width", tile.w)
          .attr("height", tile.h)
          .attr("rx", tile.rx)
          .attr("ry", tile.rx)
          .attr("fill", active ? d3.schemeTableau10[fields.indexOf(d.field) % 10] : "#c9c9c9")
          .attr("stroke", active ? "#333" : "#999")
          .attr("opacity", active ? 0.95 : 0.25);

        const showLabel = isSelected || isNeighbor;
        const label = g.select("text.node-label").style("opacity", showLabel ? 1 : 0);
        if (showLabel) {
          const padX = Math.max(6, tile.w * 0.06);
          const padY = Math.max(6, tile.h * 0.06);
          layoutLabel(label, tile.w, tile.h, padX, padY, d.title || "Untitled", k);
        } else {
          g.select("text.node-label").selectAll("tspan").remove();
        }

        P.set(d.id, { cx, cy, w: tile.w, h: tile.h });
      });

      // Edges
      const centerOf = (id) => {
        const p = P.get(id);
        return p ? { x: p.cx, y: p.cy } : null;
      };
      const hasSelection = !!lockedIdRef.current;
      edgesSel
        .style("display", hasSelection ? null : "none")
        .attr("d", e => {
          const sC = centerOf(e.source);
          const tC = centerOf(e.target);
          if (!sC || !tC) return null;
          const xm = (sC.x + tC.x) / 2;
          const ym = (sC.y + tC.y) / 2;
          return `M${sC.x},${sC.y} L${xm},${ym} L${tC.x},${tC.y}`;
        })
        .attr("stroke-opacity", 0.9);

      maybeDecay(k);

      // Axes (freeze y during zoom when sepGain==0)
      const yForAxis =
        (CFG.sepGain === 0 && sessionRef.current?.active && sessionRef.current.mode === "zoom")
          ? (sessionRef.current?.yStart ?? t.y)
          : t.y;

      yAxisG
        .attr("transform", `translate(0,${yForAxis})`)
        .call(
          d3.axisLeft(yLane)
            .tickValues(fields.map((_, i) => i))
            .tickFormat(i => fields[i])
        );

      xAxisG
        .call(d3.axisBottom(newX).ticks(10).tickFormat(d3.format("d")));
    }

    /* ---------------------------------------------------------------------------
     * EDGE VISIBILITY HELPERS
     * --------------------------------------------------------------------------- */
    function showEdgesFor(id) {
      const idxs = edgesByNode.get(id) || [];
      const subset = idxs.map(i => edges[i]);
      edgesSel = edgesG
        .selectAll("path.edge")
        .data(subset, d => (d ? `${d.source}->${d.target}` : undefined))
        .join("path")
        .attr("class", "edge")
        .attr("fill", "none")
        .attr("stroke", "#444")
        .attr("stroke-width", 1.2)
        .attr("vector-effect", "non-scaling-stroke");
      edgesSel.style("display", subset.length ? null : "none");
      edgesSel.raise();
    }
    function hideAllEdges() {
      edgesSel.style("display", "none");
    }

    /* ---------------------------------------------------------------------------
     * NODE EVENTS
     * --------------------------------------------------------------------------- */
    nodesSel
      .on("mouseover", function (_, d) {
        if (inCooldown() || focusLockRef.current) return;
        if (!lockedIdRef.current) {
          showEdgesFor(d.id);
          renderWithTransform(d3.zoomTransform(svg.node()));
        }
      })
      .on("mouseout", function () {
        if (inCooldown() || focusLockRef.current) return;
        if (!lockedIdRef.current) {
          hideAllEdges();
          renderWithTransform(d3.zoomTransform(svg.node()));
        }
      })
      .on("mousemove", (event, d) => {
        if (inCooldown()) return;
        const t = tooltipRef.current;
        if (!t) return;
        t.style.display = "block";
        t.style.left = `${event.pageX + 12}px`;
        t.style.top = `${event.pageY + 12}px`;
        t.innerHTML =
          `<strong>${d.title || "Untitled"}</strong><br/>` +
          (d.authors ? `<span>${d.authors}</span><br/>` : "") +
          `<em>${d.field}</em> • ${d.year ?? "n/a"}<br/>` +
          `<strong>Citations:</strong> ${d.citationCount}` +
          (d.url ? `<br/><a href="${d.url}" target="_blank" rel="noreferrer">Open source</a>` : "");
      })
      .on("mouseleave", () => {
        const t = tooltipRef.current;
        if (t) t.style.display = "none";
      })
      .on("click", function (event, d) {
        if ((now() - lastWheelTsRef.current) < INTERACT.CLICK_MS) return;
        event.stopPropagation();

        if (lockedIdRef.current === d.id) {
          lockedIdRef.current = null;
          focusLockRef.current = null;
          setSelected(null);
          hideAllEdges();
        } else {
          lockedIdRef.current = d.id;
          focusLockRef.current = d.id;
          setSelected(d);
          showEdgesFor(d.id);
        }

        // NOTE: We no longer re-anchor on the node; anchor remains mouse-pointer based.
        renderWithTransform(d3.zoomTransform(svg.node()));
      });

    // Background click => unlock
    d3.select(svgRef.current).on("click", () => {
      if ((now() - lastWheelTsRef.current) < INTERACT.CLICK_MS) return;
      lockedIdRef.current = null;
      focusLockRef.current = null;
      setSelected(null);
      hideAllEdges();
      renderWithTransform(d3.zoomTransform(svg.node()));
    });

    // Responsive
    const onResize = () => {
      renderWithTransform(d3.zoomTransform(svg.node()));
      updateMobileFlag();
      applyAxisVisibility();
    };
    window.addEventListener("resize", onResize);

    renderWithTransform(d3.zoomTransform(svg.node()));

    return () => {
      window.removeEventListener("resize", onResize);
      svg.on(".zoom", null).on("click", null);
    };
  }, [nodes, edges, fields, yearsDomain, baseTileSize]);

  /* ===============================================================================
   * REACT RENDER
   * =============================================================================== */
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
