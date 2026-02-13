
import * as d3 from "d3";

export const roundedHexagonPath = (radius) => {
    // Generate a hexagon path. We will use stroke-linejoin="round" in CSS/Attributes to round it visually.
    const points = [];
    for (let i = 0; i < 6; i++) {
        const angle = (i * 60) * (Math.PI / 180); // Pointy topped: 30, 90... Flat topped: 0, 60...
        // Let's use flat topped (0, 60...)
        points.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
    }
    return points.map((p, i) => (i === 0 ? "M" : "L") + p[0] + "," + p[1]).join(" ") + " Z";
};

export const hashString = (value) => {
    let hash = 0;
    const str = String(value);
    for (let i = 0; i < str.length; i += 1) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
};

export const getDeterministicPoint = (key, radius) => {
    const base = hashString(key);
    const angle = ((base % 360) * Math.PI) / 180;
    const spread = (hashString(`${key}-spread`) % 1000) / 1000;
    const r = Math.max(40, spread * radius);
    return {
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r
    };
};

export const sanitizeId = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, "_");

export const getEdgeId = (d) => (typeof d === "object" ? (d.id || d.name) : d);

export const generateHexPositions = (nodes, spacing) => {
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

export const EDGE_COLORS = {
    citation: "#f59e0b",
    reference: "#3b82f6",
    default: "#94a3b8"
};
