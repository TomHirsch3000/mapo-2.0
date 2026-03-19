
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
  const [viewMode, setViewMode] = useState('UNIVERSE'); // 'UNIVERSE' | 'GALAXY' | 'FIELD' | 'DETAIL' | 'SEARCH'
  const [activeGalaxy, setActiveGalaxy] = useState(null);
  const [activeGroup, setActiveGroup] = useState(null);
  const [selected, setSelected] = useState(null);
  const [hovered, setHovered] = useState(null);

  // --- Search State ---
  const [searchFilter, setSearchFilter] = useState(null); // { query, minCitations, maxPapers }
  const [showSearchPrompt, setShowSearchPrompt] = useState(false);
  const [pendingSearchQuery, setPendingSearchQuery] = useState('');
  const [minSearchCitations, setMinSearchCitations] = useState(0);
  const [maxSearchPapers, setMaxSearchPapers] = useState(50);

  // --- Layout State ---
  const [layout, setLayout] = useState('CENTRAL'); // 'CENTRAL' | 'TIMELINE'
  const [grouping, setGrouping] = useState('FIELD'); // 'FIELD' | 'AUTHOR' | 'INSTITUTION'

  // --- Detail View Context ---
  const [showDetailPrompt, setShowDetailPrompt] = useState(false);
  const [activeDoubleClickPaper, setActiveDoubleClickPaper] = useState(null);
  const [detailFilter, setDetailFilter] = useState(null); // { id, minCitations, maxPapers }
  const [minCitationsInput, setMinCitationsInput] = useState(100);
  const [maxPapersInput, setMaxPapersInput] = useState(500);
  const [showTimeoutPrompt, setShowTimeoutPrompt] = useState(false);

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
  const { nodes, edges, groupStats, xGroups, yGroups, universeData, rawNodes, rawEdges, isLoadingDetail, cancelDetailFetch, searchResult } = useGraphData(viewMode, activeGalaxy, groupingMode, yGroupingMode, activeGroup, selected, detailFilter, setShowTimeoutPrompt, searchFilter);

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

  const handleSearch = (query) => {
    setPendingSearchQuery(query);
    setShowSearchPrompt(true);
  };

  const confirmSearch = () => {
    setShowSearchPrompt(false);
    setSearchFilter({ query: pendingSearchQuery, minCitations: minSearchCitations, maxPapers: maxSearchPapers });
    setViewMode('SEARCH');
    setSelected(null);
  };

  const cancelSearch = () => {
    setShowSearchPrompt(false);
    setPendingSearchQuery('');
  };

  const handleBackFromSearch = () => {
    setViewMode('UNIVERSE');
    setSearchFilter(null);
    setSelected(null);
    setActiveGalaxy(null);
    setActiveGroup(null);
  };

  const handleBackToUniverse = () => {
    isReturningRef.current = true;
    setActiveGalaxy(null);
    setActiveGroup(null);
    setViewMode('UNIVERSE');
    setSearchFilter(null);
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
    } else if (viewMode === 'SEARCH') {
      if (d.isSearchDummy) return; // Dummy node is not selectable
      handlePaperClick(d);
    } else {
      handlePaperClick(d);
    }
  };

  const handleBackgroundClick = () => {
    if (selected) setSelected(null);
  };

  const handleNodeDoubleClick = (paper) => {
    if (viewMode === 'UNIVERSE' || viewMode === 'GALAXY') return;
    if (paper.isSearchDummy) return; // Don't search on the dummy node itself
    // Double-click triggers a topic search using the paper's primary field or title
    const searchTerm = paper.primaryField && paper.primaryField !== 'Unassigned'
      ? paper.primaryField
      : paper.title;
    handleSearch(searchTerm);
  };

  const handleDetailedViewClick = (paper) => {
    if (viewMode === 'UNIVERSE' || viewMode === 'GALAXY') return;
    setActiveDoubleClickPaper(paper);
    setShowDetailPrompt(true);
  };

  const confirmDetailView = () => {
    setShowDetailPrompt(false);
    setDetailFilter({
      id: activeDoubleClickPaper.id,
      minCitations: minCitationsInput,
      maxPapers: maxPapersInput
    });
    setViewMode('DETAIL');
    setSelected(activeDoubleClickPaper);
    setActiveGroup(activeDoubleClickPaper.group);
  };

  const cancelDetailView = () => {
    setShowDetailPrompt(false);
    setActiveDoubleClickPaper(null);
  };

  const handleTimeoutCancel = () => {
    setShowTimeoutPrompt(false);
    cancelDetailFetch();
    setViewMode('FIELD'); // Back to previous view
    setDetailFilter(null);
    setActiveDoubleClickPaper(null);
  };

  const handleTimeoutWait = () => {
    setShowTimeoutPrompt(false);
    // Continue waiting...
  };

  // --- Scales Calculation ---
  const scales = useMemo(() => {
    const width = dimensions.width;
    const height = dimensions.height;
    const graphCenterY = -height * 0.1;

    // For Universe view, domain must be the galaxy group names (e.g. "Quantum & Fundamental") 
    // so that each colour cluster is distinct. xGroups is empty in Universe mode.
    const colorScaleDomain = viewMode === 'UNIVERSE'
      ? [...new Set(nodes.filter(n => !n.isMenuNode).map(n => n.group).filter(Boolean))]
      : xGroups;
    const colorScale = d3.scaleOrdinal(d3.schemeTableau10).domain(colorScaleDomain);

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
        galaxyName={activeGalaxy && universeData ? (universeData.nodes?.find(n => n.id === activeGalaxy)?.name || "Galaxy View") : "Galaxy View"}
        searchQuery={searchFilter?.query || ''}
        onBackToUniverse={handleBackToUniverse}
        onBackToGalaxy={handleBackToGalaxy}
        onBackFromSearch={handleBackFromSearch}
        onLayoutChange={setLayout}
        onGroupingChange={setGrouping}
        onSearch={handleSearch}
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
        onNodeDoubleClick={handleNodeDoubleClick}
        onSearch={handleSearch}

        onNodeHover={setHovered}

        scales={scales}
        isReturning={isReturningRef.current}
        width={dimensions.width}
        height={dimensions.height}
        isLoadingDetail={isLoadingDetail}
      />

      {viewMode === 'SEARCH' && (
        <div style={searchResultsBannerStyle}>
          {isLoadingDetail ? (
            <span style={{ color: '#6366f1' }}>Searching for "{searchFilter?.query}"…</span>
          ) : searchResult?.status === 'error' ? (
            <span style={{ color: '#ef4444' }}>⚠ {searchResult.message}</span>
          ) : searchResult?.status === 'success' ? (
            <>
              <span style={{ color: '#6366f1', fontWeight: 700 }}>{searchResult.stats.core}</span> core
              <span style={dotStyle}>·</span>
              <span style={{ color: '#10b981', fontWeight: 700 }}>{searchResult.stats.foundation}</span> foundation
              <span style={dotStyle}>·</span>
              <span style={{ color: '#f59e0b', fontWeight: 700 }}>{searchResult.stats.impact}</span> impact
              {(searchResult.stats.evidence || 0) > 0 && <>
                <span style={dotStyle}>·</span>
                <span style={{ color: '#22c55e', fontWeight: 700 }}>{searchResult.stats.evidence}</span> experimental evidence
              </>}
              <span style={dotStyle}>·</span>
              <span style={{ color: '#64748b' }}>
                {(searchResult.stats.core || 0) + (searchResult.stats.foundation || 0) + (searchResult.stats.impact || 0) + (searchResult.stats.evidence || 0)} papers total
              </span>
            </>
          ) : null}
        </div>
      )}

      <FooterPanel
        selected={selected}
        hovered={hovered}
        layoutMode={layoutMode}
        onDetailedViewClick={handleDetailedViewClick}
      />

      {(viewMode === 'DETAIL' || viewMode === 'SEARCH') && isLoadingDetail && (
        <div style={modalOverlayStyle}>
          <div style={{ ...modalContentStyle, textAlign: 'center', padding: '40px 30px' }}>
            <div style={spinnerStyle} />
            {viewMode === 'SEARCH' ? (
              <>
                <h3 style={{ margin: '20px 0 8px 0', color: '#1e293b' }}>Searching the Map</h3>
                <p style={{ color: '#64748b', margin: 0, fontSize: '14px' }}>
                  Loading papers across all fields for <strong style={{ color: '#6366f1' }}>"{searchFilter?.query}"</strong>…
                </p>
              </>
            ) : (
              <>
                <h3 style={{ margin: '20px 0 8px 0', color: '#1e293b' }}>Loading Detailed View</h3>
                <p style={{ color: '#64748b', margin: 0, fontSize: '14px' }}>
                  Querying connected papers…
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {showSearchPrompt && (
        <div style={modalOverlayStyle}>
          <div style={modalContentStyle}>
            <h3 style={{ margin: '0 0 4px 0' }}>Search the Map</h3>
            <p style={{ color: '#64748b', fontSize: '14px', margin: '0 0 20px 0' }}>
              Querying the database for papers related to <strong style={{ color: '#6366f1' }}>"{pendingSearchQuery}"</strong>
            </p>
            <label style={labelStyle}>
              Minimum Citations
              <input
                type="number"
                min="0"
                value={minSearchCitations}
                onChange={e => setMinSearchCitations(Number(e.target.value))}
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              Max Core Papers to Return
              <input
                type="number"
                min="1"
                max="200"
                value={maxSearchPapers}
                onChange={e => setMaxSearchPapers(Number(e.target.value))}
                style={inputStyle}
              />
            </label>
            <p style={{ color: '#94a3b8', fontSize: '12px', margin: '12px 0 0 0' }}>
              Foundation &amp; impact papers are discovered automatically from citation links.
            </p>
            <div style={buttonContainerStyle}>
              <button onClick={cancelSearch} style={cancelButtonStyle}>Cancel</button>
              <button onClick={confirmSearch} style={confirmButtonStyle}>Search</button>
            </div>
          </div>
        </div>
      )}

      {showDetailPrompt && (
        <div style={modalOverlayStyle}>
          <div style={modalContentStyle}>
            <h3>Load Detailed Paper View</h3>
            <p>Querying the database for all connected papers...</p>
            <label style={labelStyle}>
              Minimum Citations:
              <input type="number" value={minCitationsInput} onChange={(e) => setMinCitationsInput(Number(e.target.value))} style={inputStyle} />
            </label>
            <label style={labelStyle}>
              Max Papers to Display:
              <input type="number" value={maxPapersInput} onChange={(e) => setMaxPapersInput(Number(e.target.value))} style={inputStyle} />
            </label>
            <div style={buttonContainerStyle}>
              <button onClick={cancelDetailView} style={cancelButtonStyle}>Cancel</button>
              <button onClick={confirmDetailView} style={confirmButtonStyle}>Load</button>
            </div>
          </div>
        </div>
      )}

      {showTimeoutPrompt && (
        <div style={modalOverlayStyle}>
          <div style={modalContentStyle}>
            <h3>Request Taking Longer Than Expected</h3>
            <p>The database query has taken more than 10 seconds. Do you want to keep waiting or cancel the request?</p>
            <div style={buttonContainerStyle}>
              <button onClick={handleTimeoutCancel} style={cancelButtonStyle}>Cancel</button>
              <button onClick={handleTimeoutWait} style={confirmButtonStyle}>Keep Waiting</button>
            </div>
          </div>
        </div>
      )}
    </div >
  );
}

// Simple inline styles for the prototype modals (Light Theme per user request)
const modalOverlayStyle = {
  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
  backgroundColor: 'rgba(255,255,255,0.7)',
  backdropFilter: 'blur(4px)',
  display: 'flex', justifyContent: 'center', alignItems: 'center',
  zIndex: 1000,
};

const modalContentStyle = {
  backgroundColor: '#ffffff', color: '#1e293b',
  padding: '30px', borderRadius: '12px',
  width: '450px', maxWidth: '90%',
  fontFamily: 'Inter, sans-serif',
  boxShadow: '0 10px 40px rgba(0,0,0,0.1)',
  border: '1px solid rgba(0,0,0,0.05)'
};

const labelStyle = {
  display: 'block', margin: '16px 0 8px 0', fontSize: '14px', color: '#64748b', fontWeight: '600'
};

const inputStyle = {
  width: '100%', padding: '10px', marginTop: '4px',
  backgroundColor: '#f8fafc', border: '1px solid #cbd5e1',
  color: '#334155', borderRadius: '6px', boxSizing: 'border-box',
  fontFamily: 'Inter, sans-serif', fontSize: '14px'
};

const buttonContainerStyle = {
  display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '24px'
};

const cancelButtonStyle = {
  padding: '10px 20px', backgroundColor: 'transparent',
  border: '1px solid #cbd5e1', color: '#64748b', borderRadius: '6px', cursor: 'pointer',
  fontWeight: '600', transition: 'all 0.2s'
};

const confirmButtonStyle = {
  padding: '10px 20px', backgroundColor: '#6366f1',
  border: 'none', color: 'white', borderRadius: '6px', cursor: 'pointer',
  fontWeight: 'bold', boxShadow: '0 2px 8px rgba(99, 102, 241, 0.3)', transition: 'all 0.2s'
};

const searchResultsBannerStyle = {
  position: 'fixed',
  top: 72,
  left: '50%',
  transform: 'translateX(-50%)',
  backgroundColor: 'rgba(255,255,255,0.92)',
  backdropFilter: 'blur(8px)',
  border: '1px solid rgba(0,0,0,0.08)',
  borderRadius: '20px',
  padding: '6px 18px',
  fontSize: '13px',
  fontFamily: 'Inter, sans-serif',
  boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
  zIndex: 100,
  pointerEvents: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  whiteSpace: 'nowrap',
};

const dotStyle = {
  color: '#cbd5e1',
  fontSize: '16px',
};

const spinnerStyle = {
  width: '40px', height: '40px',
  border: '3px solid rgba(99, 102, 241, 0.15)',
  borderTopColor: '#6366f1',
  borderRadius: '50%',
  margin: '0 auto',
  animation: 'spin 0.8s linear infinite'
};
