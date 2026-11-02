import { div } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, Popover, TextareaState, Textarea, VirtualListScrollHandle } from "gpui-base";
import { show_fps_monitor } from "gpui-fps";
import { theme, settings, props, exec } from "herdr";
import { parsePatch } from "./patch.js";
import { fileLines, rangeOf, lineComment, fileComment, generalComment, buildRows, scopeOf, lineLabel } from "./model.js";

const STATUS = { added: ["A", "ansi2"], deleted: ["D", "ansi1"], renamed: ["R", "ansi4"], modified: ["M", "ansi3"] };
const REPLAY_DELAY_MS = 600;
const LINE_H = 20, HUNK_H = 24, GUTTER_W = 104, CHAR_W = 7.3;
const NARROW = 1150, NOTES_W = 300;

// Contract with main.js (see DESIGN.md, "View contract"). Every handler calls
// one named method through act(); props().script replays the same methods.
export class ReviewView {
  constructor(host) {
    this.host = host;
    this.annotations = [];
    this.files = [];
    this.active = null;
    this.selection = null; // { anchor, focus }: indices into fileLines(active file)
    this.composer = null; // { scope: "line", filePath, side, lineStart, lineEnd } | { scope: "file", filePath } | { scope: "general" }, + editing?: id
    this.viewed = new Set();
    this.progress = null; // /api/review-progress answer for the current snapshot
    this.typeOpen = false;
    this.busy = null;
    this.shift = false;
  }

  init(cx) {
    this.focus = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.text = TextareaState.new({ placeholder: "Leave a comment…", rows: 3 });
    this.text.on("submit", (e, cx) => { if (e.secondary) this.act(cx, "save"); });
    this.text.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.text.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.load(this.host.session);
    this.progressLoad = this.loadProgress();
    cx.spawn(async (cx) => { await this.progressLoad; cx.notify(); });
    const script = props()?.script;
    if (Array.isArray(script)) cx.timer.after(REPLAY_DELAY_MS, (cx) => cx.spawn((cx) => this.replay(script, cx)));
  }

  restore(annotations) {
    this.annotations = annotations;
  }

  // Dev hook: runs [method, ...args] steps in order, awaiting async ones.
  async replay(script, cx) {
    await this.progressLoad;
    for (const [name, ...args] of script) {
      const before = this.annotations;
      // "$annN" stands for the id of the Nth annotation, which a script cannot know ahead.
      const resolved = args.map((v) => (typeof v === "string" && /^\$ann\d+$/.test(v) ? this.annotations[+v.slice(4)]?.id : v));
      try { await this[name](...resolved); }
      catch (e) { console.log(`replay ${name}: ${e?.message ?? e}`); }
      this.settle(before, cx);
    }
  }

  act(cx, name, ...args) {
    const before = this.annotations;
    const result = this[name](...args);
    if (result?.then) cx.spawn(async (cx) => { await result; this.settle(before, cx); });
    this.settle(before, cx);
  }

  settle(before, cx) {
    if (this.annotations !== before) this.host.changed(cx);
    else cx.notify();
  }

  // --- data ---

  load(session) {
    this.files = parsePatch(session.rawPatch ?? "").sort((a, b) => a.path.localeCompare(b.path));
    if (!this.files.some((f) => f.path === this.active)) this.active = this.files[0]?.path ?? null;
    this.selection = null;
    this.rowsCache = null;
  }

  async loadProgress() {
    const snapshot = this.host.session.snapshotId;
    if (!snapshot) return;
    const res = await this.host.api.get(`/api/review-progress?snapshot=${encodeURIComponent(snapshot)}`).catch(() => null);
    if (!res?.ok || !res.json?.available || this.host.session.snapshotId !== snapshot) return;
    this.progress = { snapshot, ...res.json };
    this.viewed = new Set(res.json.viewedFiles ?? []);
  }

  get file() {
    return this.files.find((f) => f.path === this.active) ?? null;
  }

