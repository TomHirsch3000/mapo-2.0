
import React, { useState, useRef, useEffect, useCallback } from 'react';

export const SearchBar = ({ onSearch, currentQuery, paperIndex = [], onAutocompleteSelect }) => {
    const [value, setValue] = useState('');
    const [suggestions, setSuggestions] = useState([]);
    const [highlightIndex, setHighlightIndex] = useState(-1);
    const [showDropdown, setShowDropdown] = useState(false);
    const inputRef = useRef(null);
    const wrapperRef = useRef(null);
    const debounceRef = useRef(null);

    // Filter suggestions on input change (debounced)
    const handleInputChange = useCallback((e) => {
        const q = e.target.value;
        setValue(q);
        setHighlightIndex(-1);

        clearTimeout(debounceRef.current);
        if (!q.trim() || paperIndex.length === 0) {
            setSuggestions([]);
            setShowDropdown(false);
            return;
        }

        debounceRef.current = setTimeout(() => {
            const lower = q.toLowerCase();
            const matches = [];
            for (const paper of paperIndex) {
                if (paper.title && paper.title.toLowerCase().includes(lower)) {
                    matches.push(paper);
                    if (matches.length >= 8) break;
                }
            }
            setSuggestions(matches);
            setShowDropdown(matches.length > 0);
        }, 200);
    }, [paperIndex]);

    // Close dropdown on click outside
    useEffect(() => {
        const handleMouseDown = (e) => {
            if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
                setShowDropdown(false);
            }
        };
        document.addEventListener('mousedown', handleMouseDown);
        return () => document.removeEventListener('mousedown', handleMouseDown);
    }, []);

    const handleSelect = (paper) => {
        setValue('');
        setSuggestions([]);
        setShowDropdown(false);
        setHighlightIndex(-1);
        if (onAutocompleteSelect) onAutocompleteSelect(paper);
    };

    const handleSubmit = (e) => {
        e.preventDefault();
        if (highlightIndex >= 0 && suggestions[highlightIndex]) {
            handleSelect(suggestions[highlightIndex]);
            return;
        }
        const trimmed = value.trim();
        if (trimmed) {
            setSuggestions([]);
            setShowDropdown(false);
            onSearch(trimmed);
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Escape') {
            setValue('');
            setSuggestions([]);
            setShowDropdown(false);
            inputRef.current?.blur();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlightIndex(i => Math.min(i + 1, suggestions.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlightIndex(i => Math.max(i - 1, -1));
        }
    };

    const truncate = (str, len) => str && str.length > len ? str.slice(0, len) + '…' : str;

    return (
        <form className="search-bar" onSubmit={handleSubmit} role="search">
            <div className="search-bar-inner" ref={wrapperRef}>
                <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                    ref={inputRef}
                    className="search-input"
                    type="text"
                    value={value}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    onFocus={() => { if (suggestions.length > 0) setShowDropdown(true); }}
                    placeholder="Search topics, e.g. black holes…"
                    aria-label="Search topics"
                    autoComplete="off"
                />
                {value && (
                    <button
                        type="button"
                        className="search-clear-btn"
                        onClick={() => { setValue(''); setSuggestions([]); setShowDropdown(false); }}
                        aria-label="Clear search"
                    >
                        ✕
                    </button>
                )}

                {showDropdown && suggestions.length > 0 && (
                    <ul className="autocomplete-dropdown" role="listbox">
                        {suggestions.map((s, i) => (
                            <li
                                key={s.id}
                                className={`autocomplete-item${i === highlightIndex ? ' highlighted' : ''}`}
                                onMouseDown={() => handleSelect(s)}
                                onMouseEnter={() => setHighlightIndex(i)}
                                role="option"
                                aria-selected={i === highlightIndex}
                            >
                                <span className="autocomplete-title">{truncate(s.title, 80)}</span>
                                <span className="autocomplete-galaxy">{s.galaxyName}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            <button type="submit" className="search-submit-btn">
                Search
            </button>
        </form>
    );
};
