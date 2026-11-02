import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme } from "herdr";

// Contract with main.js (see DESIGN.md, "View contract").
export class DocumentView {
  constructor(host) {
    this.host = host;
    this.annotations = [];
    this.blocks = [];
  }
  init(_cx) {}
  restore(annotations) {
    this.annotations = annotations;
  }
  render(_cx) {
    const t = theme();
    return v_flex().flex_1().p(16).child(div().text_color(t.muted).child("DocumentView placeholder"));
  }
}
