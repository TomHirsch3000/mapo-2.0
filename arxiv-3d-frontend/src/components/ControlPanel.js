
import React from 'react';
import '../styles/Galaxy.css'; // Ensure proper styling
import { SearchBar } from './SearchBar';

export const ControlPanel = ({
    viewMode,
    layout,
    grouping,
    selected,
    activeGroupLabel,
    galaxyName,
    searchQuery,
    onBackToUniverse,
    onBackToGalaxy,
    onBackFromSearch,
    onLayoutChange,
    onGroupingChange,
    onSearch,
    paperIndex,
    onAutocompleteSelect
}) => {

    const layoutOptions = [
        { label: "Central", value: "CENTRAL" },
        { label: "Timeline", value: "TIMELINE" }
    ];

    const groupingOptions = [
        { label: "Field", value: "FIELD" },
        { label: "Author", value: "AUTHOR" },
        { label: "Institution", value: "INSTITUTION" }
    ];

    // Header Title Logic
    let headerTitle = "Map of Physics";
    if (viewMode === 'UNIVERSE') {
        headerTitle = "Map of Physics";
    } else if (viewMode === 'GALAXY') {
        headerTitle = galaxyName || "Galaxy View";
    } else if (viewMode === 'FIELD' || viewMode === 'DETAIL') {
        headerTitle = selected ? selected.title : (activeGroupLabel || "Detail View");
    } else if (viewMode === 'SEARCH') {
        headerTitle = searchQuery ? `"${searchQuery}"` : "Search Results";
    }

    const isSearch = viewMode === 'SEARCH';

    return (
        <div className="galaxy-header">
            <div className="controls-row" style={{ display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'flex-start', position: 'absolute', top: 20, left: 20, pointerEvents: 'auto' }}>
                {viewMode === 'GALAXY' && <button className="back-to-galaxy" onClick={onBackToUniverse}>← Back</button>}
                {(viewMode === 'FIELD' || viewMode === 'DETAIL') && <button className="back-to-galaxy" onClick={onBackToGalaxy}>← Back</button>}
                {isSearch && <button className="back-to-galaxy" onClick={onBackFromSearch}>← Back</button>}

                {/* Layout Toggles - Hidden in Search view */}
                {!isSearch && (
                    <div className="control-group" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <strong style={{ color: '#64748b', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Layout</strong>
                        <div className="toggle-group">
                            {layoutOptions.map(opt => (
                                <button
                                    key={opt.value}
                                    className={`toggle-btn ${layout === opt.value ? 'active' : ''}`}
                                    onClick={() => onLayoutChange(opt.value)}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {/* Grouping Toggles - Only in Galaxy View */}
                {viewMode === 'GALAXY' && (
                    <div className="control-group" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <strong style={{ color: '#64748b', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Grouping</strong>
                        <div className="toggle-group">
                            {groupingOptions.map(opt => (
                                <button
                                    key={opt.value}
                                    className={`toggle-btn ${grouping === opt.value ? 'active' : ''}`}
                                    onClick={() => onGroupingChange(opt.value)}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

            </div>

            {/* Search Bar — always visible, top-right */}
            <div style={{ position: 'absolute', top: 20, right: 20, pointerEvents: 'auto' }}>
                <SearchBar onSearch={onSearch} currentQuery={searchQuery} paperIndex={paperIndex} onAutocompleteSelect={onAutocompleteSelect} />
            </div>

            <div className="galaxy-title">
                {headerTitle}
            </div>
        </div>
    );
};
