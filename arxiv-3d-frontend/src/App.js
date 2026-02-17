
import React, { useState, useMemo, useRef, useEffect } from "react";
import * as d3 from "d3";
import "./App.css";
import "./styles/Galaxy.css";
import "./styles/Toggle.css";

import { useGraphData } from "./hooks/useGraphData";
import { Graph } from "./components/Graph";
import { ControlPanel } from "./components/ControlPanel";
import { FooterPanel } from "./components/FooterPanel";

export default function App() {
  const wrapRef = useRef(null);
  const [dimensions, setDimensions] = useState({ width: window.innerWidth, height: window.innerHeight });

  // --- Global State ---
  const [viewMode, setViewMode] = useState('UNIVERSE'); // 'UNIVERSE' | 'GALAXY' | 'FIELD' | 'DETAIL'
  const [activeGalaxy, setActiveGalaxy] = useState(null);
  const [activeGroup, setActiveGroup] = useState(null);
  const [selected, setSelected] = useState(null);
  const [hovered, setHovered] = useState(null);

  // --- Layout State ---
  const [layout, setLayout] = useState('CENTRAL'); // 'CENTRAL' | 'TIMELINE'
  const [grouping, setGrouping] = useState('FIELD'); // 'FIELD' | 'AUTHOR' | 'INSTITUTION'

  // Derived Modes mapped to old logic for compatibility during refactor
  // TODO: Update child components to use new props directly
  const xAxisMode = layout === 'TIMELINE' ? 'TIMELINE' : (viewMode === 'GALAXY' ? grouping : 'NONE');
  const yGroupingMode = 'NONE'; // Deprecated for now, can be re-added if Y-axis specific grouping is needed aside from layout

  const layoutMode = layout;
  const groupingMode = grouping;

  // State History for "Back" navigation
  // Layout persistence is now native to the 'layout' state, so we don't need to track previous mode explicitly for restoration
  // unless we want to restore specific layouts per view level. For now, global Layout persistence is requested.
  const isReturningRef = useRef(false);

  // --- Data Hook ---
  const { nodes, edges, groupStats, xGroups, yGroups, universeData, rawNodes, rawEdges } = useGraphData(viewMode, activeGalaxy, groupingMode, yGroupingMode, activeGroup);

  // --- Handlers ---
  const handleGalaxyClick = (galaxyId) => {
    console.log("Galaxy clicked:", galaxyId);
    // Persist Layout: Global 'layout' state is preserved automatically.
    // Default to FIELD grouping if entering Galaxy view? OR keep current?
    // Requirement: "Ensure layout choices persist across transitions."

    // If we are in TIMELINE, stay in TIMELINE. If CENTRAL, stay CENTRAL.
    // Grouping defaults to FIELD on entry? Or keeps last? Let's keep last for now or default to FIELD.
    // setGrouping('FIELD'); // Optional: reset grouping on entry

    setActiveGalaxy(galaxyId);
    setViewMode('GALAXY');
    setActiveGroup(null);
    setSelected(null);
  };

  const handleBackToUniverse = () => {
    isReturningRef.current = true;
    setActiveGalaxy(null);
    setActiveGroup(null);
    setViewMode('UNIVERSE');
    // Layout persists globally, no need to restore from ref
    setSelected(null);
  };

  const handleGroupClick = (groupKey) => {
    console.log("Group clicked:", groupKey);
    setActiveGroup(groupKey);
    setViewMode('FIELD');
    setSelected(null);
  };

  const handleBackToGalaxy = () => {
    isReturningRef.current = true;
    setActiveGroup(null);
    setViewMode('GALAXY');
    setSelected(null);
  };

  const handlePaperClick = (paper) => {
    setSelected(paper);
    if (paper.group) setActiveGroup(paper.group);
  };

  const handleNodeClick = (d) => {
    if (viewMode === 'UNIVERSE') {
      if (d.isMenuNode) return; // Menu node doesn't navigate
      if (d.data?.hasPapers === false) { setSelected(d); return; }
      handleGalaxyClick(d.id);
    } else if (viewMode === 'GALAXY') {
      handleGroupClick(d.key);
    } else {
      handlePaperClick(d);
    }
  };

  const handleBackgroundClick = () => {
    if (selected) setSelected(null);
  };

  // --- Scales Calculation ---
  const scales = useMemo(() => {
    const width = dimensions.width;
    const height = dimensions.height;
    const graphCenterY = -height * 0.1;

    const colorScale = d3.scaleOrdinal(d3.schemeTableau10).domain(xGroups);

    // Universe Timeline Scales
    let universeXScale = null;
    let timelineHeightScale = null;

    if (viewMode === 'UNIVERSE') {
      // Global min/max year across all galaxies
      // We need access to universe nodes from hook - wait, hook returns `nodes` which ARE the universe nodes in UNIVERSE mode
      const allDecades = nodes.flatMap(n => n.data?.worksByDecade?.map(d => d.decade) || []);
      const minYear = d3.min(allDecades) || 1800;
      const maxYear = 2026; // Force end year to 2026 as requested

      universeXScale = d3.scalePow()
        .exponent(3)
        .domain([1900, maxYear])
        .range([-width * 1.2, width * 1.2]); // 3x wider (was 0.4)

      const validNodes = nodes.filter(n => !n.isMenuNode && n.data?.worksByDecade);
      const absMaxWorksSingleDecade = d3.max(validNodes, d => d3.max(d.data.worksByDecade, w => w.works_count) || 0) || 1000;

      timelineHeightScale = d3.scaleLinear()
        .domain([0, absMaxWorksSingleDecade])
        .range([0, 320]); // Increased for bigger nodes
    }

    // Galaxy/Field Scales
    const sortedXGroups = viewMode === 'GALAXY' ? xGroups.slice().sort((a, b) => a.localeCompare(b)) : [];
    const xGroupScale = (() => {
      // In Galaxy Central, X Position is determined by LayoutEngine (Spiral/Force), not a scale. 
      // Only needed if we want columns.
      // If layout is TIMELINE, xGroupScale is not used (UniverseXScale logic applies).

      // Legacy support just in case:
      if (layout === 'TIMELINE' || viewMode !== 'GALAXY' || sortedXGroups.length === 0) return null;

      // If layout is CENTRAL, we might use this for "Grouped" Central? 
      // Actually, Galaxy Central is now specific Spiral. 
      // We'll leave this null for now unless specific column layout is requested.
      return null;

      /* Legacy Code kept for reference if needed for column view:
      const xPadding = 0.35;
      const xGroupCount = sortedXGroups.length;
      const baseGap = Math.max(80, width * 0.06);
      const minGap = baseGap * 2;
      const minSpan = width * 0.9;
      const span = Math.max(minSpan, minGap * (Math.max(1, xGroupCount - 1) + 2 * xPadding));
      return d3.scalePoint().domain(sortedXGroups).range([-span / 2, span / 2]).padding(xPadding);
      */
    })();

    const yTimelineScale = (() => {
      // Stream layout logic will handle this in LayoutEngine, but we might need a scale helper?
      // For now, return null and let LayoutEngine handle relative Y positioning.
      if (layout !== 'TIMELINE' || viewMode !== 'GALAXY') return null;
      // We might want a scale for "Centering" the stream?
      return null;

      /* Legacy:
     if (yGroupingMode !== 'TIMELINE' || viewMode !== 'GALAXY') return null;
     const years = nodes.map(d => d.minYear);
     const minYear = d3.min(years) || 1990;
     const maxYear = d3.max(years) || 2025;
     return d3.scaleLinear().domain([minYear, maxYear]).range([graphCenterY - height * 0.45, graphCenterY + height * 0.45]);
     */
    })();

    const yScale = (() => {
      return null; // Not used in new spec (Stream / Spiral)
      /*
      if (yGroupingMode === 'NONE' || yGroupingMode === 'TIMELINE' || viewMode !== 'GALAXY' || yGroups.length === 0) return null;
      // ... logic for y groups scale ... 
      // Simplified for brevity, reusing same logic structure
      return d3.scalePoint().domain(yGroups).range([graphCenterY - height * 0.4, graphCenterY + height * 0.4]).padding(0.4);
      */
    })();

    return {
      colorScale,
      universeXScale,
      timelineHeightScale,
      xGroupScale,
      yTimelineScale,
      yScale
    };
  }, [dimensions, xGroups, yGroups, nodes, layout, grouping, viewMode]);

  // --- Resize Listener ---
  useEffect(() => {
    const handleResize = () => setDimensions({ width: wrapRef.current.clientWidth, height: wrapRef.current.clientHeight });
    window.addEventListener('resize', handleResize);
    // Initial size
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div className="App galaxy-theme" ref={wrapRef}>
      <ControlPanel
        viewMode={viewMode}
        layout={layout}
        grouping={grouping}
        selected={selected}
        activeGroupLabel={activeGroup} // Simplified label
        galaxyName={activeGalaxy ? (nodes.find(n => n.id === activeGalaxy)?.name || "Galaxy View") : "Galaxy View"}
        onBackToUniverse={handleBackToUniverse}
        onBackToGalaxy={handleBackToGalaxy}
        onLayoutChange={setLayout}
        onGroupingChange={setGrouping}
      />

      <Graph
        nodes={nodes}
        edges={edges}
        viewMode={viewMode}
        layoutMode={layoutMode}
        groupingMode={groupingMode}
        activeGroup={activeGroup}
        selected={selected}
        hovered={hovered}

        onNodeClick={handleNodeClick}
        onGalaxyClick={handleGalaxyClick}
        onGroupClick={handleGroupClick}
        onBackgroundClick={handleBackgroundClick}

        onNodeHover={setHovered}

        scales={scales}
        isReturning={isReturningRef.current}
        width={dimensions.width}
        height={dimensions.height}
      />

      <FooterPanel
        selected={selected}
        hovered={hovered}
        layoutMode={layoutMode}
      />
    </div >
  );
}
