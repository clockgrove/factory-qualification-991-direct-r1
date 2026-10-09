# Incident explorer frontend

Serve this directory from the local app's same origin. `index.html` loads `app.js`, `state.js`, and `styles.css`; requests use the settled `/api/incidents`, `/api/incidents/:id`, and `/api/export.csv`, and `/api/overview` endpoints. No dataset or server is embedded in the frontend.

Search is submitted with Search or Enter. Facet, date, sorting, and page-size changes apply immediately and return to page one. Dates and displayed timestamps use UTC. The overview and daily counts describe the full matching result. While updating, the previous completed rows and summaries remain explicitly marked, and page controls are disabled. CSV exports the current applied selections and sort, across all pages; tags follow the API's JSON-array CSV representation.

Copy or bookmark the browser address to share the applied query, including sorting, page size and later pages. Reload and fresh tabs restore the results view. Back and Forward restore controls (discarding unsent drafts), rows and whole-result summaries; pending requests retain the previous snapshot as stale. Details and export activity do not create history entries. Invalid address values fall back to defaults; invalid dates clear and reversed date ranges clear both bounds. Unknown parameters are removed.

Named views persist the applied search, facets, dates, sorting, and page size in browser localStorage. Opening a view applies its selections together and returns to page one. Storage failures are visible and exploration remains available.

The native details dialog supports keyboard dismissal, exposes every incident field as text, and restores focus to the incident on return. Results, detail sessions, and exports have separate ownership tokens. Each completion, error, and cleanup is gated; changed selections invalidate details and export downloads. Cancellation helps save work but tokens provide correctness. Download object URLs are released.

Run the repository's exact verification command from the checkout:

```sh
npm test
```

Discoverable tests under `tests/frontend/` exercise the actual DOM-free state module with direct events. These establish component behavior, including overlapping intents and retries; they do not establish real HTTP or browser integration. The integration suites run real sandbox-enabled Chromium against the existing backend and compare with an independent canonical-data oracle. See the root README for preparation, browser qualification and startup instructions.

Component review: `state.js` separates the requested intent from the last displayed snapshot and publishes rows and whole-result summaries atomically. Pending or stale queries lock pagination, and synchronous page transitions are clamped before dispatch. The UI retains the native modal and return target while detail ownership changes; it renders dataset values through text nodes. Independent operation tokens gate success, failure, and cleanup, and export gates download side effects after reading the response. This review establishes frontend structure and state behavior only.

## Operational overview and personal triage

The overview uses the backend's full filtered result and shows service incident,
unresolved, critical-or-high counts and resolved-only average hours. No resolved
incidents means “Unavailable”. Unresolved count descending, then service name,
sets the order. The phone layout starts with this overview; navigation links
reach the incident list, triage and filters. Cards expose every measure without
horizontal scrolling.

`overviewKey` in `state.js` identifies only search, facets and inclusive UTC dates.
Every filter change synchronously invalidates overview ownership before another
request starts. Success, failure and finish events check both token and pending
state. Abort is an optimization; the token guards correctness after reading JSON.
Page, page-size and sort transitions keep the same overview because these cannot
change its measures. `renderOverview` displays cards only if their key matches the
current selection, with a current-selection label, loading status, empty state
and a Retry action that uses the current intent. This source ownership review
complements the bounded real-browser overlap/failure journey and component tests
that explicitly attempt obsolete success, failure and cleanup writes.

`triage.js` validates stored personal snapshots and supplies ordered add, note
edit and removal operations. Its separate `incident-explorer.triage.v1` localStorage
key never enters query parameters or requests. Add deduplicates by ID; removal
also removes the note. Rendering uses textContent/text nodes and textarea.value,
not HTML. Notes are plain text limited to 1,000 characters. Read/parse failures
explain that earlier entries could not be restored. Writes update memory first;
a failed write retains current membership and notes with a visible visit-only
persistence message. Reload, malformed values and a runtime SecurityError from
Storage methods are exercised in real Chromium. The latter is an induced storage
denial, not proof of a specific browser privacy configuration.

`tests/integration/workspace.test.mjs` starts actual loopback HTTP and sandboxed
Chromium, checks full-result cards against canonical calculations, keyboard
navigation and actions, a fresh 375px phone visit, actual connection failure and
retry, overlapping searches, persisted literal notes and deletion. It saves
phone screenshots under ignored `.runtime/` and closes all owned resources in
finally blocks. `npm test` discovers these additions and retains all original
regression tests.