  /** The active file's rows and their heights, rebuilt only when an input changed. */
  rows() {
    const file = this.file;
    if (!file) return { rows: [], sizes: [], width: 0 };
    const c = this.rowsCache;
    const key = { file, annotations: this.annotations, selection: this.selection, diffW: this.diffWidth() };
    if (c && Object.keys(key).every((k) => c.key[k] === key[k])) return c;
    const rows = buildRows(file, this.annotations, this.selection);
    const noteW = this.noteWidth();
    const sizes = rows.map((r) => (r.kind === "line" ? LINE_H : r.kind === "hunk" ? HUNK_H : noteHeight(r.ann.text ?? "", noteW)));
    const longest = rows.reduce((n, r) => (r.kind === "line" ? Math.max(n, r.line.text.length) : n), 0);
    this.rowsCache = { key, rows, sizes, width: GUTTER_W + 16 + Math.ceil(longest * CHAR_W) + 24 };
    return this.rowsCache;
  }

  // on_size_change reports only on the root, so the diff column's width is derived.
  diffWidth() {
    return (this.width ?? NARROW) - this.filesWidth() - (this.notesShown() ? NOTES_W : 0);
  }

  filesWidth() {
    return this.narrow() ? 230 : 270;
  }

  noteWidth() {
    return Math.max(200, Math.min(720, this.diffWidth() - GUTTER_W - 24));
  }

  author() {
    return this.host.session.serverConfig?.displayName || undefined;
  }

  // --- methods the UI and the replay call ---

  select(path) {
    if (path === this.active) return;
    this.active = path;
    this.selection = null;
    this.scroll.scroll_to_item(0);
    if (this.composer?.scope === "line") this.closeComposer();
  }

  step(delta) {
    const i = this.files.findIndex((f) => f.path === this.active);
    const next = this.files[Math.max(0, Math.min(this.files.length - 1, i + delta))];
    if (next) this.select(next.path);
  }

  next() { this.step(1); }
  prev() { this.step(-1); }

  clickLine(i, shift = false) {
    const file = this.file;
    if (!file) return;
    const lines = fileLines(file);
    const anchor = shift && this.selection ? this.selection.anchor : i;
    this.selection = { anchor, focus: i };
    this.openComposer({ scope: "line", filePath: file.path, ...rangeOf(lines, anchor, i) });
  }

  fileComment() {
    if (this.file) this.openComposer({ scope: "file", filePath: this.file.path });
  }

  generalComment() {
    this.openComposer({ scope: "general" });
  }

  openComposer(target, value = "") {
    const keep = this.composer && !this.composer.editing && !target.editing ? this.text.value() : value;
    this.composer = target;
    this.text.set_value(keep);
    this.text.focus();
  }

  edit(id) {
    const ann = this.annotations.find((a) => a.id === id);
    if (!ann) return;
    if (ann.filePath && ann.filePath !== this.active && this.files.some((f) => f.path === ann.filePath)) this.select(ann.filePath);
    this.selection = null;
    this.openComposer({ scope: scopeOf(ann), filePath: ann.filePath, side: ann.side, lineStart: ann.lineStart, lineEnd: ann.lineEnd, editing: id }, ann.text ?? "");
    this.reveal(id);
  }

  /** Saves the composer: the text typed, or `text` when the replay passes one. */
  save(text) {
    const body = (text ?? this.text.value()).trim();
    const c = this.composer;
    if (!c || !body) return;
    const author = this.author();
    if (c.editing) {
      this.annotations = this.annotations.map((a) => (a.id === c.editing ? { ...a, text: body } : a));
    } else {
      const ann = c.scope === "line" ? lineComment({ ...c, text: body, author })
        : c.scope === "file" ? fileComment({ filePath: c.filePath, text: body, author })
        : generalComment({ text: body, author });
      this.annotations = [...this.annotations, ann];
    }
    this.closeComposer();
  }

  /** Opens a composer on a line range and saves `text` there in one step (replay). */
  comment(i, text, shiftTo) {
    this.clickLine(i);
    if (shiftTo !== undefined) this.clickLine(shiftTo, true);
    this.save(text);
  }

  remove(id) {
    this.annotations = this.annotations.filter((a) => a.id !== id);
    if (this.composer?.editing === id) this.closeComposer();
  }

  cancel() {
    this.closeComposer();
  }

  closeComposer() {
    this.composer = null;
    this.selection = null;
    this.text.set_value("");
    this.focus?.focus();
  }

  reveal(id) {
    const at = this.rows().rows.findIndex((r) => r.key === `a${id}`);
    if (at >= 0) this.scroll.scroll_to_item(at, "center");
  }

