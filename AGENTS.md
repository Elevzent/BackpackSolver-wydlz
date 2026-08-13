# Project Instructions

## Runtime

- This is a static browser app. Open `index.html` directly; there is no build step or backend.
- `script/main.index.js` is the main page logic. `css/style.main.css` contains the main page styles.

## Scope

- Make personalized changes only in this repository. Do not modify sibling projects such as `knapsack-solver`.

## Data Boundaries

- Treat `data/` as generated output. Update the generator inputs under `tools/` and run the documented generators instead of hand-editing generated data.
- Keep the screenshot recognition files and OpenCV loader compatible with the browser-only runtime.
- `p` in the text atlas generates `previewAdjacent`; it is restricted to 1x1 neighbor bonuses and must remain a display-only estimate, outside Worker scoring, score bounds, totals, and layout ordering.

## UI Behavior

- The real-time layout must keep cells belonging to one item visually continuous and use a light separator between different items.
- The item and selected-item tables use independent optional-column checkboxes; the optional columns start hidden.

## Validation

- Run `node --check script/main.index.js` after changing the main script.
- Verify user-visible changes by opening `index.html` in a browser.

## Provenance and License

- This is a derivative of `gbcdby/knapsack-solver`; keep the original author attribution, upstream link, and Apache License 2.0 notices in README and LICENSE.
