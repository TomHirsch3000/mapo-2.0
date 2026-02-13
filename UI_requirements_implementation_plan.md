# Implementation Plan - Layout & Transition Refactoring

## Goal Description
Refactor the "Map of Physics" UI to separate Layout (Central/Timeline) from Grouping (Field/Author/Institution). Ensure layout choices persist across transitions. Implement a specific "Central" layout algorithm (size-based spiral) and refine zoom transition choreography to be smoother and more deliberate, preventing chaotic node movement.

## User Review Required
> [!IMPORTANT]
> The "Grouping" control will strictly toggle *how nodes are defined* (aggregation strategy) in Galaxy View, not just their positions. This means changing Grouping triggers a data reprocessing.

> [!WARNING]
> **Universe Timeline View**: This layout is considered delicate and "done". We will ENSURE no logic changes are applied to `Universe` + `Timeline`.

## Proposed Changes

### State Management (`App.js`)
*   Replace `xAxisMode` and `yGroupingMode` with:
    *   `layout`: `'CENTRAL' | 'TIMELINE'` (Global persistence).
    *   `grouping`: `'FIELD' | 'AUTHOR' | 'INSTITUTION'` (Galaxy View only).
*   **Field/Detail Views**: Support "Central" and "Timeline" layouts. (No grouping control).

### UI Controls
*   Replace Dropdowns with Toggle Buttons / Radio Groups.
*   **Universe**: "Layout" [Central | Timeline].
*   **Galaxy**: "Layout" [Central | Timeline], "Grouping" [Field | Author | Institution].
*   **Field/Detail**: "Layout" [Central | Timeline].

### Overlay & HUD
*   **Dynamic Title**: Update header to display the specific Name of the current Galaxy ("Physics", "Computer Science") or Field/Group ("Quantum Mechanics") instead of generic "Map of Physics".
*   **Navigation Stats**: Add a small readout (bottom-right) showing:
    *   Zoom Level (`k`).
    *   Center Coordinates (`x`, `y`).
    *   Useful for navigation understanding.

### Layout Logic
*   **General Constraint**: **Deterministic Positioning**. `(NodeID, LayoutMode) -> (X, Y)` must be constant. Use hashing or cached positions. Nodes must *return* to their previous home, not find a new random one.
*   **Universe Timeline**: **PRESERVE EXACTLY**. Do not touch.
*   **Universe Central**:
    *   **Spiral Layout**: Implement "Largest (Center) -> Smallest (Outer)" spiral packing.
    *   Reduce hexagon size.
*   **Galaxy Central**:
    *   **Spiral Layout**: Sort by `val` (size). Largest at center.
*   **Galaxy Timeline**:
    *   **X-Axis**: Publication Year.
    *   **Y-Axis**: "Stream" centered.
        *   **Vertical Center**: Largest nodes (by citations/size) positioned closest to Y=0.
        *   **Outer**: Smaller nodes placed further out (alternating +Y, -Y).
*   **Field View**:
    *   **Timeline**: Standard X=Year. **Y-Axis**: "Stream" centered (Largest at Y=0).
    *   **Central**: Force-directed or Spiral packing (similar to Galaxy Central).
*   **Detail View** (Selected Paper):
    *   **Timeline**: Selected paper + connected papers. **Y-Axis**: "Stream" centered (Largest at Y=0).
    *   **Central**: Selected paper at center. Connections orbiting.
        *   **Distance**: Inverted size logic. Larger connections orbit *closer* to center. Smaller connections orbit *further* away.

### Depth Transition (Zoom In/Out)
*   **General Rule**: Nodes MUST NOT move (x/y interpolate) during view switching. They must spawn at their final destination.
*   **Zoom In** (Universe -> Galaxy, Galaxy -> Field):
    *   *Start State*: Nodes at final X/Y positions, Scale = `0.05` (Tiny).
    *   *Animation*: `transform: scale(0.05) -> scale(1)`. Duration ~800ms.
    *   *Effect*: Nodes appear to "zoom in" from the distance towards the camera.
*   **Zoom Out** (Field -> Galaxy, Galaxy -> Universe):
    *   *Context*: Returning to a higher level.
    *   *Start State*: **Zoomed In** on the specific node/group we just left.
    *   *Animation*: None (Instant placement).
    *   *Interaction*: User starts "too close" and must manually zoom out/scroll to see the rest of the map.
    *   *Constraint*: No flying nodes.

### Layout Transition (Switching Central/Timeline)
*   **Context**: Switching Layout *within* the same View (e.g., Galaxy Central -> Galaxy Timeline).
*   **Animation**: Slow, controlled interpolation of X/Y coordinates.
*   **Speed**: ~1000ms duration.
*   **Style**: Ease-in-out. Nodes slide to new deterministic positions.

## Verification Plan
### Manual Verification
*   **Layout Persistence**: Switch to "Timeline" in Universe, click a Galaxy. Verify Galaxy view opens in "Timeline". Switch to "Central", go back. Verify Universe uses "Central".
*   **Grouping**: Inside Galaxy, switch Grouping to "Author". Verify nodes change to Authors. Switch Layout to "Timeline". Verify Authors are on a timeline.
*   **Transitions**:
    *   Zoom in: Check "fly in" effect.
    *   Zoom out: Check "fade in place" (no fly) effect.
*   **Visuals**: Check size of Universe hexagons.
