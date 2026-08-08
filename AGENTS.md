# Project Instructions

## Runtime

- This is a static browser app. Open `index.html` directly; there is no build step or backend.
- `script/main.index.js` is the main page logic. `css/style.main.css` contains the main page styles.

## Data Boundaries

- Treat `data/` as generated output. Update the generator inputs under `tools/` and run the documented generators instead of hand-editing generated data.
- Keep the screenshot recognition files and OpenCV loader compatible with the browser-only runtime.

## UI Behavior

- The real-time layout must keep cells belonging to one item visually continuous and use a light separator between different items.
- The item and selected-item tables use independent optional-column checkboxes; the optional columns start hidden.

## Validation

- Run `node --check script/main.index.js` after changing the main script.
- Verify user-visible changes by opening `index.html` in a browser.

## License

- Preserve the repository's Apache License 2.0 and upstream notices when modifying or redistributing the project.