  async toggleViewed(path) {
    await this.progressLoad;
    const viewed = !this.viewed.has(path);
    if (viewed) this.viewed.add(path);
    else this.viewed.delete(path);
    this.viewed = new Set(this.viewed);
    const p = this.progress;
    const fingerprint = p?.fingerprints?.[path];
    if (!p || !fingerprint) return;
    await this.host.api.send("POST", `/api/review-progress?snapshot=${encodeURIComponent(p.snapshot)}`, {
      key: p.key,
      changes: [{ path, fingerprint, viewed }],
    }).catch(() => null);
  }

  async switchDiff(diffType) {
    this.typeOpen = false;
    const s = this.host.session;
    if (diffType === s.diffType || this.busy) return;
    this.busy = "switching";
    this.toast = null;
    try {
      const res = await this.host.api.send("POST", "/api/diff/switch", {
        diffType,
        ...(s.base ? { base: s.base } : {}),
        hideWhitespace: !!s.hideWhitespace,
      });
      if (!res.ok || res.json?.error) throw new Error(res.json?.error ?? `HTTP ${res.status}`);
      if (res.json.superseded) return;
      Object.assign(s, res.json);
      this.load(s);
      this.composer = null;
      this.viewed = new Set();
      this.progress = null;
      this.progressLoad = this.loadProgress();
      await this.progressLoad;
    } catch (e) {
      this.toast = `Could not switch the diff: ${e?.message ?? e}`;
    } finally {
      this.busy = null;
    }
  }

  setTypeOpen(open) {
    this.typeOpen = open;
  }

  toggleNotes() {
    this.notesOpen = !this.notesOpen;
  }

  /** Dev: scrolls the diff to row `i`. */
  scrollTo(i) {
    this.scroll.scroll_to_item(i, "top");
  }

  /** Dev: the frame-time HUD. */
  fps() {
    show_fps_monitor({ anchor: "bottom_left" });
  }

  /** Dev: writes the annotations as JSON to `path`. */
  async dump(path) {
    await exec("sh", ["-c", 'printf %s "$1" > "$2"', "sh", JSON.stringify(this.annotations), path]);
  }

  // --- view ---

