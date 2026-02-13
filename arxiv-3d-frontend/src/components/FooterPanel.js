
import React from 'react';
import * as d3 from 'd3';

export const FooterPanel = ({ selected, hovered, layoutMode }) => {
    if (!selected && !hovered) {
        return (
            <div className="galaxy-footer" style={{ transform: 'translateY(0)', opacity: 1, pointerEvents: 'none' }}>
                <div className="footer-empty" style={{ textAlign: 'center', color: '#94a3b8', padding: '10px' }}>
                    Hover or select a node to view details
                </div>
            </div>
        );
    }

    return (
        <div className="galaxy-footer" style={{ transform: 'translateY(0)', opacity: 1, pointerEvents: 'none' }}>
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

                {/* Selected Paper Panel */}
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

                {/* Hover Panel */}
                {hovered && !hovered.isMenuNode && hovered.id !== selected?.id && (
                    <div className="footer-panel hover-panel" style={!selected ? { gridColumn: '1 / -1' } : {}}>
                        <h4>Hovering</h4>

                        {hovered.field === "Galaxy" ? (
                            // Rich Galaxy Metadata
                            <>
                                <h3>{hovered.title}</h3>
                                <div className="footer-meta" style={{ marginBottom: '8px' }}>
                                    <strong>{d3.format(",")(hovered.totalWorksCount || hovered.totalWorks || 0)}</strong> known works
                                    <span style={{ color: '#94a3b8' }}> • </span>
                                    <strong>{d3.format(",")(hovered.nodeCount || hovered.groupCount || 0)}</strong> in map
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
                                    {hovered.year && <span>First Published: {hovered.year} • </span>}
                                    <span>{hovered.citationCount} Citations</span>
                                    {hovered.nodeCount !== undefined && <span> • Papers: {hovered.nodeCount}</span>}
                                </div>
                                {hovered.authors && <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '5px' }}>{hovered.authors}</div>}
                            </>
                        )}
                    </div>
                )}
            </div>

            {/* Nav Stats Overlay */}
            <div style={{
                position: 'fixed',
                bottom: 10,
                right: 10,
                background: 'rgba(255, 255, 255, 0.8)',
                backdropFilter: 'blur(4px)',
                padding: '4px 8px',
                borderRadius: '4px',
                fontSize: '10px',
                color: '#94a3b8',
                pointerEvents: 'none',
                fontFamily: 'monospace'
            }}>
                {/* Placeholder IDs to be updated by Graph via DOM or ref if possible, 
                    or we pass props. For now, static placeholders or simple props if passed.
                    Ideally Graph updates this state, but to avoid re-renders, best to let Graph update specific DOM element.
                */}
                <span id="nav-debug-info">Zoom: 1.00 | X: 0 | Y: 0</span>
            </div>
        </div>
    );
};
