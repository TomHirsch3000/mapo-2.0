// App.js
import React, { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import "./App.css";

export default function App() {
  const svgRef = useRef(null);
  const wrapRef = useRef(null);
  const tooltipRef = useRef(null);

  const [rawNodes, setRawNodes] = useState([]);
  const [rawEdges, setRawEdges] = useState([]);
  const [selected, setSelected] = useState(null);

  // ----- Load data -----
  useEffect(() => {
    Promise.all([
      fetch("/nodes.json").then((r) => r.json()),
      fetch("/edges.json").then((r) => r.json()),
    ])
      .then(([n, e]) => {
        setRawNodes(Array.isArray(n) ? n : []);
        setRawEdges(Array.isArray(e) ? e : []);
      })
      .catch((err) => console.error("Failed to load data:", err));
  }, []);

  // ----- Normalize node fields -----
  const nodes = useMemo(() => {
    return (rawNodes || []).map((d) => {
      const yr =
        d.year ??
        d.publication_year ??
        (d.publicationDate ? new Date(d.publicationDate).getFullYear() : undefined);
      const field = d.AI_primary_field || d.field || d.primary_field || "Unassigned";
      const cites = d.citationCount ?? d.cited_by_count ?? 0;
      return {
        ...d,
        id: String(d.id),
        year: Number.isFinite(+yr) ? +yr : undefined,
        field,
        citationCount: Number.isFinite(+cites) ? +cites : 0,
      };
    });
  }, [rawNodes]);

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // keep only valid edges
  const edges = useMemo(() => {
    const out = [];
    for (const e of rawEdges || []) {
      const s = nodeById.get(String(e.source));
      const t = nodeById.get(String(e.target));
      if (s && t) out.push({ source: s.id, target: t.id });
    }
    return out;
  }, [rawEdges, nodeById]);

  // adjacency for highlighting
  const edgesByNode = useMemo(() => {
    const m = new Map();
    for (const n of nodes) m.set(n.id, []);
    edges.forEach((e, i) => {
      m.get(e.source)?.push(i);
      m.get(e.target)?.push(i);
    });
    return m;
  }, [nodes, edges]);

  // ----- Layout & scales -----
  const { x, yIndex, color, width, height, margin, fields } = useMemo(() => {
    const margin = { top: 24, right: 24, bottom: 44, left: 160 };
    const cw = wrapRef.current?.clientWidth ?? 1200;
    const ch = wrapRef.current?.clientHeight ?? 720;
    const width = Math.max(400, cw - margin.left - margin.right);
    const height = Math.max(300, ch - margin.top - margin.bottom);

    const years = nodes.map((d) => d.year).filter((v) => Number.isFinite(v));
    const minYear = years.length ? d3.min(years) : 1950;
    const maxYear = years.length ? d3.max(years) : 2025;
    const x = d3.scaleLinear().domain([minYear - 1, maxYear + 1]).range([0, width]);

    const fields = Array.from(new Set(nodes.map((d) => d.field))).sort();
    const yIndex = d3
      .scaleLinear()
      .domain([0, Math.max(0, fields.length - 1)])
      .range([0, height]);

    const color = d3.scaleOrdinal(d3.schemeTableau10).domain(fields);

    return { x, yIndex, color, width, height, margin, fields };
  }, [nodes]);

  // ----- Depth (z) by citations (for y-projection + slight fade) -----
  useEffect(() => {
    const [minC, maxC] = d3.extent(nodes, (d) => d.citationCount);
    const zScale = d3.scaleLinear().domain([minC ?? 0, maxC ?? 1]).range([0, 1]); // 0 back, 1 front
    nodes.forEach((d) => (d.z = zScale(d.citationCount)));
  }, [nodes]);

  // ----- Base rounded-rect size by citations -----
  const sizeByCitations = useMemo(() => {
    const [minC, maxC] = d3.extent(nodes, (d) => d.citationCount);
    const s = d3
      .scaleSqrt()
      .domain([Math.max(1, minC ?? 1), Math.max(2, maxC ?? 2)])
      .range([10, 48]); // scalar base

    return (c) => {
      const base = s(Math.max(1, c));
      const w = base * 1.8;
      const h = base * 1.1;
      return { w, h };
    };
  }, [nodes]);

  // ------------------ RENDER ------------------
  useEffect(() => {
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const W = width + margin.left + margin.right;
    const H = height + margin.top + margin.bottom;
    svg.attr("width", W).attr("height", H);

    const gRoot = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
    const gPlot = gRoot.append("g").attr("class", "plot");

    // Arrow marker (used only for highlights)
    const defs = svg.append("defs");
    defs
      .append("marker")
      .attr("id", "arrowhead-mid")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 5)
      .attr("refY", 0)
      .attr("markerWidth", 7)
      .attr("markerHeight", 7)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", "#777");

    // deterministic jitter & hash helpers
    const FNV_PRIME = 16777619;
    function hash32(str) {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, FNV_PRIME);
      }
      return h >>> 0;
    }
    function hashUnit(str) {
      return hash32(str) / 4294967296; // [0,1)
    }

    const laneSpacing = fields.length > 1 ? Math.abs(yIndex(1) - yIndex(0)) : height;
    const jitterAmplitude = Math.max(6, 0.35 * (laneSpacing || 24));
    const jitterForNode = (id, amp) => (hashUnit(String(id)) - 0.5) * 2 * amp;

    // Axes
    const xAxisG = gRoot
      .append("g")
      .attr("transform", `translate(0, ${height})`)
      .call(d3.axisBottom(x).ticks(10).tickFormat(d3.format("d")));
    const yTickVals = fields.map((_, i) => i);
    const yAxis = d3.axisLeft(yIndex).tickValues(yTickVals).tickFormat((i) => fields[i]);
    const yAxisG = gRoot.append("g").call(yAxis);

    // projection for fake 3D
    const fieldIndex = (f) => Math.max(0, fields.indexOf(f ?? "Unassigned"));
    const DEPTH_SPREAD = 60; // px multiplier for Y separation while zooming
    const projectY = (baseY, jitter, z, k) => baseY + jitter + (z - 0.5) * (k - 1) * DEPTH_SPREAD;
    const fadeForZ = (z) => d3.interpolate(0.45, 1.0)(z ?? 0.5);

    // ---- Edges (hidden by default in overview) ----
    const edgeData = edges.map((e, i) => ({ ...e, _idx: i }));
    const edgeLayer = gPlot.append("g").attr("class", "edges");
    const edgePaths = edgeLayer
      .selectAll("path")
      .data(edgeData)
      .join("path")
      .attr("fill", "none")
      .attr("stroke", "#aaa")
      .attr("stroke-width", 1)
      .attr("opacity", 0.35)
      .attr("pointer-events", "none")
      .attr("vector-effect", "non-scaling-stroke");

    // ---- Nodes as groups with rounded rect ----
    const nodeLayer = gPlot.append("g").attr("class", "nodes");
    const nodesSel = nodeLayer
      .selectAll("g.node")
      .data(nodes, (d) => d.id)
      .join((enter) => {
        const g = enter.append("g").attr("class", "node").style("cursor", "pointer");
        g.append("rect")
          .attr("class", "node-rect")
          .attr("fill", (d) => color(d.field))
          .attr("stroke", "#333")
          .attr("stroke-width", 1.2)
          .attr("rx", 8)
          .attr("ry", 8)
          .attr("opacity", (d) => 0.85 * fadeForZ(d.z))
          .attr("vector-effect", "non-scaling-stroke");
        return g;
      });

    // ---- Highlight logic ----
    let lockedId = null;
    function applyDefaultEdgeStyle() {
      edgePaths
        .attr("stroke", (d) => {
          const s = nodeById.get(d.source);
          const t = nodeById.get(d.target);
          const zAvg = ((s?.z ?? 0.5) + (t?.z ?? 0.5)) / 2;
          return d3.interpolateRgb("#bbb", "#444")(zAvg);
        })
        .attr("opacity", (d) => {
          const s = nodeById.get(d.source);
          const t = nodeById.get(d.target);
          const zAvg = ((s?.z ?? 0.5) + (t?.z ?? 0.5)) / 2;
          return 0.35 + 0.6 * fadeForZ(zAvg);
        })
        .attr("marker-mid", null);
      nodesSel.selectAll("rect.node-rect").attr("stroke-width", 1.2);
    }
    function highlightByNodeId(nodeId) {
      if (!nodeId) return applyDefaultEdgeStyle();
      const idxs = edgesByNode.get(nodeId) || [];
      edgePaths.attr("stroke", "#bbb").attr("opacity", 0.2).attr("marker-mid", null);
      edgePaths
        .filter((e) => idxs.includes(e._idx))
        .attr("stroke", "#333")
        .attr("opacity", 0.95)
        .attr("marker-mid", "url(#arrowhead-mid)");
      nodesSel.selectAll("rect.node-rect").attr("stroke-width", 1.2);
      nodesSel.filter((d) => d.id === nodeId).select("rect.node-rect").attr("stroke-width", 3);
    }
    applyDefaultEdgeStyle();

    // ---- Tooltip (rAF-throttled) ----
    let raf = null;
    nodesSel
      .on("mouseover", function (_, d) {
        if (!lockedId) highlightByNodeId(d.id);
      })
      .on("mouseout", function () {
        if (!lockedId) applyDefaultEdgeStyle();
      })
      .on("click", function (_, d) {
        if (lockedId === d.id) {
          lockedId = null;
          setSelected(null);
          applyDefaultEdgeStyle();
        } else {
          lockedId = d.id;
          setSelected(d);
          highlightByNodeId(d.id);
        }
      })
      .on("mousemove", function (event, d) {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = null;
          const tip = tooltipRef.current;
          if (!tip) return;
          tip.style.display = "block";
          tip.style.left = `${event.pageX + 12}px`;
          tip.style.top = `${event.pageY + 12}px`;
          tip.innerHTML = `
            <strong>${d.title || "Untitled"}</strong><br/>
            <em>${d.field}</em> • ${d.year ?? "n/a"}<br/>
            <strong>Citations:</strong> ${d.citationCount}<br/>
            ${d.url ? "<span style='text-decoration:underline;'>(click for details)</span>" : ""}
          `;
        });
      })
      .on("mouseleave", () => {
        const tip = tooltipRef.current;
        if (tip) tip.style.display = "none";
      });

    // click background clears lock + ESC
    svg.on("click", (event) => {
      if (event.target.tagName === "svg") {
        lockedId = null;
        setSelected(null);
        applyDefaultEdgeStyle();
      }
    });
    d3.select(window).on("keydown", (ev) => {
      if (ev.key === "Escape") {
        lockedId = null;
        setSelected(null);
        applyDefaultEdgeStyle();
      }
    });

    // ---------- Vertical-only separation (away from center, no crossing) ----------
    // Decide a fixed direction per node at k=1: above center => up (-1), below => down (+1).
    const centerLine = height / 2;
    const ySign = new Map(
      nodes.map((d) => {
        const idx = fieldIndex(d.field);
        const baseY = yIndex(idx) + jitterForNode(d.id, jitterAmplitude); // baseline at k=1
        const sign = baseY >= centerLine ? 1 : -1;
        return [d.id, sign];
      })
    );

    // Optional bump: slightly stronger but still gentle curve
    // ~0px @1x, ~35px @2x, ~70px @4x, ~100px @8x (approx)
    function separationMagnitude(k) {
      const xz = Math.max(0, k - 1);
      return 140 * Math.log1p(1.1 * xz) + 20 * xz * xz;
    }

    // Show edges only when zoomed in or a node is locked
    function setEdgeVisibility(k) {
      const show = k >= 1.3 || lockedId != null;
      edgeLayer.style("display", show ? null : "none");
    }

    // ----- Zoom (no group scaling; recompute positions & sizes) -----
    // Gentler growth so separation "wins" a bit at mid-zoom
    const zoomExp = 1.1;

    // Track current k to slow wheel zoom at high zooms
    let currentK = 1;

    const zoom = d3
      .zoom()
      .scaleExtent([0.5, 16])
      // Gentler wheel zoom that slows down as you zoom in
      .wheelDelta((event) => {
        const dy = -event.deltaY;
        const mode = event.deltaMode; // 0=pixels, 1=lines, 2=pages
        const base = mode === 1 ? 0.02 : mode === 2 ? 0.2 : 0.001; // smaller than d3 default
        const slow = 1 + 0.9 * (currentK - 1); // decelerate with higher k
        return (dy * base) / slow;
      })
      // Unlimited panning (effectively). You can also just remove this line entirely.
      .translateExtent((() => {
        const PAN = 1e6; // huge margins → feels unlimited
        return [[-PAN, -PAN], [width + PAN, height + PAN]];
      })())
      .on("zoom", (ev) => {
        const t = ev.transform;
        const k = t.k;
        currentK = k;

        setEdgeVisibility(k);

        // rescaled axes
        const newX = t.rescaleX(x);
        xAxisG.call(d3.axisBottom(newX).ticks(10).tickFormat(d3.format("d")));
        const newY = t.rescaleY(yIndex);
        yAxisG.call(
          d3.axisLeft(newY).tickValues(fields.map((_, i) => i)).tickFormat((i) => fields[i])
        );

        // size growth with zoom
        const tileFor = (d) => {
          const base = sizeByCitations(d.citationCount);
          const w = base.w * Math.pow(k, zoomExp);
          const h = base.h * Math.pow(k, zoomExp);
          const rx = Math.min(12 * Math.pow(k, 0.5), h * 0.35);
          return { w, h, rx };
        };

        // vertical separation magnitude (uniform)
        const sepMag = separationMagnitude(k);

        // project centers and apply ONLY vertical separation (X fixed at time)
        const projected = nodes.map((d) => {
          const cx = newX(d.year ?? x.domain()[0]); // X fixed
          const baseY = newY(fieldIndex(d.field));
          const cy0 = projectY(baseY, jitterForNode(d.id, jitterAmplitude), d.z ?? 0.5, k);

          // fixed direction: away from center determined at k=1
          const sgn = ySign.get(d.id) ?? 1;

          // size-aware boost so larger tiles separate a bit more
          const { w, h, rx } = tileFor(d);
          const sizeBoost = Math.sqrt(w * h) / 36; // gentle size influence
          const mag = sepMag * (0.15 + sizeBoost); // overall gentle separation

          const cy = cy0 + sgn * mag;

          return { id: d.id, cx, cy, w, h, rx };
        });

        // position nodes (center groups on cx,cy)
        nodesSel.attr("transform", (d) => {
          const p = projected.find((p) => p.id === d.id);
          return `translate(${p.cx - p.w / 2},${p.cy - p.h / 2})`;
        });

        // update rect size + style
        nodesSel
          .select("rect.node-rect")
          .attr("width", (d) => projected.find((p) => p.id === d.id).w)
          .attr("height", (d) => projected.find((p) => p.id === d.id).h)
          .attr("rx", (d) => projected.find((p) => p.id === d.id).rx)
          .attr("ry", (d) => projected.find((p) => p.id === d.id).rx)
          .attr("opacity", (d) => 0.9 * fadeForZ(d.z))
          .attr("vector-effect", "non-scaling-stroke");

        // edges — recompute using new centers; skip very long when zoomed out
        const centerOf = (id) => {
          const p = projected.find((p) => p.id === id);
          return p ? { x: p.cx, y: p.cy } : null;
        };
        edgePaths.attr("d", (e) => {
          const s = centerOf(e.source);
          const tNode = centerOf(e.target);
          if (!s || !tNode) return null;
          if (Math.hypot(tNode.x - s.x, tNode.y - s.y) > 1200 / Math.max(1, k) && lockedId == null) {
            return null;
          }
          const xm = (s.x + tNode.x) / 2;
          const ym = (s.y + tNode.y) / 2;
          return `M${s.x},${s.y} L${xm},${ym} L${tNode.x},${tNode.y}`;
        });
      });

    svg.call(zoom).call(zoom.transform, d3.zoomIdentity);

    // ---------- Double-click: zoom-to-node (fill ~80% of viewport) ----------
    nodesSel.on("dblclick", function (event, d) {
      event.preventDefault();

      const t0 = d3.zoomTransform(svg.node());
      const k0 = t0.k;

      // projected center at current zoom (X fixed to time)
      const newX = t0.rescaleX(x);
      const newY = t0.rescaleY(yIndex);
      const cx = newX(d.year ?? x.domain()[0]);

      const baseY = newY(fieldIndex(d.field));
      const cy0 = projectY(baseY, jitterForNode(d.id, jitterAmplitude), d.z ?? 0.5, k0);

      // include vertical separation at current k (fixed direction)
      const sgn = (function () {
        const centerLine = height / 2;
        const idx = fieldIndex(d.field);
        const baseAt1 = yIndex(idx) + jitterForNode(d.id, jitterAmplitude);
        return baseAt1 >= centerLine ? 1 : -1;
      })();
      const sepAtK0 = separationMagnitude(k0);
      const base = sizeByCitations(d.citationCount);
      const w0 = base.w * Math.pow(k0, zoomExp);
      const h0 = base.h * Math.pow(k0, zoomExp);
      const sizeBoost = Math.sqrt(w0 * h0) / 36;
      const cy = cy0 + sgn * sepAtK0 * (0.15 + sizeBoost);

      // on-screen coords (account margins)
      const screenX = margin.left + cx;
      const screenY = margin.top + cy;

      // target scale so tile fills ~80% of viewport (respect zoomExp)
      const targetPixels = 0.8 * Math.min(width, height);
      const kFromW = Math.pow(targetPixels / Math.max(10, base.w), 1 / zoomExp);
      const kFromH = Math.pow(targetPixels / Math.max(8, base.h), 1 / zoomExp);
      const kTarget = Math.min(16, Math.max(1.2, Math.min(kFromW, kFromH)));

      const centerX = margin.left + width / 2;
      const centerY = margin.top + height / 2;

      svg
        .transition()
        .duration(700)
        .ease(d3.easeCubicOut)
        .call(zoom.scaleTo, kTarget, [screenX, screenY])
        .transition()
        .duration(400)
        .ease(d3.easeCubicOut)
        .call(zoom.translateBy, centerX - screenX, centerY - screenY);
    });

    // Responsive
    const ro = new ResizeObserver(() => setSelected((s) => s));
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [nodes, edges, x, yIndex, color, width, height, margin, fields, edgesByNode, nodeById, sizeByCitations]);

  return (
    <div className="app">
      <div className="header">
        <h1>Paper Map</h1>
        <p className="sub">Size by citations • vertical separation (no crossing) • gentle zoom • dbl-click to zoom</p>
      </div>

      <div className="chart-wrap" ref={wrapRef}>
        <svg ref={svgRef} />
        <div id="hover-tooltip" ref={tooltipRef} />
      </div>

      <aside className="sidebar">
        {selected ? (
          <Card node={selected} onClose={() => setSelected(null)} />
        ) : (
          <div className="placeholder">Click a node to see details • Double-click a node to zoom</div>
        )}
      </aside>
    </div>
  );
}

function Card({ node, onClose }) {
  return (
    <div className="card">
      <div className="card-head">
        <h3>{node.title || "Untitled"}</h3>
        <button className="ghost" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="meta">
        <div><strong>Year:</strong> {node.year ?? "n/a"}</div>
        <div><strong>Field:</strong> {node.field}</div>
        <div><strong>Citations:</strong> {node.citationCount}</div>
      </div>
      {node.url && (
        <p>
          <a href={node.url} target="_blank" rel="noreferrer">Open paper</a>
        </p>
      )}
    </div>
  );
}
