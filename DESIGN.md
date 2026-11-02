# herdr-plannotator design

A native herdr-app mod that replaces Plannotator's browser page. Plannotator
still runs its own local server. Instead of a browser it opens a herdr pane,
and that pane talks to the same server over HTTP.

## What "compatible" means

herdr-app has no web view (AGENTS.md, "You can't: use HTML, CSS, a web view").
So compatibility means **the wire, not the pixels**:

1. The server receives the same request bodies the React app sends
   (`/api/approve`, `/api/deny`, `/api/feedback`, `/api/exit`, `/api/draft`),
   with the same `serverSession` and `draftGeneration` fields.
2. The agent receives byte-identical feedback markdown, because the export code
   is Plannotator's own, vendored by `tools/update-vendor.sh` from the tag of
   the installed CLI (`PINNED_VERSION` in the bundle). We do not reimplement export.
3. Every feature we don't draw natively is one click away: the header's
   **Open in browser** button opens the same session URL in the system browser
   (`cx.open_url`). The session stays the same, so nothing is lost.

## Pieces

```
bin/plannotator-herdr      launcher + wrapper (one script, two modes)
mod/main.js                View: loads the session, picks the mode view
mod/api.js                 HTTP client for one Plannotator session
mod/decision.js            Plannotator's DecisionControl, drawn from upstream's DecisionSpec
mod/doc/                   plan + annotate document view (markdown blocks)
mod/review/                code review view (diff)
mod/vendor/plannotator.js  GENERATED. bun bundle of upstream export/parse code
vendor-src/entry.ts        the bundle's entry: re-exports + payload builders
tools/update-vendor.sh     checks out the installed CLI's tag, runs build-vendor.ts
tests/                     builder tests, CLI e2e (e2e.ts), pane e2e (pane-e2e.sh)
skill/plannotator-herdr/   the agent skill install.sh links into ~/.claude/skills
```

### Launcher (`bin/plannotator-herdr`)

