import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, focused, run, theme } from "herdr";
import { randomUUID } from "crypto";
import * as P from "./vendor/plannotator.js";
import { Api, loadSession } from "./api.js";
import { DocumentView } from "./doc/index.js";
import { ReviewView } from "./review/index.js";

const CLOSE_AFTER_MS = 2000;
const DRAFT_DEBOUNCE_MS = 800;
const LIVENESS_MS = 4000;

const TITLES = { plan: "Plan review", annotate: "Annotate", review: "Code review", archive: "Plan archive" };
const DONE_TEXT = {
  approved: "Approved. The agent has your decision.",
  denied: "Feedback sent to the agent.",
  sent: "Feedback sent to the agent.",
  exited: "Closed without feedback.",
  gone: "This Plannotator session has ended. Close this pane.",
};

// Each decision: which buttons a mode shows, and what pressing one does.
// `approve` actions follow the browser: with notes present they become
// "Approve with notes" when the host takes notes, else a confirmed discard.
// `dismissDraft`: the annotate app deletes its draft after these succeed.
const ACTIONS = {
  plan: [
    { id: "deny", label: "Send feedback", build: (i) => P.planDeny(i), done: "denied", needsNotes: true },
    { id: "approve", label: "Approve", approve: true, build: (i) => P.planApprove(i), done: "approved", primary: true },
  ],
  annotate: [
    { id: "exit", label: "Close", build: (i) => P.annotateExit(i), done: "exited" },
    { id: "approve", label: "Approve", approve: true, build: (i) => P.annotateApprove(i), done: "approved", dismissDraft: true, when: (s) => !!s.gate },
    { id: "send", label: "Send feedback", build: (i) => P.annotateSend(i), done: "sent", dismissDraft: true, primary: true },
  ],
  review: [
    { id: "send", label: "Send feedback", build: (i) => P.reviewSend({ ...i, approved: false }), done: "sent", needsNotes: true },
    { id: "approve", label: "Approve", approve: true, build: (i) => P.reviewSend({ ...i, approved: true }), done: "approved", primary: true },
  ],
  archive: [],
};

function approveLabel(notes, notesSupported, confirming) {
  if (notes === 0) return "Approve";
  if (notesSupported) return "Approve with notes";
  return confirming ? `Discard ${notes} note${notes === 1 ? "" : "s"} and approve?` : "Approve, discard notes";
}

export default class Plannotator extends View {
  init(_props, cx) {
    this.state = { name: "loading" };
    this.toast = null;
    this.draftTimer = null;
    this.draftGeneration = 0;
    this.clientId = randomUUID();
    this.confirming = null;
    const url = props()?.url;
    if (!url) {
      this.state = { name: "error", message: "No session URL. Open this pane through plannotator-herdr." };
      return;
    }
    this.api = new Api(url);
    cx.spawn(async (cx) => {
      try {
        const session = await loadSession(this.api);
        this.session = session;
        this.view = session.native ? this.makeView(session) : null;
        this.watchChanges(cx);
        this.view?.init(cx);
        await this.restoreDraft();
        this.state = { name: "ready" };
        cx.timer.every(LIVENESS_MS, (cx) => this.checkAlive(cx));
      } catch (e) {
        this.state = { name: "error", message: String(e?.message ?? e) };
      }
      cx.notify();
    });
  }

  // The server stops once a decision lands anywhere (this pane, the browser,
  // the agent's process going away); fetch then rejects.
  checkAlive(cx) {
    if (this.state.name !== "ready") return;
    cx.spawn(async (cx) => {
      const alive = await this.api.get("/api/draft").then(() => true, () => false);
      if (alive || this.state.name !== "ready") return;
      this.state = { name: "done", outcome: "gone" };
      cx.notify();
    });
  }

  makeView(session) {
    const host = {
      session: session.data,
      mode: session.kind,
      api: this.api,
      changed: (cx) => this.changed(cx),
    };
    if (session.kind === "plan" || session.kind === "annotate") return new DocumentView(host);
    if (session.kind === "review") return new ReviewView(host);
    return null;
  }

  input() {
    const base = {
      session: this.session.data,
      annotations: this.view.annotations,
      draftGeneration: this.draftGeneration,
      clientId: this.clientId,
    };
    return this.session.kind === "review" ? base : { ...base, blocks: this.view.blocks };
  }

  // A 200 draft and a 404 or 409 refusal all carry the server's generation;
  // adopting it keeps later saves from being refused as stale.
  adoptDraft(json) {
    const draft = P.draftRestore(json, this.draftGeneration);
    this.draftGeneration = draft.draftGeneration;
    return draft;
  }

  async restoreDraft() {
    if (!this.view) return;
    const res = await this.api.get("/api/draft").catch(() => null);
    if (!res || (res.status !== 200 && res.status !== 404)) return;
    const draft = this.adoptDraft(res.json);
    if (res.ok && draft.annotations.length) this.view.restore(draft.annotations);
  }

