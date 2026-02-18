
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
                if (isGalaxy || isField) {
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
            .attr("fill", "none")
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

                grad.select(".grad-stop-start").attr("stop-color", srcColor).attr("stop-opacity", 0.6);
                grad.select(".grad-stop-end").attr("stop-color", tgtColor).attr("stop-opacity", 0.6);

                d3.select(this).attr("stroke", `url(#${id})`);
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
                el.append("rect").attr("class", "node-paper-card");

                const fo = el.append("foreignObject")
                    .attr("class", "node-fo")
                    .attr("width", 1) // Set placeholder, updated in loop below
                    .attr("height", 1);

                fo.append("xhtml:div")
                    .attr("class", "node-paper-content")
                    .html(d => `<div class="node-paper-title">${d.title || d.name || 'Untitled'}</div>`);

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
                        .attr("rx", height / 2) // Rounded pills
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
                // Size: Base size scaled by citations
                const width = 60 + (d.val * 1.5); // Wider cards
                const height = 40 + (d.val * 0.5); // Taller cards

                // Store dims for collision
                d._w = width;
                d._h = height;

                el.select(".node-paper-card")
                    .attr("x", -width / 2)
                    .attr("y", -height / 2)
                    .attr("width", width)
                    .attr("height", height)
                    .attr("fill", "#ffffff") // White card
                    .style("stroke", cScale(d.xGroup || d.field)); // Border color by field

                el.select(".node-fo")
                    .attr("x", -width / 2)
                    .attr("y", -height / 2)
                    .attr("width", width)
                    .attr("height", height);
            }
        });



        // --- AXIS RENDERING (Timeline) ---
        if ((isUniverse || isGalaxy) && layoutMode === 'TIMELINE') {
            // Determine scale
            let xAxisScale = null;
            if (isUniverse) {
                xAxisScale = scales.universeXScale;
            } else {
                // Galaxy Timeline Scale (Calculated locally if not passed)
                // LayoutEngine calculated it, but we need it here for rendering.
                // Re-calculate based on currentNodes (safe enough for display)
                const minYear = d3.min(currentNodes, d => d.minYear) || 1990;
                const maxYear = d3.max(currentNodes, d => d.maxYear || d.minYear) || 2025;
                const padding = width * 0.1;
                const effectiveWidth = width - (padding * 2);
                xAxisScale = d3.scaleLinear().domain([minYear, maxYear]).range([-effectiveWidth / 2, effectiveWidth / 2]);
            }

            if (xAxisScale) {
                const axisBottom = d3.axisBottom(xAxisScale).tickFormat(d3.format("d")).ticks(10); // Decades/Years
                gAxisLayer.attr("transform", `translate(0, ${height / 2 - 40})`)
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
            allNodes.transition().duration(800).ease(d3.easeBackOut.overshoot(0.8))
                .attr("transform", d => `translate(${d.x}, ${d.y}) scale(1)`);

            // D. Reveal Links & Labels
            gLinks.transition().delay(600).duration(500).style("opacity", 1);
            allLinks.transition().delay(600).duration(500).attr("stroke-opacity", 0.6);

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
                        .transition().duration(200)
                        .attr("stroke-opacity", function () {
                            const d = d3.select(this).datum();
                            const s = (d.source.id || d.source);
                            const t = (d.target.id || d.target);
                            const key = `${prefix}|${s}|${t}`;
                            // Highlight if connected, otherwise fade
                            return connectedEdgeIds.has(key) ? 0.8 : 0.05;
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
                    .transition().duration(200)
                    .style("opacity", function () {
                        const d = d3.select(this).datum();
                        if (d.id === focusNode.id) return 1;

                        if (isGalaxy || isField) {
                            return connectedNodeIds.has(d.id) ? 1 : 0.1;
                        }
                        return 1;
                    });

            } else {
                // Reset State
                if (isGalaxy || isField) {
                    gLinks.selectAll(".d3-link")
                        .transition().duration(200)
                        .attr("stroke-opacity", 0.4) // Default opacity
                        .attr("stroke-width", function () {
                            const d = d3.select(this).datum();
                            return Math.max(1, Math.sqrt(d.weight || 1));
                        });
                }

                gNodes.selectAll(".d3-node")
                    .classed("node-shimmer", false)
                    .transition().duration(200)
                    .style("opacity", 1);
            }
        }
    }, [hovered, selected, viewMode, edges, layoutMode, isReturning]);

    return <svg ref={svgRef} className="galaxy-canvas" width={width} height={height} />;
};
