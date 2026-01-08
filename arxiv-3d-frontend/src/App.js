// Enhanced App.js — Connections are the hero
// Features:
// - Smart edge visibility (always show important connections)
// - Directional arrows on highlighted edges
// - Citation trail via double-click (BFS traversal)
// - Animated edge appearance

import React, { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import "./App.css";

/** Configuration */
const CFG = {
  kMin: 0.5,
  kMax: 300,
  wheelBase: 0.00008,
  wheelSlowCoef: 0.10,
  sepGain: 0.2,
  sepgainYoverX: 1.00,
  accelfromWidth: 100,
  accelPow: 50,
  maxSepRadius: 40,
  autoReturn: { enabled: false, kHome: 1.0, epsilonK: 0.12, halfLifeMs: 700 },
  
  // Edge visibility settings
  edges: {
    alwaysShowTopN: 200,
    showAllUnderZoom: 3,
    animationDuration: 400,
    highlightOpacity: 0.9,
    defaultOpacity: 0.15,
    importanceThreshold: 5,
  }
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const yZoomAlphaFromSep = (g) => clamp01(g);

const jitterMaxLaneUnits = 3.5;
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

const GREY_FILL = "#d8dbe1";
const GREY_STROKE = "#8e96a3";

const baseGlueEps = 0.8;
const epsGlue = () => {
  const g = clamp01(CFG.sepGain);
  return Math.max(0.6, baseGlueEps * (0.9 + 0.6 * g));
};
const INTERACT = { CLICK_MS: 200, HOVER_MS: 140, COOLDOWN_MS: 220 };

export default function App() {
  const svgRef = useRef(null);
  const wrapRef = useRef(null);

  const [rawNodes, setRawNodes] = useState([]);
  const [rawEdges, setRawEdges] = useState([]);
  const [metadata, setMetadata] = useState(null);
  const [selected, setSelected] = useState(null);
  const [hovered, setHovered] = useState(null);

  const nodeByIdRef = useRef(new Map());
  const sepAccumRef = useRef(new Map());
  const sessionRef = useRef(null);
  const lockedIdRef = useRef(null);
  const focusLockRef = useRef(null);
  const correctedTRef = useRef(null);
  const glueDeltaRef = useRef({ dx: 0, dy: 0 });
  const committingRef = useRef(false);
  const isMobileRef = useRef(false);

  const highlightSetRef = useRef(null);
  const highlightRootRef = useRef(null);
  const trailModeRef = useRef(false);
  const trailDepthRef = useRef(2);

  const trailMetadataRef = useRef(null);

  const mousePlotRef = useRef({ x: null, y: null });
  const zStateRef = useRef({ fxAbs: null, fyAbs: null, vpYear: null, vpLane: null });
  const lastWheelTsRef = useRef(0);

  /** Load data */
  useEffect(() => {
    Promise.all([
      fetch("./nodes.json").then(r => r.json()),
      fetch("./edges.json").then(r => r.json()),
      fetch("./metadata.json").then(r => r.json()).catch(() => null),
    ])
      .then(([n, e, m]) => {
        setRawNodes(Array.isArray(n) ? n : []);
        setRawEdges(Array.isArray(e) ? e : []);
        setMetadata(m);
        console.log(`Loaded ${n.length} nodes, ${e.length} edges`);
        if (m) console.log("Metadata:", m);
      })
      .catch(err => console.error("Failed to load:", err));
  }, []);

  /** Normalize nodes */
  const nodes = useMemo(() => {
    const ns = (rawNodes || []).map(d => {
      const yr = d.year ?? d.publication_year ?? 
        (d.publicationDate ? new Date(d.publicationDate).getFullYear() : undefined);

      const field = d.primaryField || d.AI_primary_field || d.field || 
        d.primary_field || "Unassigned";

      const cites = d.citationCount ?? d.cited_by_count ?? 0;
      const authors = d.allAuthors || d.firstAuthor || d.authors || 
        d.authors_text || d.author;
      const url = d.url || d.doi_url || d.openAlexUrl || d.s2Url;

      return {
        ...d,
        id: String(d.id ?? d.paperId),
        year: Number.isFinite(+yr) ? +yr : undefined,
        field,
        citationCount: Number.isFinite(+cites) ? +cites : 0,
        authors,
        url,
        title: d.title || d.display_name || "Untitled",
        clusterId: d.clusterId ?? -1,
      };
    });

    nodeByIdRef.current = new Map(ns.map(n => [n.id, n]));
    return ns;
  }, [rawNodes]);

  /** Edges with enhanced metadata */
  const edges = useMemo(() => {
    const m = nodeByIdRef.current;
    const out = [];
    for (const e of (rawEdges || [])) {
      const s = m.get(String(e.source));
      const t = m.get(String(e.target));
      if (s && t) {
        out.push({
          source: s.id,
          target: t.id,
          importance: e.importance ?? 1,
          isCrossField: s.field !== t.field,
          sourceField: s.field,
          targetField: t.field,
        });
      }
    }
    
    out.sort((a, b) => (b.importance || 0) - (a.importance || 0));
    
    console.log(`Processed ${out.length} edges`);
    if (out.length > 0) {
      console.log(`Top edge importance: ${out[0].importance.toFixed(2)}`);
      console.log(`${out.filter(e => e.isCrossField).length} cross-field connections`);
    }
    
    return out;
  }, [rawEdges]);

  /** Adjacency map */
  const edgesByNode = useMemo(() => {
    const m = new Map();
    nodes.forEach(n => m.set(n.id, []));
    edges.forEach((e, i) => {
      m.get(e.source)?.push(i);
      m.get(e.target)?.push(i);
    });
    return m;
  }, [nodes, edges]);

  /** Fields and years */
  const { fields, fieldIndex, yearsDomain } = useMemo(() => {
    const fields = Array.from(new Set(nodes.map(d => d.field))).sort();
    const fieldIndex = f => Math.max(0, fields.indexOf(f ?? "Unassigned"));
    const years = nodes.map(d => d.year).filter(v => Number.isFinite(v));
    const minY = years.length ? d3.min(years) : 1950;
    const maxY = years.length ? d3.max(years) : 2025;
    return { fields, fieldIndex, yearsDomain: [minY - 1, maxY + 1] };
  }, [nodes]);

  /** Z & sizes */
  useEffect(() => {
    const [minC, maxC] = d3.extent(nodes, d => d.citationCount);
    const z = d3.scaleLinear().domain([minC ?? 0, maxC ?? 1]).range([0, 1]);
    nodes.forEach(d => { d.z = z(d.citationCount); });
  }, [nodes]);

  const baseTileSize = useMemo(() => {
    const [minC, maxC] = d3.extent(nodes, d => d.citationCount);
    const s = d3.scaleSqrt()
      .domain([Math.max(1, minC ?? 1), Math.max(2, maxC ?? 2)])
      .range([12, 54]);
    return d => {
      const base = s(Math.max(1, d.citationCount));
      return { w: base * 1.8, h: base * 1.1, rxBase: 8 };
    };
  }, [nodes]);

  /** Keep sep map aligned with nodes */
  useEffect(() => {
    const acc = sepAccumRef.current;
    for (const n of nodes) if (!acc.has(n.id)) acc.set(n.id, { x: 0, y: 0 });
    for (const id of Array.from(acc.keys())) {
      if (!nodeByIdRef.current.has(id)) acc.delete(id);
    }
  }, [nodes]);

  useEffect(() => { 
    lockedIdRef.current = selected?.id || null; 
  }, [selected]);

  /** MAIN D3 SCENE */
  useEffect(() => {
    if (!wrapRef.current || !svgRef.current || nodes.length === 0) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = { top: 28, right: 16, bottom: 48, left: 32 };
    const cw = Math.max(720, wrapRef.current.clientWidth || vw * 0.96);
    const ch = Math.max(1000, wrapRef.current.clientHeight || vh * 0.86);
    const width = cw - margin.left - margin.right;
    const height = ch - margin.top - margin.bottom;

    const updateMobileFlag = () => {
      isMobileRef.current = window.matchMedia("(max-width: 768px)").matches;
    };
    updateMobileFlag();

    svg.attr("width", cw).attr("height", ch)
      .style("display", "block")
      .style("background", "#f5f5f7");

    const gRoot = svg.append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);
    const gPlot = gRoot.append("g").attr("class", "plot");
    
    const x = d3.scaleLinear().domain(yearsDomain).range([0, width]);
    const yLane = d3.scaleLinear()
      .domain([0, Math.max(0, fields.length - 1)])
      .range([0, height]);
    const color = d3.scaleOrdinal(d3.schemeTableau10).domain(fields);
    
    // Add defs AFTER color scale is defined
    const defs = svg.append("defs");
    
    // Glow filter
    const filter = defs.append("filter").attr("id", "edge-glow");
    filter.append("feGaussianBlur").attr("stdDeviation", 2).attr("result", "coloredBlur");
    const feMerge = filter.append("feMerge");
    feMerge.append("feMergeNode").attr("in", "coloredBlur");
    feMerge.append("feMergeNode").attr("in", "SourceGraphic");
    
    // Create gradient definitions for flowing edges - MORE DRAMATIC
    const createFlowGradient = (id, startColor, endColor) => {
      const grad = defs.append("linearGradient")
        .attr("id", id)
        .attr("gradientUnits", "userSpaceOnUse");
      
      // Much more dramatic gradient: 
      // Bright and solid at start, fade quickly to nearly invisible
      grad.append("stop")
        .attr("offset", "0%")
        .attr("stop-color", startColor)
        .attr("stop-opacity", 1.0);
      
      grad.append("stop")
        .attr("offset", "15%")
        .attr("stop-color", startColor)
        .attr("stop-opacity", 0.95);
      
      grad.append("stop")
        .attr("offset", "60%")
        .attr("stop-color", endColor)
        .attr("stop-opacity", 0.25);
        
      grad.append("stop")
        .attr("offset", "100%")
        .attr("stop-color", endColor)
        .attr("stop-opacity", 0.05);
    };
    
    // Helper to create valid CSS ID from field name
    const fieldToId = (field) => {
      return field.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-');
    };
    
    // Create flow gradients for each field
    fields.forEach(field => {
      const fieldId = fieldToId(field);
      const fieldColor = color(field);
      createFlowGradient(`flow-${fieldId}`, fieldColor, fieldColor);
    });
    createFlowGradient('flow-default', '#5b6573', '#5b6573');
    createFlowGradient('flow-highlight', '#1f2937', '#6b7280');
    
    // Arrow markers - MUCH MORE VISIBLE
    const createArrowMarker = (id, fillColor, size = 5) => {
      defs.append("marker")
        .attr("id", id)
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 9)
        .attr("refY", 0)
        .attr("markerWidth", size)
        .attr("markerHeight", size)
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-4L9,0L0,4L2,0Z")  // Solid triangle
        .attr("fill", fillColor)
        .attr("opacity", 1.0);  // Fully opaque arrows
    };
    
    fields.forEach(field => {
      const fieldId = fieldToId(field);
      createArrowMarker(`arrow-${fieldId}`, color(field), 7);  // Bigger arrows
    });
    createArrowMarker('arrow-default', '#5b6573', 7);
    createArrowMarker('arrow-highlight', '#1f2937', 9);  // Even bigger for trail

    const gAxes = gRoot.append("g").attr("class", "axes");

    const xAxisG = gAxes.append("g")
      .attr("transform", `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(10).tickFormat(d3.format("d")));

    const edgesG = gPlot.append("g").attr("class", "edges");
    const nodesG = gPlot.append("g").attr("class", "nodes");

    const nodesSel = nodesG.selectAll("g.node")
      .data(nodes, d => d.id)
      .join(enter => {
        const g = enter.append("g")
          .attr("class", "node")
          .style("cursor", "pointer");

        g.append("rect")
          .attr("class", "node-rect")
          .attr("stroke", "#333")
          .attr("fill", d => color(d.field))
          .attr("opacity", 0.85)
          .attr("vector-effect", "non-scaling-stroke");

        g.append("line")
          .attr("class", "node-header")
          .attr("stroke", "#1f2937")
          .attr("stroke-opacity", 0.25)
          .attr("vector-effect", "non-scaling-stroke")
          .style("display", "none");

        const fo = g.append("foreignObject")
          .attr("class", "node-label")
          .style("display", "none")
          .style("pointer-events", "none");

        fo.append("xhtml:div")
          .attr("class", "label-div")
          .style("width", "100%")
          .style("height", "100%")
          .style("overflow", "hidden")
          .style("word-wrap", "break-word")
          .style("line-height", "1.15")
          .style("font-weight", "600")
          .style("font-family", "ui-sans-serif, system-ui")
          .style("color", "#111827")
          .text(d => d.title || "Untitled");

        return g;
      });

    nodesSel.sort((a, b) => (a.citationCount ?? 0) - (b.citationCount ?? 0));

    let edgesSel = edgesG.selectAll("path.edge");

    const nodeWidthAtK = (d, k) => {
      const base = baseTileSize(d);
      const sizeBoost = 0.9 + 0.4 * (d.z ?? 0.5);
      return base.w * Math.pow(k, 1.2) * sizeBoost;
    };

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

    function accumulateSeparationStep(deltaInc, t, session, kNow) {
      const gSep = Math.max(0, CFG.sepGain);
      if (!session || gSep === 0 || deltaInc === 0) return;

      const isZoomIn = deltaInc > 0;
      const rawStep = gSep * deltaInc;
      const maxStep = 0.22;
      const stepBase = Math.max(-maxStep, Math.min(maxStep, rawStep));

      const anchorYear = session.vpYear;
      const anchorLane = session.vpLane;
      const ratioYX = Math.max(0, CFG.sepgainYoverX);
      const wX = 1;
      const wY = Number.isFinite(ratioYX) ? ratioYX : 1e6;
      const th = Math.max(1e-6, CFG.accelfromWidth);
      const maxR = CFG.maxSepRadius ?? 40;

      for (const d of nodes) {
        const lane = fieldIndex(d.field) + jitterLane(d.id);
        const W = nodeWidthAtK(d, kNow);
        const ratio = W / th;
        const accel = ratio <= 1 ? 1 : Math.pow(ratio, CFG.accelPow);
        const local = session.coeffById?.get(d.id) ?? 0;
        const strength = (0.25 + 0.75 * local) * accel;

        const prev = sepAccumRef.current.get(d.id) || { x: 0, y: 0 };
        let nx = prev.x;
        let ny = prev.y;

        if (isZoomIn) {
          const px = xBlendAt(t, d.year ?? yearsDomain[0]) - xBlendAt(t, anchorYear);
          const py = yBlendAt(t, lane) - yBlendAt(t, anchorLane);
          let vx = px * wX;
          let vy = py * wY;
          const norm = Math.hypot(vx, vy) || 1;
          vx /= norm;
          vy /= norm;
          const mag = stepBase * strength;
          nx += mag * vx;
          ny += mag * vy;
        } else {
          const r = Math.hypot(prev.x, prev.y);
          if (r > 1e-6) {
            const baseAlpha = (-stepBase) * strength;
            const alpha = Math.max(0, Math.min(0.2, baseAlpha));
            const keep = 1 - alpha;
            nx = prev.x * keep;
            ny = prev.y * keep;
          }
        }

        const rNew = Math.hypot(nx, ny);
        if (rNew > maxR) {
          const sClamp = maxR / rNew;
          nx *= sClamp;
          ny *= sClamp;
        }

        sepAccumRef.current.set(d.id, { x: nx, y: ny });
      }
    }

    function pointerInPlot(sourceEvent) {
      const [px0, py0] = d3.pointer(sourceEvent, gRoot.node());
      return [
        Math.max(0, Math.min(width, px0)),
        Math.max(0, Math.min(height, py0))
      ];
    }

    function gestureAnchorPlot(sourceEvent) {
      const se = sourceEvent;
      if (se?.touches?.length >= 2) {
        const rect = gRoot.node().getBoundingClientRect();
        const cx = (se.touches[0].clientX + se.touches[1].clientX) / 2 - rect.left;
        const cy = (se.touches[0].clientY + se.touches[1].clientY) / 2 - rect.top;
        return [
          Math.max(0, Math.min(width, cx)),
          Math.max(0, Math.min(height, cy))
        ];
      }
      return se ? pointerInPlot(se) : [width / 2, height / 2];
    }

    svg.on("pointermove", (ev) => {
      const [px, py] = pointerInPlot(ev);
      mousePlotRef.current = { x: px, y: py };
    });

    const a = yZoomAlphaFromSep(CFG.sepGain);

    function xBlendAt(t, year) {
      const kx = (1 - a) + a * t.k;
      return kx * x(year) + t.x;
    }

    function invXBlendYear(t, fx) {
      const kx = (1 - a) + a * t.k;
      return x.invert((fx - t.x) / Math.max(1e-6, kx));
    }

    function yBlendAt(t, lane) {
      const ky = (1 - a) + a * t.k;
      return ky * yLane(lane) + t.y;
    }

    function invYBlendLane(t, fy) {
      const ky = (1 - a) + a * t.k;
      return yLane.invert((fy - t.y) / Math.max(1e-6, ky));
    }

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

    let lastDecayTs = performance.now();
    function maybeDecay(k) {
      const ar = CFG.autoReturn;
      const gain = Math.max(0, CFG.sepGain);
      if (!ar.enabled || gain === 0) return;

      const within = Math.abs(k - ar.kHome) <= (ar.kHome * ar.epsilonK);
      if (!within) {
        lastDecayTs = performance.now();
        return;
      }
      const tNow = performance.now();
      const dt = tNow - lastDecayTs;
      if (dt <= 0) return;
      lastDecayTs = tNow;

      const scaledHalfLife = Math.max(80, ar.halfLifeMs) / Math.max(1e-6, gain);
      const decay = Math.pow(0.5, dt / scaledHalfLife);

      const acc = sepAccumRef.current;
      for (const [id, v] of acc) {
        acc.set(id, { x: v.x * decay, y: v.y * decay });
      }
    }

    let rafId = null, pendingT = null;

    const zoom = d3.zoom()
      .scaleExtent([CFG.kMin, CFG.kMax])
      .wheelDelta(wheelDelta)
      .translateExtent([[-1e7, -1e7], [width + 1e7, height + 1e7]])
      .filter(ev => !(ev.ctrlKey && ev.type === "wheel"))
      .on("start", (ev) => {
        if (committingRef.current) return;
        const se = ev?.sourceEvent;
        const t = d3.zoomTransform(svg.node());

        sessionRef.current = {
          active: true,
          isZooming: false,
          logK0: Math.log(Math.max(1e-6, t.k)),
          incNow: 0,
          incPrev: 0,
          coeffById: null,
          vpYear: null,
          vpLane: null,
          fxAbs: null,
          fyAbs: null,
          yStart: t.y,
        };

        let fxPlot, fyPlot, vpYear, vpLane;
        const locked = focusLockRef.current
          ? nodeByIdRef.current.get(focusLockRef.current)
          : null;

        if (locked) {
          const lane = fieldIndex(locked.field) + jitterLane(locked.id);
          fxPlot = xBlendAt(t, locked.year ?? yearsDomain[0]);
          fyPlot = yBlendAt(t, lane);
          vpYear = locked.year ?? yearsDomain[0];
          vpLane = lane;
        } else {
          let px, py;
          if (isMobileRef.current) {
            px = width / 2;
            py = height / 2;
          } else {
            [px, py] = gestureAnchorPlot(se);
          }
          fxPlot = px;
          fyPlot = py;
          vpYear = invXBlendYear(t, fxPlot);
          vpLane = invYBlendLane(t, fyPlot);
        }

        const fxAbs = margin.left + fxPlot;
        const fyAbs = margin.top + fyPlot;

        zStateRef.current = { fxAbs, fyAbs, vpYear, vpLane };
        sessionRef.current.vpYear = vpYear;
        sessionRef.current.vpLane = vpLane;
        sessionRef.current.fxAbs = fxAbs;
        sessionRef.current.fyAbs = fyAbs;
        sessionRef.current.coeffById = buildFocalWeightsUsingAnchor(t, vpYear, vpLane);
      })
      .on("zoom", (ev) => {
        if (committingRef.current) return;
        const t = ev.transform;
        const s = sessionRef.current;
        if (!s) return;

        const logK = Math.log(Math.max(1e-6, t.k));
        const prevInc = s.incNow ?? 0;
        const incNow = logK - s.logK0;
        const deltaInc = incNow - prevInc;

        s.incPrev = prevInc;
        s.incNow = incNow;

        const isScaleChange = Math.abs(deltaInc) > 1e-7;
        if (isScaleChange) {
          s.isZooming = true;
          accumulateSeparationStep(deltaInc, t, s, t.k);
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

        const tNow = correctedTRef.current || d3.zoomTransform(svg.node());
        const finalT = correctedTRef.current;
        const { dx = 0, dy = 0 } = glueDeltaRef.current || {};
        const delta = Math.hypot(dx, dy);

        if (finalT && delta >= epsGlue()) {
          committingRef.current = true;
          d3.select(svg.node()).call(zoom.transform, finalT);
          committingRef.current = false;
          requestAnimationFrame(() => renderWithTransform(finalT));
        } else {
          requestAnimationFrame(() => renderWithTransform(tNow));
        }

        s.active = false;
        s.isZooming = false;
        s.incNow = 0;
        s.incPrev = 0;
        correctedTRef.current = null;
        glueDeltaRef.current = { dx: 0, dy: 0 };
      });

    svg.call(zoom);
    svg.on("dblclick.zoom", null);

    // Highlight helpers
    function resetHighlight() {
      highlightSetRef.current = null;
      highlightRootRef.current = null;
      trailModeRef.current = false;
      trailMetadataRef.current = null; 
    }

    function highlightNeighborhood(id, { raise = false } = {}) {
      if (!id) {
        resetHighlight();
        return;
      }
      const idxs = edgesByNode.get(id) || [];
      const sset = new Set([id]);
      idxs.forEach(i => {
        const e = edges[i];
        sset.add(e.source);
        sset.add(e.target);
      });

      highlightSetRef.current = sset;
      highlightRootRef.current = id;
      trailModeRef.current = false;
      trailMetadataRef.current = null;

      if (raise) {
        const nodesSelLocal = d3.select(gPlot.node()).selectAll("g.node");
        nodesSelLocal.filter(d => sset.has(d.id)).raise();
        nodesSelLocal.filter(d => d.id === id).raise();
      }
    }
    
    function highlightCitationTrail(id, depth = 1, { raise = false } = {}) {
      if (!id) {
        resetHighlight();
        trailMetadataRef.current = null;
        return;
      }
      
      if (depth === 1) {
        // Depth 1: Just immediate neighbors (same as single click)
        highlightNeighborhood(id, { raise });
        trailModeRef.current = true;
        trailMetadataRef.current = null;
        return;
      }
      
      // Depth 2: Information flow through time
      // Track which direction each paper is from root
      
      const rootEdges = edgesByNode.get(id) || [];
      
      // First hop: separate into "past" (cited by root) and "future" (citing root)
      const pastPapers = new Set();      // Papers root cited (older)
      const futurePapers = new Set();    // Papers citing root (newer)
      
      rootEdges.forEach(i => {
        const e = edges[i];
        if (e.source === id) {
          // Root cites target: target is in the PAST
          pastPapers.add(e.target);
        } else if (e.target === id) {
          // Source cites root: source is in the FUTURE
          futurePapers.add(e.source);
        }
      });
      
      console.log(`[trail] Past: ${pastPapers.size}, Future: ${futurePapers.size}`);
      
      // Second hop:
      // For PAST papers: find papers THEY cited (going further back)
      const deepPastPapers = new Set();
      pastPapers.forEach(paperId => {
        const edges2 = edgesByNode.get(paperId) || [];
        edges2.forEach(i => {
          const e = edges[i];
          if (e.source === paperId) {
            // This past paper cites another (deeper in past)
            deepPastPapers.add(e.target);
          }
        });
      });
      
      // For FUTURE papers: find papers that cite THEM (going further forward)
      const deepFuturePapers = new Set();
      futurePapers.forEach(paperId => {
        const edges2 = edgesByNode.get(paperId) || [];
        edges2.forEach(i => {
          const e = edges[i];
          if (e.target === paperId) {
            // Another paper cites this future paper (deeper in future)
            deepFuturePapers.add(e.source);
          }
        });
      });
      
      console.log(`[trail] Deep past: ${deepPastPapers.size}, Deep future: ${deepFuturePapers.size}`);
      
      // Store metadata about trail structure
      trailMetadataRef.current = {
        root: id,
        past: pastPapers,
        future: futurePapers,
        deepPast: deepPastPapers,
        deepFuture: deepFuturePapers
      };
      
      // Combine all into trail set
      const trailSet = new Set([
        id,
        ...pastPapers,
        ...futurePapers,
        ...deepPastPapers,
        ...deepFuturePapers
      ]);
      
      // Limit if too large
      if (trailSet.size > 50) {
        console.log(`[trail] Trail too large (${trailSet.size}), limiting...`);
        
        const sortByCitations = (set) => {
          return Array.from(set).sort((a, b) => {
            const aNode = nodeByIdRef.current.get(a);
            const bNode = nodeByIdRef.current.get(b);
            return (bNode?.citationCount || 0) - (aNode?.citationCount || 0);
          });
        };
        
        const topPast = sortByCitations(pastPapers).slice(0, 6);
        const topFuture = sortByCitations(futurePapers).slice(0, 6);
        const topDeepPast = sortByCitations(deepPastPapers).slice(0, 4);
        const topDeepFuture = sortByCitations(deepFuturePapers).slice(0, 4);
        
        trailSet.clear();
        trailSet.add(id);
        topPast.forEach(p => trailSet.add(p));
        topFuture.forEach(p => trailSet.add(p));
        topDeepPast.forEach(p => trailSet.add(p));
        topDeepFuture.forEach(p => trailSet.add(p));
        
        // Update metadata with limited sets
        trailMetadataRef.current = {
          root: id,
          past: new Set(topPast),
          future: new Set(topFuture),
          deepPast: new Set(topDeepPast),
          deepFuture: new Set(topDeepFuture)
        };
      }
      
      console.log(`[trail] Final trail size: ${trailSet.size} papers`);
      
      highlightSetRef.current = trailSet;
      highlightRootRef.current = id;
      trailModeRef.current = true;
      
      if (raise) {
        const nodesSelLocal = d3.select(gPlot.node()).selectAll("g.node");
        nodesSelLocal.filter(d => trailSet.has(d.id)).raise();
        nodesSelLocal.filter(d => d.id === id).raise();
      }
    }

    // RENDER FUNCTION
    function renderWithTransform(rawT) {
      let t = rawT;

      if (sessionRef.current?.active && sessionRef.current.isZooming) {
        const { fxAbs, fyAbs, vpYear, vpLane } = zStateRef.current || {};

        if (fxAbs != null && fyAbs != null && vpYear != null && vpLane != null) {
          const ax = margin.left + xBlendAt(t, vpYear);
          const ay = margin.top + yBlendAt(t, vpLane);
          const dx = fxAbs - ax;
          const dy = fyAbs - ay;

          if (CFG.sepGain === 0) {
            const yFrozen = sessionRef.current?.yStart ?? t.y;
            t = d3.zoomIdentity.translate(t.x + dx, yFrozen).scale(t.k);
            glueDeltaRef.current = { dx, dy: 0 };
          } else {
            t = d3.zoomIdentity.translate(t.x + dx, t.y + dy).scale(t.k);
            glueDeltaRef.current = { dx, dy };
          }

          correctedTRef.current = t;
        } else {
          correctedTRef.current = null;
          glueDeltaRef.current = { dx: 0, dy: 0 };
        }
      } else {
        correctedTRef.current = null;
        glueDeltaRef.current = { dx: 0, dy: 0 };
      }

      const k = t.k;
      const newX = (year) => xBlendAt(t, year);
      const newY = (lane) => yBlendAt(t, lane);

      maybeDecay(k);

      const showAllEdges = k >= CFG.edges.showAllUnderZoom;
      const inHighlight = !!highlightSetRef.current;
      
      let visibleEdges = [];
      if (inHighlight) {
        if (trailModeRef.current && trailMetadataRef.current) {
          // TRAIL MODE: Only show edges that follow the directional flow
          const meta = trailMetadataRef.current;
          const rootId = meta.root;
          
          visibleEdges = edges.filter(e => {
            const src = e.source;
            const tgt = e.target;
            
            // Rule 1: Root → Past papers (root cites them)
            if (src === rootId && meta.past.has(tgt)) return true;
            
            // Rule 2: Future papers → Root (they cite root)
            if (tgt === rootId && meta.future.has(src)) return true;
            
            // Rule 3: Past papers → Deep past (past papers cite deeper past)
            if (meta.past.has(src) && meta.deepPast.has(tgt)) return true;
            
            // Rule 4: Deep future → Future papers (deep future cites future)
            if (meta.deepFuture.has(src) && meta.future.has(tgt)) return true;
            
            // Don't show any other edges
            return false;
          });
          
          console.log(`[trail] Showing ${visibleEdges.length} directional edges`);
        } else if (trailModeRef.current) {
          // Trail mode but no metadata (depth 1)
          const idxs = edgesByNode.get(highlightRootRef.current) || [];
          visibleEdges = idxs.map(i => edges[i]);
        } else {
          // NORMAL HIGHLIGHT: Just edges connected to root
          const idxs = edgesByNode.get(highlightRootRef.current) || [];
          visibleEdges = idxs.map(i => edges[i]);
        }
      } else if (showAllEdges) {
        visibleEdges = edges;
      } else {
        visibleEdges = edges.slice(0, CFG.edges.alwaysShowTopN);
      }

      const P = new Map();
      const gSep = Math.max(0, CFG.sepGain);
      const sepFactor = 360 / Math.sqrt(k);

      nodesSel.each(function (d) {
        const lane = fieldIndex(d.field) + jitterLane(d.id);
        const baseX = newX(d.year ?? yearsDomain[0]);
        const baseY = newY(lane);

        const v = sepAccumRef.current.get(d.id) || { x: 0, y: 0 };
        const sepX = v.x * gSep * sepFactor;
        const sepY = v.y * gSep * sepFactor;

        const cx = baseX + sepX;
        const cy = baseY + sepY;

        const bs = baseTileSize(d);
        const s = Math.pow(k, 1.2) * (0.9 + 0.4 * (d.z ?? 0.5));
        const tile = {
          w: bs.w * s,
          h: bs.h * s,
          rx: Math.min(bs.rxBase * Math.pow(k, 0.5), 16)
        };

        const g = d3.select(this);
        g.attr("transform", `translate(${cx - tile.w / 2},${cy - tile.h / 2})`);

        const isHighlighted = inHighlight && highlightSetRef.current.has(d.id);
        const isRoot = inHighlight && highlightRootRef.current === d.id;

        g.select("rect.node-rect")
          .attr("width", tile.w)
          .attr("height", tile.h)
          .attr("rx", tile.rx)
          .attr("ry", tile.rx)
          .attr("fill", inHighlight ? 
            (isHighlighted ? color(d.field) : GREY_FILL) : 
            color(d.field))
          .attr("opacity", inHighlight ?
            (isHighlighted ? 0.95 : 0.55) :
            0.85 * (0.6 + 0.4 * (d.z ?? 0.5)))
          .attr("stroke", inHighlight ?
            (isHighlighted ? "#1f2937" : GREY_STROKE) :
            "#333")
          .attr("stroke-width", inHighlight ?
            (isRoot ? 2.6 : (isHighlighted ? 2.0 : 1.2)) :
            1.2);

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

      const centerOf = id => {
        const p = P.get(id);
        return p ? { x: p.cx, y: p.cy } : null;
      };

      edgesSel = edgesG.selectAll("path.edge")
        .data(visibleEdges, e => e ? `${e.source}->${e.target}` : undefined);

      edgesSel.exit()
        .transition()
        .duration(CFG.edges.animationDuration)
        .attr("stroke-opacity", 0)
        .remove();

      const edgesEnter = edgesSel.enter()
        .append("path")
        .attr("class", "edge")
        .attr("fill", "none")
        .attr("stroke-opacity", 0)
        .attr("vector-effect", "non-scaling-stroke");

      edgesSel = edgesEnter.merge(edgesSel);

      edgesSel
        .each(function(e) {
          const sC = centerOf(e.source);
          const tC = centerOf(e.target);
          if (!sC || !tC) return;
          
          // Update gradient to match actual line position
          const fieldId = fieldToId(e.sourceField);
          const gradId = inHighlight && highlightSetRef.current.has(e.source) ?
            (trailModeRef.current ? 'flow-highlight' : `flow-${fieldId}`) :
            'flow-default';
          
          const grad = svg.select(`#${gradId}`);
          if (!grad.empty()) {
            grad.attr("x1", sC.x).attr("y1", sC.y)
               .attr("x2", tC.x).attr("y2", tC.y);
          }
        })
        .attr("d", e => {
          const sC = centerOf(e.source);
          const tC = centerOf(e.target);
          if (!sC || !tC) return null;
          
          const dx = tC.x - sC.x;
          const dy = tC.y - sC.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          
          // Flowing curve with directional bias
          const curveFactor = inHighlight ? 0.3 : 0.25;
          const dr = dist * curveFactor;
          
          // Control point for smooth flow
          const mx = sC.x + dx * 0.5;
          const my = sC.y + dy * 0.5;
          
          // Perpendicular offset
          const offsetX = -dy / dist * dr;
          const offsetY = dx / dist * dr;
          
          return `M${sC.x},${sC.y} Q${mx + offsetX},${my + offsetY} ${tC.x},${tC.y}`;
        })
        .attr("stroke", e => {
          if (inHighlight) {
            const isSource = highlightSetRef.current.has(e.source);
            const isTarget = highlightSetRef.current.has(e.target);
            
            if (trailModeRef.current) {
              // In trail mode, show all edges with gradient
              if (isSource && isTarget) {
                const fieldId = fieldToId(e.sourceField);
                return `url(#flow-${fieldId})`;
              }
              return GREY_STROKE;
            } else {
              // Normal highlight mode - only edges FROM root
              if (isSource) {
                const fieldId = fieldToId(e.sourceField);
                return `url(#flow-${fieldId})`;
              } else {
                return GREY_STROKE;
              }
            }
          }
          // Default view: subtle solid colors
          return e.isCrossField ? "#7a8a99" : color(e.sourceField);
        })
        .attr("stroke-width", e => {
          if (inHighlight) {
            if (trailModeRef.current) {
              // All trail edges visible
              const isSource = highlightSetRef.current.has(e.source);
              const isTarget = highlightSetRef.current.has(e.target);
              if (isSource && isTarget) {
                // Is this edge FROM the root?
                const rootIdxs = edgesByNode.get(highlightRootRef.current) || [];
                const isFromRoot = rootIdxs.some(i => {
                  const rootEdge = edges[i];
                  return rootEdge.source === e.source && rootEdge.target === e.target;
                });
                return isFromRoot ? 3.5 : 2.4;
              }
              return 1.6;
            } else {
              const isSource = highlightSetRef.current.has(e.source);
              return isSource ? 3.2 : 1.6;
            }
          }
          const base = 1.2;
          const importanceBoost = Math.min(1.6, 1 + (e.importance || 0) / 30);
          return base * importanceBoost;
        })
        .attr("stroke-linecap", "round")
        .attr("stroke-dasharray", e => {
          if (!inHighlight) return null;
          
          const sourceNode = nodeByIdRef.current.get(e.source);
          const targetNode = nodeByIdRef.current.get(e.target);
          
          // Subtle dash for reverse-time citations (unusual case)
          if (sourceNode?.year && targetNode?.year) {
            return sourceNode.year < targetNode.year ? "5 4" : null;
          }
          return null;
        })
        .attr("marker-end", null)  // NO ARROWS - they look stupid
        .attr("filter", e => {
          if (inHighlight && highlightSetRef.current.has(e.source)) {
            return "url(#edge-glow)";
          }
          return null;
        });

      edgesEnter
        .transition()
        .duration(CFG.edges.animationDuration)
        .attr("stroke-opacity", e => {
          if (inHighlight) return CFG.edges.highlightOpacity;
          return e.importance > CFG.edges.importanceThreshold ?
            CFG.edges.defaultOpacity * 1.5 :
            CFG.edges.defaultOpacity;
        });

      edgesSel
        .filter(function() { return !this.classList.contains('entering'); })
        .attr("stroke-opacity", e => {
          if (inHighlight) return CFG.edges.highlightOpacity;
          return e.importance > CFG.edges.importanceThreshold ?
            CFG.edges.defaultOpacity * 1.5 :
            CFG.edges.defaultOpacity;
        });

      const kx = (1 - a) + a * t.k;
      const xAxisScale = x.copy().range(x.range().map(v => kx * v + t.x));
      xAxisG.call(d3.axisBottom(xAxisScale).ticks(10).tickFormat(d3.format("d")));
    }

    const inCooldown = () =>
      (performance.now() - lastWheelTsRef.current) < INTERACT.COOLDOWN_MS;

    nodesSel
      .on("mouseover", function (_, d) {
        if (inCooldown() || focusLockRef.current) return;
        setHovered(d);

        if (!lockedIdRef.current) {
          highlightNeighborhood(d.id, { raise: true });
          renderWithTransform(d3.zoomTransform(svg.node()));
        }
      })
      .on("mouseout", function () {
        if (inCooldown() || focusLockRef.current) return;
        setHovered(null);

        if (!lockedIdRef.current) {
          resetHighlight();
          renderWithTransform(d3.zoomTransform(svg.node()));
        }
      })
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
          setHovered(null);
          highlightNeighborhood(d.id, { raise: true });

          const tNow = d3.zoomTransform(svg.node());
          const lane = fieldIndex(d.field) + jitterLane(d.id);
          const fxAbs = margin.left + xBlendAt(tNow, d.year ?? yearsDomain[0]);
          const fyAbs = margin.top + yBlendAt(tNow, lane);

          zStateRef.current = {
            fxAbs,
            fyAbs,
            vpYear: d.year ?? yearsDomain[0],
            vpLane: lane
          };
        }

        renderWithTransform(d3.zoomTransform(svg.node()));
      })
      .on("dblclick", function (event, d) {
        event.stopPropagation();
        
        if (lockedIdRef.current === d.id && trailModeRef.current && trailDepthRef.current === 2) {
          // Third click: back to single click mode
          lockedIdRef.current = d.id;
          focusLockRef.current = d.id;
          setSelected(d);
          setHovered(null);
          highlightNeighborhood(d.id, { raise: true });
          trailDepthRef.current = 1;
        } else if (lockedIdRef.current === d.id && trailDepthRef.current === 1) {
          // Second click: activate trail mode (depth 2)
          trailDepthRef.current = 2;
        } else {
          // First click: start at depth 1
          trailDepthRef.current = 1;
          lockedIdRef.current = d.id;
          focusLockRef.current = d.id;
          setSelected(d);
          setHovered(null);
        }
        
        highlightCitationTrail(d.id, trailDepthRef.current, { raise: true });
        renderWithTransform(d3.zoomTransform(svg.node()));
      });

    svg.on("click", () => {
      if ((performance.now() - lastWheelTsRef.current) < INTERACT.CLICK_MS) return;
      lockedIdRef.current = null;
      focusLockRef.current = null;
      setSelected(null);
      resetHighlight();
      renderWithTransform(d3.zoomTransform(svg.node()));
    });

    const onResize = () => {
      renderWithTransform(d3.zoomTransform(svg.node()));
      updateMobileFlag();
    };
    window.addEventListener("resize", onResize);
    renderWithTransform(d3.zoomTransform(svg.node()));

    return () => {
      window.removeEventListener("resize", onResize);
      svg.on(".zoom", null).on("click", null).on("pointermove", null);
    };
  }, [nodes, edges, fields, yearsDomain, baseTileSize, edgesByNode, fieldIndex]);

  const activeNode = selected || hovered;

  return (
    <div className="app-wrap">
      <header className="mobile-header">
        <button className="menu-btn">☰</button>
        <div className="app-title">MAPO</div>
        {metadata && (
          <div style={{ fontSize: '11px', color: '#666' }}>
            {metadata.nodeCount} papers • {metadata.edgeCount} connections
          </div>
        )}
        <input
          type="text"
          className="search-input"
          placeholder="Search papers..."
        />
      </header>

      <div className="app-main">
        <div className="canvas-container" ref={wrapRef}>
          <svg ref={svgRef} />
        </div>
      </div>

      <footer className="mobile-footer">
        {activeNode ? (
          <div className="footer-details">
            <div className="footer-title">
              {activeNode.title || "Untitled"}
            </div>
            <div className="footer-meta">
              {activeNode.authors && (
                <span className="footer-authors">{activeNode.authors}</span>
              )}
              {activeNode.field && (
                <span className="footer-dot"> • {activeNode.field}</span>
              )}
              {activeNode.year && (
                <span className="footer-dot"> • {activeNode.year}</span>
              )}
              <span className="footer-dot">
                {" "}• Citations: {activeNode.citationCount ?? 0}
              </span>
              {activeNode.clusterId >= 0 && (
                <span className="footer-dot">
                  {" "}• Cluster {activeNode.clusterId}
                </span>
              )}
            </div>
            {selected && (
              <div style={{ fontSize: '11px', color: '#888', marginTop: '4px' }}>
                {trailModeRef.current && trailDepthRef.current === 2 ? (
                  <>
                    Information flow: {highlightSetRef.current?.size || 0} papers • 
                    Earlier work → Selected paper → Later citations • 
                    Double-click again to reset
                  </>
                ) : (
                  'Single-click: neighbors • Double-click: information flow through time'
                )}
              </div>
            )}
          </div>
        ) : (
          <div style={{ textAlign: 'center', color: '#666' }}>
            Explore • Click to select • Double-click for citation trail
          </div>
        )}
      </footer>
    </div>
  );
}