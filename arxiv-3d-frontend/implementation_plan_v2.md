# Map of Physics Implementation Plan

## 1. Field View Refinement (Immediate)
- [x] **Filter Nodes**: Modify `useGraphData.js` to filter nodes by `activeGroup` when in `FIELD` view.
- [ ] **Node Styling**: Ensure `Graph.js` renders these filtered nodes as "Rectangular cards with curved corners" as per Brief.
- [ ] **Edges**: Ensure edges only show connections between visible papers.

## 2. Universe View Enhancements
- [ ] **Data Source**: Verify `universe.json` structure aligns with "universe_fields.json" concept.
- [ ] **Timeline Layout**: Ensure nodes are "charts showing number of papers per decade".
- [ ] **Tooltip/Hover**: Update `FooterPanel` or Tooltip to show specialized data:
    - Total papers in field
    - Number of papers in map
    - First publication date/title
    - Most cited paper/title

## 3. Galaxy View (Aggregated)
- [ ] **Layout**: Ensure "Central" layout uses the aggregated nodes.
- [ ] **Shape**: Confirm nodes are Circles.
- [ ] **Color/Size**: Verify color by active grouping and size by paper count.
- [ ] **Interaction**: Ensure clicking a group navigates to Field View.

## 4. Paper View (Micro Level)
- [ ] **Concept**: Distinct view for single paper + links.
- [ ] **Implementation**: Can be a sub-state of `FIELD` view or a new `App.js` viewMode `PAPER` (or `DETAIL`).
- [ ] **Visuals**:
    - Focus on selected node.
    - Show neighbors.
    - Fade others.
    - Edges color-coded (Citations vs References).

## 5. Transitions & Navigation
- [ ] **Galaxy <-> Field**: Smooth transition.
- [ ] **Zoom Behavior**: "As you zoom in, nodes grow slightly...".
- [ ] **Z-Axis/Parallax**: Implement pseudo-3D effect based on citation count.

## 6. Backend / AI Process (Python)
- [ ] **Mislabel Detection**: New script to check paper titles/abstracts against fields using LLM.
- [ ] **Field Normalization**: Count fields, subset to top 50, re-assign papers to this subset.
