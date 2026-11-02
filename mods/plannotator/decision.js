import { div } from "gpui-kit";
import { v_flex, h_flex, Popover, TextareaState, Textarea } from "gpui-base";

// Plannotator's DecisionControl, drawn natively from upstream's DecisionSpec:
// the primary button, a caret menu of alternates, and the composer or confirm
// an item morphs the menu into. Pressing anything calls onDecide(id, note).
export class DecisionControl {
  constructor() {
    this.open = false;
    this.mode = { name: "menu" }; // menu | composer{item} | confirm{item}
    this.note = TextareaState.new({ placeholder: "Add a note...", rows: 3 });
  }

  close() {
    this.open = false;
    this.mode = { name: "menu" };
  }

  pick(item, onDecide, cx) {
    if (item.composer) {
      this.mode = { name: "composer", item };
      this.note.set_value("");
      this.note.focus();
    } else if (item.confirm) {
      this.mode = { name: "confirm", item };
    } else {
      this.close();
      onDecide(item.id, undefined, cx);
    }
    cx.notify();
  }

  submitNote(item, onDecide, cx) {
    const note = this.note.value();
    if (!note.trim()) return;
    this.close();
    onDecide(item.id, note, cx);
    cx.notify();
  }

  render(t, spec, { busy, count, label, onDecide }) {
    const tone = (name) =>
      name === "success" ? { bg: t.solid, fg: t.solid_foreground, border: t.solid }
        : name === "destructive" ? { bg: t.blocked, fg: t.solid_foreground, border: t.blocked }
          : name === "neutral" ? { bg: t.surface, fg: t.foreground, border: t.border }
            : { bg: t.accent, fg: t.accent_foreground, border: t.accent };
    const c = tone(spec.primary.tone);
    const primaryLabel = label ?? (count > 0 && spec.primary.icon === "send" ? `${spec.primary.label} · ${count}` : spec.primary.label);

    const primary = div().id("decision-primary").h(28).px(12).flex().items_center().rounded_l(6).text_size(12.5)
      .bg(c.bg).text_color(c.fg).border_1().border_color(c.border)
      .when(busy, (el) => el.opacity(0.6))
      .when(!busy, (el) => el.cursor_pointer().hover((s) => s.opacity(0.9)).on_click((_e, cx) => onDecide("primary", undefined, cx)))
      .child(primaryLabel);

    const caret = div().id("decision-caret").h(28).w(26).flex().items_center().justify_center().rounded_r(6).text_size(11)
      .bg(c.bg).text_color(c.fg).border_1().border_l(1).border_color(c.border)
      .when(busy, (el) => el.opacity(0.6))
      .when(!busy, (el) => el.cursor_pointer().hover((s) => s.opacity(0.9)))
      .child("▾");

    const control = h_flex().child(primary);
    if (spec.items.length === 0) return control.child(caret.rounded_l(0).opacity(0.4));

    return control.child(
      Popover.new("decision-menu").anchor("top_right").open(this.open && !busy)
        .on_open_change((open, cx) => { this.open = open; if (!open) this.mode = { name: "menu" }; cx.notify(); })
        .trigger(caret)
        .content(v_flex().id("decision-panel").mt(4).w(300).p(4).rounded(8).bg(t.popover).border_1().border_color(t.border)
          .text_size(12.5).text_color(t.foreground)
          .child(this.panel(t, spec, onDecide, tone))));
  }

  panel(t, spec, onDecide, tone) {
    const { name, item } = this.mode;
    const back = (title) => h_flex().id("decision-back").h(28).px(6).gap(6).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.mode = { name: "menu" }; cx.notify(); })
      .child(div().text_color(t.dim).child("‹")).child(div().font_semibold().child(title));
    const action = (id, text, toneName, onClick) => {
      const c = tone(toneName);
      return div().id(id).h(28).px(12).flex().items_center().rounded(6).bg(c.bg).text_color(c.fg).cursor_pointer()
        .hover((s) => s.opacity(0.9)).on_click((_e, cx) => onClick(cx)).child(text);
    };

    if (name === "composer") {
      const k = item.composer;
      return v_flex().gap(6).p(4)
        .child(back(k.title))
        .child(div().rounded(6).border_1().border_color(t.input).bg(t.background).p(6)
          .on_key_down((e, cx) => {
            if (e.keystroke === "ctrl-enter" || e.keystroke === "cmd-enter") this.submitNote(item, onDecide, cx);
          })
          .child(Textarea.new(this.note)))
        .child(h_flex().justify_end().child(action("decision-note-send", k.actionLabel, k.tone, (cx) => this.submitNote(item, onDecide, cx))));
    }

    if (name === "confirm") {
      const k = item.confirm;
      return v_flex().gap(8).p(4)
        .child(back(k.title))
        .child(div().px(6).text_color(t.muted).child(k.message))
        .child(h_flex().justify_end().child(action("decision-confirm", k.confirmText, item.tone, (cx) => {
          this.close();
          onDecide(item.id, undefined, cx);
          cx.notify();
        })));
    }

    return v_flex().children(spec.items.flatMap((it) => [
      ...(it.dividerBefore ? [div().h(1).my(4).bg(t.border)] : []),
      v_flex().id(`decision-item-${it.id}`).px(8).py(6).gap(2).rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.pick(it, onDecide, cx))
        .child(div().text_color(it.tone === "destructive" ? t.blocked : t.foreground).child(it.label))
        .child(div().text_size(11.5).text_color(t.dim).child(it.subtitle)),
    ]));
  }
}