  render(cx) {
    const t = theme();
    return v_flex()
      .id("rv-root")
      .flex_1()
      .min_h(0)
      .track_focus(this.focus)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); })
      .child(this.toolbar(t))
      .when(!!this.toast, (el) => el.child(div().px(14).py(4).text_size(12).text_color(t.blocked).bg(t.surface).child(this.toast)))
      .child(h_flex().flex_1().min_h(0).items_stretch()
        .child(this.fileList(t))
        .child(this.diffColumn(t))
        .when(this.notesShown(), (el) => el.child(this.notesPanel(t))));
  }

  narrow() {
    return (this.width ?? NARROW) < NARROW;
  }

  notesShown() {
    return this.narrow() ? !!this.notesOpen : !this.notesOpen;
  }

  key(e, cx) {
    if (this.typing) {
      if (e.key === "escape") { this.act(cx, "cancel"); cx.stop_propagation(); }
      return;
    }
    const k = { j: "next", k: "prev", escape: "cancel" }[e.key];
    if (k) this.act(cx, k);
  }

  btn(t, id, label, onClick, { primary = false, quiet = false } = {}) {
    return div().id(id).flex_none().px(10).h(24).flex().items_center().rounded(6).text_size(12).cursor_pointer()
      .when(!quiet, (el) => el.border_1().border_color(primary ? t.solid : t.border))
      .bg(primary ? t.solid : quiet ? "#00000000" : t.surface)
      .text_color(primary ? t.solid_foreground : quiet ? t.muted : t.foreground)
      .hover((s) => s.bg(primary ? t.accent : t.hover))
      .on_click((_e, cx) => onClick(cx))
      .child(label);
  }

  toolbar(t) {
    const s = this.host.session;
    const options = s.gitContext?.diffOptions ?? [];
    const current = options.find((o) => o.id === s.diffType)?.label ?? s.gitRef ?? s.diffType ?? "Diff";
    const add = this.files.reduce((n, f) => n + f.additions, 0);
    const del = this.files.reduce((n, f) => n + f.deletions, 0);
    const trigger = h_flex().id("rv-type").h(26).px(10).gap(6).items_center().rounded(6).border_1().border_color(t.border)
      .bg(t.surface).text_size(12).cursor_pointer().hover((st) => st.bg(t.hover))
      .child(div().child(this.busy === "switching" ? "Switching…" : current))
      .child(div().text_color(t.dim).child("▾"));
    const picker = options.length === 0 ? trigger : Popover.new("rv-type-menu").anchor("top_left").open(this.typeOpen)
      .on_open_change((open, cx) => this.act(cx, "setTypeOpen", open))
      .trigger(trigger)
      .content(v_flex().id("rv-type-list").mt(4).p(4).min_w(240).rounded(8).bg(t.popover).border_1().border_color(t.border).text_size(12.5)
        .children(options.map((o) => h_flex().id(`rv-type-${o.id}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .when(o.id === s.diffType, (el) => el.bg(t.selected))
          .hover((st) => st.bg(t.hover))
          .on_click((_e, cx) => this.act(cx, "switchDiff", o.id))
          .child(div().w(12).text_color(t.accent).child(o.id === s.diffType ? "✓" : ""))
          .child(div().child(o.label)))));
    const viewedCount = this.files.filter((f) => this.viewed.has(f.path)).length;
    return h_flex().flex_none().h(40).px(12).gap(10).items_center().border_b(1).border_color(t.border).bg(t.background)
      .child(picker)
      .child(div().text_size(12).text_color(t.muted).child(`${this.files.length} file${this.files.length === 1 ? "" : "s"}`))
      .child(div().text_size(12).text_color(t.ansi2).child(`+${add}`))
      .child(div().text_size(12).text_color(t.ansi1).child(`−${del}`))
      .child(div().flex_1())
      .child(div().text_size(12).text_color(t.muted).child(`${viewedCount}/${this.files.length} viewed`))
      .child(this.btn(t, "rv-general", "General comment", (cx) => this.act(cx, "generalComment")))
      .child(this.btn(t, "rv-notes-toggle", `${this.notesShown() ? "Hide" : "Show"} comments · ${this.annotations.length}`, (cx) => this.act(cx, "toggleNotes"), { quiet: true }));
  }

  fileList(t) {
    const counts = {};
    for (const a of this.annotations) if (a.filePath) counts[a.filePath] = (counts[a.filePath] ?? 0) + 1;
    return v_flex().id("rv-files").w(this.filesWidth()).flex_none().min_h(0).overflow_y_scrollbar().p(6).gap(1).border_r(1).border_color(t.border).bg(t.chrome)
      .when(this.files.length === 0, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child("No changes in this diff.")))
      .children(this.files.map((f) => {
        const on = f.path === this.active;
        const viewed = this.viewed.has(f.path);
        const parts = f.path.split("/");
        const name = parts.pop();
        const [letter, color] = STATUS[f.status];
        return h_flex().id(`rv-file-${f.path}`).h(28).flex_none().px(6).gap(6).items_center().rounded(6).cursor_pointer().text_size(12.5)
          .when(on, (el) => el.bg(t.selected))
          .hover((s) => s.bg(on ? t.selected : t.hover))
          .on_click((_e, cx) => this.act(cx, "select", f.path))
          .child(this.checkbox(t, `rv-viewed-${f.path}`, viewed, (cx) => this.act(cx, "toggleViewed", f.path)))
          .child(div().w(12).flex_none().text_size(11).font_semibold().text_color(t[color]).child(letter))
          .child(h_flex().flex_1().min_w(0).when(viewed, (el) => el.opacity(0.55))
            .child(div().min_w(0).truncate().text_color(t.dim).child(parts.length ? parts.join("/") + "/" : ""))
            .child(div().flex_none().max_w(200).truncate().text_color(t.foreground).child(name)))
          .when(!!counts[f.path], (el) => el.child(div().flex_none().px(5).rounded(8).bg(t.accent).text_color(t.accent_foreground).text_size(10.5).child(String(counts[f.path]))))
          .when(f.additions > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.additions}`)))
          .when(f.deletions > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.deletions}`)));
      }));
  }

  checkbox(t, id, checked, onClick) {
    return div().id(id).size(14).flex_none().flex().items_center().justify_center().rounded(3).border_1()
      .border_color(checked ? t.accent : t.input).bg(checked ? t.accent : "#00000000")
      .text_size(10).text_color(t.accent_foreground).cursor_pointer()
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(checked ? "✓" : "");
  }

  diffColumn(t) {
    const file = this.file;
    if (!file) return v_flex().flex_1().min_w(0).items_center().justify_center().child(div().text_color(t.dim).text_size(13).child("Nothing to review."));
    const [letter, color] = STATUS[file.status];
    const fileNotes = this.annotations.filter((a) => a.filePath === file.path && scopeOf(a) === "file");
    const header = h_flex().flex_none().h(36).px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.surface)
      .child(div().text_size(11).font_semibold().text_color(t[color]).child(letter))
      .child(div().flex_1().min_w(40).truncate().text_size(12.5).font_semibold().child(file.oldPath ? `${file.oldPath} → ${file.path}` : file.path))
      .child(div().flex_none().text_size(11.5).text_color(t.ansi2).child(`+${file.additions}`))
      .child(div().flex_none().text_size(11.5).text_color(t.ansi1).child(`−${file.deletions}`))
      .child(h_flex().id("rv-viewed-head").gap(6).items_center().cursor_pointer().text_size(12).text_color(t.muted)
        .on_click((_e, cx) => this.act(cx, "toggleViewed", file.path))
        .child(this.checkbox(t, "rv-viewed-box", this.viewed.has(file.path), (cx) => this.act(cx, "toggleViewed", file.path)))
        .child(div().child("Viewed")))
      .child(this.btn(t, "rv-file-comment", "Comment on file", (cx) => this.act(cx, "fileComment"), { quiet: true }));
    return v_flex().flex_1().min_w(0).min_h(0)
      .child(header)
      .when(fileNotes.length > 0, (el) => el.child(v_flex().flex_none().p(8).gap(6).border_b(1).border_color(t.border)
        .children(fileNotes.map((a) => this.noteCard(t, a, "File comment", true)))))
      .child(this.diffBody(t, file))
      .when(!!this.composer, (el) => el.child(this.composerBox(t)));
  }

  diffBody(t, file) {
    if (file.binary) return this.notice(t, "Binary file. No text diff.");
    if (!file.hunks.length) return this.notice(t, file.status === "renamed" ? "Renamed without changes." : "No text changes.");
    const { rows, sizes, width } = this.rows();
    const font = settings().font_family ?? "JetBrains Mono";
    const noteW = this.noteWidth();
    return div().id("rv-diff-area").flex_1().min_h(0).relative().font_family(font).text_size(12)
      .on_mouse_down("left", (e) => { this.shift = !!e.modifiers?.shift; })
      .child(div().id("rv-diff-x").size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(width).h_full()
          .child(v_virtual_list("rv-diff", rows.length, sizes, (i) => rows[i].key,
            (range) => rows.slice(range.start, range.end).map((r) => this.row(t, r, noteW)))
            .track_scroll(this.scroll)
            .size_full()
            .on_item_click((key, cx) => {
              if (key[0] === "l") this.act(cx, "clickLine", Number(key.slice(1)), this.shift);
              else if (key[0] === "a") this.act(cx, "edit", key.slice(1));
            }))))
      .child(Scrollbar.vertical("rv-diff").viewport_from_layout().absolute().inset_0());
  }

  notice(t, text) {
    return v_flex().flex_1().items_center().justify_center().child(div().text_size(13).text_color(t.dim).child(text));
  }

  row(t, r, noteW) {
    if (r.kind === "hunk") {
      return div().w_full().h(24).px(12).flex().items_center().bg(t.raised).text_color(t.dim).truncate().child(r.text);
    }
    if (r.kind === "note") return div().w_full().h_full().overflow_hidden().pl(GUTTER_W).py(4).child(div().w(noteW).child(this.noteCard(t, r.ann, lineLabel(r.ann), false)));
    const { line } = r;
    const tint = line.kind === "add" ? t.ansi2 : line.kind === "del" ? t.ansi1 : null;
    const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
    const gutter = r.selected ? t.selection : r.noted ? t.accent + "30" : tint ? tint + "22" : null;
    return h_flex().w_full().h(LINE_H).cursor_pointer()
      .when(!!tint, (el) => el.bg(tint + "16"))
      .when(r.selected, (el) => el.bg(t.selection))
      .child(h_flex().flex_none().w(88).h_full().text_color(t.dim).when(!!gutter, (el) => el.bg(gutter))
        .child(div().w(40).text_right().child(line.oldNo === null ? "" : String(line.oldNo)))
        .child(div().w(40).text_right().child(line.newNo === null ? "" : String(line.newNo))))
      .child(div().w(16).flex_none().text_center().text_color(tint ?? t.dim).child(sign))
      .child(div().flex_1().whitespace_nowrap().pr(12).child((line.text.replace(/\t/g, "    ") || " ") + (line.noEol ? "  ⏎̸" : "")));
  }

  // Inside the diff list a card cannot have handlers (on_item_click opens it);
  // outside it, `interactive` adds Edit and Remove.
  noteCard(t, a, label, interactive) {
    const editing = this.composer?.editing === a.id;
    return v_flex().id(`rv-note-${a.id}-${interactive ? "i" : "l"}`).gap(4).px(10).py(7).rounded(8).border_1()
      .border_color(editing ? t.accent : t.border).bg(t.popover).font_family(settings().ui_font_family ?? "Inter").text_size(12.5)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(11).font_semibold().text_color(t.accent).child(label))
        .child(div().flex_1())
        .when(interactive, (el) => el
          .child(this.btn(t, `rv-edit-${a.id}`, "Edit", (cx) => this.act(cx, "edit", a.id), { quiet: true }))
          .child(this.btn(t, `rv-remove-${a.id}`, "Remove", (cx) => this.act(cx, "remove", a.id), { quiet: true })))
        .when(!interactive, (el) => el.child(div().text_size(11).text_color(t.dim).child(editing ? "editing" : "click to edit"))))
      .child(div().text_color(t.foreground).child(a.text ?? ""));
  }

  composerBox(t) {
    const c = this.composer;
    const where = c.scope === "general" ? "General comment"
      : c.scope === "file" ? `File comment · ${c.filePath}`
      : `${c.filePath} · ${lineLabel(c)}`;
    return v_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child(c.editing ? `Edit · ${where}` : where))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child("Ctrl+Enter to save · Esc to cancel")))
      .child(div().id("rv-composer-text").px(8).py(6).rounded(6).border_1().border_color(this.typing ? t.accent : t.input).bg(t.background)
        .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(this.text).w_full().text_size(13).text_color(t.foreground)))
      .child(h_flex().gap(8).justify_end()
        .when(!!c.editing, (el) => el.child(this.btn(t, "rv-composer-remove", "Remove", (cx) => this.act(cx, "remove", c.editing), { quiet: true })))
        .child(this.btn(t, "rv-composer-cancel", "Cancel", (cx) => this.act(cx, "cancel")))
        .child(this.btn(t, "rv-composer-save", c.editing ? "Save" : "Comment", (cx) => this.act(cx, "save"), { primary: true })));
  }

  notesPanel(t) {
    const general = this.annotations.filter((a) => scopeOf(a) === "general");
    const byFile = new Map();
    for (const a of this.annotations) {
      if (scopeOf(a) === "general") continue;
      if (!byFile.has(a.filePath)) byFile.set(a.filePath, []);
      byFile.get(a.filePath).push(a);
    }
    const order = [...byFile.keys()].sort();
    const label = (a) => (scopeOf(a) === "file" ? "File comment" : lineLabel(a));
    return v_flex().id("rv-notes").w(NOTES_W).flex_none().min_h(0).border_l(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().flex_none().h(36).px(12).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(12.5).font_semibold().child(`Comments · ${this.annotations.length}`)))
      .child(v_flex().id("rv-notes-list").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(10)
        .when(this.annotations.length === 0, (el) => el.child(div().p(4).text_size(12).text_color(t.dim)
          .child("Click a line to comment on it. Shift-click extends the range. j / k move between files.")))
        .when(general.length > 0, (el) => el.child(this.group(t, "General", general.map((a) => this.noteCard(t, a, "General", true)))))
        .children(order.map((path) => this.group(t, path, byFile.get(path).map((a) => this.noteCard(t, a, label(a), true)), path))));
  }

  group(t, title, cards, path) {
    return v_flex().gap(6)
      .child(div().id(`rv-group-${title}`).text_size(11.5).text_color(t.muted).truncate().when(!!path, (el) => el.cursor_pointer()
        .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.act(cx, "select", path))).child(title))
      .children(cards);
  }
}

// A note card's height in the diff list: label row plus wrapped text at ~6.9px
// per UI character. The card clips, so an underestimate cuts text rather than
// overlapping the next row.
function noteHeight(text, width) {
  const perLine = Math.max(10, Math.floor((width - 24) / 6.9));
  const lines = text.split("\n").reduce((n, p) => n + Math.max(1, Math.ceil(p.length / perLine)), 0);
  return 8 + 16 + 18 + 4 + lines * 18;
}
