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


### Navigation & Camera
-   **Description**: Users navigate the space using standard pan and zoom controls (d3-zoom).
-   **Behavior**:
    -   **Panning**: Smooth inertial panning.
    -   **Zooming**: Centered around the mouse pointer.
    -   **Constraints**: Zoom extent should allow seeing the whole specific view or zooming in to card details.
    -   **Stats**: A debug/info overlay in the bottom-right corner must show the current Zoom Level (`k`) and Center Coordinates (`x`, `y`).


### Footer Panel (HUD)
-   **Description**: A persistent bottom panel taking up approximately 20% of the screen height.
-   **Behavior**:
    -   **Default**: Shows general map info or "Hover to explore".
    -   **Hover/Selection**: updates instantly to show summary details of the specific node (Field, Galaxy, or Paper).
    -   **Content**: Title, citations, year, and abstract (for papers).

### Status
        -   [x] White/Grey Background
        -   [x] No visual gridlines
        -   [x] Panning & Zooming
        -   [] Smooth Transitions between views and layouts with animations
        -   [ ] **Requirement**: Navigation Stats Overlay (Zoom/X/Y readout) working in real-time.
        -   [x] Always visible bottom panel
        -   [x] Dynamic content updating on Hover/Select
        -   [x] **Requirement**: Footer Panel must show paper abstracts
        -   [x] **Requirement**: Footer Panel must show title of galaxies in universe view

---

## 2. Universe View (Macro Level)
**Concept**: The highest level of abstraction. Nodes represent entire **Fields of Study** (e.g., "Quantum Mechanics", "Astrophysics").
the source of this data is the universe json file which is created by the backend process build_universe_json.py. This is the landing page of the application.

### Layout Mode: Central (Cluster)
-   **Description**: Nodes are arranged in a packed spiral or cluster, emphasizing the "center of gravity" of physics.
-   **Node Appearance**:
    -   **Shape**: **Hexagons**.
    -   **Size**: Scaled by `totalWorksCount` (total papers in the field).
    -   **Color**: Distinct color per field ID.
    -   **Shimmer**: node body color should shimmer when they are hovered
-   **Physics/Logic**:
    -   placement is deterministic
    Nodes gravitate toward the center (Radial force).
    -   Larger nodes (more papers) are pulled closer to the center.
    -   Collision detection prevents overlapping.
-   **Pictures**
    -   The hexagons should contain a picture which represents the field. The picture should be a small image of a symbol or icon which represents the field. 
    -   The pictures will be stored in a folder called "universe_pictures" in the same directory as the universe json file. 

### Layout Mode: Timeline (Chronological)
-   **Description**: Broad historical view of when fields emerged and evolved.
-   **Structure**:
    -   **X-Axis**: Represents Time (Year). Oldest on the left, newest on the right.
    -   **Y-Axis**: Vertical distribution to have no overlap and leave the same amount of white space between nodes regardless of node size. 
    -   **Projection**: Timeline must extend to **2026** to show current data without visual "drop-off". this makes it look like there are more papers in this decade than last despite only being half way through the decade. 
-   **Node Appearance**:
    -   **Shape**: **Area Charts** (or "Stream shapes") showing the number of papers per decade.
    -   **Labeling**: Labels should appear to the right of the node (most recent data point).
    -   **Shimmer**: node body color should shimmer when they are hovered

### Stub Galaxies
-   **Description**: Not all fields have detailed map data available locally.
-   **Behavior**: Fields with `!hasPapers` (no local data) must be:
    -   Visually distinct (Greyed out / Ghosted).
    -   **Non-interactive**: Clicking them does **not** enter Galaxy View.

### Status
    -   [] central node appearance -Hexagon Shapes - need work the colours look bland and nodes are too big
    -   [x] Central layoutSpiral/Central Packing
    -   [x] Timeline Axis (decades)
    -   [x] Timeline node appearance - Area Chart rendering for nodes
    -   [x] Projection to 2026
    -   [x] timeline layout
    -   [ ] **Requirement**: Universe View must show field pictures

---

## 3. Galaxy View (Meso Level)
**Concept**: A specific Field of Study (e.g., "Computer Science"). Nodes represent **Groups** of papers.
### UI Layout 
- title should show the name of the galaxy we're in 
- buttons should show layout options and grouping options 
- button poitioning should be on the left 
- Footer pannel:   
    - should remain as per general specification and show specific data on hover: 
    - title of the group 
    - total number of papers and total citations of papers in the group 
    - paper title, publising date and abstract from earliest paper in the group 

### Grouping Controls
-   **Description**: Users can dynamically regroup the data.
-   **Options**:
    -   **Field** (Default): Sub-fields or topics.
    -   **Author**: Groups papers by primary author.
    -   **Institution**: Groups papers by institution.
-   **Behavior**: Changing grouping triggers a smooth re-layout/transition.

