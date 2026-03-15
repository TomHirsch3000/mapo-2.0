
import React, { useState, useRef } from 'react';

export const SearchBar = ({ onSearch, currentQuery }) => {
    const [value, setValue] = useState('');
    const inputRef = useRef(null);

    const handleSubmit = (e) => {
        e.preventDefault();
        const trimmed = value.trim();
        if (trimmed) onSearch(trimmed);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Escape') {
            setValue('');
            inputRef.current?.blur();
        }
    };

    return (
        <form className="search-bar" onSubmit={handleSubmit} role="search">
            <div className="search-bar-inner">
                <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                    ref={inputRef}
                    className="search-input"
                    type="text"
                    value={value}
                    onChange={e => setValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Search topics, e.g. black holes…"
                    aria-label="Search topics"
                />
                {value && (
                    <button
                        type="button"
                        className="search-clear-btn"
                        onClick={() => setValue('')}
                        aria-label="Clear search"
                    >
                        ✕
                    </button>
                )}
            </div>
            <button type="submit" className="search-submit-btn">
                Search
            </button>
        </form>
    );
};
