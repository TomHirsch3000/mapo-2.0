// Galaxy View App.js — "The Cosmos of Knowledge"
// Features:
// - Galaxy View: Fields/Authors/Institutions as "Constellations"
// - Field View: Key papers as "Stars"
// - Dynamic grouping and layouts (Central vs Timeline)

import React, { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import "./App.css";
import "./styles/Galaxy.css";

export default function App() {
  const svgRef = useRef(null);
  const wrapRef = useRef(null);

  // Data State
  const [rawNodes, setRawNodes] = useState([]);
  const [rawEdges, setRawEdges] = useState([]);
  const [selected, setSelected] = useState(null);
  const [hovered, setHovered] = useState(null);

  // View State
  const [viewMode, setViewMode] = useState('GALAXY'); // 'GALAXY' | 'FIELD' | 'DETAIL'
  const [groupingMode, setGroupingMode] = useState('FIELD'); // 'FIELD' | 'AUTHOR' | 'INSTITUTION'
  const [layoutMode, setLayoutMode] = useState('CENTRAL'); // 'CENTRAL' | 'TIMELINE'
  const [activeGroup, setActiveGroup] = useState(null);

  const nodeByIdRef = useRef(new Map());
  const simulationRef = useRef(null);
  const groupPositionsMatch = useRef(new Map());
  const nodePositionsCache = useRef(new Map()); // Store all node positions
  const isTransitioning = useRef(false);
  const prevViewMode = useRef(viewMode);
  const prevLayoutMode = useRef(layoutMode);
  const layoutSignatureRef = useRef("");

  const EDGE_COLORS = {
    citation: "#f59e0b",
    reference: "#3b82f6",
    default: "#94a3b8"
  };

  const hashString = (value) => {
    let hash = 0;
    const str = String(value);
    for (let i = 0; i < str.length; i += 1) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  };

  const getDeterministicPoint = (key, radius) => {
    const base = hashString(key);
    const angle = ((base % 360) * Math.PI) / 180;
    const spread = (hashString(`${key}-spread`) % 1000) / 1000;
    const r = Math.max(40, spread * radius);
    return {
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r
    };
  };

  const sanitizeId = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
  const getEdgeId = (d) => (typeof d === "object" ? (d.id || d.name) : d);

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

  /* Data Processing */
  const { nodes, groupStats, uniqueGroups, groupEdges } = useMemo(() => {
    if (!rawNodes || rawNodes.length === 0) return { nodes: [], groupStats: [], uniqueGroups: [], groupEdges: [] };

    const gMap = new Map();
    const nodeIdToGroup = new Map();

    // Helper to extract group key
    const getGroupKey = (d) => {
      if (groupingMode === 'AUTHOR') return d.firstAuthor || "Unknown";
      if (groupingMode === 'INSTITUTION') return (d.institutions ? d.institutions.split(';')[0].trim() : "Unknown");
      return d.primaryField || d.AI_primary_field || "Unassigned";
    };

    // 1. Process Nodes & Build Group Map
    const ns = rawNodes.map(d => {
      const yr = d.year ?? d.publication_year ?? (d.publicationDate ? new Date(d.publicationDate).getFullYear() : 2000);
      const group = getGroupKey(d);
      const cites = d.citationCount ?? d.cited_by_count ?? 0;

      const n = {
        id: String(d.id || d.paperId),
        title: d.title,
        year: yr,
        citationCount: cites,
        group: group, // Dynamic grouping
        field: d.primaryField,
        abstract: d.abstract || d.AI_summary || "No abstract available.",
        authors: d.allAuthors || d.firstAuthor || "Unknown",
        institutions: d.institutions
      };

      nodeIdToGroup.set(n.id, group);

      if (!gMap.has(group)) {
        gMap.set(group, { name: group, count: 0, totalCitations: 0, minYear: Infinity });
      }
      const g = gMap.get(group);
      g.count += 1;
      g.totalCitations += cites;
      g.minYear = Math.min(g.minYear, yr);

      return n;
    });

    nodeByIdRef.current = new Map(ns.map(n => [n.id, n]));

    // Calculate Stats and Sort
    const gStats = Array.from(gMap.values()).map(g => ({
      ...g,
      minYear: g.minYear === Infinity ? 2000 : g.minYear
    })).sort((a, b) => b.totalCitations - a.totalCitations);

    // Limit groups for performance in Galaxy view if high cardinality
    const finalGroupStats = (groupingMode === 'FIELD') ? gStats : gStats.slice(0, 150);
    const validGroups = new Set(finalGroupStats.map(g => g.name));

    // 2. Process Edges & Build Group Connections
    const groupEdgeMap = new Map();

    rawEdges.forEach(e => {
      const sourceGroup = nodeIdToGroup.get(String(e.source));
      const targetGroup = nodeIdToGroup.get(String(e.target));

      if (sourceGroup && targetGroup && sourceGroup !== targetGroup && validGroups.has(sourceGroup) && validGroups.has(targetGroup)) {
        const key = `${sourceGroup}|${targetGroup}`;
        groupEdgeMap.set(key, (groupEdgeMap.get(key) || 0) + 1);
      }
    });

    const calculatedGroupEdges = Array.from(groupEdgeMap.entries()).map(([key, count]) => {
      const [source, target] = key.split("|");
      return { source, target, weight: count };
    });

    return {
      nodes: ns,
      groupStats: finalGroupStats,
      uniqueGroups: finalGroupStats.map(f => f.name),
      groupEdges: calculatedGroupEdges
    };
  }, [rawNodes, rawEdges, groupingMode]);

  /** Edges */
  const edges = useMemo(() => {
    const m = nodeByIdRef.current;
    return rawEdges
      .map(e => ({
        source: String(e.source),
        target: String(e.target),
        importance: e.importance ?? 1
      }))
      .filter(e => m.has(e.source) && m.has(e.target) && e.source !== e.target);
  }, [rawEdges, rawNodes]);

  const colorScale = useMemo(() => d3.scaleOrdinal(d3.schemeTableau10).domain(uniqueGroups), [uniqueGroups]);

  // Galaxy View Data (Group Nodes)
  const galaxyNodes = useMemo(() => {
    if (viewMode !== 'GALAXY') return [];

    return groupStats.map((f) => {
      const existing = groupPositionsMatch.current.get(f.name);

      const val = Math.sqrt(f.totalCitations) * 0.25;

      const fallbackPos = getDeterministicPoint(f.name, 450);
      const node = {
        id: `group-${f.name}`,
        type: 'group',
        name: f.name,
        val: Math.max(val, 5),
        minYear: f.minYear, // Use minYear
        data: f,
        // Init positions (D3 will update)
        x: existing ? existing.x : fallbackPos.x,
        y: existing ? existing.y : fallbackPos.y,
      };

      return node;
    });
  }, [groupStats, viewMode]);

  // Transitions
  const handleGroupClick = (groupName) => {
    console.log("Group clicked:", groupName);
    setActiveGroup(groupName);
    setViewMode('FIELD');
    setSelected(null);
  };

  const handleBackToGalaxy = () => {
    setActiveGroup(null);
    setViewMode('GALAXY');
    setSelected(null);
  };

  const handlePaperClick = (paper) => {
    setSelected(paper);
  };

  // --- RENDER EFFECT ---
  useEffect(() => {
    // Reset transition lock on each render
    isTransitioning.current = false;

    if (!svgRef.current || !wrapRef.current) return;

    const width = wrapRef.current.clientWidth;
    const height = wrapRef.current.clientHeight;

    const svg = d3.select(svgRef.current)
      .attr("width", width)
      .attr("height", height)
      .style("background", "radial-gradient(circle at center, #ffffff 0%, #f0f4f8 100%)");

    // Initialize Root Group if needed
    let gMain = svg.select(".g-main");
    if (gMain.empty()) {
      const gRoot = svg.append("g");
      gMain = gRoot.append("g").attr("class", "g-main");
    }

    // Zoom Behavior - Defined every render to access current state (closures)
    const zoom = d3.zoom()
      .scaleExtent([0.1, 8])
      .on("zoom", (event) => {
        gMain.attr("transform", event.transform);

        if (isTransitioning.current) return;

        // --- SEMANTIC ZOOM LOGIC ---
        const k = event.transform.k;

        // 1. Zooming IN (Galaxy -> Field)
        if (viewMode === 'GALAXY' && k > 1.8) {
          const cx = (width / 2 - event.transform.x) / k;
          const cy = (height / 2 - event.transform.y) / k;

          let closest = null;
          let minD = Infinity;

          galaxyNodes.forEach(n => {
            const dx = n.x - cx;
            const dy = n.y - cy;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < minD) { minD = d; closest = n; }
          });

          // Threshold: expanded for easier navigation
          if (closest && minD < (closest.val * 2.5 + 100)) {
            isTransitioning.current = true;
            handleGroupClick(closest.name);
            // Smooth transition: zoom to 0.8 scale of the field view
            svg.transition().duration(750)
              .call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2).scale(0.8))
              .on("end", () => { isTransitioning.current = false; });
          }
        }

        // 2. Zooming OUT (Field -> Galaxy)
        if ((viewMode === 'FIELD' || viewMode === 'DETAIL') && k < 0.45) {
          isTransitioning.current = true;
          handleBackToGalaxy();
          svg.transition().duration(750)
            .call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2).scale(0.8))
            .on("end", () => { isTransitioning.current = false; });
        }
      });

    // Attach zoom behavior
    svg.call(zoom);
    // Initialize zoom position ONLY if it's the first time
    if (svg.select(".g-main").attr("transform") === null) {
      svg.call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2).scale(0.8));
    }

    // Determine current dataset
    let currentNodes = [];
    let currentEdges = [];
    let isGalaxy = (viewMode === 'GALAXY');

    if (isGalaxy) {
      currentNodes = galaxyNodes;
      // Deep clone edges to avoid mutation key issues in D3
      currentEdges = groupEdges.map(e => ({
        source: typeof e.source === 'object' ? e.source.name : e.source,
        target: typeof e.target === 'object' ? e.target.name : e.target,
        weight: e.weight
      }));
    } else {
      currentNodes = nodes.filter(n => n.group === activeGroup);

      // Positions are initialized deterministically before simulation.
      currentEdges = edges.filter(e => {
        const s = typeof e.source === 'object' ? e.source.id : e.source;
        const t = typeof e.target === 'object' ? e.target.id : e.target;
        return currentNodes.find(n => n.id === s) && currentNodes.find(n => n.id === t);
      });

      const maxCites = d3.max(currentNodes, d => d.citationCount) || 1;
      const sizeScale = d3.scaleSqrt().domain([0, maxCites]).range([0.8, 2.5]);
      currentNodes.forEach(d => {
        d._scale = sizeScale(d.citationCount);
        d._w = 120 * d._scale; d._h = 50 * d._scale;
      });
    }

    // --- D3 JOIN PATTERN (Smooth Transitions) ---

    // Edges
    const getEdgeKey = (d) => `${isGalaxy ? "G" : "P"}|${getEdgeId(d.source)}|${getEdgeId(d.target)}`;
    const getGradientId = (d) => {
      const id = `link-gradient-${sanitizeId(getEdgeKey(d))}`;
      d._gradId = id;
      return id;
    };
    const getEdgeSourceName = (d) => {
      const source = typeof d.source === "object" ? (d.source.name || d.source.group || d.source.id) : d.source;
      return source;
    };
    const getBaseEdgeColor = (d) => (isGalaxy ? colorScale(getEdgeSourceName(d)) : EDGE_COLORS.default);
    const setGradientStops = (selection, color) => {
      selection.select(".grad-stop-start").attr("stop-color", color).attr("stop-opacity", 0.0);
      selection.select(".grad-stop-mid").attr("stop-color", color).attr("stop-opacity", 0.25);
      selection.select(".grad-stop-end").attr("stop-color", color).attr("stop-opacity", 0.85);
    };

    const defs = svg.select("defs").empty() ? svg.append("defs") : svg.select("defs");
    const gradientJoin = defs.selectAll(".link-gradient")
      .data(currentEdges, getEdgeKey);

    gradientJoin.exit().remove();

    const gradientEnter = gradientJoin.enter().append("linearGradient")
      .attr("class", "link-gradient")
      .attr("gradientUnits", "userSpaceOnUse")
      .attr("id", d => getGradientId(d));

    gradientEnter.append("stop").attr("class", "grad-stop-start").attr("offset", "0%");
    gradientEnter.append("stop").attr("class", "grad-stop-mid").attr("offset", "60%");
    gradientEnter.append("stop").attr("class", "grad-stop-end").attr("offset", "100%");

    const gradients = gradientEnter.merge(gradientJoin)
      .attr("id", d => getGradientId(d));

    gradients.each(function (d) {
      setGradientStops(d3.select(this), getBaseEdgeColor(d));
    });
    // --- EXPLICIT CLEANUP (LINKS) ---
    // If we are in Galaxy, kill paper links. If in Field, kill galaxy links.
    // Also remove generic .d3-link if they don't match current expected class (legacy cleanup)
    gMain.selectAll(isGalaxy ? ".type-paper-link" : ".type-galaxy-link").remove();
    // Safety: Remove any link that doesn't have the correct class for current view
    // (This prevents "plain" links from sticking around)
    gMain.selectAll(".d3-link").filter(function () {
      const cl = d3.select(this).attr("class");
      return !cl.includes(isGalaxy ? 'type-galaxy-link' : 'type-paper-link');
    }).remove();

    const linkJoin = gMain.selectAll(".d3-link")
      // Namespace key by view type to force full replacement on view switch
      .data(currentEdges, getEdgeKey);

    linkJoin.exit().transition().duration(500).attr("stroke-opacity", 0).remove();

    const linksEntry = linkJoin.enter().append("path")
      .attr("class", `d3-link ${isGalaxy ? 'type-galaxy-link' : 'type-paper-link'}`)
      .attr("fill", "none")
      .attr("stroke-linecap", "round")
      .attr("stroke-opacity", 0);

    // Update both new and existing
    const links = linksEntry.merge(linkJoin)
      .attr("class", `d3-link ${isGalaxy ? 'type-galaxy-link' : 'type-paper-link'}`) // Ensure class is correct on update
      .attr("stroke-width", d => isGalaxy ? Math.max(1.6, Math.sqrt(d.weight || 1) + 0.8) : 2.6)
      .attr("stroke", d => `url(#${getGradientId(d)})`)
      .transition().duration(1000)
      .attr("stroke-opacity", isGalaxy ? 0.55 : 0.5);

    // Nodes
    // Use a generic selection to ensure we catch ALL nodes (Galaxy or Field)
    // This guarantees the 'exit' selection contains any node that shouldn't be here.
    const nodeJoin = gMain.selectAll(".d3-node")
      .data(currentNodes, d => d.id);

    // EXIT
    nodeJoin.exit()
      .each(function (d) {
        // Check if this node is "incompatible" with current view
        // e.g. We are in FIELD mode, but this is a Group node
        const isGroupNode = d.id.startsWith("group-");
        const isWrongType = (isGalaxy && !isGroupNode) || (!isGalaxy && isGroupNode);

        const el = d3.select(this);

        if (isWrongType) {
          // INSTANT REMOVAL - Garbage collect immediately to prevent ghosts
          el.remove();
        } else {
          // Smooth fade out for normal data updates
          el.transition().duration(400).style("opacity", 0).remove();
        }
      });

    // ENTER
    const nodesEntry = nodeJoin.enter().append("g")
      .attr("class", d => `d3-node ${isGalaxy ? 'type-group' : 'type-paper'}`)
      .attr("cursor", "pointer")
      .style("opacity", 0) // Start invisible
      .on("click", (e, d) => {
        e.stopPropagation();
        if (isGalaxy) handleGroupClick(d.name);
        else handlePaperClick(d);
      })
      .on("mouseover", (e, d) => setHovered(isGalaxy ? {
        id: d.id,
        title: d.name,
        year: `Est. ${d.minYear}`,
        citationCount: d.data.totalCitations,
        groupCount: d.data.count,
        minYear: d.minYear,
        field: "Galaxy Group",
        abstract: `${d.data.count} papers in this cluster. Combined citation impact of ${d.data.totalCitations}.`
      } : d))
      .on("mouseout", () => setHovered(null));

    // Keep new nodes hidden until we pre-calc positions (no movement on appearance)
    nodesEntry.style("opacity", 0);

    // Construct Node content based on type
    if (isGalaxy) {
      nodesEntry.append("circle").attr("class", "orbit").attr("r", d => d.val * 2.5).attr("fill-opacity", 0.15);
      nodesEntry.append("circle").attr("class", "core").attr("r", d => d.val * 0.8).attr("fill-opacity", 0.8).style("filter", "blur(1px)");
      nodesEntry.append("text").attr("class", "label-main").attr("text-anchor", "middle").attr("dy", d => d.val * 2 + 20)
        .style("font-size", "16px").style("font-weight", "600").style("fill", "#0f172a").style("text-shadow", "0 2px 4px white");
      nodesEntry.append("text").attr("class", "label-sub").attr("text-anchor", "middle").attr("dy", d => d.val * 2 + 40)
        .style("font-size", "12px").style("fill", "#64748b");
    } else {
      nodesEntry.append("rect").attr("class", "node-rect").attr("rx", 6).attr("fill-opacity", 0.9).attr("stroke", "#fff").attr("stroke-width", 2)
        .style("filter", "drop-shadow(0px 2px 4px rgba(0,0,0,0.1))");
      nodesEntry.append("foreignObject").attr("class", "fo-content").style("pointer-events", "none").append("xhtml:div").attr("class", "node-fo");
    }

    nodesEntry.style("opacity", 0);

    // Merge for updates
    const allNodes = nodesEntry.merge(nodeJoin);

    if (isGalaxy) {
      allNodes.select(".orbit").attr("fill", d => colorScale(d.name)).attr("r", d => d.val * 2.5);
      allNodes.select(".core").attr("fill", d => colorScale(d.name)).attr("r", d => d.val * 0.8);
      allNodes.select(".label-main").text(d => d.name.length > 25 ? d.name.substring(0, 22) + "..." : d.name).attr("dy", d => d.val * 2 + 20);
      allNodes.select(".label-sub").text(d => `${d.data.count} papers`).attr("dy", d => d.val * 2 + 40);

      // Remove Field elements if switching types
      allNodes.select("rect").remove();
      allNodes.select("foreignObject").remove();

    } else {
      allNodes.select("rect")
        .attr("width", d => d._w).attr("height", d => d._h)
        .attr("x", d => -d._w / 2).attr("y", d => -d._h / 2)
        .attr("fill", d => colorScale(d.group));

      const fo = allNodes.select("foreignObject")
        .attr("width", d => d._w - 10).attr("height", d => d._h - 10)
        .attr("x", d => -d._w / 2 + 5).attr("y", d => -d._h / 2 + 5);

      fo.select("div")
        .style("width", "100%").style("height", "100%")
        .style("display", "flex").style("align-items", "center").style("justify-content", "center")
        .style("text-align", "center").style("font-family", "Inter, sans-serif").style("color", "#fff")
        .style("font-size", d => `${10 * d._scale}px`).style("line-height", "1.1").style("overflow", "hidden")
        .text(d => d.title);

      // Remove Galaxy elements
      allNodes.select("circle").remove();
      allNodes.select("text").remove();
    }

    const getLinkPath = (d) => {
      const s = d.source;
      const t = d.target;
      const sx = (s && typeof s.x === "number") ? s.x : 0;
      const sy = (s && typeof s.y === "number") ? s.y : 0;
      const tx = (t && typeof t.x === "number") ? t.x : 0;
      const ty = (t && typeof t.y === "number") ? t.y : 0;
      const dx = tx - sx;
      const dy = ty - sy;
      const dr = Math.sqrt(dx * dx + dy * dy) || 1;
      const curve = Math.min(80, dr * 0.3);
      const nx = -dy / dr;
      const ny = dx / dr;
      const cx = (sx + tx) / 2 + nx * curve;
      const cy = (sy + ty) / 2 + ny * curve;
      return `M${sx},${sy} Q${cx},${cy} ${tx},${ty}`;
    };

    const updateLinkPositions = () => {
      gMain.selectAll(".d3-link").attr("d", d => getLinkPath(d));
      svg.select("defs").selectAll(".link-gradient")
        .attr("x1", d => (d.source && typeof d.source.x === "number") ? d.source.x : 0)
        .attr("y1", d => (d.source && typeof d.source.y === "number") ? d.source.y : 0)
        .attr("x2", d => (d.target && typeof d.target.x === "number") ? d.target.x : 0)
        .attr("y2", d => (d.target && typeof d.target.y === "number") ? d.target.y : 0);
    };
    const layoutSignature = `${viewMode}|${layoutMode}|${activeGroup || ""}|${groupingMode}`;
    const signatureChanged = layoutSignatureRef.current !== layoutSignature;
    const viewChanged = prevViewMode.current !== viewMode;
    const layoutChanged = prevLayoutMode.current !== layoutMode;
    const shouldAnimateLayout = layoutChanged && !viewChanged;
    const shouldPrecompute = signatureChanged && !shouldAnimateLayout;
    const shouldIntro = shouldPrecompute;

    const seededRandom = d3.randomLcg(0.42);

    const applyInitialPositions = () => {
      if (isGalaxy) {
        currentNodes.forEach(n => {
          const cached = groupPositionsMatch.current.get(n.name);
          if (cached) {
            n.x = cached.x;
            n.y = cached.y;
            return;
          }
          const pos = getDeterministicPoint(n.name, 450);
          n.x = pos.x;
          n.y = pos.y;
        });
      } else {
        const groupAnchor = groupPositionsMatch.current.get(activeGroup) || getDeterministicPoint(activeGroup || "group", 120);
        currentNodes.forEach(n => {
          const cached = nodePositionsCache.current.get(n.id);
          if (cached) {
            n.x = cached.x;
            n.y = cached.y;
            return;
          }
          const offset = getDeterministicPoint(n.id, 60);
          n.x = groupAnchor.x + offset.x + (seededRandom() - 0.5) * 8;
          n.y = groupAnchor.y + offset.y + (seededRandom() - 0.5) * 8;
        });
      }
    };

    applyInitialPositions();

    // --- FORCES & SIMULATION ---
    if (simulationRef.current) simulationRef.current.stop();

    const sim = d3.forceSimulation(currentNodes)
      .randomSource(seededRandom)
      .force("charge", d3.forceManyBody().strength(isGalaxy ? -400 : -600))
      .force("collide", d3.forceCollide().radius(d => isGalaxy ? (d.val * 2 + 50) : (d._w * 0.6)));

    if (isGalaxy) {
      if (layoutMode === 'CENTRAL' || layoutMode === 'TIMELINE') {
        sim.force("link", d3.forceLink(currentEdges).id(d => d.name).distance(200).strength(layoutMode === 'TIMELINE' ? 0.01 : 0.05));
      }
    } else {
      sim.force("link", d3.forceLink(currentEdges).id(d => d.id).distance(150));
    }

    // LAYOUT FORCES & AXIS
    gMain.select(".timeline-axis").remove();

    if (layoutMode === 'TIMELINE') {
      const years = currentNodes.map(d => isGalaxy ? d.minYear : d.year);
      const minYear = d3.min(years) || 1990;
      const maxYear = d3.max(years) || 2025;
      const xScale = d3.scaleLinear().domain([minYear, maxYear]).range([-width * 0.4, width * 0.4]);

      sim.force("x", d3.forceX(d => xScale(isGalaxy ? d.minYear : d.year)).strength(0.9));
      sim.force("y", d3.forceY(0).strength(0.2));
      sim.force("center", null);
      sim.force("radial", null);

      const axisGroup = gMain.insert("g", ":first-child").attr("class", "timeline-axis").attr("transform", `translate(0, ${height * 0.3})`);
      axisGroup.append("line")
        .attr("x1", xScale(minYear) - 50).attr("x2", xScale(maxYear) + 50).attr("y1", 0).attr("y2", 0)
        .attr("stroke", "#94a3b8").attr("stroke-width", 2).attr("opacity", 0.5);

      const startDecade = Math.floor(minYear / 10) * 10;
      const endDecade = Math.ceil(maxYear / 10) * 10;
      for (let y = startDecade; y <= endDecade; y += 10) {
        if (y >= minYear - 5 && y <= maxYear + 5) {
          const x = xScale(y);
          axisGroup.append("line").attr("x1", x).attr("x2", x).attr("y1", -10).attr("y2", 10).attr("stroke", "#64748b").attr("stroke-width", 2);
          axisGroup.append("text").attr("x", x).attr("y", 30).attr("text-anchor", "middle")
            .style("fill", "#64748b").style("font-size", "14px").style("font-weight", "600").text(y);
        }
      }
    } else {
      sim.force("x", null);
      sim.force("y", null);
      sim.force("center", d3.forceCenter(0, 0));

      if (isGalaxy) {
        const maxVal = d3.max(currentNodes, n => n.val) || 1;
        sim.force("radial", d3.forceRadial(d => (1 - d.val / maxVal) * 400, 0, 0).strength(0.15));
      } else {
        const maxCites = d3.max(currentNodes, n => n.citationCount) || 1;
        sim.force("radial", d3.forceRadial(d => (1 - d.citationCount / maxCites) * 300, 0, 0).strength(0.25));
      }
    }

    const syncPositions = (scale = 1) => {
      gMain.selectAll(".d3-node")
        .attr("transform", d => `translate(${d.x}, ${d.y}) scale(${scale})`);
      updateLinkPositions();
    };

    if (shouldPrecompute) {
      sim.stop();
      for (let i = 0; i < 280; i += 1) sim.tick();
      if (isGalaxy) {
        currentNodes.forEach(n => groupPositionsMatch.current.set(n.name, { x: n.x, y: n.y }));
      } else {
        currentNodes.forEach(n => nodePositionsCache.current.set(n.id, { x: n.x, y: n.y }));
      }

      gMain.selectAll(".d3-node").style("opacity", 0);
      gMain.selectAll(".d3-link").attr("stroke-opacity", 0);
      syncPositions(0.1);

      if (shouldIntro) {
        gMain.selectAll(".d3-node")
          .transition().duration(650).ease(d3.easeQuadOut)
          .style("opacity", 1)
          .attr("transform", d => `translate(${d.x}, ${d.y}) scale(1)`);
        gMain.selectAll(".d3-link")
          .transition().duration(650).ease(d3.easeQuadOut)
          .attr("stroke-opacity", isGalaxy ? 0.55 : 0.5);
      } else {
        gMain.selectAll(".d3-node").style("opacity", 1);
        gMain.selectAll(".d3-link").attr("stroke-opacity", isGalaxy ? 0.55 : 0.5);
        syncPositions(1);
      }
    } else {
      gMain.selectAll(".d3-node").style("opacity", 1);
      gMain.selectAll(".d3-link").attr("stroke-opacity", isGalaxy ? 0.55 : 0.5);
      syncPositions(1);
    }

    if (shouldAnimateLayout) {
      sim.velocityDecay(0.6);
      sim.alphaDecay(0.05);
      sim.on("tick", () => {
        if (isGalaxy) {
          currentNodes.forEach(n => groupPositionsMatch.current.set(n.name, { x: n.x, y: n.y }));
        } else {
          currentNodes.forEach(n => nodePositionsCache.current.set(n.id, { x: n.x, y: n.y }));
        }
        syncPositions(1);
      });
      sim.alpha(1).restart();
      const stopTimer = d3.timeout(() => sim.stop(), 650);
      simulationRef.current = sim;
      prevViewMode.current = viewMode;
      prevLayoutMode.current = layoutMode;
      layoutSignatureRef.current = layoutSignature;

      return () => {
        stopTimer.stop();
        sim.stop();
      };
    }

    simulationRef.current = sim;
    sim.stop();

    // Update refs
    prevViewMode.current = viewMode;
    prevLayoutMode.current = layoutMode;
    layoutSignatureRef.current = layoutSignature;

    return () => {
      sim.stop();
    };

  }, [viewMode, groupingMode, layoutMode, activeGroup, galaxyNodes, nodes, edges, groupEdges, colorScale]);

  // HIGHLIGHTING EFFECT
  useEffect(() => {
    if (!svgRef.current) return;
    if (viewMode !== 'FIELD') {
      // Reset styles for Galaxy
      d3.select(svgRef.current).selectAll(".d3-node").style("opacity", 1);
      d3.select(svgRef.current).selectAll(".d3-link").attr("stroke-opacity", 0.55);
      return;
    }

    const svg = d3.select(svgRef.current);
    const node = svg.selectAll(".d3-node");
    const link = svg.selectAll(".d3-link");
    const gradients = svg.select("defs").selectAll(".link-gradient");
    const rect = svg.selectAll(".node-rect");

    if (selected) {
      const connectedIds = new Set([selected.id]);
      const visibleLinks = link.data();
      visibleLinks.forEach(e => {
        const sourceId = getEdgeId(e.source);
        const targetId = getEdgeId(e.target);
        if (sourceId === selected.id) connectedIds.add(targetId);
        if (targetId === selected.id) connectedIds.add(sourceId);
      });

      node.transition().duration(200).style("opacity", d => connectedIds.has(d.id) || d.id === selected.id ? 1 : 0.1);

      link.transition().duration(200)
        .attr("stroke-opacity", d => {
          const s = getEdgeId(d.source);
          const t = getEdgeId(d.target);
          return (s === selected.id || t === selected.id) ? 0.9 : 0.05;
        });

      gradients.each(function (d) {
        const s = getEdgeId(d.source);
        const t = getEdgeId(d.target);
        const isConnected = s === selected.id || t === selected.id;
        const color = s === selected.id ? EDGE_COLORS.reference : (t === selected.id ? EDGE_COLORS.citation : EDGE_COLORS.default);
        const opacityScale = isConnected ? 1 : 0.15;
        const sel = d3.select(this);
        sel.select(".grad-stop-start").attr("stop-color", color).attr("stop-opacity", 0.0);
        sel.select(".grad-stop-mid").attr("stop-color", color).attr("stop-opacity", 0.25 * opacityScale);
        sel.select(".grad-stop-end").attr("stop-color", color).attr("stop-opacity", 0.85 * opacityScale);
      });

      rect.transition().duration(200).attr("stroke", d => d.id === selected.id ? "#0f172a" : "#fff").attr("stroke-width", d => d.id === selected.id ? 4 : 2);
    } else {
      node.transition().duration(200).style("opacity", 1);
      link.transition().duration(200).attr("stroke-opacity", 0.5);
      gradients.each(function (d) {
        const sel = d3.select(this);
        sel.select(".grad-stop-start").attr("stop-color", EDGE_COLORS.default).attr("stop-opacity", 0.0);
        sel.select(".grad-stop-mid").attr("stop-color", EDGE_COLORS.default).attr("stop-opacity", 0.25);
        sel.select(".grad-stop-end").attr("stop-color", EDGE_COLORS.default).attr("stop-opacity", 0.85);
      });
      rect.transition().duration(200).attr("stroke", "#fff").attr("stroke-width", 2);
    }
  }, [selected, viewMode]);

  return (
    <div className="App galaxy-theme" ref={wrapRef}>
      <div className="galaxy-header">
        <div className="controls-row" style={{ display: 'flex', gap: '12px', alignItems: 'center', position: 'absolute', top: 20, left: 20, pointerEvents: 'auto' }}>
          {viewMode !== 'GALAXY' && <button className="back-to-galaxy" onClick={handleBackToGalaxy}>← Back</button>}

          <div className="control-group">
            <strong style={{ color: '#64748b', fontSize: '0.85rem', marginRight: '5px' }}>GROUP BY</strong>
            <select className="galaxy-select" value={groupingMode} onChange={e => setGroupingMode(e.target.value)} disabled={viewMode !== 'GALAXY'}>
              <option value="FIELD">Field</option>
              <option value="AUTHOR">Author</option>
              <option value="INSTITUTION">Institution</option>
            </select>
          </div>

          <div className="control-group">
            <strong style={{ color: '#64748b', fontSize: '0.85rem', marginRight: '5px' }}>LAYOUT</strong>
            <div className="toggle-group">
              <button className={`toggle-btn ${layoutMode === 'CENTRAL' ? 'active' : ''}`} onClick={() => setLayoutMode('CENTRAL')}>Central</button>
              <button className={`toggle-btn ${layoutMode === 'TIMELINE' ? 'active' : ''}`} onClick={() => setLayoutMode('TIMELINE')}>Timeline</button>
            </div>
          </div>
        </div>
        <div className="galaxy-title">{viewMode === 'GALAXY' ? `Map of ${groupingMode === 'FIELD' ? 'Physics' : groupingMode + 'S'}` : activeGroup}</div>
      </div>

      <svg ref={svgRef} className="galaxy-canvas" />

      {/* Persistent Footer Panel */}
      <div className="galaxy-footer" style={{ transform: (selected || hovered) ? 'translateY(0)' : 'translateY(0)', opacity: 1, pointerEvents: 'none' }}>
        {(selected || hovered) ? (
          <div className="footer-panels" style={{ pointerEvents: 'auto' }}>
            {selected && (
              <div className="footer-panel selected-panel">
                <h4>Selected</h4>
                <h3>{selected.title}</h3>
                <div className="footer-meta">
                  <span>{selected.year}</span> • <span>{selected.citationCount} Citations</span>
                  {selected.field && <span> • {selected.field}</span>}
                </div>
                <div className="footer-abstract">
                  <strong>Abstract</strong>
                  <p>{selected.abstract}</p>
                </div>
              </div>
            )}
            {hovered && hovered.id !== selected?.id && (
              <div className="footer-panel hover-panel" style={!selected ? { gridColumn: '1 / -1' } : {}}>
                <h4>Hovering</h4>
                <h3>{hovered.title || hovered.name}</h3>
                <div className="footer-meta">
                  {hovered.year && <span>{hovered.year} • </span>}
                  <span>{hovered.citationCount} Citations</span>
                  {hovered.groupCount !== undefined && <span> • {hovered.groupCount} Papers</span>}
                </div>
                {hovered.authors && <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '5px' }}>{hovered.authors}</div>}
              </div>
            )}
          </div>
        ) : (
          <div className="footer-empty" style={{ textAlign: 'center', color: '#94a3b8', padding: '10px' }}>
            Hover or select a node to view details
          </div>
        )}
      </div>
    </div >
  );
}
