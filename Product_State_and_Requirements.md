# Map of Physics - Product Functional Specification
**Version:** 2.1 (Expanded & Embedded Requirements)
**Date:** 2026-02-13

This document serves as the single source of truth for the **Map of Physics** application. It details the functionality, design behavior, and implementation status of every feature.

---

## 1. Core Interface & Experience
The application is an interactive 2D visualization of academic papers arranged in a graph form. The design philosophy emphasizes immersion, smoothness, and a "premium" feel.

### Canvas & Environment
-   **Description**: A clean, expansive 2D chart rendered on a soft white/light grey background (~#f0f0f0).
-   **Grid**: The canvas must be free of visible gridlines to maintain an organic feel.
-   **Visual Style**: High-quality rendering with anti-aliasing.
    -   **Status**:
        -   [x] White/Grey Background
        -   [x] No visual gridlines

### Navigation & Camera
-   **Description**: Users navigate the space using standard pan and zoom controls (d3-zoom).
-   **Behavior**:
    -   **Panning**: Smooth inertial panning.
    -   **Zooming**: Centered around the mouse pointer.
    -   **Constraints**: Zoom extent should allow seeing the whole specific view or zooming in to card details.
    -   **Stats**: A debug/info overlay in the bottom-right corner must show the current Zoom Level (`k`) and Center Coordinates (`x`, `y`).
    -   **Status**:
        -   [x] Panning & Zooming
        -   [x] Smooth Transitions
        -   [ ] **Requirement**: Navigation Stats Overlay (Zoom/X/Y readout) working in real-time.

### Footer Panel (HUD)
-   **Description**: A persistent bottom panel taking up approximately 20% of the screen height.
-   **Behavior**:
    -   **Default**: Shows general map info or "Hover to explore".
    -   **Hover/Selection**: updates instantly to show summary details of the specific node (Field, Galaxy, or Paper).
    -   **Content**: Title, citations, year, and abstract (for papers).
    -   **Status**:
        -   [x] Always visible bottom panel
        -   [x] Dynamic content updating on Hover/Select
        -   [ ] **Requirement**: Footer Panel must show paper abstracts
        -   [ ] **Requirement**: Footer Panel must show title of galaxies in universe view


---

## 2. Universe View (Macro Level)
**Concept**: The highest level of abstraction. Nodes represent entire **Fields of Study** (e.g., "Quantum Mechanics", "Astrophysics").
the source of this data is the universe json file which is created by the backend process build_universe_json.py

### Layout Mode: Central (Cluster)
-   **Description**: Nodes are arranged in a packed spiral or cluster, emphasizing the "center of gravity" of physics.
-   **Node Appearance**:
    -   **Shape**: **Hexagons**.
    -   **Size**: Scaled by `totalWorksCount` (total papers in the field).
    -   **Color**: Distinct color per field ID.
-   **Physics/Logic**:
    -   Nodes gravitate toward the center (Radial force).
    -   Larger nodes (more papers) are pulled closer to the center.
    -   Collision detection prevents overlapping.
    -   **Status**:
        -   [x] Hexagon Shapes
        -   [x] Spiral/Central Packing
        -   [x] Size based on volume

### Layout Mode: Timeline (Chronological)
-   **Description**: Broad historical view of when fields emerged and evolved.
-   **Structure**:
    -   **X-Axis**: Represents Time (Year). Oldest on the left, newest on the right.
    -   **Y-Axis**: Vertical distribution to minimize overlap.
    -   **Projection**: Timeline must extend to **2026** to show current data without visual "drop-off".
-   **Node Appearance**:
    -   **Shape**: **Area Charts** (or "Stream shapes") showing the number of papers per decade.
    -   **Labeling**: Labels should appear to the right of the node (most recent data point).
-   **Status**:
    -   [x] Timeline Axis (Years)
    -   [x] Area Chart rendering for nodes
    -   [x] Projection to 2026
    -   [x] Labels aligned to the right

### Stub Galaxies
-   **Description**: Not all fields have detailed map data available locally.
-   **Behavior**: Fields with `!hasPapers` (no local data) must be:
    -   Visually distinct (Greyed out / Ghosted).
    -   **Non-interactive**: Clicking them does **not** enter Galaxy View.
    -   **Status**:
        -   [x] Greyed out visual style
        -   [x] Interaction disabled

---

## 3. Galaxy View (Meso Level)
**Concept**: A specific Field of Study (e.g., "Computer Science"). Nodes represent **Groups** of papers.

### Grouping Controls
-   **Description**: Users can dynamically regroup the data.
-   **Options**:
    -   **Field** (Default): Sub-fields or topics.
    -   **Author**: Groups papers by primary author.
    -   **Institution**: Groups papers by institution.
-   **Behavior**: Changing grouping triggers a smooth re-layout/transition.
    -   **Status**:
        -   [x] Grouping UI Controls (Control Panel)
        -   [x] Toggling functionality

### Layout Mode: Central (Cluster)
-   **Description**: Overview of the groups within this galaxy.
-   **Node Appearance**:
    -   **Shape**: **Circles**.
    -   **Size**: Proportional to the number of papers in the group.
    -   **Color**: Determined by the active grouping category.
-   **Logic**:
    -   Use a "Spiral" or center-weighted force layout.
    -   Largest groups in the center.
    -   **Status**:
        -   [x] Circle nodes
        -   [x] Center-weighted spiral layout

### Layout Mode: Timeline (Streamgraph)
-   **Description**: Shows the evolution of these groups over time.
-   **Structure**:
    -   **X-Axis**: Publication Year.
    -   **Y-Axis**: "Stream" centered. Largest groups positioned closest to Y=0 (center horizontal line), smaller ones further out.
-   **Status**:
    -   [x] Stream/River Layout sorting (Largest at center)

### Edges & Connections
-   **Description**: Visualizing the flow of citations between groups.
-   **Appearance**:
    -   **Bi-directional**: Separate edges for A->B vs B->A.
    -   **Curved**: Smooth quadratic bezier curves.
    -   **Style**: Tapering width (optional) or varying thickness based on connection weight.
    -   **Color**: Gradient or solid color matching the **Source** node.
-   **Interaction**:
    -   **Hover**: Hovering a node highlights ALL its connections. Unrelated nodes/edges fade to low opacity (0.1).
    -   **Status**:
        -   [x] Bi-directional curved edges
        -   [x] Weighted thickness
        -   [x] Color by Source
        -   [x] Hover highlighting

---

## 4. Topic View (Micro Level)
**Concept**: Viewing individual **Papers** within a selected Group or Topic.

### Node Appearance
-   **Shape**: **Rectangular Cards** (rounded corners).
-   **Content**: Paper Title (legible, wrapped).
-   **Size**: Base size, slightly scaled by citation count.
-   **Color**: Consistent with the paper's primary field.
    -   **Status**:
        -   [x] Rectangular "Card" Nodes
        -   [x] Title Text Rendering

### Layouts
-   **Timeline**: Papers arranged by specific publication year (X) and citation impact (Y-Center).
-   **Central**: Force-directed network.
    -   **Focused Mode**: If a specific paper is selected, it moves to the center. Connected papers "orbit" around it.
    -   **Orbit Logic**: Larger/More cited papers orbit *closer* to the center.
    -   **Status**:
        -   [x] Timeline placement
        -   [x] Central/focused force layout

---

## 5. Visual Physics & Transitions
The "feel" of the application is defined by how things move.

### Transitions
-   **View Switching (Universe <-> Galaxy)**:
    -   **Zoom In**:
        -   **Animation**: Nodes should "fly in". Start at scale `0.05` at the target position and animate to `1.0`.
        -   **Trigger**: triggered by clicking a node in the universe view or by scrolling in close enough to a node in the universe view
            **Action**: transition to galaxy view of the selected node, with default grouping (field) already selected and maintain current layout selection (central or timeline)
    -   **Zoom Out**:
        -   **Animation**: Nodes should appear instantly or fade in at their final positions. No "flying backwards" which can be disorienting.
        -   **Trigger**: triggered by clicking the "Zoom Out" button in the galaxy view or by scrolling far enough away from the center of the galaxy view
        -   **Action**: transition to universe view with the galaxy node the user has just come from at the center of the universe view and zoomed in, maintain current layout selection (central or timeline)

    -   **Status**:
        -   [] Zoom In "Fly" Effect
        -   [] Zoom Out Static/Fade

    **View Switching (Galaxy <-> topic)**:
    -   **Zoom In**:
        -   **Trigger**: triggered by clicking a node in the galaxy view or by scrolling in close enough to a node in the galaxy v iew
        -   **Action**: transition to topic view of the selected node, with default grouping (field) already selected and maintain current layout selection (central or timeline). all other nodes should not be shown
        -   **Animation**: nodes should start small and zoom towards the screen as if flying towards them. all nodes in the new view should be visible so the zoom should be adjusted according to the number of nodes
    -   **Zoom Out**:
        -   **Trigger**: triggered by clicking the "Zoom Out" button in the topic view or by scrolling far enough away from the center of the topic view
        -   **Action**: transition to galaxy view with the topic node the user has just come from at the center of the galaxy view and zoomed in, maintain current layout selection (central or timeline)
        -   **Animation**: transition to galaxy view with the topic node the user has just come from at the center of the galaxy view and zoomed in, maintain current layout selection (central or timeline)
    -   **Status**:
        -   [] Zoom In "Fly" Effect
        -   [] Zoom Out Static/Fade
    
-   **Layout Switching Universe view (Central <-> Timeline)**:
    -   **Movement**: morphing animation between hexagons and timeline graphs, slow interpolation (~1000ms) 
    -   **Behavior**: Nodes slide to new positions.
    -   **Status**:
        -   [x] functioning
        -   [] animation - needs work

-   **Layout Switching galaxy view (Central <-> Timeline)**:
    -   **Movement**: Deterministic, slow interpolation (~1000ms).
    -   **Behavior**: Nodes slide to new positions.
    -   **Status**:
        -   [x] functioning
        -   [] Smooth interpolation

### Determinism
-   **Requirement**: The map must be **Deterministic**.
-   **Definition**: If I leave a view and come back, every node must be in the **exact same pixel position** as before. No random jitter on re-entry.
    -   **Status**:
        -   [x] Seeded random number generators
        -   [x] Cached layout positions

---

## 6. Technical & Data
### Data Sources
-   **Universe**: `universe_fields.json`
-   **Galaxy/Papers**: Loaded dynamically based on selection.

### Styling
-   **Theme**: Light Mode / Premium. match `Galaxy.css`.
-   **Status**:
    -   [ ] **Verification Needed**: Ensure all UI components (dropdowns, panels) strictly adhere to the premium aesthetics defined in `Galaxy.css`.

