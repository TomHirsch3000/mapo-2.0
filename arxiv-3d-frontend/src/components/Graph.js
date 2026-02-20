
import React, { useEffect, useRef, useMemo, useState } from 'react';
import * as d3 from 'd3';
import { roundedHexagonPath, getDeterministicPoint, hashString, EDGE_COLORS, getEdgeId, sanitizeId, generateHexPositions } from '../utils/d3-helpers';
import { LayoutEngine } from '../modules/LayoutEngine';

export const Graph = ({
    nodes,
    edges,
    viewMode,
    layoutMode,
    groupingMode,
    activeGroup,
    selected,
    hovered,
    onNodeClick,
    onNodeHover,
    onBackgroundClick,
    onGalaxyClick,
    onGroupClick,
    onBackToUniverse,
    onBackToGalaxy,
    scales, // { xScale, yScale, xGroupScale, yTimelineScale, universeXScale, timelineHeightScale }
    isReturning,
    width,
    height
}) => {
    const svgRef = useRef(null);
    const layoutEngine = useRef(new LayoutEngine(width, height));

    // Internal Refs for D3 State
    const simulationRef = useRef(null);
    const nodePositionsCache = useRef(new Map());
    const groupPositionsMatch = useRef(new Map());
    const layoutPositionCacheRef = useRef(new Map());
    // Ref to track if we are currently handling a view transition to prevent ghosting
    const isTransitioningView = useRef(false);

    // Previous State Refs
    const prevViewMode = useRef(viewMode);
    const prevLayoutMode = useRef(layoutMode);
    const prevSelectedIdRef = useRef(null);
    const edgeRevealTimeoutRef = useRef(null);
    const edgeRevealPendingRef = useRef(false);
    const firstDataRenderRef = useRef(true);

    // Callbacks Ref (to avoid re-running effect on handler change)
    const handlersRef = useRef({ onNodeClick, onNodeHover, onBackgroundClick, onGalaxyClick, onGroupClick });
    handlersRef.current = { onNodeClick, onNodeHover, onBackgroundClick, onGalaxyClick, onGroupClick };

    // Update Layout Engine dimensions
    useEffect(() => {
        layoutEngine.current.updateDimensions(width, height);
    }, [width, height]);


    // --- MAIN RENDER EFFECT ---
    useEffect(() => {
        isTransitioningView.current = false;
        if (!svgRef.current || !width || !height) return;

        const svg = d3.select(svgRef.current);
        const isUniverse = viewMode === 'UNIVERSE';
        const isGalaxy = viewMode === 'GALAXY';
        const isField = viewMode === 'FIELD';

        // --- DATA PREP ---
        const currentNodes = nodes.map(n => ({ ...n })); // Shallow copy to prevent mutation issues between runs/views if needed, though d3 mutates inplace usually fine if we reset
        const currentEdges = edges.map(e => ({ ...e })); // Same for edges

        // --- PRE-CALCULATE DIMENSIONS (FIELD VIEW) ---
        // Ensure dimensions are available BEFORE simulation runs
        if (isField) {
            currentNodes.forEach(n => {
                const cites = n.citationCount || 0;
                // Sizing based on citations (Square root scale for better distribution)
                // Min width 80px, grows with citations.
                // Example: 0 cites = 80px, 100 cites = 80 + 10*3 = 110px, 1000 cites = 80 + 31*3 = 173px
                n._w = 80 + Math.sqrt(cites) * 3;
                // Height allows for title wrapping. Base 50px.
                n._h = 50 + Math.sqrt(cites) * 1.5;
            });
        }

        // --- SETUP GROUPS ---
        let gMain = svg.select(".g-main");
        if (gMain.empty()) {
            const gRoot = svg.append("g");
            gMain = gRoot.append("g").attr("class", "g-main");
        }

        let gLinks = gMain.select(".g-links");
        if (gLinks.empty()) gLinks = gMain.append("g").attr("class", "g-links");

        let gAxisLayer = gMain.select(".g-axis-layer");
        if (gAxisLayer.empty()) gAxisLayer = gMain.append("g").attr("class", "g-axis-layer");

        let gNodes = gMain.select(".g-nodes");
        if (gNodes.empty()) gNodes = gMain.append("g").attr("class", "g-nodes");

        // Correct Z-Order
        gAxisLayer.lower();
        gLinks.lower();
        gNodes.raise();

        // --- ZOOM BEHAVIOR ---
        const zoom = d3.zoom()
            .scaleExtent([0.01, 8]) // Allow zooming out far for auto-fit
            .on("zoom", (event) => {
                gMain.attr("transform", event.transform);
                if (isTransitioningView.current) return;
            });

        svg.call(zoom);
        svg.on("click.unselect", (event) => {
            if (event.target.tagName === 'svg') onBackgroundClick();
        });


        // --- LAYOUT SIMULATION (HYBRID APPROACH) ---
        if (simulationRef.current) simulationRef.current.stop();

        // 1. CLEAR PREVIOUS STATE if View Changed OR Layout Changed
        if (prevViewMode.current !== viewMode || prevLayoutMode.current !== layoutMode) {
            gLinks.selectAll("*").remove();
            gNodes.selectAll("*").interrupt().remove();
            // Reset opacity to hidden for Fly-in
            gNodes.style("opacity", 0);
            gLinks.style("opacity", 0);
        }

        const sim = d3.forceSimulation(currentNodes);

        // 2. CONFIG SIMULATION
        if (isUniverse) {
            if (layoutMode === 'TIMELINE') {
                layoutEngine.current.applyUniverseTimelineLayout(currentNodes, sim, scales.universeXScale, scales.timelineHeightScale);
            } else {
                layoutEngine.current.applyUniverseCentralLayout(currentNodes, sim);
            }
        } else if (isGalaxy) {
            layoutEngine.current.applyGalaxyLayout(currentNodes, currentEdges, sim, layoutMode, scales);
        } else {
            layoutEngine.current.applyFieldLayout(currentNodes, currentEdges, sim, selected, layoutMode, scales);
        }

        // 3. EXECUTE DRY RUN (The "Function")
        // If Galaxy/Field View, we run it visibly? NO, we want it pre-calculated.
        const DRY_RUN_TICKS = (isGalaxy || isField) ? 300 : 120;

        sim.stop(); // Don't run timer yet
        sim.alpha(1);
        for (let i = 0; i < DRY_RUN_TICKS; ++i) {
            sim.tick();
        }

        // 4. RENDER (Now nodes have final x,y)

        // D3 JOIN - Links
        // Filter edges for rendering (Galaxy uses gradients)
        const getEdgeKey = (d) => `${(isGalaxy || isField) ? "G" : "P"}|${d.source.id || d.source}|${d.target.id || d.target}`;
        const getGradientId = (d) => `link-gradient-${sanitizeId(getEdgeKey(d))}`;
        const defs = svg.select("defs").empty() ? svg.append("defs") : svg.select("defs");

        // Links Update
        // Note: For Galaxy, we curved them in tick(), but now tick is done.
        // We calculate paths ONCE here based on final positions.
        const updateLinkPaths = (s) => {
            s.attr("d", d => {
                const src = d.source;
                const tgt = d.target;

                if (isGalaxy) {
                    // Curve Logic from prev implementation
                    const dx = tgt.x - src.x;
                    const dy = tgt.y - src.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist === 0) return `M${src.x},${src.y} L${tgt.x},${tgt.y}`;
                    const curvature = 0.2;
                    const offset = dist * curvature;
                    const midX = (src.x + tgt.x) / 2;
                    const midY = (src.y + tgt.y) / 2;
                    // Normal vector
                    const nx = -dy / dist;
                    const ny = dx / dist;
                    const cx = midX + nx * offset;
                    const cy = midY + ny * offset;
                    return `M${src.x},${src.y} Q${cx},${cy} ${tgt.x},${tgt.y}`;
                } else if (isField) {
                    // Tapered Curved Edge Logic
                    // Source (Citing) -> Target (Cited)
                    // Narrow -> Wide
                    const dx = tgt.x - src.x;
                    const dy = tgt.y - src.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist === 0) return "";

                    // 1. Calculate Control Point (Same as Galaxy for consistency)
                    const curvature = 0.2;
                    const offset = dist * curvature;
                    const midX = (src.x + tgt.x) / 2;
                    const midY = (src.y + tgt.y) / 2;

                    // Chord Normal
                    const nx = -dy / dist;
                    const ny = dx / dist;

                    const cx = midX + nx * offset;
                    const cy = midY + ny * offset;

                    // 2. Define Widths
                    const wStart = 2;  // Citing (Narrow)
                    const wEnd = 8;   // Cited (Wide)

                    // 3. Vector Math for Offsets
                    // To get smooth tapering, we need normals at specific points on the curve:
                    // Start Normal (perp to S->C)
                    const dx1 = cx - src.x;
                    const dy1 = cy - src.y;
                    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1) || 1;
                    const nx1 = -dy1 / len1;
                    const ny1 = dx1 / len1;

                    // End Normal (perp to C->T)
                    const dx2 = tgt.x - cx;
                    const dy2 = tgt.y - cy;
                    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1;
                    const nx2 = -dy2 / len2;
                    const ny2 = dx2 / len2;

                    // Control Normal (Approximate as Chord Normal or average of start/end normals)
                    // Using Chord Normal (nx, ny) is usually sufficient for symmetric curves

                    // 4. Calculate Offset Points
                    // Start Points
                    const s1x = src.x + nx1 * (wStart / 2);
                    const s1y = src.y + ny1 * (wStart / 2);
                    const s2x = src.x - nx1 * (wStart / 2);
                    const s2y = src.y - ny1 * (wStart / 2);

                    // End Points
                    const t1x = tgt.x + nx2 * (wEnd / 2);
                    const t1y = tgt.y + ny2 * (wEnd / 2);
                    const t2x = tgt.x - nx2 * (wEnd / 2);
                    const t2y = tgt.y - ny2 * (wEnd / 2);

                    // Control Points for the Outer/Inner Curves
                    // We offset the main control point. 
                    // The width at the control point (t=0.5) is approx (wStart + wEnd)/2
                    const wMid = (wStart + wEnd) / 2;
                    // Use chord normal for control point offset direction
                    const c1x = cx + nx * (wMid / 2);
                    const c1y = cy + ny * (wMid / 2);
                    const c2x = cx - nx * (wMid / 2);
                    const c2y = cy - ny * (wMid / 2);

                    // 5. Build Path
                    // Move to Start1 -> Quad to End1 -> Line to End2 -> Quad to Start2 -> Close
                    return `M${s1x},${s1y} Q${c1x},${c1y} ${t1x},${t1y} L${t2x},${t2y} Q${c2x},${c2y} ${s2x},${s2y} Z`;
                } else {
                    return `M${src.x},${src.y} L${tgt.x},${tgt.y}`;
                }
            });
            // Update Gradients for Galaxy
            if (isGalaxy) {
                defs.selectAll(".link-gradient")
                    .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
                    .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
            }
        };

        const linkJoin = gLinks.selectAll(".d3-link").data(currentEdges, getEdgeKey);
        linkJoin.exit().remove();
        const linkEnter = linkJoin.enter().append("path")
            .attr("class", `d3-link ${(isGalaxy || isField) ? 'type-galaxy-link' : 'type-paper-link'}`)
            .attr("fill", isField ? "#999" : "none") // Fill provided by styles or update loop. Field needs fill for tapered shape.
            .attr("stroke-linecap", "round");

        const allLinks = linkEnter.merge(linkJoin);

        // Gradients (Galaxy & Field)
        if (isGalaxy || isField) {
            allLinks.each(function (d) {
                const id = getGradientId(d);
                let grad = defs.select(`#${id}`);
                if (grad.empty()) {
                    grad = defs.append("linearGradient").attr("id", id).attr("gradientUnits", "userSpaceOnUse");
                    grad.append("stop").attr("offset", "0%").attr("class", "grad-stop-start");
                    grad.append("stop").attr("offset", "100%").attr("class", "grad-stop-end");
                }
                const srcNode = currentNodes.find(n => n.id === (d.source.id || d.source));
                const tgtNode = currentNodes.find(n => n.id === (d.target.id || d.target));
                const cScale = scales.colorScale || d3.scaleOrdinal(d3.schemeTableau10);

                // For Field view, use field color or xGroup
                const srcColor = srcNode ? (srcNode.groupColor || cScale(srcNode.xGroup || srcNode.id)) : "#ccc";
                const tgtColor = tgtNode ? (tgtNode.groupColor || cScale(tgtNode.xGroup || tgtNode.id)) : "#ccc";

                grad.select(".grad-stop-start").attr("stop-color", srcColor).attr("stop-opacity", isField ? 0.8 : 0.6);
                grad.select(".grad-stop-end").attr("stop-color", tgtColor).attr("stop-opacity", isField ? 0.2 : 0.6);

                if (isField) {
                    // For tapered wedge, we fill the shape with the gradient
                    d3.select(this).attr("fill", `url(#${id})`).attr("stroke", "none");
                } else {
                    d3.select(this).attr("stroke", `url(#${id})`).attr("fill", "none");
                }
            });
        }

        updateLinkPaths(allLinks); // Set final paths immediately
        allLinks.attr("stroke-width", d => (isGalaxy || isField) ? Math.max(2, Math.sqrt(d.weight || 1)) : 1)
            .attr("stroke-opacity", 0); // Start hidden for fly-in

        // D3 JOIN - Nodes
        const nodeJoin = gNodes.selectAll(".d3-node").data(currentNodes, d => d.id);
        nodeJoin.exit().remove();

        const nodeEnter = nodeJoin.enter().append("g")
            .attr("class", "d3-node")
            .attr("cursor", "pointer")
            .on("click", (e, d) => { e.stopPropagation(); onNodeClick(d); })
            .on("mouseover", (e, d) => onNodeHover(d))
            .on("mouseout", (e, d) => onNodeHover(null));

        // Append Shapes (Same as before)
        nodeEnter.each(function (d) {
            const el = d3.select(this);
            if (isUniverse && !d.isMenuNode) {
                el.append("path").attr("class", "orbit");
                el.append("path").attr("class", "core");
            } else if (isGalaxy) {
                // Check if Galaxy Timeline
                if (layoutMode === 'TIMELINE') {
                    // Timeline Rect
                    // Use 'rect' for strict rectangle
                    el.append("rect").attr("class", "orbit");
                    // Core unused or maybe a marker?
                    el.append("rect").attr("class", "core").attr("display", "none");
                } else {
                    el.append("circle").attr("class", "orbit");
                    el.append("circle").attr("class", "core");
                }

            } else if (isField) {
                // Topic/Field View (Papers)
                const width = d._w || 80;
                const height = d._h || 50;

                el.append("rect")
                    .attr("class", "node-paper-card")
                    .attr("x", -width / 2)
                    .attr("y", -height / 2)
                    .attr("width", width)
                    .attr("height", height);

                const fo = el.append("foreignObject")
                    .attr("class", "node-fo-wrapper")
                    .attr("x", -width / 2)
                    .attr("y", -height / 2)
                    .attr("width", width)
                    .attr("height", height);

                fo.append("xhtml:div")
                    .attr("class", "node-paper-content")
                    // Inline styles to force wrapping logic if CSS fails
                    .style("width", "100%")
                    .style("height", "100%")
                    .style("display", "flex")
                    .style("align-items", "center")
                    .style("justify-content", "center")
                    .style("text-align", "center")
                    .style("overflow", "hidden")
                    .style("padding", "4px")
                    .style("box-sizing", "border-box")
                    .html(d => `<div class="node-paper-title" style="width: 100%; word-wrap: break-word; overflow-wrap: break-word; white-space: normal; line-height: 1.2; text-align: center;">${d.title || d.name || 'Untitled'}</div>`);


            } else {
                // Field (Fallback or Universe non-menu nodes not covered above?? Actually Universe covered in first block)
                // This block was originally labelled "Field" but might have been Galaxy? 
                // Let's assume this handles unknown types.
                el.append("rect").attr("class", "node-rect").attr("rx", 6);
                el.append("foreignObject").attr("class", "fo-content").append("xhtml:div").attr("class", "node-fo");
            }
            el.append("text").attr("class", "label-main");
            el.append("text").attr("class", "label-sub");
            if (isUniverse) el.append("text").attr("class", "label-right");
        });

        const allNodes = nodeEnter.merge(nodeJoin);

        // Position Nodes Immediately
        allNodes.attr("transform", d => `translate(${d.x}, ${d.y})`);

        // Node Visuals (Colors/Sizes)
        const cScale = scales.colorScale || d3.scaleOrdinal(d3.schemeTableau10);
        allNodes.each(function (d) {
            const el = d3.select(this);
            // ... Apply Styles ...
            if (isGalaxy) {
                if (layoutMode === 'TIMELINE') {
                    const width = d._layoutWidth || 30;
                    const height = d._layoutHeight || 14;

                    // Position rect centered at 0,0 via x,y offset
                    // width/height applied to rect
                    el.select(".orbit")
                        .attr("x", -width / 2)
                        .attr("y", -height / 2)
                        .attr("width", width)
                        .attr("height", height)
                        .attr("rx", 6) // Rounded corners for timeline blocks
                        .attr("fill", cScale(d.xGroup))
                        .attr("fill-opacity", 0.6)
                        .attr("stroke", "none")
                        .attr("r", null); // Remove radius from previous circle

                    // Label above center
                    el.select(".label-main")
                        .text((d.name || "").substring(0, 30))
                        .attr("x", 0)
                        .attr("y", -height / 2 - 5)
                        .attr("dy", 0)
                        .attr("text-anchor", "middle")
                        .style("font-size", "14px") // Smaller font for dense timeline
                        .style("fill", "#64748b")
                        .style("pointer-events", "none");

                    el.select(".label-sub").text(""); // No sub-label needed for now

                } else {
                    const val = d.val || 20;
                    const radius = val * 0.16;
                    el.select(".orbit").attr("r", radius).attr("fill", cScale(d.xGroup)).attr("fill-opacity", 0.15)
                        .attr("width", null).attr("height", null); // Clear rect attrs
                    el.select(".core").attr("r", radius * 0.6).attr("fill", cScale(d.xGroup));
                    el.select(".label-main").text((d.name || "").substring(0, 25)).attr("dy", radius + 25).style("font-size", "28px");
                    el.select(".label-sub").text(d.nodeCount ? `${d.nodeCount} papers` : "").attr("dy", radius + 45);
                }
            } else if (isUniverse) {
                const val = d.val || 20;
                if (!d.isMenuNode) {
                    if (layoutMode === 'TIMELINE' && d.data?.worksByDecade && scales.universeXScale) {
                        // --- AREA CHART RENDERING ---
                        // Clear previous shapes if any (transitioning from Central)
                        el.select(".orbit").attr("d", null).attr("r", null);
                        el.select(".core").attr("d", null).attr("r", null);

                        const height = d._height || 60; // Default if missing
                        const halfH = height / 2;

                        // PROJECTION LOGIC:
                        // Scale up the last data point (2020) assuming significant growth.
                        // User feedback: "scale it back down to 2x".
                        const projectionFactor = 2.0;
                        const dataForChart = d.data.worksByDecade.map(w => {
                            if (w.decade === 2020) {
                                return { ...w, works_count: w.works_count * projectionFactor };
                            }
                            return w;
                        });

                        const maxWorks = d3.max(dataForChart, w => w.works_count) || 1;
                        const yScaleLocal = d3.scaleLinear()
                            .domain([0, maxWorks])
                            .range([0, height - 10]); // -10 padding

                        // Symmetric Area (Streamgraph)
                        const areaGenerator = d3.area()
                            .x(D => scales.universeXScale(D.decade))
                            .y0(D => -yScaleLocal(D.works_count) / 2)
                            .y1(D => yScaleLocal(D.works_count) / 2)
                            .curve(d3.curveMonotoneX);

                        // We use the .orbit path for the area
                        el.select(".orbit")
                            .attr("d", areaGenerator(dataForChart)) // Use projected data for shape
                            .attr("fill", cScale(d.id))
                            .attr("fill-opacity", 0.6)
                            .attr("stroke", "none");

                        // Hide core for area view
                        el.select(".core").attr("d", null).attr("r", 0);

                        // Position Label
                        // Move to Right side of node
                        // Calculate X position based on max year (2020/2025)
                        const lastYearX = scales.universeXScale(2020);

                        el.select(".label-main")
                            .text(d.name)
                            .attr("x", lastYearX + 20)
                            .attr("y", 0)
                            .attr("dx", 0)
                            .attr("dy", 5)
                            .attr("text-anchor", "start")
                            .style("font-size", "18px") // Increased to 18px
                            .style("font-weight", "500")
                            .style("fill", "#334155");

                    } else {
                        // --- HEXAGON RENDERING (Central) ---
                        // Ensure class is correct for shimmer (uses .orbit)
                        el.select(".orbit")
                            .attr("d", roundedHexagonPath(val * 2.5))
                            .attr("fill", cScale(d.id)) // Fill with node color
                            .attr("fill-opacity", 0.4)  // Increased opacity for body visibility
                            .attr("stroke", "#475569")
                            .attr("stroke-width", 12);

                        el.select(".core")
                            .attr("d", roundedHexagonPath(val * 0.8))
                            .attr("r", null)
                            .attr("fill", cScale(d.id))
                            .style("filter", "blur(1px)");

                        // Label inside the bottom of the hexagon
                        // "inside the boarder" -> Move up more
                        el.select(".label-main")
                            .text(d.name)
                            .attr("x", 0)
                            .attr("y", 0)
                            .attr("dx", 0)
                            .attr("dy", val * 2.5 - 45) // Moved up significantly (was -25)
                            .attr("text-anchor", "middle")
                            .style("font-size", "22px")
                            .style("fill", "#1e293b"); // Ensure contrast
                    }
                } else {
                    el.select(".orbit").attr("r", val * 2.5);
                }
            } else if (isField) {
                // Field View Styling
                // Use pre-calculated dimensions
                const width = d._w || 80;
                const height = d._h || 50;

                el.select(".node-paper-card")
                    .attr("x", -width / 2)
                    .attr("y", -height / 2)
                    .attr("width", width)
                    .attr("height", height)
                    .attr("fill", cScale(d.xGroup || d.field)) // Color by field
                    .attr("fill-opacity", 0.2) // Light background
                    .style("stroke", cScale(d.xGroup || d.field)) // Border color by field
                    .style("stroke-width", 2);

                el.select(".node-fo-wrapper")
                    .attr("x", -width / 2)
                    .attr("y", -height / 2)
                    .attr("width", width)
                    .attr("height", height);

                // Adjust font size based on size?
                // Larger cards can have slightly larger fonts, but keep it readable
                el.select(".node-paper-title")
                    .style("font-size", `${Math.min(12, Math.max(9, width / 12))}px`)
                    .style("width", "100%") // Ensure it takes full width for centering
                    .style("word-wrap", "break-word")
                    .style("white-space", "normal")
                    .style("text-align", "center")
                    .style("overflow-wrap", "anywhere"); // Break long words if needed
            }
        });



        // --- AXIS RENDERING (Timeline) ---
        if ((isUniverse || isGalaxy || isField) && layoutMode === 'TIMELINE') {
            // Determine scale
            let xAxisScale = null;
            if (isUniverse) {
                xAxisScale = scales.universeXScale;
            } else if (isGalaxy) {
                // Galaxy Timeline Scale (Calculated locally if not passed)
                // LayoutEngine calculated it, but we need it here for rendering.
                // Re-calculate based on currentNodes (safe enough for display)
                const minYear = d3.min(currentNodes, d => d.minYear) || 1990;
                const maxYear = d3.max(currentNodes, d => d.maxYear || d.minYear) || 2025;
                const padding = width * 0.05; // Matches LayoutEngine padding
                const effectiveWidth = width - (padding * 2);
                xAxisScale = d3.scaleLinear().domain([minYear, maxYear]).range([-effectiveWidth / 2, effectiveWidth / 2]);
            } else if (isField) {
                // Topic/Field Scale mapping the wider range from LayoutEngine
                const minYear = d3.min(currentNodes, d => d.year) || 1990;
                const maxYear = d3.max(currentNodes, d => d.year) || 2025;
                xAxisScale = d3.scaleLinear().domain([minYear, maxYear]).range([-width * 0.8, width * 0.8]);
            }

            if (xAxisScale) {
                const axisBottom = d3.axisBottom(xAxisScale).tickFormat(d3.format("d")).ticks(10); // Decades/Years

                // Dynamically position the axis below the elements based on Y extent
                const yExtent = d3.extent(currentNodes, d => d.y);
                const lowestY = (yExtent[1] !== undefined && !isNaN(yExtent[1])) ? yExtent[1] : (height / 2 - 40);
                // Add a small buffer (e.g., 60px) below the lowest node edge
                const axisY = isUniverse ? (height / 2 - 40) : (lowestY + 60);

                gAxisLayer.attr("transform", `translate(0, ${axisY})`)
                    .style("opacity", 1)
                    .call(axisBottom);

                gAxisLayer.selectAll("text").style("fill", "#64748b").style("font-size", "18px"); // Larger Timeline Font
                gAxisLayer.selectAll("line").style("stroke", "#cbd5e1");
                gAxisLayer.selectAll("path").style("stroke", "#cbd5e1");
            }
        } else {
            gAxisLayer.style("opacity", 0);
        }

        // 5. ANIMATION SEQUENCE (Fly-in)
        if (prevViewMode.current !== viewMode && (viewMode === 'GALAXY' || viewMode === 'FIELD')) {

            // A. "Blank Screen" / Start State
            // Already set opacity 0 above.
            gNodes.style("opacity", 1); // Make container visible
            // Scale nodes to 0
            allNodes.attr("transform", d => `translate(${d.x}, ${d.y}) scale(0)`);

            // B. Camera Auto-Fit
            // Calculate bounds of the new layout
            const xExtent = d3.extent(currentNodes, d => d.x);
            const yExtent = d3.extent(currentNodes, d => d.y);
            const padding = 100;
            if (xExtent[0] !== undefined && yExtent[0] !== undefined) {
                const gw = xExtent[1] - xExtent[0];
                const gh = yExtent[1] - yExtent[0];
                const scale = Math.min(width / (gw + padding * 2), height / (gh + padding * 2), 2); // Max scale 2
                const cx = (xExtent[0] + xExtent[1]) / 2;
                const cy = (yExtent[0] + yExtent[1]) / 2;

                // Animate Camera
                svg.transition().duration(1000).call(
                    zoom.transform,
                    d3.zoomIdentity.translate(width / 2, height / 2).scale(scale).translate(-cx, -cy)
                );
            }

            // C. Fly-In Animation
            allNodes.transition("flyin").duration(800).ease(d3.easeBackOut.overshoot(0.8))
                .attr("transform", d => `translate(${d.x}, ${d.y}) scale(1)`);

            // D. Reveal Links & Labels
            gLinks.transition("flyin-links").delay(600).duration(500).style("opacity", 1);
            allLinks.transition("flyin-links-stroke").delay(600).duration(500).attr("stroke-opacity", 0.6);

        } else {
            // No transition (e.g. initial load or same view), just show
            gNodes.style("opacity", 1);
            gLinks.style("opacity", 1);
            allLinks.attr("stroke-opacity", 0.6);
        }

        // Update Refs
        prevViewMode.current = viewMode;
        prevLayoutMode.current = layoutMode;

        // We DON'T restart the simulation here. It's done. 
        // Unless it's universe/field where we might want some drift? 
        // User requested "no visible settling". Static is better.
        // If we want interactivity (dragging), we can restart it on drag.

        simulationRef.current = sim;

    }, [nodes, edges, viewMode, layoutMode, groupingMode, activeGroup, selected, width, height, scales]);

    // --- VISUAL HIGHLIGHT EFFECT (Hover & Selection) ---
    useEffect(() => {
        if (!svgRef.current) return;
        const svg = d3.select(svgRef.current);
        const isGalaxy = viewMode === 'GALAXY';
        const isField = viewMode === 'FIELD';
        const isUniverseTimeline = viewMode === 'UNIVERSE' && layoutMode === 'TIMELINE';
        const isUniverseCentral = viewMode === 'UNIVERSE' && layoutMode === 'CENTRAL';

        if (isGalaxy || isField || isUniverseTimeline || isUniverseCentral) {
            const gLinks = svg.select(".g-links");
            const gNodes = svg.select(".g-nodes");
            const currentEdges = edges;

            // Determine Focus Object (Hover takes precedence, then Selection in Field/Detail modes)
            const focusNode = hovered || ((isField && selected && !isReturning) ? selected : null);
            const isHovering = !!hovered;

            if (focusNode) {
                const connectedEdgeIds = new Set();
                const connectedNodeIds = new Set();
                connectedNodeIds.add(focusNode.id);

                if (isGalaxy || isField) {
                    const prefix = isField ? "P" : "G";
                    const keyFn = (s, t) => `${prefix}|${s}|${t}`;

                    currentEdges.forEach(e => {
                        const sId = (e.source && e.source.id) ? e.source.id : e.source;
                        const tId = (e.target && e.target.id) ? e.target.id : e.target;
                        if (sId === focusNode.id || tId === focusNode.id) {
                            connectedEdgeIds.add(keyFn(sId, tId));
                            connectedNodeIds.add(sId);
                            connectedNodeIds.add(tId);
                        }
                    });
                }

                // Update Links
                if (isGalaxy || isField) {
                    const prefix = isField ? "P" : "G";
                    gLinks.selectAll(".d3-link")
                        .transition("highlight").duration(200)
                        .attr("stroke-opacity", function () {
                            if (isField) return null; // Let style("opacity") handle it for Field
                            const d = d3.select(this).datum();
                            const s = (d.source.id || d.source);
                            const t = (d.target.id || d.target);
                            const key = `${prefix}|${s}|${t}`;
                            // Highlight if connected, otherwise fade
                            return connectedEdgeIds.has(key) ? 0.8 : 0.05;
                        })
                        .style("opacity", function () {
                            if (!isField) return null; // Let stroke-opacity handle it for Galaxy
                            const d = d3.select(this).datum();
                            const s = (d.source.id || d.source);
                            const t = (d.target.id || d.target);
                            const key = `${prefix}|${s}|${t}`;
                            // Highlight if connected, otherwise fade/hide
                            if (connectedEdgeIds.has(key)) return 1;
                            return (isField && selected && !isHovering) ? 0 : 0.05;
                        })
                        .attr("stroke-width", function () {
                            const d = d3.select(this).datum();
                            const s = (d.source.id || d.source);
                            const t = (d.target.id || d.target);
                            const key = `${prefix}|${s}|${t}`;
                            const weight = d.weight || 1;
                            return connectedEdgeIds.has(key) ? Math.max(2, Math.sqrt(weight) + 1) : Math.max(1, Math.sqrt(weight));
                        });
                }

                // Update Nodes
                gNodes.selectAll(".d3-node")
                    .classed("node-shimmer", d => d.id === focusNode.id && isHovering) // Only shimmer on hover
                    .transition("highlight").duration(200)
                    .style("opacity", function () {
                        const d = d3.select(this).datum();
                        if (d.id === focusNode.id) return 1;

                        if (isGalaxy || isField) {
                            if (connectedNodeIds.has(d.id)) return 1;
                            return (isField && selected && !isHovering) ? 0 : 0.1;
                        }
                        return 1;
                    });

            } else {
                // Reset State
                if (isGalaxy || isField) {
                    gLinks.selectAll(".d3-link")
                        .transition("highlight").duration(200)
                        .attr("stroke-opacity", isField ? null : 0.6) // Reset stroke-opacity for Galaxy (was 0.6 previously on load)
                        .style("opacity", isField ? 1 : null) // Reset opacity for Field
                        .attr("stroke-width", function () {
                            const d = d3.select(this).datum();
                            return Math.max(1, Math.sqrt(d.weight || 1));
                        });
                }

                gNodes.selectAll(".d3-node")
                    .classed("node-shimmer", false)
                    .transition("highlight").duration(200)
                    .style("opacity", 1);
            }
        }
    }, [hovered, selected, viewMode, edges, layoutMode, isReturning]);

    return <svg ref={svgRef} className="galaxy-canvas" width={width} height={height} />;
};
