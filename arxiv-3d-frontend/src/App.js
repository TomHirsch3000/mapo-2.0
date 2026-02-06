// Galaxy View App.js — "The Cosmos of Knowledge"
// Features:
// - Galaxy View: Fields/Authors/Institutions as "Constellations"
// - Field View: Key papers as "Stars"
// - Dynamic grouping and layouts (Central vs Timeline)

import React, { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import "./App.css";
import "./styles/Galaxy.css";

// --- Helpers ---
const roundedHexagonPath = (radius) => {
  // Generate a hexagon path. We will use stroke-linejoin="round" in CSS/Attributes to round it visually.
  const points = [];
  for (let i = 0; i < 6; i++) {
    const angle = (i * 60) * (Math.PI / 180); // Pointy topped: 30, 90... Flat topped: 0, 60...
    // Let's use flat topped (0, 60...)
    points.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
  }
  return points.map((p, i) => (i === 0 ? "M" : "L") + p[0] + "," + p[1]).join(" ") + " Z";
};

const generateHexPositions = (nodes, spacing) => {
  const result = new Map();
  const sorted = nodes.filter(n => !n.isMenuNode).sort((a, b) => (b.val || 0) - (a.val || 0));
  const menu = nodes.find(n => n.isMenuNode);

  if (menu) {
    // Position menu node away from the cluster
    result.set(menu.id || menu.key, { x: -spacing * 5, y: -spacing * 3 }); // Top-left ish
  }

  // Generate grid points
  const points = [];
  const maxRing = Math.ceil(Math.sqrt(nodes.length)) + 1;
  for (let q = -maxRing; q <= maxRing; q++) {
    for (let r = -maxRing; r <= maxRing; r++) {
      if (Math.abs(q + r) <= maxRing) {
        // Flat-topped hex to pixel
        var x = spacing * (3 / 2 * q);
        var y = spacing * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r);
        const dist = Math.sqrt(x * x + y * y);
        points.push({ x, y, dist });
      }
    }
  }
  points.sort((a, b) => a.dist - b.dist);

  sorted.forEach((n, i) => {
    if (points[i]) {
      result.set(n.id || n.key, { x: points[i].x, y: points[i].y });
    }
  });

  return result;
};

