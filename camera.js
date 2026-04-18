// camera.js
// Tracks a viewport offset so the ship stays centered on the canvas.
//
// Zoom-correct centering:
//   The renderer scales the world by ZOOM around the canvas center.
//   In screen space the ship must sit at (canvasW/2, canvasH/2).
//   Working backwards through the renderer's transform chain:
//
//     screen = (world - offset) * zoom  +  canvas_center * (1 - zoom)
//
//   Setting screen = canvas_center and solving for offset gives:
//
//     offset = world - canvasCenter / zoom
//
//   Which is simply: center the ship in the *zoomed* viewport.

export function createCamera() {
  let offsetX = 0;
  let offsetY = 0;

  return {
    // shipX/Y   — ship world position
    // canvasW/H — current canvas pixel dimensions
    // zoom      — must match ZOOM constant in renderer.js exactly
    update(shipX, shipY, canvasW, canvasH, zoom = 1) {
      // How much world-space the canvas shows at this zoom level
      const visibleW = canvasW / zoom;
      const visibleH = canvasH / zoom;

      // Ship sits at the center of the visible region
      offsetX = shipX - visibleW / 2;
      offsetY = shipY - visibleH / 2;
    },

    get offsetX() { return offsetX; },
    get offsetY() { return offsetY; },
  };
}