### Layout Mode: Central (Cluster)
-   **Description**: Overview of the groups within this galaxy.
-   **Node Appearance**:
    -   **Shape**: **Circles**.
    -   **Size**: Proportional to the number of papers in the group.
    -   **Color**: Determined by the active grouping category.
    -   **Shimmer**: on hover node colour should shimmer and other nodes should fade to low opacity (0.1)
-   **Logic**:
    -   Use a "Spiral" or center-weighted force layout.
    -   Largest groups in the center. !! not sure about this???
-   **Pictures**
    -   The circles should contain a picture which represents the field. The picture should be a small image of a symbol or icon which represents the field. 
    -   The pictures will be stored in a folder called "galaxy_pictures" in the same directory as the universe json file. 

### Layout Mode: Timeline (Streamgraph)
-   **Description**: Shows the evolution of these groups over time. Nodes should be positioned with their left most point at the correct date on the timeline. They should be spread out from the vertical center so they do not overlap. The shape of the nodes in this view should be long and thin so they represent when papers were being published in this area. The right most point should be the date of the last paper being published. 
-   **Node Appearance**:
    -   **Shape**: **Area Charts** (or "Stream shapes") showing the number of papers per decade.
    -   **Labeling**: Labels should appear to the right of the node (most recent data point).
-   **Structure**:
    -   **X-Axis**: First publication Year defines the left most point, last publication year defines the right most point.
    -   **Y-Axis size**: defines the height of the graph in any 
    -   **Y-Axis**: "Stream" centered. Largest groups positioned closest to Y=0 (center horizontal line), smaller ones further out.


### Edges & Connections
-   **Description**: Visualizing the flow of citations between groups.
-   **Appearance**:
    -   **Bi-directional**: Separate edges for A->B vs B->A.
    -   **Curved**: Smooth quadratic bezier curves.
    -   **Style**: Tapering width (optional) or varying thickness based on connection weight.
    -   **Color**: Gradient or solid color matching the **Source** node.
-   **Interaction**:
    -   **Hover**: Hovering a node highlights ALL its connections. Unrelated nodes/edges fade to low opacity (0.1).

### Status
    -   [ ] Galaxy View must show title currently just says 'galaxy view'
    -   [x] layout and grouping controls
    -   [ ] Footer pannel should show specific data
    -   [x] Node appearance central - needs work, they look a bit basic
    -   [x] Node appearance timeline - needs work, they look a bit basic   
    -   [] Node layout Central- Center-weighted spiral layout - layout is a bit random
    -   [] Node layout Timeline - Center-weighted spiral layout - layout is a bit random
    -   [x] Edges: Bi-directional curved edges 

---

## 4. Topic View (Micro Level)
**Concept**: Viewing individual **Papers** within a selected Group or Topic according to the layout and grouping options selected in the galaxy view.

### Node Appearance
-   **Shape**: **Rectangular Cards** (rounded corners).
-   **Content**: Paper Title (legible, wrapped).
-   **Size**: Base size, slightly scaled by citation count.
-   **Color**: Consistent with the paper's primary field.


### Edges
 - **Description**: Visualizing the flow of citations between papers.
- **Appearance**:
    -   **Directional**: visual cue as to which way the citation is going
    -   **Curved**: Smooth quadratic bezier curves.
    -   **Style**: Tapering width (optional) or varying thickness based on connection weight.
    -   **Color**: Gradient or solid color matching the **Source** node.
- **Interaction**:
    -   **Hover**: Hovering a node highlights ALL its connections. Unrelated nodes/edges fade to low opacity (0.1).

### Layouts
-   **Timeline**: Papers arranged by specific publication year (X) and citation impact (Y-Center).
-   **Central**: larger nodes in the center with smaller nodes radiating away. no overlapping. 
    
### Status
    -   [x] Node appearance Rectangular "Card" Nodes
    -   [] Node layout Central
    -   [] Node layout Timeline
    -   [] Edges: directional curved edges
    -   [] Hover highlighting
     



---
## 5. Paper view 
-   **Description**: When a specific paper is selected, it moves to the center of view. All connected papers "orbit" around it, including papers from other galaxy groupings. All non connected papers are no longer visible (removed)
-   **Orbit Logic**: Larger/More cited papers orbit *closer* to the center.
- **Appearance** as per topic view
### Layouts
-   **Timeline**: Papers arranged by specific publication year (X) and citation impact (Y-Center).
-   **Central**: larger nodes in the center with smaller nodes radiating away. no overlapping. 
### actions
-   **Hover**: Hovering a node highlights ALL its connections. Unrelated nodes/edges fade to low opacity (0.1). It also displayes the title, authors, citation count, abstract, authors and institutions in the footer panel. 
-   **Click**: Clicking a node moves it to the center of view and all connected papers "orbit" around it, including papers from other galaxy groupings. All non connected papers are no longer visible (removed). It also displayes the title, authors, citation count, abstract, authors and institutions in the footer panel. 

