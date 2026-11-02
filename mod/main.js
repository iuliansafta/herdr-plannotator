import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, focused, run, theme } from "herdr";
import * as P from "./vendor/plannotator.js";
import { Api, loadSession } from "./api.js";
import { DecisionControl } from "./decision.js";
import { DocumentView } from "./doc/index.js";
import { ReviewView } from "./review/index.js";

const CLOSE_AFTER_MS = 2000;
const DRAFT_DEBOUNCE_MS = 800;
const LIVENESS_MS = 4000;

const TITLES = { plan: "Plan review", annotate: "Annotate", review: "Code review", archive: "Plan archive" };
const DONE_TEXT = {
  approved: "Approved. The agent has your decision.",
  sent: "Feedback sent to the agent.",
  done: "Done. Nothing to send.",
  exited: "Closed without feedback.",
  gone: "This Plannotator session has ended. Close this pane.",
};

/** What the server was told, from the decisive request itself. */
function outcomeOf(request) {
  const path = request.path.split("?")[0];
  if (path === "/api/exit") return "exited";
  if (path === "/api/approve" || request.body?.approved === true) return "approved";
  if (request.body?.nothingToSend) return "done";
  return "sent";
}

export default class Plannotator extends View {
  init(_props, cx) {
    this.state = { name: "loading" };
    this.toast = null;
    this.draftTimer = null;
    this.draftGeneration = 0;
    this.clientId = P.newClientId();
    this.decision = new DecisionControl();
    this.confirmClose = false;
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
      annotations: this.view?.annotations ?? [],
      draftGeneration: this.draftGeneration,
      clientId: this.clientId,
    };
    return this.session.kind === "review" ? base : { ...base, blocks: this.view?.blocks ?? [] };
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
    const res = await this.api.decide(P.draftLoad(this.input())).catch(() => null);
    if (!res || (res.status !== 200 && res.status !== 404)) return;
    const draft = this.adoptDraft(res.json);
    if (res.ok && draft.annotations.length) this.view.restore(draft.annotations);
  }

  async sendDraft(request) {
    this.draftGeneration = request.draftGeneration ?? this.draftGeneration;
    return this.api.decide(request).catch(() => null);
  }

  async saveDraft() {
    if (this.state.name !== "ready") return;
    const res = await this.sendDraft(P.draftSave(this.input()));
    if (res?.status !== 409 || res.json?.decided) return;
    this.adoptDraft(res.json);
    await this.sendDraft(P.draftSave(this.input()));
  }

  // Views report changes from their own child cx, whose notify can't reach the
  // header. Waking this root task redraws the root, and its timer owns the
  // draft debounce.
  changed(_childCx) {
    this.confirmClose = false;
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

  /** Runs one decision: the first request decides; the rest are cleanup. */
  submit(plan, cx) {
    if (this.state.name !== "ready") return;
    // Clicking a mod pane focuses it, so this is our own pane.
    this.ownPane = focused()?.pane ?? null;
    this.state = { name: "submitting" };
    this.toast = null;
    this.draftTimer?.cancel?.();
    cx.notify();
    cx.spawn(async (cx) => {
      const [decisive, ...cleanup] = plan.requests;
      try {
        const res = await this.api.decide(decisive);
        if (!res.ok) throw new Error(res.json?.error ?? res.json?.message ?? res.json?.code ?? `HTTP ${res.status}`);
        for (const r of cleanup) await this.sendDraft(r);
        this.state = { name: "done", outcome: outcomeOf(decisive) };
        cx.timer.after(CLOSE_AFTER_MS, () => this.closePane());
      } catch (e) {
        // A note the composer added rides the request; keep it as an annotation.
        if (plan.note && this.view) this.view.restore([...this.view.annotations, plan.note]);
        this.state = { name: "ready" };
        this.toast = `Could not send: ${e?.message ?? e}`;
      }
      cx.notify();
    });
  }

  decide(id, note, cx) {
    const plan = P.decisionRequest(id, this.input(), note);
    if (!plan) {
      this.toast = "Write a note first.";
      cx.notify();
      return;
    }
    this.submit(plan, cx);
  }

  exit(cx) {
    if (this.input().annotations.length > 0 && !this.confirmClose) {
      this.confirmClose = true;
      cx.notify();
      return;
    }
    this.confirmClose = false;
    const request = this.session.kind === "review" ? P.reviewExit(this.input()) : P.annotateExit(this.input());
    this.submit({ requests: [request] }, cx);
  }

  closePane() {
    if (this.ownPane) run("pane.close", { pane: this.ownPane });
  }

  button(t, id, label, onClick, { disabled = false, danger = false } = {}) {
    return div().id(id).h(28).px(12).flex().items_center().rounded(6).text_size(12.5)
      .border_1().border_color(danger ? t.blocked : t.border).bg(t.surface)
      .text_color(danger ? t.blocked : t.foreground)
      .when(disabled, (el) => el.opacity(0.5))
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)))
      .child(label);
  }

  versionNote(t) {
    const running = props()?.version;
    if (!running || running === P.PINNED_VERSION) return null;
    return div().px(8).py(2).rounded(10).bg(t.surface).border_1().border_color(t.border).text_size(11).text_color(t.dim)
      .child(`Plannotator ${running} · pane built for ${P.PINNED_VERSION}`);
  }

  header(t) {
    const kind = this.session?.kind;
    const data = this.session?.data ?? {};
    const subtitle = data.filePath ?? data.gitRef ?? data.origin ?? "";
    const live = this.state.name === "ready" || this.state.name === "submitting";
    const busy = this.state.name !== "ready";
    const decides = live && !!this.view && kind !== "archive";
    const count = this.view?.annotations.length ?? 0;
    const version = this.versionNote(t);
    let control = null;
    if (decides) {
      const spec = P.buildDecisionSpec(P.decisionSpecInput(kind, this.input()));
      control = this.decision.render(t, spec, {
        busy,
        count,
        label: this.state.name === "submitting" ? "Sending…" : undefined,
        onDecide: (id, note, cx) => this.decide(id, note, cx),
      });
    }
    return h_flex().flex_none().h(44).px(14).gap(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child(TITLES[kind] ?? "Plannotator"))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(String(subtitle)))
      .when(!!version, (el) => el.child(version))
      .when(!!this.api && live, (el) => el.child(this.button(t, "open-browser", "Open in browser", (cx) => cx.open_url(this.api.url("/")))))
      .when(decides && kind !== "plan", (el) => el.child(this.button(t, "close-session",
        this.confirmClose ? `Close without sending ${count}?` : "Close", (cx) => this.exit(cx), { disabled: busy, danger: this.confirmClose })))
      .when(!!control, (el) => el.child(control));
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
        if (!this.view) return this.centered(t, "This session type is not drawn natively. Use Open in browser.");
        return this.view.render(cx);
    }
  }

  render(cx) {
    const t = theme();
    return v_flex().id("plannotator-root").size_full().bg(t.background).text_color(t.foreground)
      .child(this.header(t))
      .when(!!this.toast, (el) => el.child(div().px(14).py(6).bg(t.surface).text_size(12).text_color(t.blocked).child(this.toast)))
      .child(v_flex().flex_1().min_h(0).child(this.body(t, cx)));
  }
}