  async sendDraft(request) {
    this.draftGeneration = request.draftGeneration ?? this.draftGeneration;
    return this.api.decide(request).catch(() => null);
  }

  async saveDraft() {
    const res = await this.sendDraft(P.draftSave(this.input()));
    if (res?.status !== 409 || res.json?.decided) return;
    this.adoptDraft(res.json);
    await this.sendDraft(P.draftSave(this.input()));
  }

  // Views report changes from their own child cx, whose notify can't reach the
  // header. Waking this root task redraws the root, and its timer owns the
  // draft debounce.
  changed(_childCx) {
    this.confirming = null;
    this.wake?.();
  }

  watchChanges(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        await new Promise((resolve) => (this.wake = resolve));
        cx.notify();
        this.draftTimer?.cancel?.();
        this.draftTimer = cx.timer.after(DRAFT_DEBOUNCE_MS, (cx) => {
          cx.spawn(async () => this.saveDraft());
        });
      }
    });
  }

  decide(action, cx) {
    if (this.state.name !== "ready") return;
    const notes = this.view?.annotations.length ?? 0;
    if (action.approve && notes > 0 && !this.session.data.approvalNotesSupported && this.confirming !== action.id) {
      this.confirming = action.id;
      cx.notify();
      return;
    }
    this.confirming = null;
    // Clicking a mod pane focuses it, so this is our own pane.
    this.ownPane = focused()?.pane ?? null;
    this.state = { name: "submitting", action: action.id };
    this.toast = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const res = await this.api.decide(action.build(this.input()));
        if (!res.ok) throw new Error(res.json?.error ?? res.json?.code ?? `HTTP ${res.status}`);
        this.draftTimer?.cancel?.();
        if (action.dismissDraft) await this.sendDraft(P.draftDismiss(this.input()));
        this.state = { name: "done", outcome: action.done };
        cx.timer.after(CLOSE_AFTER_MS, () => this.closePane());
      } catch (e) {
        this.state = { name: "ready" };
        this.toast = `Could not send: ${e?.message ?? e}`;
      }
      cx.notify();
    });
  }

  closePane() {
    if (this.ownPane) run("pane.close", { pane: this.ownPane });
  }

  openInBrowser(cx) {
    cx.open_url(this.api.url("/"));
  }

  button(t, id, label, onClick, { primary = false, disabled = false } = {}) {
    return div()
      .id(id)
      .px(12)
      .py(5)
      .rounded(6)
      .text_size(12.5)
      .border(1)
      .border_color(primary ? t.solid : t.border)
      .bg(primary ? t.solid : t.surface)
      .text_color(primary ? t.solid_foreground : t.foreground)
      .when(disabled, (el) => el.opacity(0.5))
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(primary ? t.accent : t.hover)).on_click((_e, cx) => onClick(cx)))
      .child(label);
  }

  header(t) {
    const kind = this.session?.kind;
    const data = this.session?.data ?? {};
    const subtitle = data.filePath ?? data.gitRef ?? data.origin ?? "";
    const busy = this.state.name !== "ready";
    const done = this.state.name === "done";
    const notes = this.view?.annotations.length ?? 0;
    const actions = done || !this.view ? [] : (ACTIONS[kind] ?? []).filter((a) => !a.when || a.when(data));
    const label = (a) =>
      this.state.action === a.id ? "Sending…"
        : a.approve ? approveLabel(notes, data.approvalNotesSupported === true, this.confirming === a.id)
          : a.label;
    return h_flex()
      .flex_none()
      .h(44)
      .px(14)
      .gap(10)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child(TITLES[kind] ?? "Plannotator"))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(String(subtitle)))
      .when(!!this.api && !done, (el) => el.child(this.button(t, "open-browser", "Open in browser", (cx) => this.openInBrowser(cx))))
      .children(actions.map((a) => this.button(t, `act-${a.id}`, label(a), (cx) => this.decide(a, cx), {
        primary: a.primary,
        disabled: busy || (a.needsNotes && notes === 0),
      })));
  }

  centered(t, text, color) {
    return v_flex().flex_1().items_center().justify_center().p(24).child(div().text_size(14).text_color(color ?? t.muted).child(text));
  }

  body(t, cx) {
    switch (this.state.name) {
      case "loading":
        return this.centered(t, "Loading session…");
      case "error":
        return this.centered(t, this.state.message, t.blocked);
      case "done":
        return this.centered(t, DONE_TEXT[this.state.outcome], t.foreground);
      default:
        if (!this.view) return this.centered(t, "This session type is not drawn natively yet. Use Open in browser.");
        return this.view.render(cx);
    }
  }

  render(cx) {
    const t = theme();
    return v_flex()
      .id("plannotator-root")
      .size_full()
      .bg(t.background)
      .text_color(t.foreground)
      .child(this.header(t))
      .when(!!this.toast, (el) =>
        el.child(div().px(14).py(6).bg(t.surface).text_size(12).text_color(t.blocked).child(this.toast)))
      .child(v_flex().flex_1().min_h(0).child(this.body(t, cx)));
  }
}