### Status
        -   [] Node appearance Rectangular "Card" Nodes
        -   [] Node layout Central
        -   [] Node layout Timeline
        -   [] Edges: directional curved edges
        -   [] Hover highlighting
        -   [] Click to transition to next paper view 

---

## Detailed paper view
**description** 
when a specific paper is selected and double clicked the map shows all connected papers, including papers from the database which are not in the json files. This requires a function in the backend to get the connected papers from the database and return them to the frontend. It should query the database edges table for a list of papers connected to the selected paper and then query the database nodes table for the details of those papers. It should return the papers to the frontend and be presented as nodes in the same way as the normal paper view.

There is currently only 1 valid database file with all the papers within that field and its papers_particle_physics_all.db

There should be a popup whne double clicking that asks the user to confirm the details of the request including the minimum number of citations and the maximum number of papers to display. 
And there should be a timeout asking for confirmation to continue if the request is taking longer than 10 seconds. 
The popups should be themed along with the rest of the website, neutral colours. 

### Status
    -   [ ] Edges: showing the correct number - not edges between the connected nodes, only edges to the selected node
    -   [ ] 



## 6. Visual Physics & Transitions
The "feel" of the application is defined by how things move.

### Transitions
 - Landing page Universe view central layout
 No animations 
 All hexagons should be visible and the camera should be adjusted to fit all nodes in the view.

-   **View Switching (Universe <-> Galaxy)**:
    -   **Zoom In**:
        -   **Animation**: Node position shouldbe determined before anything is shown so there is no positioning animation. However, Nodes should "fly in" towards the screen by starting very small and getting bigger until they reach their final size. Once they reach their final size, all nodes should be visible and the camera should be adjusted to fit all nodes in the view.
        -   **Trigger**: triggered by clicking a node in the universe view or by scrolling in close enough to a node in the universe view
        -   **Action**: transition to galaxy view of the selected node, with default grouping (field) already selected and maintain current layout selection (central or timeline)
        -   **Sequence**:
            1. remove all nodes from the view, blank screen 
            2. set camera to high zoom level
            3. load the list of nodes to be shown in the galaxy view but don't show them
            4. calculate the node positions for each node by running the simulation in the background, still nothing is showing
            5. once the simulation is finished, add all nodes to the view at size 0
            6. animate all nodes to their final size
            7. adjust camera to fit all nodes in the view
            8. calculate the edges points and colours
            9. fade in the edges 
            10. fade in the labels


    -   **Zoom Out**:
        -   **Animation**: Nodes should appear instantly or fade in at their final positions. No "flying backwards" which can be disorienting.
        -   **Trigger**: triggered by clicking the "Zoom Out" button in the galaxy view or by scrolling far enough away from the center of the galaxy view
        -   **Action**: transition to universe view with the galaxy node the user has just come from at the center of the universe view and zoomed in, maintain current layout selection (central or timeline)
        -   **Sequence**:
            1. remove all nodes from the view, blank screen 
            2. set camera to high zoom level
            3. load the list of nodes to be shown in the galaxy view but don't show them
            4. calculate the node positions for each node by running the simulation in the background, still nothing is showing
            5. once the simulation is finished, add all nodes to the view at size 0
            6. animate all nodes to their final size
            7. adjust camera to fit all nodes in the view
            8. calculate the edges points and colours
            9. fade in the edges 
            10. fade in the labels
    ### Status
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
    ### Status
        -   [] Zoom In "Fly" Effect
        -   [] Zoom Out Static/Fade
    
-   **Layout Switching Universe view (Central <-> Timeline)**:
    -   **Movement**: morphing animation between hexagons and timeline graphs, slow interpolation (~1000ms) 
    -   **Behavior**: Nodes slide to new positions.
    ### Status
        -   [x] functioning
        -   [] animation - needs work

-   **Layout Switching galaxy view (Central <-> Timeline)**:
    -   **Movement**: Deterministic, slow interpolation (~1000ms).
    -   **Behavior**: Nodes slide to new positions.
    ### Status
        -   [x] functioning
        -   [] Smooth interpolation

### Determinism
-   **Requirement**: The map must be **Deterministic**.
-   **Definition**: If I leave a view and come back, every node must be in the **exact same pixel position** as before. No random jitter on re-entry.
    ### Status
        -   [x] Seeded random number generators
        -   [x] Cached layout positions

---

## 6. Technical & Data
### Data Sources
-   **Universe**: `universe_fields.json`
-   **Galaxy/Papers**: Loaded dynamically based on selection.

### Styling
-   **Theme**: Light Mode / Premium. match `Galaxy.css`.
### Status
    -   [ ] **Verification Needed**: Ensure all UI components (dropdowns, panels) strictly adhere to the premium aesthetics defined in `Galaxy.css`.

