
import * as d3 from "d3";
import { getDeterministicPoint, hashString } from "../utils/d3-helpers";

export class LayoutEngine {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.graphCenterY = -height * 0.1;
    }

    updateDimensions(width, height) {
        this.width = width;
        this.height = height;
        this.graphCenterY = -height * 0.1;
    }

    // --- Universe View Layouts ---

    applyUniverseCentralLayout(nodes, sim) {
        // Deterministic Spiral Packing
        // Sort by value (desc) then ID (asc) for stability
        const sorted = [...nodes].sort((a, b) => (b.val || 0) - (a.val || 0) || a.id.localeCompare(b.id));

        sorted.forEach((n, i) => {
            n.fx = null;
            n.fy = null;

            if (n.isMenuNode) {
                // Keep menu node somewhat fixed or let it float? 
                // Brief says "Nodes gravitate toward center". Menu node is special.
                // Let's fix it off-center or let it float.
                // Current behavior: Fixed at 800, -600.
                n.x = 800; n.y = -600;
            } else {
                // Archimedean Spiral
                // theta = i * a
                // r = b * theta
                const angle = i * 0.5; // Tighter spiral
                const radius = 40 * Math.sqrt(i); // SQRT distribution for packing
                // Apply separate spacing for larger nodes

                // Simple phyllotaxis:
                const theta = i * 2.39996; // Golden angle approx
                const r = 40 * Math.sqrt(i) + (n.val * 2);

                // Deterministic initial position
                if (!n.x && !n.y) {
                    n.x = Math.cos(theta) * r;
                    n.y = Math.sin(theta) * r;
                }
            }
        });

        // Use forces to handle overlaps dynamically but keep the spiral shape
        sim.force("center", d3.forceCenter(0, 0))
            .force("x", d3.forceX(0).strength(0.02))
            .force("y", d3.forceY(0).strength(0.02))
            .force("charge", d3.forceManyBody().strength(d => -100 - (d.val * 10))) // Repel based on size
            .force("collide", d3.forceCollide().radius(d => (d.val * 2.5 + 20)).iterations(2))
            .force("link", null);

        return sim;
    }

    applyUniverseTimelineLayout(nodes, sim, universeXScale, timelineHeightScale) {
        // ... (Existing implementation preserved) ...
        // Rigid Grid / Streamgraph Layout
        // Rigid Grid / Streamgraph Layout
        // Dynamic Grid / Streamgraph Layout
        // 35 + Dynamic Component based on Node Size

        const sortedForLayout = [...nodes]
            .filter(n => !n.isMenuNode)
            .sort((a, b) => {
                const yearDiff = (a.data.firstPublicationYear || 0) - (b.data.firstPublicationYear || 0);
                if (yearDiff !== 0) return yearDiff;
                return a.id.localeCompare(b.id);
            });

        // Calculate heights
        let totalHeight = 0;
        const nodeHeights = new Map();

        sortedForLayout.forEach(n => {
            let dynamicSize = 0;
            if (timelineHeightScale && n.data && n.data.worksByDecade) {
                // Apply Projection (scaling up 2020s) to match Renderer
                // Factor updated to 2.0 based on user feedback
                const projectedData = n.data.worksByDecade.map(w => {
                    if (w.decade === 2020) {
                        return { ...w, works_count: w.works_count * 2.0 };
                    }
                    return w;
                });
                const maxWorks = d3.max(projectedData, w => w.works_count) || 0;
                dynamicSize = timelineHeightScale(maxWorks);
            }
            // Fallback size if data missing
            if (!dynamicSize) dynamicSize = 10;

            // Slot Height = 35 + Dynamic Size
            const slotH = 35 + dynamicSize;
            nodeHeights.set(n.id, slotH);
            n._height = slotH; // Store for rendering
            totalHeight += slotH;
        });

        // Anchor relative to Axis Position (height/2 - 40)
        // We want the lowest node to be significantly above the axis.
        const bottomY = (this.height / 2) - 75;
        let currentY = bottomY - totalHeight;

        sortedForLayout.forEach((n, i) => {
            n.fx = 0; // Anchor at center

            const h = nodeHeights.get(n.id);
            n.fy = currentY + (h / 2);
            currentY += h;

            // SMOOTH TRANSITION LOGIC:
            if (n.x === undefined || n.y === undefined) {
                n.x = n.fx;
                n.y = n.fy;
            }
            n.vx = 0;
            n.vy = 0;
        });

        // Menu Node
        const menuNode = nodes.find(n => n.isMenuNode);
        if (menuNode) {
            menuNode.fx = 800;
            menuNode.fy = -600;
            if (menuNode.x === undefined) {
                menuNode.x = 800;
                menuNode.y = -600;
            }
        }

        sim.force("center", null)
            .force("link", null)
            .force("charge", null)
            .force("collide", null)
            .force("x", d3.forceX(0).strength(1))
            .force("y", d3.forceY(d => d.fy).strength(1));

        return sim;
    }


    // --- Galaxy View Layouts ---

    applyGalaxyLayout(nodes, edges, sim, layoutMode, scales) {
        const { yScale, xGroupScale, yTimelineScale } = scales;

        if (layoutMode === 'TIMELINE') {
            // Stream Layout
            // X = Year, Y = Centered Stream

            // X-Axis Force
            // We need a scale for the years if not provided. 
            // In Galaxy view, 'yTimelineScale' was actually used for Y-banding in old implementation. 
            // Now we need X-scale for years. 
            // We can reuse 'yTimelineScale' if it covers the years, but mapped to X? 
            // Or create a new local scale if missing.

            const minYear = d3.min(nodes, d => d.minYear) || 1990;
            const maxYear = d3.max(nodes, d => d.maxYear || d.minYear) || 2025;
            // Widen the scale to fill space better (3x wider as requested)
            const widthFactor = 8.0; // Increased to 8.0 from 2.4 (roughly 3.3x)
            const xScale = d3.scaleLinear().domain([minYear, maxYear]).range([-this.width * widthFactor, this.width * widthFactor]);

            // Y-Axis Sorting (Stream)
            // Sort by size (desc) to put largest in middle
            const sorted = [...nodes].sort((a, b) => (b.val || 0) - (a.val || 0));
            sorted.forEach((d, i) => {
                // Alternating placement: 0, 1, -1, 2, -2...
                const sign = i % 2 === 0 ? 1 : -1;
                const offset = Math.ceil(i / 2) * (d.val * 1.5 + 40); // Dynamic step based on size
                d._targetY = offset * sign;
            });

            sim.force("x", d3.forceX(d => xScale(d.minYear)).strength(0.8))
                .force("y", d3.forceY(d => d._targetY + this.graphCenterY).strength(0.5))
                .force("collide", d3.forceCollide().radius(d => d.val * 1.2 + 20).iterations(2))
                .force("charge", d3.forceManyBody().strength(-50))
                .force("link", d3.forceLink(edges).id(d => d.id).strength(0.01)); // Weak links

        } else {
            // CENTRAL: Spiral Layout (Gap-less packing)
            // Sort by value (desc) then ID (asc) for stability and center-heavy packing
            const sorted = [...nodes].sort((a, b) => (b.val || 0) - (a.val || 0) || a.id.localeCompare(b.id));

            sorted.forEach((n, i) => {
                n.fx = null;
                n.fy = null;

                // Archimedean Spiral / Phyllotaxis
                const theta = i * 2.39996; // Golden angle approx
                // Tighter packing factor:
                const spread = 8; // Reduced from 35 (approx 20%)
                const r = spread * Math.sqrt(i) + (n.val * 0.2); // Reduced val impact

                // Deterministic initial position target
                const tx = Math.cos(theta) * r;
                const ty = Math.sin(theta) * r + this.graphCenterY;

                // If node has no position, snap it there
                if (!n.x && !n.y) {
                    n.x = tx;
                    n.y = ty;
                }

                n._targetX = tx;
                n._targetY = ty;
            });

            sim.force("link", d3.forceLink(edges).id(d => d.id).strength(0.05)); // Keep edges visible but weak

            // Pull towards spiral target
            sim.force("x", d3.forceX(d => d._targetX).strength(0.3))
                .force("y", d3.forceY(d => d._targetY).strength(0.3))
                // Collide Radius drastically reduced: val portion ~0.3 (matches visual roughly), padding 5
                .force("collide", d3.forceCollide().radius(d => (d.val * 0.3 + 5)).iterations(3))
                // Charge reduced to allow closer packing
                .force("charge", d3.forceManyBody().strength(d => -5 - (d.val * 0.5)));
        }

        return sim;
    }

    // --- Field View Layouts ---

    applyFieldLayout(nodes, edges, sim, selectedNode, layoutMode, scales) {

        if (layoutMode === 'TIMELINE') {
            // Stream Layout for Papers
            // X = Year
            const minYear = d3.min(nodes, d => d.year) || 1990;
            const maxYear = d3.max(nodes, d => d.year) || 2025;
            const xScale = d3.scaleLinear().domain([minYear, maxYear]).range([-this.width * 0.4, this.width * 0.4]);

            // Y = Stream (Largest citations at center)
            const sorted = [...nodes].sort((a, b) => (b.citationCount || 0) - (a.citationCount || 0));
            sorted.forEach((d, i) => {
                const sign = i % 2 === 0 ? 1 : -1;
                const offset = Math.ceil(i / 2) * 50; // 50px step for papers
                d._targetY = offset * sign;
            });

            sim.force("x", d3.forceX(d => xScale(d.year)).strength(0.9))
                .force("y", d3.forceY(d => d._targetY + this.graphCenterY).strength(0.6))
                .force("collide", d3.forceCollide().radius(30).iterations(2))
                .force("charge", d3.forceManyBody().strength(-50))
                .force("link", d3.forceLink(edges).id(d => d.id).strength(0.1));

        } else {
            // CENTRAL
            const linkDist = selectedNode ? 450 : 150;

            // Base Forces
            sim.force("link", d3.forceLink(edges).id(d => d.id).distance(linkDist));

            if (selectedNode) {
                // Focused Mode
                sim.force("charge", d3.forceManyBody().strength(-3000));
                sim.force("collide", d3.forceCollide().radius(d => {
                    if (d.id === selectedNode.id) return d._w * 0.8 + 80;
                    return d._w * 0.6 + 20;
                }).iterations(4));

                sim.force("center-pin", d3.forceRadial(0, selectedNode.x, selectedNode.y).strength(d => d.id === selectedNode.id ? 1 : 0));

                const maxCites = d3.max(nodes, d => d.citationCount) || 1;
                // Inverted orbit: Larger (more cites) = closer
                sim.force("neighbor-ring", d3.forceRadial(d => {
                    if (d.id === selectedNode.id) return 0;
                    const importance = (d.citationCount || 0) / maxCites;
                    return 300 + ((1 - importance) * 400); // Inverse: High importance -> Small radius
                }, selectedNode.x, selectedNode.y).strength(0.6));
            } else {
                // Default Cluster
                sim.force("charge", d3.forceManyBody().strength(d => d._isExtra ? -1600 : -600));
                sim.force("collide", d3.forceCollide().radius(d => (d._w * 0.6) + (d._isExtra ? 260 : 40)).iterations(4));
                sim.force("center", d3.forceCenter(0, this.graphCenterY));

                // Spiral-ish Radial
                const maxCites = d3.max(nodes, n => n.citationCount) || 1;
                sim.force("radial", d3.forceRadial(d => (1 - (d.citationCount / maxCites)) * 500, 0, 0).strength(0.3));
            }
        }
        return sim;
    }

}