- `plannotator-herdr <http(s)://url>`: browser mode. Plannotator calls
  `[PLANNOTATOR_BROWSER, url]` and **waits for it to exit**, so this must return
  at once. It finds the pane of `$HC_TERMINAL_ID` (the agent's terminal) in
  `herdr-app ls`, runs `pane.split {direction: "right", pane, mod: "plannotator",
  props: {url}}`, else `tab.new {mod, props}`. With no herdr window it falls
  back to `xdg-open`.
- `plannotator-herdr <anything else>`: wrapper mode, `exec plannotator "$@"`
  with `PLANNOTATOR_BROWSER` pointing at itself. So `plannotator-herdr annotate
  plan.md` opens in herdr, and plain `plannotator` keeps the browser.

### Session load and mode (`main.js`, `api.js`)

`props().url` is the session origin. Mode detection:

- `GET /api/plan` 200 with `mode: "annotate"`: annotate (markdown or folder).
  `renderAs: "html"` or a diagram kind is not drawn natively. Show the
  open-in-browser notice.
- `GET /api/plan` 200 with no `mode`: plan review (ExitPlanMode hook).
- `GET /api/plan` 200 with `mode: "archive"`: archive browser.
- `GET /api/diff` 200: code review.

Session state is one state machine, never loose booleans:

```
loading -> ready -> submitting -> done{approved|denied|sent|closed|exited}
                \-> error{message}      submitting -> ready (on failure, toast)
```

After `done`, the pane shows a short result and closes itself after 2 s
(`run("pane.close", {pane})`, the pane id from `panes()` for this copy).

### Document view (plan + annotate)

Data:

```
Block        upstream parseMarkdownToBlocks() output (id, type, content, level, ...)
Token        { blockId, i, text, style: {bold, italic, code, strike, link?}, start, end }
             one word of a block's rendered text; start/end are offsets into the
             block's rendered text, which is what Annotation.startOffset/endOffset mean
Selection    { anchor: {blockId, i}, focus: {blockId, i} } | null
Annotation   upstream type, verbatim: { id, blockId, startOffset, endOffset,
             type: "COMMENT"|"DELETION"|"GLOBAL_COMMENT", text?, originalText,
             createdA, images: [] }
```

Text selection is ours. `TextView` is selectable but cannot report the
selection, so each block renders as a `flex_wrap` row of word tokens. Press on a
word sets the anchor, moving over words while pressed moves the focus, release
opens the composer. A double click selects a word. Clicking a code block,
table cell or diagram line selects that unit.

The composer offers **Comment**, **Delete** (redline) and the global comment
box in the panel. The right panel lists annotations in document order, each
editable and removable. Highlights: comment = accent underline/background,
deletion = strikethrough in the deletion color.

Decisions, plan mode: **Approve** (`/api/approve`, with notes when any exist),
**Send feedback** (`/api/deny`). Annotate mode: **Send feedback**
(`/api/feedback`), **Approve** only when `gate` is on, **Close** (`/api/exit`).
The bodies come from vendor payload builders, never hand-built.

Drafts: `GET /api/draft` on load restores annotations, `POST /api/draft` after
each change (debounced), `DELETE` after a decision.

### Review view

`GET /api/diff` gives `rawPatch`. Upstream's patch parsing splits it into
files and hunks. Left: file list with +/- counts and viewed checkboxes. Right:
unified diff for the selected file, line numbers both sides, add/remove
coloring. Click a line number (shift-click extends) to open a line comment.
A general comment box. **Send feedback** and **Approve** post `/api/feedback`
with the upstream review body (`exportReviewFeedback` and friends). Diff type
switch (`/api/diff/switch`) is a dropdown in the header.

## Out of scope (open in browser instead)

Ask AI and agent jobs, Code Tours and Guided Reviews, call flow and semantic
diff, image upload and attachments, Obsidian/Bear/Octarine saves, plan version
diff view, raw HTML pinpoint annotation, live-app annotation, the Inbox, PR
platform actions, sharing. Each is listed so nobody thinks it is silently
missing: the header shows **Open in browser** in every mode.

## Testing

- `herdr-app check mod` after every change (it sandboxes `fetch`, so it only
  proves load + first render).
- A second herdr screen on a hidden workspace (`HERDR_APP_HOME=/run/user/1000/hpt`)
  shares the core but not focus, so tests can select tabs and `herdr-app shot`
  without moving the user's window.
- Parity: the same annotations exported by the vendor bundle and by the
  upstream module under bun produce identical strings.
- End to end: a real `plannotator annotate` / `review` session, driven through
  the pane, and the CLI's stdout compared with the browser's for the same
  annotations.

## View contract

`main.js` owns the header, mode detection, drafts and decisions. A view owns
its body and its annotations, nothing else. It never builds a request body.

```js
export class DocumentView {          // mod/doc/index.js   (plan + annotate)
  constructor(host)                  // host: { session, mode, api, changed(cx) }
  init(cx)                           // once, after the session loaded
  render(cx)                         // the body element (fills the space under the header)
  restore(annotations)               // from a draft
  annotations                        // upstream Annotation[], GLOBAL_COMMENT included
  blocks                             // the parseMarkdownToBlocks output it renders
}
export class ReviewView {            // mod/review/index.js
  constructor(host) init(cx) render(cx) restore(annotations)
  annotations                        // upstream CodeAnnotation[]
}
```

Call `host.changed(cx)` after every annotation change: main.js saves the
draft and redraws the header.

Mouse handlers only call named methods on the view (`press(ref)`,
`extend(ref)`, `release()`, `addComment(text)`, ...). A dev-only
`props().script` (an array of `[method, ...args]`) replays those methods after
load, so tests can drive the view on a screen nobody clicks.

## Dev loop

```sh
HPT=hpt-<you> tools/test-screen.sh start      # your own hidden X11 herdr screen (HPT names it)
plannotator annotate x.md --browser none &      # prints the session URL on stderr
HPT=hpt-<you> tools/dev-open.sh plannotator <url> shot.png   # new tab on it + screenshot
HERDR_APP_HOME=/run/user/$UID/hpt-<you> herdr-app do tab.close --id <tab> --confirmed true
```

`herdr-app shot` returns the last frame of the test screen only.
