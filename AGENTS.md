# Project Instructions

## Runtime

- This is a static browser app. Open `index.html` directly; there is no build step or backend.
- `script/main.index.js` is the main page logic. `css/style.main.css` contains the main page styles.

## Scope

- Make personalized changes only in this repository. Do not modify sibling projects such as `knapsack-solver`.

## Data Boundaries

- Treat `data/` as generated output. Update the generator inputs under `tools/` and run the documented generators instead of hand-editing generated data.
- Keep the screenshot recognition files and OpenCV loader compatible with the browser-only runtime.
- On a CSP-protected deployment, `script-src` must allow `blob:`, `'wasm-unsafe-eval'`, and `'unsafe-eval'`; OpenCV uses Blob injection, WASM, and embind's `new Function(...)` bindings.
- `p` in the text atlas generates `previewAdjacent` for 1x1 neighbor bonuses. Multi-cell items with an adjacent bonus also participate when the user enables the adjacent-bonus switch. Include both cases consistently in main-thread totals, Worker scoring, score bounds, and layout ordering; when disabled, they contribute nothing.

## UI Behavior

- The real-time layout must keep cells belonging to one item visually continuous and use a light separator between different items.
- The item and selected-item tables use independent optional-column checkboxes; the optional columns start hidden.

## Validation

- Run `node --check script/main.index.js` after changing the main script.
- Run `node tools/test-adjacent-bonus.js` after changing adjacent-bonus scoring.
- Verify user-visible changes by opening `index.html` in a browser.

## Provenance and License

- This is a derivative of `gbcdby/knapsack-solver`; keep the original author attribution, upstream link, and Apache License 2.0 notices in README and LICENSE.
