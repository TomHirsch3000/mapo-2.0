# Phase 2: Refinement & New Features - Galaxy Map

## Objective
Enhance the Galaxy View visualization, restore key interactions, and implement new layout and navigation features.

## Status: In Progress

## Tasks

### 1. Restore & Enhance Panels
- [x] **Restore Hover Panel**: Add a panel to display information about the node currently being hovered over.
- [x] **Restore/Verify Selected Panel**: Ensure the selected node panel is displaying correctly (including abstract).
- [ ] **Styling**: Ensure panels match the new Light Mode theme using `Galaxy.css`.

### 2. Galaxy View Physics & Layout
- [x] **Center-Weighted Layout**: numeric force update to pull larger (more cited) field nodes towards the center.
- [x] **Field Clustering**: Use `d3.forceLink` with `fieldEdges` to cluster connected fields together.
- [x] **Render Inter-Field Edges**: Draw lines between field nodes in Galaxy View based on `fieldEdges`.
- [x] **Edge Thickness**: Scale edge thickness based on the weight (number of connections) between fields.

### 3. Semantic Zoom
- [x] **Implement Zoom Listener**: Detect zoom level changes in `Galaxy View`.
- [x] **Auto-Transition**: Automatically switch to `FIELD` view for a specific field if the user zooms in closely enough to a field node.
- [x] **Smooth Transition**: Ensure the transition is seamless and preserves context.

### 4. Field View Layouts
- [x] **Central Layout**: Adjust Field View force simulation to position larger paper nodes centrally.
- [x] **Timeline Layout**: Implement an optional Left-to-Right chronological layout (x-axis = time).
- [x] **Toggle Button**: Add a UI control to switch between Central and Timeline layouts in Field View.

### 5. Interaction Refinement
- [x] **Edge Highlighting**: Verify that selecting a node highlights its connected edges in all views.
- [x] **Back Navigation**: Ensure "Back to Galaxy" works correctly from all states.

### 6. Dynamic Grouping & Galaxy Timeline
- [x] **Grouping Options**: Implement grouping by Field, Author, and Institution.
- [x] **Galaxy Timeline**: Enable Timeline layout for the Galaxy View (average year of group).
- [x] **Smooth Transitions**: Implement D3 join pattern to transition nodes instead of full re-render.
- [x] **UI Controls**: Add dropdown and toggle buttons for grouping and layout.

## Verification
- [x] Verify Hover Panel appears/disappears correctly.
- [x] Verify Galaxy View layout groups related fields.
- [x] Verify inter-field edges are visible and weighted.
- [x] Test Semantic Zoom functionality.
- [x] Test Field View layout toggling.
- [x] Test Grouping options (Author/Institution).
- [x] Test Galaxy Timeline transition.
- [x] **Timeline Metric Update**: Used first publication year (minYear) for Galaxy Timeline alignment.
- [x] **Semantic Zoom Entry**: Implemented logic to enter field/group view by zooming into a node.
- [x] **Timeline Axis**: Added visual axis with decade markers for Timeline Layout.
