
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
    const isTransitioning = useRef(false);

    // Previous State Refs
    const prevViewMode = useRef(viewMode);
    const prevLayoutMode = useRef(layoutMode);
    const prevSelectedIdRef = useRef(null);
    const edgeRevealTimeoutRef = useRef(null);
    const edgeRevealPendingRef = useRef(false);
    const firstDataRenderRef = useRef(true);

    // Update Layout Engine dimensions
    useEffect(() => {
        layoutEngine.current.updateDimensions(width, height);
    }, [width, height]);


    // --- MAIN RENDER EFFECT ---
    useEffect(() => {
        isTransitioning.current = false;
        if (!svgRef.current || !width || !height) return;

        const svg = d3.select(svgRef.current);

        // --- SETUP GROUPS ---
        let gMain = svg.select(".g-main");
        if (gMain.empty()) {
            const gRoot = svg.append("g");
            gMain = gRoot.append("g").attr("class", "g-main");
            // Add filters/defs here if needed (e.g. drop shadows)
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
            .scaleExtent([0.1, 8])
            .on("zoom", (event) => {
                gMain.attr("transform", event.transform);
                if (isTransitioning.current) return;

                // Semantic Zoom Logic
                const k = event.transform.k;
                const cx = (width / 2 - event.transform.x) / k;
                const cy = (height / 2 - event.transform.y) / k;

                if (viewMode === 'UNIVERSE' && k > 1.8) {
                    // Check logic for potential auto-entry (omitted for modularity, can be re-added if needed)
                }
            })
            .on("end", () => {
                // Potential future optimizations
            });

        svg.call(zoom);
        svg.on("click.unselect", (event) => {
            if (event.target.tagName === 'svg') onBackgroundClick();
        });

        // --- DATA PREP ---
        const isUniverse = viewMode === 'UNIVERSE';
        const isGalaxy = viewMode === 'GALAXY';
        const currentNodes = nodes;
        const currentEdges = edges; // Filtered by hook

        // --- D3 JOIN ---

        // LINIEAR GRADIENTS & EDGES
        const getEdgeKey = (d) => `${isGalaxy ? "G" : "P"}|${getEdgeId(d.source)}|${getEdgeId(d.target)}`;
        const getGradientId = (d) => `link-gradient-${sanitizeId(getEdgeKey(d))}`;

        const colorScale = scales.colorScale || d3.scaleOrdinal(d3.schemeTableau10);

        const getBaseEdgeColor = (d) => {
            if (!isGalaxy) return EDGE_COLORS.default;
            const src = d.source;
            const name = typeof src === 'object' ? (src.xGroup || src.name) : src;
            return colorScale(name);
        };

        const defs = svg.select("defs").empty() ? svg.append("defs") : svg.select("defs");

        // Cleanup if selected changed
        if (!isGalaxy && prevSelectedIdRef.current !== (selected?.id || null)) {
            gLinks.selectAll(".d3-link").interrupt().remove();
            defs.selectAll(".link-gradient").remove();
            nodePositionsCache.current.clear();
        }

        // Links
        if (isUniverse) {
            gLinks.selectAll(".d3-link").remove();
        } else {
            const linkJoin = gLinks.selectAll(".d3-link").data(currentEdges, getEdgeKey);
            linkJoin.exit().remove();

            const linkEnter = linkJoin.enter().append("path")
                .attr("class", `d3-link ${isGalaxy ? 'type-galaxy-link' : 'type-paper-link'}`)
                .attr("fill", "none")
                .attr("stroke-linecap", "round")
                .attr("stroke-opacity", 0);

            linkEnter.merge(linkJoin)
                .attr("stroke-width", d => isGalaxy ? Math.max(1.6, Math.sqrt(d.weight || 1) + 0.8) : 6)
                .each(function (d) {
                    const id = getGradientId(d);
                    let grad = defs.select(`#${id}`);
                    if (grad.empty()) {
                        grad = defs.append("linearGradient").attr("id", id).attr("gradientUnits", "userSpaceOnUse");
                        grad.append("stop").attr("offset", "0%").attr("class", "grad-stop-start");
                        grad.append("stop").attr("offset", "100%").attr("class", "grad-stop-end");
                    }
                    const color = getBaseEdgeColor(d);
                    grad.select(".grad-stop-start").attr("stop-color", color).attr("stop-opacity", 0.1);
                    grad.select(".grad-stop-end").attr("stop-color", color).attr("stop-opacity", 0.6);

                    d3.select(this).attr("stroke", `url(#${id})`);
                });
        }

        // Nodes
        const nodeJoin = gNodes.selectAll(".d3-node").data(currentNodes, d => d.id);

        nodeJoin.exit().transition().duration(400).style("opacity", 0).remove();

        const nodeEnter = nodeJoin.enter().append("g")
            .attr("class", "d3-node")
            .attr("cursor", "pointer")
            .style("opacity", 0)
            .on("click", (e, d) => {
                e.stopPropagation();
                onNodeClick(d);
            })
            .on("mouseover", (e, d) => onNodeHover(d))
            .on("mouseout", (e, d) => onNodeHover(null));

        // Append Shapes based on type
        if (isUniverse || isGalaxy) {
            nodeEnter.each(function (d) {
                const el = d3.select(this);
                if (isUniverse && !d.isMenuNode) {
                    el.append("path").attr("class", "orbit");
                    el.append("path").attr("class", "core");
                } else {
                    el.append("circle").attr("class", "orbit");
                    el.append("circle").attr("class", "core");
                }
                el.append("text").attr("class", "label-main");
                el.append("text").attr("class", "label-sub");
                // Extra labels for timeline
                el.append("text").attr("class", "label-right").style("opacity", 0);
            });
        } else {
            // Field View Nodes
            nodeEnter.append("rect").attr("class", "node-rect").attr("rx", 6);
            nodeEnter.append("foreignObject").attr("class", "fo-content")
                .style("pointer-events", "none")
                .append("xhtml:div").attr("class", "node-fo");
        }

        const allNodes = nodeEnter.merge(nodeJoin);

        // Update Node Styles
        allNodes.each(function (d) {
            const el = d3.select(this);
            // ... (Style update logic similar to App.js, condensed)
            if (isUniverse) {
                const val = d.val || 20;
                if (!d.isMenuNode) {
                    if (layoutMode === 'TIMELINE' && scales.universeXScale && scales.timelineHeightScale) {
                        // Generator for Area Path
                        const generateAreaPath = (d) => {
                            const decades = d.data.worksByDecade || [];
                            if (!decades.length) return "M0,0Z";
                            const area = d3.area()
                                .x(p => scales.universeXScale(p.decade) - d.x)
                                .y0(p => -scales.timelineHeightScale(p.works_count) / 2)
                                .y1(p => scales.timelineHeightScale(p.works_count) / 2)
                                .curve(d3.curveBasis);
                            return area(decades);
                        };

                        const areaPath = generateAreaPath(d);
                        el.select(".orbit").transition().duration(1000).attr("d", areaPath).attr("fill-opacity", 0.4).attr("stroke-width", 2);
                        el.select(".core").transition().duration(1000).attr("d", areaPath).attr("fill-opacity", 0.1).style("filter", "none");

                        // Labels for Timeline
                        const startYear = d.data.firstPublicationYear || 1900;
                        const startX = scales.universeXScale(startYear) - d.x;
                        el.select(".label-main").transition().duration(1000).attr("x", startX - 20).attr("dy", 0).style("text-anchor", "end").style("font-size", "14px");
                        el.select(".label-sub").transition().duration(1000).attr("x", startX - 20).attr("dy", 15).style("text-anchor", "end").style("opacity", 1);

                        // Right Label
                        const endYear = d.data.lastPublicationYear || 2024;
                        const endX = scales.universeXScale(endYear) - d.x;
                        el.select(".label-right").transition().duration(1000).text(d.name).attr("x", endX + 20).attr("dy", 0).style("text-anchor", "start").style("opacity", 1);

                    } else {
                        // Default Hexagon
                        el.select(".orbit").transition().duration(1000).attr("d", roundedHexagonPath(val * 2.5)).attr("fill-opacity", 0.15).attr("stroke", "#475569").attr("stroke-width", 12);
                        el.select(".core").transition().duration(1000).attr("d", roundedHexagonPath(val * 0.8)).attr("fill", d.isMenuNode ? "#94a3b8" : colorScale(d.id)).style("filter", "blur(1px)");

                        el.select(".label-main").transition().duration(1000).attr("x", 0).attr("dy", val * 1.6).style("text-anchor", "middle").style("font-size", "22px").style("font-weight", "bold");
                        el.select(".label-sub").transition().duration(1000).attr("x", 0).attr("dy", val * 1.6 + 20).style("text-anchor", "middle").style("opacity", 0.7);
                        el.select(".label-right").style("opacity", 0);
                    }
                } else {
                    // Menu Node
                    el.select(".orbit").attr("r", val * 2.5);
                    el.select(".core").attr("r", val * 0.8);
                }
                el.select(".label-main").text(d.name);
                el.select(".label-sub").text(d.nodeCount ? `${d.nodeCount} papers` : "");
            } else if (isGalaxy) {
                el.select(".orbit").attr("r", d.val * 2.5).attr("fill", colorScale(d.xGroup)).attr("fill-opacity", 0.15);
                el.select(".core").attr("r", d.val * 0.8).attr("fill", colorScale(d.xGroup));
                // Larger Labels
                el.select(".label-main").text((d.name || d.title || "").substring(0, 25)).attr("dy", d.val * 2 + 24).style("text-anchor", "middle").style("font-size", "14px").style("font-weight", "600");
                el.select(".label-sub").text(d.nodeCount ? `${d.nodeCount} papers` : "").attr("dy", d.val * 2 + 38).style("text-anchor", "middle").style("font-size", "11px");
            } else {
                // Field View (Papers)
                // Ensure rects are visible
                const w = 140;
                const h = 60;

                // Update Rect
                el.select("rect")
                    .attr("width", w)
                    .attr("height", h)
                    .attr("x", -w / 2)
                    .attr("y", -h / 2)
                    .attr("fill", "white") // White card background
                    .attr("stroke", d => colorScale(d.group)) // Border color by group
                    .attr("stroke-width", 2)
                    .style("opacity", 1);

                // Update ForeignObject text
                el.select("foreignObject")
                    .attr("width", w - 8)
                    .attr("height", h - 8)
                    .attr("x", -w / 2 + 4)
                    .attr("y", -h / 2 + 4)
                    .select(".node-fo")
                    .style("font-size", "10px")
                    .style("color", "#333")
                    .style("overflow", "hidden")
                    .style("display", "-webkit-box")
                    .style("-webkit-line-clamp", "3")
                    .style("-webkit-box-orient", "vertical")
                    .text(d.title || "No Title");
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
                gAxisLayer.attr("transform", `translate(0, ${height / 2 - 40})`) // Bottom of screen-ish or Layout center? 
                    // LayoutEngine centers Y at 0 (graphCenterY). So Axis should be below that.
                    // Actually Graph centers everything at 0,0 via Zoom? No, zoom is on gMain.
                    // We want axis relative to the nodes.
                    // Nodes are centered at 0,0 (LayoutEngine usually outputs centered coords).
                    // So Axis should be at some Y offset.
                    .style("opacity", 1)
                    .call(axisBottom);

                gAxisLayer.selectAll("text").style("fill", "#64748b").style("font-size", "12px");
                gAxisLayer.selectAll("line").style("stroke", "#cbd5e1");
                gAxisLayer.selectAll("path").style("stroke", "#cbd5e1");
            }
        } else {
            gAxisLayer.style("opacity", 0);
        }

        // --- LAYOUT SIMULATION ---
        if (simulationRef.current) simulationRef.current.stop();

        // ZOOM IN Transition Logic: Universe -> Galaxy
        // If we just entered Galaxy View from Universe, we want to zoom FROM the clicked galaxy.
        const prevMode = prevViewMode.current;
        if (prevMode === 'UNIVERSE' && viewMode === 'GALAXY' && activeGroup && !isReturning) {
            // Find the active galaxy node position in the Universe Layout (conceptually)
            // Ideally we should know which node it was. 
            // For now, let's just scale up from center or default.
            // Requirement: "Nodes spawn at final X/Y positions, Scale = 0.05".

            gNodes.selectAll(".d3-node")
                .attr("transform", d => `translate(${d.x}, ${d.y}) scale(0.05)`)
                .transition().duration(800).ease(d3.easeCubicOut)
                .attr("transform", d => `translate(${d.x}, ${d.y}) scale(1)`);
        } else if (isReturning) {
            // Zoom OUT / Back: Instant placement is default, or fade in.
            // Brief says: "Zoom Out (Field -> Galaxy)... Animation: None (Instant placement)."
        }

        const sim = d3.forceSimulation(currentNodes);

        // Prevent generic center force if using custom layout engines
        // sim.force("center", d3.forceCenter(0, 0)); 

        if (isUniverse) {
            if (layoutMode === 'TIMELINE') {
                layoutEngine.current.applyUniverseTimelineLayout(currentNodes, sim, scales.universeXScale, scales.timelineHeightScale);
            } else {
                layoutEngine.current.applyUniverseCentralLayout(currentNodes, sim);
            }
        } else if (isGalaxy) {
            layoutEngine.current.applyGalaxyLayout(currentNodes, currentEdges, sim, layoutMode, scales);
        } else {
            // Field View
            // Pass layoutMode and scales (needed for Timeline)
            layoutEngine.current.applyFieldLayout(currentNodes, currentEdges, sim, selected, layoutMode, scales);
        }

        sim.on("tick", () => {
            // If strictly rigid (Timeline), positions are fixed. 
            // If simulation running, update.
            allNodes.attr("transform", d => `translate(${d.x}, ${d.y})`);

            if (!isUniverse) {
                gLinks.selectAll(".d3-link").attr("d", d => {
                    const s = d.source;
                    const t = d.target;
                    return `M${s.x},${s.y} L${t.x},${t.y}`; // Simplified straight lines for now
                });
                // Update gradients positions
                defs.selectAll(".link-gradient")
                    .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
                    .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
            }
        });

        // Warmup
        sim.alpha(1).restart();
        // Simulate some ticks synchronously for stability
        for (let i = 0; i < 50; ++i) sim.tick();

        simulationRef.current = sim;

        // Reveal
        allNodes.transition().duration(500).style("opacity", 1);

        // GALAXY EDGE RENDERING & HOVER EFFECTS
        if (isGalaxy) {
            const linkJoin = gLinks.selectAll(".d3-link").data(currentEdges, getEdgeKey);
            linkJoin.exit().remove();

            const linkEnter = linkJoin.enter().append("path")
                .attr("class", "d3-link type-galaxy-link")
                .attr("fill", "none")
                .attr("stroke-linecap", "round")
                .attr("stroke-opacity", 0);

            const links = linkEnter.merge(linkJoin);

            links.attr("stroke-width", d => Math.max(1, Math.sqrt(d.weight || 1)))
                .attr("stroke", "#cbd5e1") // Default grey for galaxy edges
                .transition().duration(500)
                .attr("stroke-opacity", 0.4); // Base opacity

            // Handle Hover Effects
            if (hovered) {
                const connectedEdgeIds = new Set();
                const connectedNodeIds = new Set();
                connectedNodeIds.add(hovered.id);

                currentEdges.forEach(e => {
                    // Check if edge is connected to hovered node
                    // d3 force replaces source/target with objects, so check id
                    const sourceId = typeof e.source === 'object' ? e.source.id : e.source;
                    const targetId = typeof e.target === 'object' ? e.target.id : e.target;

                    if (sourceId === hovered.id || targetId === hovered.id) {
                        connectedEdgeIds.add(getEdgeKey(e));
                        connectedNodeIds.add(sourceId);
                        connectedNodeIds.add(targetId);
                    }
                });

                // Update Links
                links.transition().duration(200)
                    .attr("stroke-opacity", d => connectedEdgeIds.has(getEdgeKey(d)) ? 0.8 : 0.05)
                    .attr("stroke", d => connectedEdgeIds.has(getEdgeKey(d)) ? "#64748b" : "#cbd5e1")
                    .attr("stroke-width", d => connectedEdgeIds.has(getEdgeKey(d)) ? Math.max(2, Math.sqrt(d.weight || 1) + 1) : Math.max(1, Math.sqrt(d.weight || 1)));

                // Update Nodes (Optional: Dim unconnected nodes?)
                gNodes.selectAll(".d3-node")
                    .transition().duration(200)
                    .style("opacity", d => connectedNodeIds.has(d.id) ? 1 : 0.3);

            } else {
                // Reset
                links.transition().duration(200)
                    .attr("stroke-opacity", 0.4)
                    .attr("stroke", "#cbd5e1")
                    .attr("stroke-width", d => Math.max(1, Math.sqrt(d.weight || 1)));

                gNodes.selectAll(".d3-node")
                    .transition().duration(200)
                    .style("opacity", 1);
            }
        } else {
            // Universe / Field Edge Rendering (Existing logic preserved or updated if needed)
            gLinks.selectAll(".d3-link").transition().duration(500).attr("stroke-opacity", 0.8);
        }

        return () => {
            sim.stop();
        };

    }, [nodes, edges, viewMode, layoutMode, groupingMode, activeGroup, selected, width, height, scales]);

    // --- HOVER EFFECT (Visual Only) ---
    useEffect(() => {
        if (!svgRef.current) return;
        const svg = d3.select(svgRef.current);
        const isGalaxy = viewMode === 'GALAXY';

        // Only apply heavy hover logic in Galaxy view for now (as requested)
        if (isGalaxy) {
            const gLinks = svg.select(".g-links");
            const gNodes = svg.select(".g-nodes");
            const currentEdges = edges; // We need access to edges to map connections

            if (hovered) {
                const connectedEdgeIds = new Set();
                const connectedNodeIds = new Set();
                connectedNodeIds.add(hovered.id);

                // Helper to get edge key (must match main render key)
                const getEdgeKey = (d) => `G|${d.source.id || d.source}|${d.target.id || d.target}`;

                currentEdges.forEach(e => {
                    // Check if edge is connected to hovered node
                    // The 'edges' prop might still have string IDs or object references depending on if simulation ran
                    // BUT, simulation mutates the objects. The 'edges' passed to THIS effect might be the raw ones if they haven't updated?
                    // Actually, 'edges' comes from useGraphData. The simulation mutates them IN PLACE if they are the same objects.
                    // The main effect runs and mutates. 

                    const sId = (e.source && e.source.id) ? e.source.id : e.source;
                    const tId = (e.target && e.target.id) ? e.target.id : e.target;

                    if (sId === hovered.id || tId === hovered.id) {
                        // We need to match the key format used in main render
                        // transform IDs to string just in case
                        connectedEdgeIds.add(`G|${sId}|${tId}`);
                        connectedNodeIds.add(sId);
                        connectedNodeIds.add(tId);
                    }
                });

                // Update Links
                gLinks.selectAll(".d3-link")
                    .transition().duration(200)
                    .attr("stroke-opacity", function () {
                        // d3 data binding is preserved on the element
                        const d = d3.select(this).datum();
                        // Re-construct keys or check if we can rely on datum
                        // Datum is the edge object.
                        const s = (d.source.id || d.source);
                        const t = (d.target.id || d.target);
                        const key = `G|${s}|${t}`;
                        return connectedEdgeIds.has(key) ? 0.8 : 0.05;
                    })
                    .attr("stroke", function () {
                        const d = d3.select(this).datum();
                        const s = (d.source.id || d.source);
                        const t = (d.target.id || d.target);
                        const key = `G|${s}|${t}`;
                        return connectedEdgeIds.has(key) ? "#64748b" : "#cbd5e1";
                    })
                    .attr("stroke-width", function () {
                        const d = d3.select(this).datum();
                        const s = (d.source.id || d.source);
                        const t = (d.target.id || d.target);
                        const key = `G|${s}|${t}`;
                        const weight = d.weight || 1;
                        return connectedEdgeIds.has(key) ? Math.max(2, Math.sqrt(weight) + 1) : Math.max(1, Math.sqrt(weight));
                    });

                // Update Nodes
                gNodes.selectAll(".d3-node")
                    .transition().duration(200)
                    .style("opacity", function () {
                        const d = d3.select(this).datum();
                        return connectedNodeIds.has(d.id) ? 1 : 0.3;
                    });

            } else {
                // Reset
                gLinks.selectAll(".d3-link")
                    .transition().duration(200)
                    .attr("stroke-opacity", 0.4)
                    .attr("stroke", "#cbd5e1")
                    .attr("stroke-width", function () {
                        const d = d3.select(this).datum();
                        return Math.max(1, Math.sqrt(d.weight || 1));
                    });

                gNodes.selectAll(".d3-node")
                    .transition().duration(200)
                    .style("opacity", 1);
            }
        }
    }, [hovered, viewMode, edges]); // Dependencies specific to visual updates

    return <svg ref={svgRef} className="galaxy-canvas" width={width} height={height} />;
};