export default function App() {
  // Trigger rebuild
  const svgRef = useRef(null);
  const wrapRef = useRef(null);

  // Data State
  const [rawNodes, setRawNodes] = useState([]);
  const [rawEdges, setRawEdges] = useState([]);
  const [universeData, setUniverseData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [activeGalaxy, setActiveGalaxy] = useState(null);

  // View State
  const [viewMode, setViewMode] = useState('UNIVERSE'); // 'UNIVERSE' | 'GALAXY' | 'FIELD' | 'DETAIL'
  const [xAxisMode, setXAxisMode] = useState('TIMELINE'); // 'NONE' | 'FIELD' | 'AUTHOR' | 'INSTITUTION' | 'TIMELINE'
  const [yGroupingMode, setYGroupingMode] = useState('NONE'); // 'NONE' | 'FIELD' | 'AUTHOR' | 'INSTITUTION' | 'TIMELINE'
  const [activeGroup, setActiveGroup] = useState(null);

  const groupingMode = (xAxisMode === 'TIMELINE' || xAxisMode === 'NONE') ? 'FIELD' : xAxisMode;
  const layoutMode = xAxisMode === 'TIMELINE' ? 'TIMELINE' : 'CENTRAL';

  const nodeByIdRef = useRef(new Map());
  const simulationRef = useRef(null);
  const groupPositionsMatch = useRef(new Map());
  const nodePositionsCache = useRef(new Map()); // Store all node positions
  const layoutPositionCacheRef = useRef(new Map());
  const isTransitioning = useRef(false);
  const prevViewMode = useRef(viewMode);
  const prevLayoutMode = useRef(layoutMode);
  const layoutSignatureRef = useRef("");
  const lastActiveGroupRef = useRef(null);
  const prevGroupingModeRef = useRef(groupingMode);
  const prevYAxisModeRef = useRef(yGroupingMode);
  const prevXAxisModeRef = useRef(xAxisMode);
  const prevSelectedIdRef = useRef(null);
  const returnToGalaxyRef = useRef(false);
  const returnToUniverseRef = useRef(false);
  const edgeRevealTimeoutRef = useRef(null);
  const edgeRevealPendingRef = useRef(false);
  const firstDataRenderRef = useRef(true);

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

  /** Load universe data on mount */
  useEffect(() => {
    fetch("./universe.json")
      .then(r => r.json())
      .then(data => {
        setUniverseData(data);
      })
      .catch(err => console.error("Failed to load universe data:", err));
  }, []);

  /** Load galaxy data when activeGalaxy changes */
  useEffect(() => {
    if (!activeGalaxy || !universeData) return;

    const galaxy = universeData.nodes?.find(g => g.id === activeGalaxy);
    if (!galaxy) return;

    Promise.all([
      fetch(`./${galaxy.nodesFile}`).then(r => r.json()),
      fetch(`./${galaxy.edgesFile}`).then(r => r.json()),
    ])
      .then(([n, e]) => {
        setRawNodes(Array.isArray(n) ? n : []);
        setRawEdges(Array.isArray(e) ? e : []);
      })
      .catch(err => console.error("Failed to load galaxy data:", err));
  }, [activeGalaxy, universeData]);

  /* Data Processing */
  const { nodes, groupStats, xGroups, groupEdges, yGroups } = useMemo(() => {
    if (!rawNodes || rawNodes.length === 0) return { nodes: [], groupStats: [], xGroups: [], groupEdges: [], yGroups: [] };

    const gMap = new Map();
    const nodeIdToGroup = new Map();

    // Helper to extract group key
    const getXAxisKey = (d) => {
      if (groupingMode === 'AUTHOR') return d.firstAuthor || "Unknown";
      if (groupingMode === 'INSTITUTION') return (d.institutions ? d.institutions.split(';')[0].trim() : "Unknown");
      return d.primaryField || d.AI_primary_field || "Unassigned";
    };
    const getYAxisKey = (d) => {
      if (yGroupingMode === 'NONE' || yGroupingMode === 'TIMELINE') return null;
      if (yGroupingMode === 'AUTHOR') return d.firstAuthor || "Unknown";
      if (yGroupingMode === 'INSTITUTION') return (d.institutions ? d.institutions.split(';')[0].trim() : "Unknown");
      return d.primaryField || d.AI_primary_field || "Unassigned";
    };

    // 1. Process Nodes & Build Group Map
    const ns = rawNodes.map(d => {
      const yr = d.year ?? d.publication_year ?? (d.publicationDate ? new Date(d.publicationDate).getFullYear() : 2000);
      const xGroup = getXAxisKey(d);
      const cites = d.citationCount ?? d.cited_by_count ?? 0;
      const yGroup = getYAxisKey(d);
      const shouldAggregateByY = yGroupingMode !== 'NONE' && yGroupingMode !== 'TIMELINE';
      const groupKey = shouldAggregateByY ? `${xGroup}|||${yGroup}` : xGroup;
      const displayName = shouldAggregateByY ? `${xGroup} / ${yGroup}` : xGroup;

      const n = {
        id: String(d.id || d.paperId),
        title: d.title,
        year: yr,
        citationCount: cites,
        group: groupKey, // Dynamic grouping (x/y aggregation)
        xGroup,
        yGroup,
        field: d.primaryField,
        abstract: d.abstract || d.AI_summary || "No abstract available.",
        authors: d.allAuthors || d.firstAuthor || "Unknown",
        institutions: d.institutions
      };

      nodeIdToGroup.set(n.id, groupKey);

      if (!gMap.has(groupKey)) {
        gMap.set(groupKey, { key: groupKey, name: displayName, xGroup, yGroup, count: 0, totalCitations: 0, minYear: Infinity });
      }
      const g = gMap.get(groupKey);
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
    const validGroups = new Set(finalGroupStats.map(g => g.key));
    const finalXGroups = Array.from(new Set(finalGroupStats.map(g => g.xGroup)));
    const finalYGroups = Array.from(new Set(finalGroupStats.map(g => g.yGroup).filter(Boolean)));

    // 2. Process Edges & Build Group Connections
    const groupEdgeMap = new Map();

    const encodeEdgeKey = (sourceGroup, targetGroup) => `${sourceGroup.length}::${sourceGroup}${targetGroup}`;
    const decodeEdgeKey = (key) => {
      const splitIdx = key.indexOf("::");
      if (splitIdx === -1) return { source: key, target: "" };
      const len = Number(key.slice(0, splitIdx));
      const rest = key.slice(splitIdx + 2);
      return {
        source: rest.slice(0, len),
        target: rest.slice(len)
      };
    };

    rawEdges.forEach(e => {
      const sourceGroup = nodeIdToGroup.get(String(e.source));
      const targetGroup = nodeIdToGroup.get(String(e.target));

      if (sourceGroup && targetGroup && sourceGroup !== targetGroup && validGroups.has(sourceGroup) && validGroups.has(targetGroup)) {
        const edgeKey = encodeEdgeKey(sourceGroup, targetGroup);
        groupEdgeMap.set(edgeKey, (groupEdgeMap.get(edgeKey) || 0) + 1);
      }
    });

    const calculatedGroupEdges = Array.from(groupEdgeMap.entries()).map(([key, count]) => {
      const { source, target } = decodeEdgeKey(key);
      return { source, target, weight: count };
    });

    return {
      nodes: ns,
      groupStats: finalGroupStats,
      xGroups: finalXGroups,
      groupEdges: calculatedGroupEdges,
      yGroups: finalYGroups
    };
  }, [rawNodes, rawEdges, groupingMode, yGroupingMode]);

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

  const colorScale = useMemo(() => d3.scaleOrdinal(d3.schemeTableau10).domain(xGroups), [xGroups]);
  const groupLabelByKey = useMemo(() => new Map(groupStats.map(g => [g.key, g.name])), [groupStats]);
  const groupXByKey = useMemo(() => new Map(groupStats.map(g => [g.key, g.xGroup])), [groupStats]);

  // Universe View Data (Galaxy Nodes)
  const universeNodes = useMemo(() => {
    if (viewMode !== 'UNIVERSE' || !universeData) return [];

    // Pre-sort by size (Works) to put largest in center
    const sortedRaw = (universeData.nodes || []).sort((a, b) => (b.totalWorksCount || 0) - (a.totalWorksCount || 0));

    const galaxyNodes = sortedRaw.map((galaxy, i) => {
      const existing = groupPositionsMatch.current.get(galaxy.id);

      // SIZE FIX: Strictly based on Total Works (Papers)
      const totalWorks = galaxy.totalWorksCount || 0;
      let val = 20;

      if (totalWorks > 0) {
        // Use Sqrt scale for area-proportional sizing
        // approx range: 0 -> 20, 100k -> 60, 1M -> ~80?
        // Let's tune: Max works is ~1.5M (Condensed Matter). We want that to be BIG but not screen-filling.
        // sqrt(1.5M) is ~1224. 
        // val = 30 + (sqrt(works) / 20) -> 30 + 60 = 90.
        // min val 30.
        val = 30 + Math.sqrt(totalWorks) * 0.05;
      } else {
        val = 25; // Smaller default for unknowns
      }

      // POS FIX: Deterministic Spiral Layout Initialization
      // "Try something else" -> Don't rely on random scatter.
      // Place them in a golden spiral so they are strictly separated at spawn.
      const angle = i * 2.5; // Golden angle-ish
      const radius = 100 + (val * 10) + (i * 200); // Expanding spiral
      const spiralX = Math.cos(angle) * radius;
      const spiralY = Math.sin(angle) * radius;

      // Use position from universe.json if timeline, else SPIRAL
      const position = galaxy.position || [0, 0, 0];
      const node = {
        id: galaxy.id,
        key: galaxy.id,
        type: 'galaxy',
        name: galaxy.name,
        nodeCount: galaxy.nodeCount || 0,
        edgeCount: galaxy.edgeCount || 0,
        totalWorksCount: totalWorks,
        val: Math.max(val, 30),
        data: galaxy,
        x: existing ? existing.x : spiralX, // Use existing or Spiral
        y: existing ? existing.y : spiralY, // Use existing or Spiral
        z: position[2],
        field: 'Galaxy',
        citationCount: galaxy.totalCitations || 0 // Keep data but don't use for size
      };

      // Force initial position to break "same spot" bug
      if (!existing && viewMode === 'UNIVERSE') {
        node.x = spiralX;
        node.y = spiralY;
      }

      return node;
    });

    // Add Menu Node
    galaxyNodes.push({
      id: 'menu-node',
      key: 'menu-node',
      type: 'menu',
      name: 'Menu',
      val: 40,
      x: 0, y: 0,
      fx: 800, fy: -600, // Fixed top right
      isMenuNode: true,
      data: {}
    });

    return galaxyNodes;
  }, [universeData, viewMode]);

  // Galaxy View Data (Group Nodes)
  const galaxyNodes = useMemo(() => {
    if (viewMode !== 'GALAXY') return [];

    return groupStats.map((f) => {
      const existing = groupPositionsMatch.current.get(f.key);

      const val = Math.sqrt(f.totalCitations) * 0.25;

      const fallbackPos = getDeterministicPoint(f.key, 450);
      const node = {
        id: `group-${f.key}`,
        key: f.key,
        type: 'group',
        name: f.name,
        xGroup: f.xGroup,
        yGroup: f.yGroup,
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
  const handleGalaxyClick = (galaxyId) => {
    console.log("Galaxy clicked:", galaxyId);
    prevXAxisModeRef.current = xAxisMode; // Save current mode (e.g. TIMELINE)
    setActiveGalaxy(galaxyId);
    setViewMode('GALAXY');
    setXAxisMode('NONE'); // Default to Central/Cluster layout
    setActiveGroup(null);
    setSelected(null);
  };

  const handleBackToUniverse = () => {
    returnToUniverseRef.current = true;
    setActiveGalaxy(null);
    setActiveGroup(null);
    setViewMode('UNIVERSE');
    // Restore previous mode if available
    if (prevXAxisModeRef.current) {
      setXAxisMode(prevXAxisModeRef.current);
    }
    // If not, we leave it as is (which is likely NONE from galaxy view, so Central)

    setSelected(null);
    setRawNodes([]);
    setRawEdges([]);
  };

  const handleGroupClick = (groupKey) => {
    console.log("Group clicked:", groupKey);
    setActiveGroup(groupKey);
    setViewMode('FIELD');
    setSelected(null);
  };

  const handleBackToGalaxy = () => {
    lastActiveGroupRef.current = activeGroup;
    returnToGalaxyRef.current = true;
    setActiveGroup(null);
    setViewMode('GALAXY');
    setSelected(null);
  };

  const handlePaperClick = (paper) => {
    setSelected(paper);
    // Update active group to this paper's group so "Back" works correctly contextually
    if (paper.group) {
      setActiveGroup(paper.group);
    }
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
    let gLinks = gMain.select(".g-links");
    if (gLinks.empty()) {
      gLinks = gMain.append("g").attr("class", "g-links");
    }
    // Axis container - create it specifically so we can control order
    let gAxisLayer = gMain.select(".g-axis-layer");
    if (gAxisLayer.empty()) {
      gAxisLayer = gMain.append("g").attr("class", "g-axis-layer");
    }

    let gNodes = gMain.select(".g-nodes");
    if (gNodes.empty()) {
      gNodes = gMain.append("g").attr("class", "g-nodes");
    }

    // Ensure render order: Links -> Axis -> Nodes 
    // (Actually Axis is usually behind nodes in charts, but for "Nodes above labels" user request:
    // User said: "nodes in universe view should appear above the x axis labels"
    // So Nodes must be last.
    gLinks.lower();
    gAxisLayer.lower(); // Axis below nodes
    gLinks.lower(); // Links at bottom
    gNodes.raise(); // Explicitly raise nodes to top
    // Result: Links -> Axis -> Nodes (Top)

    // Zoom Behavior - Defined every render to access current state (closures)
    const zoom = d3.zoom()
      .scaleExtent([0.1, 8])
      .on("zoom", (event) => {
        gMain.attr("transform", event.transform);

        if (isTransitioning.current) return;

        // --- SEMANTIC ZOOM LOGIC ---
        const k = event.transform.k;

        // 1. Zooming IN (Universe -> Galaxy)
        if (viewMode === 'UNIVERSE' && k > 1.8) {
          const cx = (width / 2 - event.transform.x) / k;
          const cy = (height / 2 - event.transform.y) / k;

          let closest = null;
          let minD = Infinity;

          universeNodes.forEach(n => {
            if (n.isMenuNode) return;

            if (layoutMode === 'TIMELINE') {
              // Timeline Hit Test: Vertical Slot Proximity
              // Check if Y is within range of the node's stream area
              const dy = Math.abs(n.y - cy);
              // Max height is ~400, so half is 200. Add padding for easier entry.
              const HIT_THRESHOLD = 250;

              // Also check X bounds loosely (don't zoom if WAY off chart)
              // Chart is roughly -1.5*width to 1.5*width.
              // Just using Y is safe enough for a vertical stack.

              if (dy < HIT_THRESHOLD && dy < minD) {
                minD = dy;
                closest = n;
              }
            } else {
              // Default (Radial/Spiral) Hit Test
              const dx = n.x - cx;
              const dy = n.y - cy;
              const d = Math.sqrt(dx * dx + dy * dy);
              if (d < minD) { minD = d; closest = n; }
            }
          });

          // Threshold Logic
          let trigger = false;
          if (closest) {
            if (layoutMode === 'TIMELINE') {
              // Absolute threshold for timeline
              if (minD < 250) trigger = true;
            } else {
              // Radius based for clusters
              if (minD < (closest.val * 2.5 + 100)) trigger = true;
            }
          }

          if (trigger && closest) {
            isTransitioning.current = true;
            handleGalaxyClick(closest.id);
            // Smooth transition: zoom to 0.3 scale of the galaxy view
            svg.transition().duration(750)
              .call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2).scale(0.3))
              .on("end", () => { isTransitioning.current = false; });
          }
        }

        // 2. Zooming IN (Galaxy -> Field)
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
              .call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2).scale(0.2))
              .on("end", () => { isTransitioning.current = false; });
          }
        }

        // 3. Zooming OUT (Galaxy -> Universe)
        if (viewMode === 'GALAXY' && k < 0.15) {
          isTransitioning.current = true;
          handleBackToUniverse();
        }

        // 4. Zooming OUT (Field -> Galaxy)
        if ((viewMode === 'FIELD' || viewMode === 'DETAIL') && k < 0.2) {
          isTransitioning.current = true;
          handleBackToGalaxy();
        }
      });

    // Attach zoom behavior
    svg.call(zoom);
    svg.on("click.unselect", (event) => {
      if (viewMode === 'FIELD' && selected) {
        setSelected(null);
      }
    });
    // Initialize zoom position ONLY if it's the first time
    if (svg.select(".g-main").attr("transform") === null) {
      svg.call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2).scale(0.3));
    }
    // When returning to Universe, reset zoom
    if (viewMode === 'UNIVERSE' && prevViewMode.current !== 'UNIVERSE') {
      if (layoutMode === 'TIMELINE') {
        const k = 0.45;
        const tx = width * 0.12;

        // Dynamic Vertical Logic (Same as Initial - Predictive)
        let predictedMaxY = 0;
        const validNodes = universeNodes.filter(n => !n.isMenuNode);
        const hasDataPositions = validNodes.some(n => typeof n.data.timeline_y === 'number');
        if (hasDataPositions) {
          predictedMaxY = d3.max(validNodes, n => n.data.timeline_y) || 0;
        } else {
          const count = validNodes.length;
          predictedMaxY = count > 0 ? 400 * (count - 1) : 0;
        }

        const dataBottomY = predictedMaxY + 150;
        const reservedBottom = height * 0.45;
        const targetScreenY = height - reservedBottom;
        const ty = targetScreenY - (dataBottomY * k);

        svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
      } else {
        svg.call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2).scale(0.3));
      }
      returnToUniverseRef.current = false;
      isTransitioning.current = false;
    }

    // When entering Galaxy from Universe, set zoom
    if (viewMode === 'GALAXY' && prevViewMode.current === 'UNIVERSE') {
      svg.call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2).scale(0.3));
      isTransitioning.current = false;
    }

    // When returning to Galaxy, focus on the last active group
    if (viewMode === 'GALAXY' && prevViewMode.current !== 'GALAXY' && prevViewMode.current !== 'UNIVERSE' && lastActiveGroupRef.current) {
      const groupName = lastActiveGroupRef.current;
      const pos = groupPositionsMatch.current.get(groupName);
      if (pos) {
        const scale = 1.2;
        const tx = width / 2 - pos.x * scale;
        const ty = height / 2 - pos.y * scale;
        svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
      }
      lastActiveGroupRef.current = null;
      isTransitioning.current = false;
    }

    // Determine current dataset
    let currentNodes = [];
    let currentEdges = [];
    let isUniverse = (viewMode === 'UNIVERSE');
    let isGalaxy = (viewMode === 'GALAXY');

    if (isUniverse) {
      currentNodes = universeNodes;
      currentEdges = []; // No edges in universe view
    } else if (isGalaxy) {
      currentNodes = galaxyNodes;
      const hoveredGroupKey = hovered?.id;
      const galaxyEdges = hoveredGroupKey
        ? groupEdges.filter(e => e.source === hoveredGroupKey || e.target === hoveredGroupKey)
        : groupEdges;
      // Deep clone edges to avoid mutation key issues in D3
      currentEdges = galaxyEdges.map(e => ({
        source: e.source,
        target: e.target,
        weight: e.weight
      }));
    } else {
      // FIELD VIEW
      const selectedId = selected?.id;
      let connectedIds = new Set();

      if (selectedId) {
        // 1. Get ALL connected edges for the selected node
        const connectedEdges = edges.filter(e => {
          const s = typeof e.source === 'object' ? e.source.id : e.source;
          const t = typeof e.target === 'object' ? e.target.id : e.target;
          return s === selectedId || t === selectedId;
        });

        connectedIds = new Set([selectedId]);
        connectedEdges.forEach(e => {
          const s = typeof e.source === 'object' ? e.source.id : e.source;
          const t = typeof e.target === 'object' ? e.target.id : e.target;
          connectedIds.add(s);
          connectedIds.add(t);
        });

        // 2. Build currentNodes from ALL available nodes matching connectedIds
        const m = nodeByIdRef.current;
        currentNodes = [];
        connectedIds.forEach(id => {
          const n = m.get(String(id));
          if (n) {
            currentNodes.push(n);
          }
        });

        // 3. Filter edges
        currentEdges = connectedEdges;

      } else {
        // Default Field View: Show all in group
        currentNodes = nodes.filter(n => n.group === activeGroup);
        // Filter edges to only those within the group
        const nodeIds = new Set(currentNodes.map(n => n.id));
        currentEdges = edges.filter(e => {
          const s = typeof e.source === 'object' ? e.source.id : e.source;
          const t = typeof e.target === 'object' ? e.target.id : e.target;
          return nodeIds.has(s) && nodeIds.has(t);
        });
      }

      // Calculate sizes for field nodes
      const maxCites = d3.max(currentNodes, d => d.citationCount) || 1;
      const sizeScale = d3.scaleSqrt().domain([0, maxCites]).range([0.8, 2.5]);
      currentNodes.forEach(d => {
        d._scale = sizeScale(d.citationCount);
        d._w = 120 * d._scale; d._h = 50 * d._scale;
        d._isConnected = selectedId ? connectedIds.has(d.id) : false;
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
      if (!isGalaxy) {
        return typeof d.source === "object" ? (d.source.group || d.source.id) : d.source;
      }
      if (typeof d.source === "object") {
        return d.source.xGroup || d.source.name || d.source.group || d.source.id;
      }
      return groupXByKey.get(String(d.source)) || d.source;
    };
    const getBaseEdgeColor = (d) => (isGalaxy ? colorScale(getEdgeSourceName(d)) : EDGE_COLORS.default);
    const setGradientStops = (selection, color) => {
      selection.select(".grad-stop-start").attr("stop-color", color).attr("stop-opacity", 0.0);
      selection.select(".grad-stop-mid").attr("stop-color", color).attr("stop-opacity", 0.25);
      selection.select(".grad-stop-end").attr("stop-color", color).attr("stop-opacity", 0.85);
    };

    const defs = svg.select("defs").empty() ? svg.append("defs") : svg.select("defs");
    const selectedChanged = prevSelectedIdRef.current !== (selected?.id || null);
    if (!isGalaxy && selectedChanged) {
      gLinks.selectAll(".d3-link").interrupt().remove();
      defs.selectAll(".link-gradient").remove();
      nodePositionsCache.current.clear();
    }
    const groupingChanged = isGalaxy && (
      prevGroupingModeRef.current !== groupingMode
      || prevYAxisModeRef.current !== yGroupingMode
      || prevXAxisModeRef.current !== xAxisMode
    );
    if (groupingChanged) {
      gNodes.selectAll(".d3-node").remove();
      gLinks.selectAll(".d3-link").remove();
      defs.selectAll(".link-gradient").remove();
      groupPositionsMatch.current.clear();
      layoutPositionCacheRef.current.clear();
    }
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
    // If we are in Universe, remove all links. If in Galaxy, kill paper links. If in Field, kill galaxy links.
    // Also remove generic .d3-link if they don't match current expected class (legacy cleanup)
    if (isUniverse) {
      gLinks.selectAll(".d3-link").remove();
    } else {
      gLinks.selectAll(isGalaxy ? ".type-paper-link" : ".type-galaxy-link").remove();
      // Safety: Remove any link that doesn't have the correct class for current view
      // (This prevents "plain" links from sticking around)
      gLinks.selectAll(".d3-link").filter(function () {
        const cl = d3.select(this).attr("class");
        return !cl.includes(isGalaxy ? 'type-galaxy-link' : 'type-paper-link');
      }).remove();
    }

    const linkJoin = gLinks.selectAll(".d3-link")
      // Namespace key by view type to force full replacement on view switch
      .data(currentEdges, getEdgeKey);

    linkJoin.exit().transition().duration(500).attr("stroke-opacity", 0).remove();

    const linksEntry = linkJoin.enter().append("path")
      .attr("class", `d3-link ${isUniverse ? 'type-universe-link' : (isGalaxy ? 'type-galaxy-link' : 'type-paper-link')}`)
      .attr("fill", "none")
      .attr("stroke-linecap", "round")
      .attr("stroke-opacity", 0);

    // Update both new and existing
    const links = linksEntry.merge(linkJoin)
      .attr("class", `d3-link ${isUniverse ? 'type-universe-link' : (isGalaxy ? 'type-galaxy-link' : 'type-paper-link')}`) // Ensure class is correct on update
      .attr("stroke-width", d => isUniverse ? 0 : (isGalaxy ? Math.max(1.6, Math.sqrt(d.weight || 1) + 0.8) : 6))
      .attr("stroke", d => `url(#${getGradientId(d)})`)
      .attr("opacity", 0)
      .attr("stroke-opacity", 0);

    // Nodes
    // Use a generic selection to ensure we catch ALL nodes (Galaxy or Field)
    // This guarantees the 'exit' selection contains any node that shouldn't be here.
    const nodeJoin = gNodes.selectAll(".d3-node")
      .data(currentNodes, d => d.id);

    // EXIT
    nodeJoin.exit()
      .each(function (d) {
        // Check if this node is "incompatible" with current view
        // e.g. We are in FIELD mode, but this is a Group node
        const isGroupNode = d.id.startsWith("group-");
        const isGalaxyNode = d.type === 'galaxy';
        const isWrongType = (isUniverse && !isGalaxyNode) || (isGalaxy && !isGroupNode) || (!isGalaxy && !isUniverse && isGroupNode) || (!isGalaxy && !isUniverse && isGalaxyNode);

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
      .attr("class", d => `d3-node ${isUniverse ? 'type-galaxy' : (isGalaxy ? 'type-group' : 'type-paper')}`)
      .attr("cursor", "pointer")
      .style("opacity", 0) // Start invisible
      .on("click", (e, d) => {
        e.stopPropagation();
        if (isUniverse && d.isMenuNode) {
          // Don't navigate when clicking menu node, just keep it selected/hovered
          setSelected({ ...d, isMenuNode: true });
          return;
        }
        if (isUniverse) {
          if (d.data?.hasPapers === false) {
            // Stub galaxy: Select to show metadata but do not enter
            setSelected(d);
            return;
          }
          handleGalaxyClick(d.id);
        }
        else if (isGalaxy) handleGroupClick(d.key);
        else handlePaperClick(d);
      })
      .on("mouseover", (e, d) => {
        if (isUniverse && d.isMenuNode) {
          setHovered({
            id: d.id,
            title: "About This Map",
            isMenuNode: true,
          });
        } else if (isUniverse) {
          const hasPapers = d.data?.hasPapers !== false;
          const totalWorks = d.data?.totalWorksCount || 0;
          setHovered({
            id: d.id,
            title: d.name,
            citationCount: hasPapers ? d.nodeCount : totalWorks,
            groupCount: hasPapers ? d.nodeCount : 0,
            edgeCount: d.edgeCount,
            field: "Galaxy",
            abstract: hasPapers
              ? `${d.nodeCount} papers in this galaxy. ${d.edgeCount} connections.`
              : `Data pending download. Total works in field: ${d3.format(",")(totalWorks)}.`,
            // Rich Metadata
            oldestWork: d.data?.oldestWork,
            mostCitedWork: d.data?.mostCitedWork,
            totalWorks: totalWorks,
            hasPapers: hasPapers
          });
        } else if (isGalaxy) {
          setHovered({
            id: d.key,
            title: d.name,
            year: `Est. ${d.minYear}`,
            citationCount: d.data.totalCitations,
            groupCount: d.data.count,
            minYear: d.minYear,
            field: "Galaxy Group",
            abstract: `${d.data.count} papers in this cluster. Combined citation impact of ${d.data.totalCitations}.`
          });
        } else {
          setHovered(d);
        }
      })
      .on("mouseout", (e, d) => {
        // Don't clear hover if menu node is selected/hovered
        if (d.isMenuNode && (selected?.isMenuNode || hovered?.isMenuNode)) {
          return;
        }
        // Clear hover for non-menu nodes unless menu is selected
        if (!selected?.isMenuNode) {
          setHovered(null);
        }
      });

    // Keep new nodes hidden until we pre-calc positions (no movement on appearance)
    nodesEntry.style("opacity", 0);

    // Construct Node content based on type
    if (isUniverse || isGalaxy) {
      nodesEntry.each(function (d) {
        const el = d3.select(this);
        if (isUniverse && !d.isMenuNode) {
          // Hexagon for Universe nodes
          el.append("path").attr("class", "orbit")
            .attr("stroke-width", 12) // Thick stroke for rounding
            .attr("stroke-linejoin", "round")
            .attr("fill-opacity", 0.15);
          el.append("path").attr("class", "core")
            .attr("fill-opacity", 0.8).style("filter", "blur(1px)");
        } else {
          // Circle for others (Galaxy nodes or Menu node)
          // Added stroke and stroke-width (default 0 or small) so we can animate stroke-opacity in CSS
          el.append("circle").attr("class", "orbit")
            .attr("r", d => d.val * 2.5)
            .attr("fill-opacity", 0.15)
            .attr("stroke", d => colorScale(d.xGroup)) // Set default color so stroke exists
            .attr("stroke-width", 2)
            .attr("stroke-opacity", 0.2); // Start low

          el.append("circle").attr("class", "core").attr("r", d => d.val * 0.8).attr("fill-opacity", 0.8).style("filter", "blur(1px)");
        }

        el.append("text").attr("class", "label-main").attr("text-anchor", "middle").attr("dy", d => d.val * 2 + 20)
          .style("font-size", "16px").style("font-weight", "600").style("fill", "#0f172a").style("text-shadow", "0 2px 4px white");
        el.append("text").attr("class", "label-right").attr("text-anchor", "start").attr("dy", 5) // Vertically centered roughly
          .style("font-size", "16px").style("font-weight", "600").style("fill", "#0f172a").style("text-shadow", "0 2px 4px white")
          .style("opacity", 0);
        el.append("text").attr("class", "label-sub").attr("text-anchor", "middle").attr("dy", d => d.val * 2 + 40)
          .style("font-size", "12px").style("fill", "#64748b");
      });
    } else {
      nodesEntry.append("rect").attr("class", "node-rect").attr("rx", 6).attr("fill-opacity", 0.9).attr("stroke", "#fff").attr("stroke-width", 2)
        .style("filter", "drop-shadow(0px 2px 4px rgba(0,0,0,0.1))");
      nodesEntry.append("foreignObject").attr("class", "fo-content").style("pointer-events", "none").append("xhtml:div").attr("class", "node-fo");
    }

    nodesEntry.style("opacity", 0);

    // Merge for updates
    const allNodes = nodesEntry.merge(nodeJoin);

    if (isUniverse) {
      // Universe nodes - use a color scheme based on galaxy id
      const universeColorScale = d3.scaleOrdinal(d3.schemeTableau10);

      allNodes.each(function (d) {
        const el = d3.select(this);
        // Safely access data.hasPapers. Menu nodes don't have data, so they default to "false" concept or handled by isMenuNode check later.
        // Actually, let's just make it safe.
        const hasPapers = d.data?.hasPapers !== false;
        const color = d.isMenuNode ? "#94a3b8" : (hasPapers ? universeColorScale(d.id) : "#cbd5e1");
        const isHex = !d.isMenuNode;

        // Handle Orbit
        const orbit = el.select(".orbit");
        orbit
          .attr("fill", d.isMenuNode ? "#94a3b8" : color)
          .attr("stroke", d.isMenuNode ? "none" : color) // Stroke for rounded corners
          .attr("fill-opacity", d.isMenuNode ? 0.08 : (hasPapers ? 0.15 : 0.05));

        if (isHex) {
          orbit.attr("d", roundedHexagonPath(d.val * 2.5))
            .attr("r", null); // Clear r if it was a circle
        } else {
          orbit.attr("r", d.val * 2.5)
            .attr("d", null);
        }

        // Handle Core
        const core = el.select(".core");
        core
          .attr("fill", d.isMenuNode ? "#64748b" : color)
          .attr("fill-opacity", d.isMenuNode ? 0.4 : (hasPapers ? 0.8 : 0.4));

        if (isHex) {
          core.attr("d", roundedHexagonPath(d.val * 0.8))
            .attr("r", null);
        } else {
          core.attr("r", d.val * 0.8)
            .attr("d", null);
        }
      });

      allNodes.select(".label-main")
        .text(d => d.isMenuNode ? d.name : (d.name.length > 25 ? d.name.substring(0, 22) + "..." : d.name))
        .attr("dy", d => d.val * 2 + 20)
        .style("font-size", d => d.isMenuNode ? "20px" : "16px")
        .style("fill", d => (d.data?.hasPapers !== false) ? "#0f172a" : "#94a3b8"); // Grey text for stubs

      allNodes.select(".label-sub")
        // Show "No local data" or just count (0)
        .text(d => d.isMenuNode ? "" : (d.data?.hasPapers !== false ? `${d.nodeCount} papers` : "No data"))
        .attr("dy", d => d.val * 2 + 40)
        .style("opacity", d => d.isMenuNode ? 0 : 1);

      allNodes.select(".label-right")
        .text(d => d.name)
        .style("opacity", 0); // Default hidden

      // Remove Field elements if switching types
      allNodes.select("rect").remove();
      allNodes.select("foreignObject").remove();
    } else if (isGalaxy) {
      allNodes.select(".orbit").attr("fill", d => colorScale(d.xGroup)).attr("r", d => d.val * 2.5);
      allNodes.select(".core").attr("fill", d => colorScale(d.xGroup)).attr("r", d => d.val * 0.8);
      allNodes.select(".label-main").text(d => d.name.length > 25 ? d.name.substring(0, 22) + "..." : d.name).attr("dy", d => d.val * 2 + 20);
      allNodes.select(".label-sub").text(d => `${d.data.count} papers`).attr("dy", d => d.val * 2 + 40);

      // Remove Field elements if switching types
      allNodes.select("rect").remove();
      allNodes.select("foreignObject").remove();

    } else {
      allNodes.select("rect")
        .attr("width", d => d._w).attr("height", d => d._h)
        .attr("x", d => -d._w / 2).attr("y", d => -d._h / 2)
        .attr("fill", d => colorScale(d.xGroup || d.group));

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
      gLinks.selectAll(".d3-link").attr("d", d => getLinkPath(d));
      svg.select("defs").selectAll(".link-gradient")
        .attr("x1", d => (d.source && typeof d.source.x === "number") ? d.source.x : 0)
        .attr("y1", d => (d.source && typeof d.source.y === "number") ? d.source.y : 0)
        .attr("x2", d => (d.target && typeof d.target.x === "number") ? d.target.x : 0)
        .attr("y2", d => (d.target && typeof d.target.y === "number") ? d.target.y : 0);
    };
    const dataSignature = `${viewMode}|${layoutMode}|${activeGroup || ""}|${groupingMode}|${xAxisMode}|${yGroupingMode}|${rawNodes.length}|${rawEdges.length}`;
    const signatureChanged = layoutSignatureRef.current !== dataSignature;
    const viewChanged = prevViewMode.current !== viewMode;
    const layoutChanged = prevLayoutMode.current !== layoutMode;
    const shouldAnimateLayout = layoutChanged && !viewChanged;
    const hasRenderableNodes = currentNodes.length > 0;
    const isReturningGalaxy = viewMode === 'GALAXY' && returnToGalaxyRef.current;
    const shouldPrecompute = (signatureChanged && !shouldAnimateLayout && hasRenderableNodes)
      || (hasRenderableNodes && firstDataRenderRef.current);
    // Skip precompute for universe view since positions are fixed from universe.json
    const shouldRunIntro = (!isUniverse && shouldPrecompute) || isReturningGalaxy;
    const shouldIntro = shouldRunIntro;
    const introStartScale = isGalaxy ? (isReturningGalaxy ? 2.5 : 0.1) : 0.1;
    const introTargetScale = 1;

    const seededRandom = d3.randomLcg(0.42);

    let timelineXScale = null;
    if (layoutMode === 'TIMELINE') {
      // FIX: Use ALL nodes in the group for scale domain, not just selected subset
      // This ensures the timeline doesn't jump/rescale when selecting a node
      let domainNodes = currentNodes;
      if (!isGalaxy && !isUniverse && activeGroup) {
        domainNodes = nodes.filter(n => n.group === activeGroup);
      }

      const years = domainNodes.map(d => isGalaxy ? d.minYear : d.year);
      const minYear = d3.min(years) || 1990;
      const maxYear = d3.max(years) || 2025;
      timelineXScale = d3.scaleLinear().domain([minYear, maxYear]).range([-width * 1.2, width * 1.2]);
    }

    const applyInitialPositions = () => {
      if (isUniverse) {
        // Universe view:
        if (layoutMode === 'CENTRAL') {
          // ENFORCE SPIRAL LAYOUT if seemingly stuck
          currentNodes.forEach((n, i) => {
            n.fx = null;
            n.fy = null;

            if ((Math.abs(n.x) < 1 && Math.abs(n.y) < 1) || !n.x) {
              const val = n.val || 30;
              const angle = i * 2.5;
              const radius = 100 + (val * 10) + (i * 200);
              n.x = Math.cos(angle) * radius;
              n.y = Math.sin(angle) * radius;
              n.vx = n.x * 0.01;
              n.vy = n.y * 0.01;
            }
          });
        }
      } else if (isGalaxy) {
        currentNodes.forEach(n => {
          const cached = groupPositionsMatch.current.get(n.key);
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
        const selectedAnchor = selected ? (nodePositionsCache.current.get(selected.id) || groupAnchor) : groupAnchor;
        currentNodes.forEach(n => {
          const cached = nodePositionsCache.current.get(n.id);
          if (cached && !n._isExtra) {
            n.x = cached.x;
            n.y = cached.y;
            if (selected && !n._isExtra && !n._isConnected) {
              n.fx = n.x;
              n.fy = n.y;
            } else {
              n.fx = null;
              n.fy = null;
            }
            return;
          } else if (selected && !isGalaxy) {
            // Warm Start for Topic View (Selected Node)
            if (n.id === selected.id) {
              n.x = selectedAnchor.x;
              n.y = selectedAnchor.y;
            } else {
              const maxCites = d3.max(currentNodes, d => d.citationCount) || 1;
              const importance = (n.citationCount || 0) / maxCites;
              const targetRadius = 600 - (importance * 350);
              const base = hashString(n.id);
              const angle = ((base % 360) * Math.PI) / 180;

              n.x = selectedAnchor.x + Math.cos(angle) * targetRadius;
              n.y = selectedAnchor.y + Math.sin(angle) * targetRadius;
            }
          } else {
            const offsetRadius = n._isExtra ? 1000 : 60;
            const offset = getDeterministicPoint(n.id, offsetRadius);
            const anchor = n._isExtra ? selectedAnchor : groupAnchor;
            const anchorX = (timelineXScale && n._isExtra) ? timelineXScale(n.year) : anchor.x;
            n.x = anchorX + offset.x + (seededRandom() - 0.5) * 8;
            n.y = anchor.y + offset.y + (seededRandom() - 0.5) * 8;
          }
          if (selected && !n._isExtra && !n._isConnected) {
            n.fx = n.x;
            n.fy = n.y;
          } else {
            n.fx = null;
            n.fy = null;
          }
        });
      }
    };

    applyInitialPositions();

    // Initial Center View (Crucial for Universe Timeline to be visible)
    if (firstDataRenderRef.current && width && height) {
      if (layoutMode === 'TIMELINE') {
        const k = 0.45;
        const tx = width * 0.12;

        // Dynamic Vertical Positioning
        // Goal: "Bottom right of chart fits in bottom right of screen"

        // 1. Predict Data Bottom (Deterministic Layout Logic)
        // We cannot rely on n.fy being set yet on first render.
        // We replicate the layout logic:
        // Logic: centerY = 0. Slots are 800px high. 
        // Bottom-most node Y = (Count * 800 / 2) - 400 = 400 * Count - 400 = 400 * (Count - 1)

        let predictedMaxY = 0;
        const validNodes = universeNodes.filter(n => !n.isMenuNode);

        // Check if we have pre-calculated positions in data
        const hasDataPositions = validNodes.some(n => typeof n.data.timeline_y === 'number');

        if (hasDataPositions) {
          predictedMaxY = d3.max(validNodes, n => n.data.timeline_y) || 0;
        } else {
          const count = validNodes.length;
          predictedMaxY = count > 0 ? 400 * (count - 1) : 0;
        }

        const dataBottomY = predictedMaxY + 150; // Axis position

        // 2. Target Screen Bottom
        // We want dataBottomY to be at screen bottom minus footer height
        // Footer is min 30vh. User wants axis clearly visible, so reserve more space (45%).
        const reservedBottom = height * 0.45;
        const targetScreenY = height - reservedBottom;

        // 3. Solve for ty: ScreenY = DataY * k + ty  =>  ty = ScreenY - DataY * k
        const ty = targetScreenY - (dataBottomY * k);

        svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
      } else {
        svg.call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2));
      }
    }

    // When entering Field view, start zoomed further out
    if (viewMode === 'FIELD' && prevViewMode.current !== 'FIELD') {
      isTransitioning.current = true;
      svg.call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2).scale(0.12));
      svg.transition().duration(650)
        .call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2).scale(0.3))
        .on("end", () => { isTransitioning.current = false; });
    }

    // Center selected node in Field view after positions exist
    if (viewMode === 'FIELD' && selected) {
      const selNode = currentNodes.find(n => n.id === selected.id);
      if (selNode) {
        const t = d3.zoomTransform(svg.node());
        const tx = width / 2 - selNode.x * t.k;
        const ty = height / 2 - selNode.y * t.k;
        svg.transition().duration(450)
          .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(t.k));
      }
    }

    // --- FORCES & SIMULATION ---
    if (simulationRef.current) simulationRef.current.stop();

    const graphCenterY = -height * 0.1;
    const selectedNode = !isGalaxy && selected ? currentNodes.find(n => n.id === selected.id) : null;
    const selectedAnchor = selectedNode ? { x: selectedNode.x, y: selectedNode.y } : { x: 0, y: graphCenterY };

    const hasTimeline = layoutMode === 'TIMELINE' || yGroupingMode === 'TIMELINE';

    // Universe Timeline Scale
    let universeXScale = null;
    let universeYScale = null; // Kept for other modes/refs, though null in TIMELINE now
    let timelineHeightScale = null;

    if (isUniverse && layoutMode === 'TIMELINE') {
      // Global min/max year across all galaxies
      const allDecades = universeNodes.flatMap(n => n.data?.worksByDecade?.map(d => d.decade) || []);
      const minYear = d3.min(allDecades) || 1800;
      const maxYear = d3.max(allDecades) || 2025;

      // Use 300% of width for timeline to maximize spread and alignment
      universeXScale = d3.scaleLinear()
        .domain([minYear, maxYear])
        .range([-width * 1.5, width * 1.5]);

      // Calculate global stats for sizing
      const validNodes = universeNodes.filter(n => !n.isMenuNode && n.data?.worksByDecade);

      // Find the absolute maximum papers in a single decade for a single field
      // This will be our "maximum width funnel" anchor (e.g., Condensed Matter's peak)
      const absMaxWorksSingleDecade = d3.max(validNodes, d => d3.max(d.data.worksByDecade, w => w.works_count) || 0) || 1000;

      // Smart Layout Distribution (Unconstrained Vertical Stack):
      // Vertical space is unlimited (scrollable).
      // We scale the data such that the "fattest" funnel is 400px tall (leaving 400px gap in 800px slot).
      const TARGET_MAX_DATA_HEIGHT = 400;

      // Scale maps works -> variable_height_component
      timelineHeightScale = d3.scaleLinear()
        .domain([0, absMaxWorksSingleDecade])
        .range([0, TARGET_MAX_DATA_HEIGHT]);

      universeYScale = null; // We use dynamic positioning now
    }


    const sim = d3.forceSimulation(currentNodes)
      .randomSource(seededRandom)
      .force("charge", d3.forceManyBody().strength(d => {
        if (isUniverse) return -200;
        if (isGalaxy) return -400;
        return d._isExtra ? -1600 : -600;
      }))
      .force("collide", d3.forceCollide().radius(d => {
        if (isUniverse) {
          // Universe Central Collision - MASSIVE spacing
          // "Not even close together" -> Radius + 150px padding
          return (d.val * 2.5 + 150);
        }
        if (isGalaxy) return (d.val * 2 + 50);
        return (d._w * 0.6) + (d._isExtra ? 260 : 40);
      }).iterations(isUniverse ? 4 : 4));

    // Universe Area Generator
    const generateAreaPath = (d) => {
      const decades = d.data.worksByDecade || [];
      if (!decades.length || !universeXScale || !timelineHeightScale) return "M0,0Z";

      // Symmetric Streamgraph
      // Center Y is 0 (relative to node position)
      // Top is -height/2, Bottom is +height/2

      const area = d3.area()
        .x(p => universeXScale(p.decade) - d.x) // Adjust for node position
        .y0(p => -timelineHeightScale(p.works_count) / 2)
        .y1(p => timelineHeightScale(p.works_count) / 2)
        .curve(d3.curveBasis); // Smooth curves

      return area(decades);
    };



    if (!isGalaxy && selected && !hasTimeline) {
      // ... (Selected Node Logic - unchanged)
      // 1. Stronger Charge to prevent overlapping
      sim.force("charge", d3.forceManyBody().strength(-3000));

      // 2. Strong collide with padding
      sim.force("collide", d3.forceCollide().radius(d => {
        // Larger collision radius for the central node
        if (d.id === selected.id) return d._w * 0.8 + 80;
        return d._w * 0.6 + 20;
      }).iterations(4));

      // 3. Pin selected node to center
      sim.force("center-pin", d3.forceRadial(0, selectedAnchor.x, selectedAnchor.y).strength(d => d.id === selected.id ? 1 : 0));

      // 4. Position neighbors based on importance
      const maxCites = d3.max(currentNodes, d => d.citationCount) || 1;
      sim.force("neighbor-ring", d3.forceRadial(d => {
        if (d.id === selected.id) return 0;
        const importance = (d.citationCount || 0) / maxCites;
        return 600 - (importance * 350);
      }, selectedAnchor.x, selectedAnchor.y).strength(0.6));

    } else {
      sim.force("extra-ring", null);
      sim.force("center-pin", null);
      sim.force("neighbor-ring", null);
    }

    if (isUniverse) {
      if (layoutMode === 'TIMELINE') {
        sim.force("center", null);
        sim.force("link", null);
        sim.force("charge", null);
        sim.force("collide", null);
      } else {
        // Central Layout (Universe) - FORCE SIMULATION (No Grid)
        // Use soft gravity instead of hard center to allow cloud to breathe
        sim.force("center", null);
        sim.force("x", d3.forceX(0).strength(0.05));
        sim.force("y", d3.forceY(0).strength(0.05));

        // Strong repulsion to help push them apart initially (-2000)
        sim.force("charge", d3.forceManyBody().strength(-2000));
        // Collision already set above with conditional radius
        sim.force("link", null);
      }

      // Update forces/positions based on layout
      // Update forces/positions based on layout
      if (layoutMode === 'TIMELINE' && universeXScale && timelineHeightScale) {
        // Ridge Plot Layout - Robust Explicit Positioning
        // Reset ALL universe positions to handle stale state
        currentNodes.forEach(n => {
          if (n.field === 'Galaxy' || n.isMenuNode) {
            // Keep menu node fixed
            if (n.isMenuNode) {
              n.fx = 800; n.fy = -600;
            } else {
              n.fx = null; n.fy = null;
              // Add Jitter if undefined/zero to prevent stacking
              if (!n.x && !n.y) {
                n.x = (Math.random() - 0.5) * 100;
                n.y = (Math.random() - 0.5) * 100;
              }
            }
          }
        });

        // Stable Sort: Year -> ID
        const sortedForLayout = [...currentNodes]
          .filter(n => !n.isMenuNode)
          .sort((a, b) => {
            const yearDiff = (a.data.firstPublicationYear || 0) - (b.data.firstPublicationYear || 0);
            if (yearDiff !== 0) return yearDiff;
            return a.id.localeCompare(b.id);
          });

        // Strict Slot Layout - Absolute Positioning (Backend Driven)
        // If data has 'timeline_y', use it. Else fallback to index-based slot.
        const SLOT_HEIGHT = 800;

        sortedForLayout.forEach((n, i) => {
          n.fx = 0;
          if (typeof n.data.timeline_y === "number") {
            n.fy = n.data.timeline_y;
          } else {
            // Fallback if universe.json is stale
            const totalHeight = sortedForLayout.length * SLOT_HEIGHT;
            const startY = -totalHeight / 2;
            n.fy = startY + (i * SLOT_HEIGHT) + (SLOT_HEIGHT / 2);
          }
          // FORCE Position immediate update - Bypass D3 tick for initial placement
          if (n.fy !== undefined) {
            n.y = n.fy;
            n.vy = 0;
          }
          if (n.fx !== undefined) {
            n.x = n.fx;
            n.vx = 0;
          }
        });

      } else {
        // Central Layout (Universe) - FORCE SIMULATION (No Grid)
        // We let the force simulation handle positioning to ensure tight packing
        // without overlap and without rigid grid structure.

        // Reset fixed positions so simulation takes over
        currentNodes.forEach(n => {
          n.fx = null;
          n.fy = null;
          // Add Jitter if undefined/zero to prevent stacking at 0,0
          if (!n.x && !n.y) {
            n.x = (Math.random() - 0.5) * 500; // Increased jitter range
            n.y = (Math.random() - 0.5) * 500;
          }
        });

        // RESTART SIMULATION to ensure expansion happens if it has cooled
        sim.alpha(1).restart();
      }

    } else if (isGalaxy) {
      if (layoutMode === 'CENTRAL' || layoutMode === 'TIMELINE') {
        sim.force("link", d3.forceLink(currentEdges).id(d => d.key).distance(200).strength(layoutMode === 'TIMELINE' ? 0.01 : 0.05));
      }
    } else {
      // FIELD VIEW
      const linkDist = selected ? 450 : 150;
      sim.force("link", d3.forceLink(currentEdges).id(d => d.id).distance(linkDist));
    }

    // ... (Layout Force Code - unchanged) ...


    // ... xGroupScale definition ...

    // Apply Initial Positions override? No, handled in forces for Universe now.

    // ... (Simulation start logic - unchanged)

    // --- RENDER UPDATE FOR UNIVERSE SHAPES ---
    if (isUniverse) {
      // Disable animation on first render to make it instant
      const tDuration = (firstDataRenderRef.current && layoutMode === 'TIMELINE') ? 0 : 1000;

      allNodes.each(function (d) {
        const el = d3.select(this);
        const orbit = el.select(".orbit");
        const core = el.select(".core");
        const label = el.select(".label-main");
        const sub = el.select(".label-sub");

        if (layoutMode === 'TIMELINE' && !d.isMenuNode) {
          // Morph to Area
          const areaPath = generateAreaPath(d);

          orbit.transition().duration(tDuration)
            .attr("d", areaPath)
            .attr("fill-opacity", 0.4)
            .attr("stroke-width", 2);

          // Hide core or make it follow? simpler to hide or match
          core.transition().duration(tDuration)
            .attr("d", areaPath) // Core matches area
            .attr("fill-opacity", 0.1)
            .style("filter", "none");

          // Move labels to left of the ridge
          // Start year X
          const startYear = d.data.firstPublicationYear || 1900;
          const startX = universeXScale ? (universeXScale(startYear) - d.fx) : -200;

          label.transition().duration(tDuration)
            .attr("x", startX - 20)
            .attr("dy", 0)
            .attr("text-anchor", "end");

          sub.transition().duration(tDuration)
            .attr("x", startX - 20)
            .attr("dy", 15)
            .attr("text-anchor", "end")
            .style("opacity", 1);

          // Right Label
          const endYear = d.data.lastPublicationYear || 2024;
          const endX = universeXScale ? (universeXScale(endYear) - d.fx) : 200;

          d3.select(this).select(".label-right").transition().duration(tDuration)
            .attr("x", endX + 20)
            .attr("dy", 0)
            .attr("text-anchor", "start")
            .style("opacity", 1);

        } else {
          // Hexagon (Default)
          const val = d.val || 20;
          const hexPath = roundedHexagonPath(val * 2.5);
          const corePath = roundedHexagonPath(val * 0.8);

          orbit.transition().duration(tDuration)
            .attr("d", hexPath)
            .attr("fill-opacity", 0.15)
            .attr("stroke-width", 12);

          core.transition().duration(tDuration)
            .attr("d", corePath)
            .attr("fill-opacity", 0.8)
            .style("filter", "blur(1px)");

          label.transition().duration(tDuration)
            .attr("x", 0)
            .attr("dy", val * 2 + 20)
            .attr("text-anchor", "middle");

          sub.transition().duration(tDuration)
            .attr("x", 0)
            .attr("dy", val * 2 + 40)
            .attr("text-anchor", "middle");
        }
      });

      // Add Timeline Axis if needed
      if (layoutMode === 'TIMELINE' && universeXScale) {
        // Use the pre-created axis layer to ensure Z-order
        const gAxisLayer = gMain.select(".g-axis-layer");
        let gAxis = gAxisLayer.select(".universe-axis");
        if (gAxis.empty()) {
          gAxis = gAxisLayer.append("g").attr("class", "universe-axis");
        }

        // Fix Axis Position relative to Nodes (World Space)
        // Find the bottom-most node to place axis below the stack
        const validNodes = currentNodes.filter(n => !n.isMenuNode && typeof n.fy === 'number');
        const maxY = d3.max(validNodes, n => n.fy) || (height / 2);
        const axisY = maxY + 150; // Place closer to the last slot (was 450)

        // Dynamic axis
        const axis = d3.axisBottom(universeXScale).ticks(10).tickFormat(d3.format("d"));

        gAxis.attr("transform", `translate(0, ${axisY})`)
          .transition().duration(1000)
          .style("opacity", 1)
          .call(axis);

        gAxis.selectAll("text").style("font-size", "14px").style("fill", "#64748b");
        gAxis.selectAll("line").style("stroke", "#cbd5e1");
        gAxis.selectAll("path").style("stroke", "#cbd5e1");
      } else {
        gMain.select(".universe-axis").transition().duration(500).style("opacity", 0).remove();
      }
    }

    const getLayoutCacheKey = (mode) => `${viewMode}|${activeGroup || ""}|${groupingMode}|${xAxisMode}|${yGroupingMode}|${mode}`;
    const cachedTargets = layoutPositionCacheRef.current.get(getLayoutCacheKey(layoutMode));
    const hasCachedTargets = cachedTargets && cachedTargets.size > 0;

    // LAYOUT FORCES & AXIS
    gMain.select(".timeline-axis").remove();
    gMain.select(".y-axis").remove();
    gMain.select(".x-axis").remove();

    const sortedYGroups = yGroups.slice().sort((a, b) => a.localeCompare(b));
    const yScale = (() => {
      if (yGroupingMode === 'NONE' || yGroupingMode === 'TIMELINE' || !isGalaxy || sortedYGroups.length === 0) return null;
      const yPadding = 0.4;
      const yGroupCount = sortedYGroups.length;
      const baseGap = Math.max(60, height * 0.05);
      const minGap = baseGap * 2;
      const minSpan = height * 0.9;
      const span = Math.max(minSpan, minGap * (Math.max(1, yGroupCount - 1) + 2 * yPadding)) * 0.7;
      const range = [graphCenterY - span / 2, graphCenterY + span / 2];
      return d3.scalePoint().domain(sortedYGroups).range(range).padding(yPadding);
    })();

    const sortedXGroups = isGalaxy ? xGroups.slice().sort((a, b) => a.localeCompare(b)) : [];
    const xGroupScale = (() => {
      if (xAxisMode === 'NONE' || xAxisMode === 'TIMELINE' || !isGalaxy || sortedXGroups.length === 0) return null;
      const xPadding = 0.35;
      const xGroupCount = sortedXGroups.length;
      const baseGap = Math.max(80, width * 0.06);
      const minGap = baseGap * 2;
      const minSpan = width * 0.9;
      const span = Math.max(minSpan, minGap * (Math.max(1, xGroupCount - 1) + 2 * xPadding));
      const range = [-span / 2, span / 2];
      return d3.scalePoint().domain(sortedXGroups).range(range).padding(xPadding);
    })();

    const yTimelineScale = (() => {
      if (yGroupingMode !== 'TIMELINE' || !isGalaxy) return null;
      const years = currentNodes.map(d => isGalaxy ? d.minYear : d.year);
      const minYear = d3.min(years) || 1990;
      const maxYear = d3.max(years) || 2025;
      return d3.scaleLinear().domain([minYear, maxYear]).range([graphCenterY - height * 0.45, graphCenterY + height * 0.45]);
    })();

    if (yScale) {
      const axisX = -width * 0.46;
      const axisGroup = gMain.insert("g", ":first-child")
        .attr("class", "y-axis")
        .attr("transform", `translate(${axisX}, 0)`);

      const axisRange = yScale.range();
      const yMin = Math.min(axisRange[0], axisRange[1]);
      const yMax = Math.max(axisRange[0], axisRange[1]);

      axisGroup.append("line")
        .attr("x1", 0).attr("x2", 0)
        .attr("y1", yMin - 20).attr("y2", yMax + 20)
        .attr("stroke", "#94a3b8")
        .attr("stroke-width", 2)
        .attr("opacity", 0.6);

      const tick = axisGroup.selectAll(".y-axis-tick")
        .data(sortedYGroups, d => d)
        .enter()
        .append("g")
        .attr("class", "y-axis-tick")
        .attr("transform", d => `translate(0, ${yScale(d)})`);

      tick.append("line")
        .attr("x1", -6).attr("x2", 6)
        .attr("y1", 0).attr("y2", 0)
        .attr("stroke", "#64748b")
        .attr("stroke-width", 1.5);

      tick.append("text")
        .attr("x", -12)
        .attr("y", 4)
        .attr("text-anchor", "end")
        .style("fill", "#64748b")
        .style("font-size", "12px")
        .style("font-weight", "600")
        .text(d => d);

      axisGroup.append("text")
        .attr("x", 0)
        .attr("y", yMin - 36)
        .attr("text-anchor", "middle")
        .style("fill", "#475569")
        .style("font-size", "12px")
        .style("font-weight", "700")
        .text(yGroupingMode);
    }

    if (yTimelineScale) {
      const axisX = -width * 0.46;
      const axisGroup = gMain.insert("g", ":first-child")
        .attr("class", "y-axis")
        .attr("transform", `translate(${axisX}, 0)`);

      const axisRange = yTimelineScale.range();
      const yMin = Math.min(axisRange[0], axisRange[1]);
      const yMax = Math.max(axisRange[0], axisRange[1]);

      axisGroup.append("line")
        .attr("x1", 0).attr("x2", 0)
        .attr("y1", yMin - 20).attr("y2", yMax + 20)
        .attr("stroke", "#94a3b8")
        .attr("stroke-width", 2)
        .attr("opacity", 0.6);

      const minYear = Math.floor(yTimelineScale.domain()[0] / 10) * 10;
      const maxYear = Math.ceil(yTimelineScale.domain()[1] / 10) * 10;
      for (let y = minYear; y <= maxYear; y += 10) {
        if (y >= yTimelineScale.domain()[0] - 5 && y <= yTimelineScale.domain()[1] + 5) {
          const yy = yTimelineScale(y);
          axisGroup.append("line")
            .attr("x1", -6).attr("x2", 6)
            .attr("y1", yy).attr("y2", yy)
            .attr("stroke", "#64748b")
            .attr("stroke-width", 1.5);
          axisGroup.append("text")
            .attr("x", -12)
            .attr("y", yy + 4)
            .attr("text-anchor", "end")
            .style("fill", "#64748b")
            .style("font-size", "12px")
            .style("font-weight", "600")
            .text(y);
        }
      }

      axisGroup.append("text")
        .attr("x", 0)
        .attr("y", yMin - 36)
        .attr("text-anchor", "middle")
        .style("fill", "#475569")
        .style("font-size", "12px")
        .style("font-weight", "700")
        .text("TIMELINE");
    }

    if (xGroupScale) {
      const axisY = graphCenterY + height * 0.48;
      const axisGroup = gMain.insert("g", ":first-child")
        .attr("class", "x-axis")
        .attr("transform", `translate(0, ${axisY})`);

      const axisRange = xGroupScale.range();
      const xMin = Math.min(axisRange[0], axisRange[1]);
      const xMax = Math.max(axisRange[0], axisRange[1]);

      axisGroup.append("line")
        .attr("x1", xMin - 30).attr("x2", xMax + 30)
        .attr("y1", 0).attr("y2", 0)
        .attr("stroke", "#94a3b8")
        .attr("stroke-width", 2)
        .attr("opacity", 0.6);

      const tick = axisGroup.selectAll(".x-axis-tick")
        .data(sortedXGroups, d => d)
        .enter()
        .append("g")
        .attr("class", "x-axis-tick")
        .attr("transform", d => `translate(${xGroupScale(d)}, 0)`);

      tick.append("line")
        .attr("x1", 0).attr("x2", 0)
        .attr("y1", -6).attr("y2", 6)
        .attr("stroke", "#64748b")
        .attr("stroke-width", 1.5);

      tick.append("text")
        .attr("x", 0)
        .attr("y", 22)
        .attr("text-anchor", "middle")
        .style("fill", "#64748b")
        .style("font-size", "12px")
        .style("font-weight", "600")
        .text(d => d);

      axisGroup.append("text")
        .attr("x", (xMin + xMax) / 2)
        .attr("y", 40)
        .attr("text-anchor", "middle")
        .style("fill", "#475569")
        .style("font-size", "12px")
        .style("font-weight", "700")
        .text(xAxisMode);
    }

    if (layoutMode === 'TIMELINE' && !isUniverse) {
      // FIX: Re-calculate domain using stable set if needed, or use cached scale
      let timelineScale = timelineXScale;
      let minYear, maxYear;

      if (!timelineScale) {
        let domainNodes = currentNodes;
        if (isGalaxy) {
          // Galaxy view naturally has all currentNodes as the set
        } else if (activeGroup) {
          domainNodes = nodes.filter(n => n.group === activeGroup);
        }
        const years = domainNodes.map(d => isGalaxy ? d.minYear : d.year);
        minYear = d3.min(years) || 1990;
        maxYear = d3.max(years) || 2025;
        timelineScale = d3.scaleLinear().domain([minYear, maxYear]).range([-width * 1.2, width * 1.2]);
      } else {
        [minYear, maxYear] = timelineScale.domain();
      }

      sim.force("x", d3.forceX(d => timelineScale(isGalaxy ? d.minYear : d.year)).strength(0.9));
      sim.force("x-band", null);
      if (yTimelineScale) {
        sim.force("y", d3.forceY(d => yTimelineScale(isGalaxy ? d.minYear : d.year)).strength(0.9));
      } else if (yScale) {
        sim.force("y", d3.forceY(d => yScale(d.yGroup) ?? graphCenterY).strength(0.9));
      } else {
        sim.force("y", d3.forceY(graphCenterY).strength(0.2));
      }
      sim.force("center", null);
      sim.force("radial", null);

      const axisGroup = gMain.insert("g", ":first-child").attr("class", "timeline-axis").attr("transform", `translate(0, ${graphCenterY + height * 0.3})`);
      axisGroup.append("line")
        .attr("x1", timelineScale(minYear) - 50).attr("x2", timelineScale(maxYear) + 50).attr("y1", 0).attr("y2", 0)
        .attr("stroke", "#94a3b8").attr("stroke-width", 2).attr("opacity", 0.5);

      const startDecade = Math.floor(minYear / 10) * 10;
      const endDecade = Math.ceil(maxYear / 10) * 10;
      for (let y = startDecade; y <= endDecade; y += 10) {
        if (y >= minYear - 5 && y <= maxYear + 5) {
          const x = timelineScale(y);
          axisGroup.append("line").attr("x1", x).attr("x2", x).attr("y1", -10).attr("y2", 10).attr("stroke", "#64748b").attr("stroke-width", 2);
          axisGroup.append("text").attr("x", x).attr("y", 30).attr("text-anchor", "middle")
            .style("fill", "#64748b").style("font-size", "14px").style("font-weight", "600").text(y);
        }
      }
    } else {
      sim.force("x", null);
      sim.force("y", null);
      if (layoutChanged && hasCachedTargets) {
        sim.force("center", null);
        sim.force("radial", null);
        sim.force("x", d3.forceX(d => {
          const pos = cachedTargets.get(d.id);
          return pos ? pos.x : 0;
        }).strength(0.7));
        sim.force("y", d3.forceY(d => {
          const pos = cachedTargets.get(d.id);
          return pos ? pos.y : 0;
        }).strength(0.7));
      } else {
        if (!isUniverse) {
          sim.force("center", d3.forceCenter(0, graphCenterY));
        }
        if (isGalaxy) {
          const maxVal = d3.max(currentNodes, n => n.val) || 1;
          sim.force("radial", d3.forceRadial(d => (1 - d.val / maxVal) * 400, 0, 0).strength(0.15));
        } else {
          const maxCites = d3.max(currentNodes, n => n.citationCount) || 1;
          sim.force("radial", d3.forceRadial(d => (1 - d.citationCount / maxCites) * 300, 0, 0).strength(0.25));
        }
      }
      if (yTimelineScale && isGalaxy) {
        sim.force("y-band", d3.forceY(d => yTimelineScale(d.minYear)).strength(0.9));
      } else if (yScale && isGalaxy) {
        sim.force("y-band", d3.forceY(d => yScale(d.yGroup) ?? graphCenterY).strength(0.9));
      } else {
        sim.force("y-band", null);
      }
      if (xGroupScale && isGalaxy) {
        sim.force("x-band", d3.forceX(d => xGroupScale(d.xGroup) ?? 0).strength(0.9));
      } else {
        sim.force("x-band", null);
      }
    }

    const syncPositions = (scale = 1) => {
      gNodes.selectAll(".d3-node")
        .attr("transform", d => `translate(${d.x}, ${d.y}) scale(${scale})`);
      updateLinkPositions();
    };

    const scheduleEdgeReveal = (delayMs, targetOpacity) => {
      edgeRevealPendingRef.current = true;
      // Re-select to ensure we have the latest DOM elements
      const currentLinks = gMain.selectAll(".d3-link");
      currentLinks.attr("opacity", 0).attr("stroke-opacity", 0);

      if (edgeRevealTimeoutRef.current) {
        edgeRevealTimeoutRef.current.stop();
      }
      edgeRevealTimeoutRef.current = d3.timeout(() => {
        currentLinks
          .transition().duration(900).ease(d3.easeQuadOut)
          .attr("opacity", 1)
          .attr("stroke-opacity", targetOpacity);
        edgeRevealPendingRef.current = false;
      }, delayMs);
    };

    if (shouldRunIntro) {
      if (shouldIntro) {
        edgeRevealPendingRef.current = true;
        // Keep them hidden initially
        gLinks.selectAll(".d3-link").interrupt().attr("opacity", 0).attr("stroke-opacity", 0);
      }
      // Ensure we clear previous timeouts to avoid cancellations
      if (edgeRevealTimeoutRef.current) edgeRevealTimeoutRef.current.stop();
      firstDataRenderRef.current = false;
      sim.stop();
      sim.alpha(1);
      sim.alphaDecay(0.03);
      let ticks = 0;
      const maxTicks = 6000;
      // If selected (Topic View), we pre-calculated positions, so we don't need as many ticks to "untangle"
      // But we still want some settling.
      const runTicks = (selected && !isGalaxy) ? 300 : maxTicks;

      while (sim.alpha() > 0.02 && ticks < runTicks) {
        sim.tick();
        ticks += 1;
      }
      if (isUniverse) {
        // Universe nodes: save positions to cache
        currentNodes.forEach(n => {
          groupPositionsMatch.current.set(n.key || n.id, { x: n.x, y: n.y });
        });
      } else if (isGalaxy) {
        currentNodes.forEach(n => groupPositionsMatch.current.set(n.key, { x: n.x, y: n.y }));
      } else {
        currentNodes.forEach(n => nodePositionsCache.current.set(n.id, { x: n.x, y: n.y }));
      }
      {
        const cacheKey = getLayoutCacheKey(layoutMode);
        let cache = layoutPositionCacheRef.current.get(cacheKey);
        if (!cache) {
          cache = new Map();
          layoutPositionCacheRef.current.set(cacheKey, cache);
        }
        currentNodes.forEach(n => cache.set(n.id, { x: n.x, y: n.y }));
      }

      gNodes.selectAll(".d3-node").style("opacity", 0);
      gLinks.selectAll(".d3-link").attr("stroke-opacity", 0);
      syncPositions(introStartScale);

      if (shouldIntro) {
        const introNodes = gNodes.selectAll(".d3-node");
        introNodes
          .transition().duration(900).ease(d3.easeQuadOut)
          .style("opacity", 1)
          .attr("transform", d => `translate(${d.x}, ${d.y}) scale(${introTargetScale})`);
        scheduleEdgeReveal(500, isGalaxy ? 0.55 : 0.9);
        if (isReturningGalaxy) {
          sim.on("tick", () => syncPositions(introTargetScale));
          sim.alpha(0.6).restart();
          const settleTimer = d3.timeout(() => {
            sim.stop();
            sim.on("tick", null);
            syncPositions(introTargetScale);
          }, 900);
          simulationRef.current = sim;
          return () => {
            settleTimer.stop();
            sim.stop();
          };
        }
      } else {
        gNodes.selectAll(".d3-node").style("opacity", 1);
        if (!edgeRevealPendingRef.current) {
          gLinks.selectAll(".d3-link").attr("opacity", 1).attr("stroke-opacity", isGalaxy ? 0.55 : 0.9);
        }
        syncPositions(1);
      }
    } else {
      gNodes.selectAll(".d3-node").style("opacity", 1);
      if (!edgeRevealPendingRef.current) {
        // Force visible if not pending reveal
        gLinks.selectAll(".d3-link")
          .style("opacity", 1) // Ensure style opacity is set
          .attr("opacity", 1)
          .attr("stroke-opacity", isGalaxy ? 0.55 : 0.9);
      }
      syncPositions(1);
    }

    if (shouldAnimateLayout) {
      sim.velocityDecay(0.7);
      sim.alphaDecay(0.02);
      sim.on("tick", () => {
        if (isGalaxy) {
          currentNodes.forEach(n => groupPositionsMatch.current.set(n.key, { x: n.x, y: n.y }));
        } else {
          currentNodes.forEach(n => nodePositionsCache.current.set(n.id, { x: n.x, y: n.y }));
        }
        const cacheKey = getLayoutCacheKey(layoutMode);
        let cache = layoutPositionCacheRef.current.get(cacheKey);
        if (!cache) {
          cache = new Map();
          layoutPositionCacheRef.current.set(cacheKey, cache);
        }
        currentNodes.forEach(n => cache.set(n.id, { x: n.x, y: n.y }));
        syncPositions(1);
      });
      sim.alpha(1).restart();
      const stopTimer = d3.timeout(() => sim.stop(), 1500);
      simulationRef.current = sim;
      prevViewMode.current = viewMode;
      prevLayoutMode.current = layoutMode;
      if (hasRenderableNodes) {
        layoutSignatureRef.current = dataSignature;
      }

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
    prevXAxisModeRef.current = xAxisMode;
    prevYAxisModeRef.current = yGroupingMode;
    prevSelectedIdRef.current = selected?.id || null;
    if (viewMode === 'GALAXY' && returnToGalaxyRef.current) {
      returnToGalaxyRef.current = false;
    }
    if (hasRenderableNodes) {
      layoutSignatureRef.current = dataSignature;
    }

    return () => {
      sim.stop();
    };

  }, [viewMode, groupingMode, yGroupingMode, layoutMode, activeGroup, selected, universeNodes, galaxyNodes, nodes, edges, groupEdges, yGroups, xGroups, colorScale, groupXByKey]);

  // HIGHLIGHTING EFFECT
  useEffect(() => {
    if (!svgRef.current) return;
    if (edgeRevealPendingRef.current) {
      return;
    }

    const svg = d3.select(svgRef.current);
    const node = svg.selectAll(".d3-node");
    const link = svg.selectAll(".d3-link");
    const gradients = svg.select("defs").selectAll(".link-gradient");
    const rect = svg.selectAll(".node-rect");

    if (viewMode === 'UNIVERSE') {
      // Universe view: no edges, simple highlighting
      node.transition().duration(200).style("opacity", 1);
      prevGroupingModeRef.current = groupingMode;
      return;
    }

    if (viewMode === 'GALAXY') {
      const hoveredGroupKey = hovered?.id;
      const getGalaxyEdgeColor = (d) => {
        if (typeof d.source === 'object') {
          return colorScale(d.source.xGroup || d.source.name || d.source.group || d.source.id);
        }
        return colorScale(groupXByKey.get(String(d.source)) || d.source);
      };
      if (!hoveredGroupKey) {
        node.transition().duration(200).style("opacity", 1);
        // FORCE REVEAL: Ensure edges are visible if no reveal is pending
        // We use style to force checking against DOM reality
        if (!edgeRevealPendingRef.current) {
          link.style("opacity", 1);
          link.transition().duration(200).attr("stroke-opacity", 0.55);
        } else {
          // If pending, do nothing to opacity (let intro handle it)
          link.transition().duration(200).attr("stroke-opacity", 0.55);
        }
        gradients.each(function (d) {
          const color = getGalaxyEdgeColor(d);
          const sel = d3.select(this);
          sel.select(".grad-stop-start").attr("stop-color", color).attr("stop-opacity", 0.0);
          sel.select(".grad-stop-mid").attr("stop-color", color).attr("stop-opacity", 0.25);
          sel.select(".grad-stop-end").attr("stop-color", color).attr("stop-opacity", 0.85);
        });
        prevGroupingModeRef.current = groupingMode;
        return;
      }

      link.transition().duration(200)
        .attr("stroke-opacity", d => {
          const s = typeof d.source === 'object' ? d.source.key : d.source;
          const t = typeof d.target === 'object' ? d.target.key : d.target;
          return (s === hoveredGroupKey || t === hoveredGroupKey) ? 0.9 : 0.15;
        });

      gradients.each(function (d) {
        const s = typeof d.source === 'object' ? d.source.key : d.source;
        const t = typeof d.target === 'object' ? d.target.key : d.target;
        const isConnected = s === hoveredGroupKey || t === hoveredGroupKey;
        const color = isConnected ? getGalaxyEdgeColor(d) : "#94a3b8";
        const opacityScale = isConnected ? 1 : 0.3;
        const sel = d3.select(this);
        sel.select(".grad-stop-start").attr("stop-color", color).attr("stop-opacity", 0.0);
        sel.select(".grad-stop-mid").attr("stop-color", color).attr("stop-opacity", 0.2 * opacityScale);
        sel.select(".grad-stop-end").attr("stop-color", color).attr("stop-opacity", 0.7 * opacityScale);
      });

      prevGroupingModeRef.current = groupingMode;
      return;
    }

    if (viewMode !== 'FIELD') {
      node.style("opacity", 1);
      link.attr("stroke-opacity", 0.55);
      prevGroupingModeRef.current = groupingMode;
      return;
    }

    if (selected) {
      const connectedIds = new Set([selected.id]);
      const visibleLinks = link.data();
      visibleLinks.forEach(e => {
        const sourceId = getEdgeId(e.source);
        const targetId = getEdgeId(e.target);
        if (sourceId === selected.id) connectedIds.add(targetId);
        if (targetId === selected.id) connectedIds.add(sourceId);
      });

      // Strict filtering: unconnected nodes are hidden and non-interactive
      node.style("pointer-events", d => connectedIds.has(d.id) || d.id === selected.id ? "auto" : "none")
        .transition().duration(200).style("opacity", d => connectedIds.has(d.id) || d.id === selected.id ? 1 : 0);

      link.transition().duration(200)
        .attr("stroke-opacity", d => {
          const s = getEdgeId(d.source);
          const t = getEdgeId(d.target);
          return (s === selected.id || t === selected.id) ? 1 : 0.05;
        })
        .attr("stroke-width", d => {
          const s = getEdgeId(d.source);
          const t = getEdgeId(d.target);
          return (s === selected.id || t === selected.id) ? 8 : 1;
        });

      gradients.each(function (d) {
        const s = getEdgeId(d.source);
        const t = getEdgeId(d.target);
        const isConnected = s === selected.id || t === selected.id;
        const color = s === selected.id ? EDGE_COLORS.reference : (t === selected.id ? EDGE_COLORS.citation : EDGE_COLORS.default);
        const opacityScale = isConnected ? 1 : 0.15;
        const sel = d3.select(this);
        sel.select(".grad-stop-start").attr("stop-color", color).attr("stop-opacity", 0.0);
        sel.select(".grad-stop-mid").attr("stop-color", color).attr("stop-opacity", 0.4 * opacityScale); // Increased opacity
        sel.select(".grad-stop-end").attr("stop-color", color).attr("stop-opacity", 1.0 * opacityScale); // Increased opacity
      });

      rect.transition().duration(200).attr("stroke", d => d.id === selected.id ? "#0f172a" : "#fff").attr("stroke-width", d => d.id === selected.id ? 4 : 2);
    } else {
      node.transition().duration(200).style("opacity", 1);
      link.transition().duration(200).attr("stroke-opacity", 0.9);
      gradients.each(function (d) {
        const sel = d3.select(this);
        sel.select(".grad-stop-start").attr("stop-color", EDGE_COLORS.default).attr("stop-opacity", 0.0);
        sel.select(".grad-stop-mid").attr("stop-color", EDGE_COLORS.default).attr("stop-opacity", 0.25);
        sel.select(".grad-stop-end").attr("stop-color", EDGE_COLORS.default).attr("stop-opacity", 0.85);
      });
      rect.transition().duration(200).attr("stroke", "#fff").attr("stroke-width", 2);
    }
  }, [selected, hovered, viewMode, groupingMode, colorScale, groupXByKey, xAxisMode, layoutMode, universeNodes, yGroupingMode]);

  const activeGroupLabel = activeGroup ? (groupLabelByKey.get(activeGroup) || activeGroup) : null;

  return (
    <div className="App galaxy-theme" ref={wrapRef}>
      <div className="galaxy-header">
        <div className="controls-row" style={{ display: 'flex', gap: '12px', alignItems: 'center', position: 'absolute', top: 20, left: 20, pointerEvents: 'auto' }}>
          {viewMode === 'GALAXY' && <button className="back-to-galaxy" onClick={handleBackToUniverse}>← Back to Universe</button>}
          {viewMode !== 'GALAXY' && viewMode !== 'UNIVERSE' && <button className="back-to-galaxy" onClick={handleBackToGalaxy}>← Back</button>}

          <div className="control-group">
            <strong style={{ color: '#64748b', fontSize: '0.85rem', marginRight: '5px' }}>LAYOUT</strong>
            <select className="galaxy-select" value={layoutMode} onChange={e => {
              // If in Universe, we map Layout change to internal state or just rely on layoutMode being derived?
              // Actually layoutMode is derived from xAxisMode. So we should change xAxisMode to 'TIMELINE' or 'NONE'
              // But for Universe, 'NONE' means Central (Spiral).
              if (viewMode === 'UNIVERSE') {
                setXAxisMode(e.target.value === 'TIMELINE' ? 'TIMELINE' : 'NONE');
              } else {
                setXAxisMode(e.target.value);
              }
            }} disabled={false}>
              <option value="NONE">Central</option>
              {viewMode !== 'UNIVERSE' && <option value="FIELD">Field</option>}
              {viewMode !== 'UNIVERSE' && <option value="AUTHOR">Author</option>}
              {viewMode !== 'UNIVERSE' && <option value="INSTITUTION">Institution</option>}
              <option value="TIMELINE">Timeline</option>
            </select>
          </div>

          <div className="control-group">
            <strong style={{ color: '#64748b', fontSize: '0.85rem', marginRight: '5px' }}>Y-AXIS</strong>
            <select className="galaxy-select" value={yGroupingMode} onChange={e => setYGroupingMode(e.target.value)} disabled={viewMode === 'UNIVERSE'}>
              <option value="NONE">None</option>
              <option value="FIELD">Field</option>
              <option value="AUTHOR">Author</option>
              <option value="INSTITUTION">Institution</option>
              <option value="TIMELINE">Timeline</option>
            </select>
          </div>

        </div>
        <div className="galaxy-title">
          {viewMode === 'UNIVERSE' ? 'Map of Physics - Universe' :
            viewMode === 'GALAXY' ? `Map of ${groupingMode === 'FIELD' ? 'Physics' : groupingMode + 'S'}` :
              (selected ? selected.title : activeGroupLabel)}
        </div>
      </div>

      <svg ref={svgRef} className="galaxy-canvas" />

      {/* Persistent Footer Panel */}
      <div className="galaxy-footer" style={{ transform: (selected || hovered) ? 'translateY(0)' : 'translateY(0)', opacity: 1, pointerEvents: 'none' }}>
        {(selected || hovered) ? (
          <div className="footer-panels" style={{ pointerEvents: 'auto' }}>
            {/* Menu/Info node content */}
            {(selected?.isMenuNode || hovered?.isMenuNode) && (
              <div className="footer-panel menu-panel" style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '1fr auto', gap: '24px', alignItems: 'start' }}>
                <div>
                  <h4>About This Map</h4>
                  <h3>Map of Physics</h3>
                  <div className="footer-abstract" style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid rgba(0, 0, 0, 0.05)' }}>
                    <p>
                      This interactive map visualizes the landscape of physics research, showing how different areas
                      of physics connect through citations and references. Each galaxy represents a major field of study,
                      containing clusters of related papers. You can zoom in to explore individual papers and their
                      connections, or zoom out to see the broader structure of physics research.
                    </p>
                    <p style={{ marginTop: '12px' }}>
                      <strong>How to use:</strong> Hover over nodes to see details, click to select, and use the mouse
                      wheel or pinch to zoom. Navigate by zooming in on galaxies to explore their contents.
                    </p>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <img
                    src="./Mapo information flow.png"
                    alt="Map of Physics Information Flow"
                    style={{
                      maxWidth: '400px',
                      maxHeight: '300px',
                      width: 'auto',
                      height: 'auto',
                      borderRadius: '8px',
                      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
                      objectFit: 'contain'
                    }}
                  />
                </div>
              </div>
            )}
            {selected && !selected.isMenuNode && (
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
            {hovered && !hovered.isMenuNode && hovered.id !== selected?.id && (
              <div className="footer-panel hover-panel" style={!selected ? { gridColumn: '1 / -1' } : {}}>
                <h4>Hovering</h4>

                {hovered.field === "Galaxy" ? (
                  // Rich Galaxy Metadata
                  <>
                    <h3>{hovered.title}</h3>
                    <div className="footer-meta" style={{ marginBottom: '8px' }}>
                      <strong>{d3.format(",")(hovered.totalWorks || 0)}</strong> known works
                      <span style={{ color: '#94a3b8' }}> • </span>
                      <strong>{d3.format(",")(hovered.groupCount || 0)}</strong> in map
                    </div>

                    {hovered.oldestWork && (
                      <div style={{ fontSize: '0.85rem', marginBottom: '4px' }}>
                        <span style={{ color: '#64748b', fontWeight: 600 }}>First Work ({hovered.oldestWork.year}):</span> <br />
                        {hovered.oldestWork.title}
                      </div>
                    )}

                    {hovered.mostCitedWork && (
                      <div style={{ fontSize: '0.85rem', marginTop: '6px' }}>
                        <span style={{ color: '#64748b', fontWeight: 600 }}>Most Cited ({hovered.mostCitedWork.year}):</span> <br />
                        {hovered.mostCitedWork.title} <span style={{ color: '#f59e0b' }}>({d3.format(",")(hovered.mostCitedWork.citations)} cites)</span>
                      </div>
                    )}

                    {!hovered.hasPapers && (
                      <div style={{ marginTop: '10px', color: '#64748b', fontStyle: 'italic', fontSize: '0.8rem' }}>
                        ℹ️ Detailed paper map pending locally.
                      </div>
                    )}
                  </>
                ) : (
                  // Standard Paper/Group Metadata
                  <>
                    <h3>{hovered.title || hovered.name}</h3>
                    <div className="footer-meta">
                      {hovered.year && <span>{hovered.year} • </span>}
                      <span>{hovered.citationCount} Citations</span>
                      {hovered.groupCount !== undefined && <span> • {hovered.groupCount} Papers</span>}
                    </div>
                    {hovered.authors && <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '5px' }}>{hovered.authors}</div>}
                  </>
                )}
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
