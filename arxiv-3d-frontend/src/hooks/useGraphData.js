
import { useState, useEffect, useMemo, useRef } from 'react';
import * as d3 from 'd3';

export const useGraphData = (viewMode, activeGalaxy, groupingMode, yGroupingMode, activeGroup, selected, detailFilter, setShowTimeoutPrompt, searchFilter) => {
    const [universeData, setUniverseData] = useState(null);
    const [rawNodes, setRawNodes] = useState([]);
    const [rawEdges, setRawEdges] = useState([]);
    const [isLoadingDetail, setIsLoadingDetail] = useState(false);
    const abortControllerRef = useRef(null);

    const nodeByIdRef = useRef(new Map());

    // Load Universe Data
    useEffect(() => {
        fetch("./universe.json")
            .then(r => r.json())
            .then(data => {
                setUniverseData(data);
            })
            .catch(err => console.error("Failed to load universe data:", err));
    }, []);

    // Load Galaxy Data
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

    // --- NEW: Load Detail Data (Flask API) ---
    useEffect(() => {
        if (viewMode !== 'DETAIL' || !detailFilter) return;

        setIsLoadingDetail(true);
        if (abortControllerRef.current) abortControllerRef.current.abort();
        const controller = new AbortController();
        abortControllerRef.current = controller;

        const { id, minCitations, maxPapers } = detailFilter;
        // Use environment variable for backend URL if provided, fallback to localhost:5000
        const backendUrl = process.env.REACT_APP_API_URL || 'http://localhost:5000';
        const url = `${backendUrl}/api/paper/${id}/details?min_citations=${minCitations}&max_papers=${maxPapers}`;

        const timeoutId = setTimeout(() => {
            if (setShowTimeoutPrompt) setShowTimeoutPrompt(true);
        }, 10000); // 10 seconds timeout warning

        fetch(url, { signal: controller.signal })
            .then(res => {
                clearTimeout(timeoutId);
                if (!res.ok) throw new Error("API request failed");
                return res.json();
            })
            .then(data => {
                console.log("DETAIL API RESPONSE:", data);
                if (setShowTimeoutPrompt) setShowTimeoutPrompt(false);
                setRawNodes(data.nodes || []);
                setRawEdges(data.edges || []);
                setIsLoadingDetail(false);
            })
            .catch(err => {
                if (err.name !== 'AbortError') {
                    console.error("Failed to fetch detailed paper view:", err);
                    clearTimeout(timeoutId);
                    setIsLoadingDetail(false);
                }
            });

        return () => {
            clearTimeout(timeoutId);
        };
    }, [viewMode, detailFilter, setShowTimeoutPrompt]);

    const cancelDetailFetch = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            setIsLoadingDetail(false);
        }
    };

    // --- Search: call Flask /api/search endpoint ---
    useEffect(() => {
        if (viewMode !== 'SEARCH' || !searchFilter) return;

        setIsLoadingDetail(true);
        setRawNodes([]);
        setRawEdges([]);

        if (abortControllerRef.current) abortControllerRef.current.abort();
        const controller = new AbortController();
        abortControllerRef.current = controller;

        const { query, minCitations, maxPapers } = searchFilter;
        const backendUrl = process.env.REACT_APP_API_URL || 'http://localhost:5000';
        const url = `${backendUrl}/api/search?query=${encodeURIComponent(query)}&min_citations=${minCitations}&max_papers=${maxPapers}`;

        fetch(url, { signal: controller.signal })
            .then(res => { if (!res.ok) throw new Error('Search API request failed'); return res.json(); })
            .then(data => {
                setRawNodes(data.nodes || []);
                setRawEdges(data.edges || []);
                setIsLoadingDetail(false);
            })
            .catch(err => {
                if (err.name !== 'AbortError') {
                    console.error('Search failed:', err);
                    setIsLoadingDetail(false);
                }
            });

        return () => controller.abort();
    }, [viewMode, searchFilter]);

    // Process Nodes & Groups
    const { nodes, groupStats, xGroups, groupEdges, yGroups } = useMemo(() => {
        if (!rawNodes || rawNodes.length === 0) return { nodes: [], groupStats: [], xGroups: [], groupEdges: [], yGroups: [] };

        const gMap = new Map();
        const nodeIdToGroup = new Map();

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
                group: groupKey,
                xGroup,
                yGroup,
                field: d.primaryField,
                abstract: d.abstract || d.AI_summary || "No abstract available.",
                authors: d.allAuthors || d.firstAuthor || "Unknown",
                institutions: d.institutions,
                val: Math.min(50, Math.max(5, Math.sqrt(cites) * 2)),
                nodeType: d.nodeType || null, // Preserved from search API response
                data: d // Keep original data accessible
            };

            nodeIdToGroup.set(n.id, groupKey);

            if (!gMap.has(groupKey)) {
                gMap.set(groupKey, { key: groupKey, name: displayName, xGroup, yGroup, count: 0, totalCitations: 0, minYear: Infinity, maxYear: -Infinity });
            }
            const g = gMap.get(groupKey);
            g.count += 1;
            g.totalCitations += cites;
            g.minYear = Math.min(g.minYear, yr);
            g.maxYear = Math.max(g.maxYear, yr);

            // In Detail mode, we might want to force the group to be the activeGroup 
            // so that color mappings work based on the central node's group.
            if (viewMode === 'DETAIL' && activeGroup) {
                n.group = activeGroup;
            }

            return n;
        });

        nodeByIdRef.current = new Map(ns.map(n => [n.id, n]));

        const gStats = Array.from(gMap.values()).map(g => ({
            ...g,
            minYear: g.minYear === Infinity ? 2000 : g.minYear,
            maxYear: g.maxYear === -Infinity ? 2025 : g.maxYear
        })).sort((a, b) => b.totalCitations - a.totalCitations);

        const finalGroupStats = (groupingMode === 'FIELD') ? gStats : gStats.slice(0, 150);
        const validGroups = new Set(finalGroupStats.map(g => g.key));
        const finalXGroups = Array.from(new Set(finalGroupStats.map(g => g.xGroup)));
        const finalYGroups = Array.from(new Set(finalGroupStats.map(g => g.yGroup).filter(Boolean)));

        // Process Edges
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
        }).sort((a, b) => b.weight - a.weight).slice(0, 100);

        return {
            nodes: ns,
            groupStats: finalGroupStats,
            xGroups: finalXGroups,
            groupEdges: calculatedGroupEdges,
            yGroups: finalYGroups
        };
    }, [rawNodes, rawEdges, groupingMode, yGroupingMode]);

    // Process Universe Nodes (Galaxy Nodes)
    const universeNodes = useMemo(() => {
        if (viewMode !== 'UNIVERSE' || !universeData) return [];

        // Pre-sort by size
        const sortedRaw = (universeData.nodes || []).sort((a, b) => (b.totalWorksCount || 0) - (a.totalWorksCount || 0));

        const galaxyNodes = sortedRaw.map((galaxy, i) => {
            const totalWorks = galaxy.totalWorksCount || 0;
            let val = 20;

            if (totalWorks > 0) {
                val = 30 + Math.sqrt(totalWorks) * 0.05;
            } else {
                val = 25;
            }

            // Initial Position Logic handled in LayoutEngine, but we pass properties needed
            const position = galaxy.position || [0, 0, 0];

            // Ensure worksByDecade is sorted for Area Chart
            if (galaxy.worksByDecade && Array.isArray(galaxy.worksByDecade)) {
                galaxy.worksByDecade.sort((a, b) => a.decade - b.decade);
            }

            return {
                id: galaxy.id,
                key: galaxy.id,
                type: 'galaxy',
                name: galaxy.name,
                nodeCount: galaxy.nodeCount || 0,
                edgeCount: galaxy.edgeCount || 0,
                totalWorksCount: totalWorks,
                val: Math.max(val, 30),
                data: galaxy,
                x: 0,
                y: 0,
                z: position[2],
                field: 'Galaxy',
                // --- KEY FIELDS FOR LAYOUT AND ICONS ---
                group: galaxy.group || 'Uncategorized',  // Used by LayoutEngine for clustering
                iconPath: galaxy.iconPath || null,         // Used by Graph.js to render icons
                // --- END KEY FIELDS ---
                citationCount: galaxy.totalCitations || 0,
                oldestWork: galaxy.oldest_work || galaxy.oldestWork,
                mostCitedWork: galaxy.most_cited_work || galaxy.mostCitedWork,
                hasPapers: (galaxy.nodeCount > 0)
            };
        });

        // Add Menu Node
        galaxyNodes.push({
            id: 'menu-node',
            key: 'menu-node',
            type: 'menu',
            name: 'Menu',
            val: 40,
            x: 0, y: 0,
            isMenuNode: true,
            data: {}
        });

        return galaxyNodes;
    }, [universeData, viewMode]);



    // Process Aggregated Galaxy Nodes (Group Nodes)
    const aggregatedNodes = useMemo(() => {
        if (viewMode !== 'GALAXY') return [];

        return groupStats.map(g => ({
            id: g.key,
            key: g.key,
            type: 'group',
            name: g.name,
            nodeCount: g.count,
            totalWorksCount: g.count, // Using available count
            val: Math.max(20, Math.sqrt(g.totalCitations || g.count) * 1.5),
            x: 0,
            y: 0,
            field: g.xGroup, // For color
            xGroup: g.xGroup,
            yGroup: g.yGroup,
            minYear: g.minYear, // Ensure this exists for sorting/timeline
            maxYear: g.maxYear, // For timeline right bound
            year: g.minYear,    // Alias for consistency with Universe nodes
            citationCount: g.totalCitations
        }));
    }, [groupStats, viewMode]);

    // Determine which nodes to return based on viewMode
    const activeNodes = useMemo(() => {
        if (viewMode === 'UNIVERSE') return universeNodes;
        if (viewMode === 'GALAXY') return aggregatedNodes;
        if (viewMode === 'FIELD') {
            if (!activeGroup) return nodes;

            // If a node is selected, show ONLY the selected node and its connected nodes (even from other fields).
            if (selected) {
                const connectedIndices = new Set();
                connectedIndices.add(selected.id);
                // Find all nodes connected to the selected node
                rawEdges.forEach(e => {
                    const src = String(e.source.id || e.source);
                    const tgt = String(e.target.id || e.target);
                    if (src === selected.id) connectedIndices.add(tgt);
                    if (tgt === selected.id) connectedIndices.add(src);
                });
                return nodes.filter(n => connectedIndices.has(n.id));
            }

            return nodes.filter(n => n.group === activeGroup);
        }
        if (viewMode === 'DETAIL') {
            if (!selected) return nodes;

            // STRICT EGO-NETWORK FILTERING
            // The user ONLY wants to see papers connected to the selected paper.
            // The API might return unconnected "context" papers, so we physically filter them out here.
            const connectedIndices = new Set();
            connectedIndices.add(selected.id);

            rawEdges.forEach(e => {
                const src = String(e.source.id ?? e.source);
                const tgt = String(e.target.id ?? e.target);
                if (src === selected.id) connectedIndices.add(tgt);
                if (tgt === selected.id) connectedIndices.add(src);
            });

            return nodes.filter(n => connectedIndices.has(String(n.id)));
        }
        if (viewMode === 'SEARCH') {
            // API returns nodes already tagged with nodeType ('core'/'foundation'/'impact')
            // Just prepend the central dummy node representing the search query
            const dummyNode = {
                id: 'search-dummy',
                title: searchFilter?.query || '',
                name: searchFilter?.query || '',
                isSearchDummy: true,
                nodeType: 'search_dummy',
                val: 60,
                citationCount: 0,
                year: null,
                group: 'search',
                xGroup: 'search',
                field: 'search',
                abstract: `Search results for: "${searchFilter?.query}". Inner ring = directly matching papers. Outer ring = foundations (what they cite) and impact (what cited them).`,
                authors: '',
                institutions: ''
            };
            return [dummyNode, ...nodes];
        }
        return nodes; // Default
    }, [viewMode, universeNodes, aggregatedNodes, nodes, activeGroup, selected, rawEdges, searchFilter]);

    // Process Edges - Filter based on Active Nodes
    const edges = useMemo(() => {
        if (viewMode === 'GALAXY') return groupEdges; // Return aggregated edges for Galaxy View
        if (viewMode !== 'FIELD' && viewMode !== 'DETAIL' && viewMode !== 'SEARCH') return [];

        // Create a set of active node IDs for fast lookup
        const activeIds = new Set(activeNodes.map(n => n.id));

        const paperEdges = rawEdges
            .map(e => ({
                source: String(e.source),
                target: String(e.target),
                importance: e.importance ?? 1,
                edgeType: e.edgeType || null
            }))
            .filter(e => activeIds.has(e.source) && activeIds.has(e.target) && e.source !== e.target);

        if (viewMode === 'DETAIL') {
            // Only show edges that directly involve the selected (central) paper.
            // This prevents cross-paper edges between context nodes from cluttering the view.
            if (!selected) return [];
            return paperEdges.filter(e => e.source === selected.id || e.target === selected.id);
        }

        if (viewMode === 'SEARCH') {
            // Add spokes from dummy node to each core paper
            const coreSpokes = activeNodes
                .filter(n => n.nodeType === 'core')
                .map(n => ({
                    source: 'search-dummy',
                    target: n.id,
                    importance: 1,
                    edgeType: 'spoke'
                }));
            return [...coreSpokes, ...paperEdges];
        }

        return paperEdges;
    }, [rawEdges, activeNodes, viewMode, groupEdges]);

    // Helper to clear data
    const clearData = () => {
        setRawNodes([]);
        setRawEdges([]);
    };

    return {
        universeData,
        nodes: activeNodes,
        edges,
        groupStats,
        xGroups,
        yGroups,
        groupEdges,
        rawNodes,
        rawEdges,
        nodeByIdRef,
        clearData,
        isLoadingDetail,
        cancelDetailFetch
    };
};
