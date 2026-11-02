import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { exec } from "herdr";
import * as P from "./vendor/plannotator.js";

export default class Plannotator extends View {
  init(_p, cx) {
    const blocks = P.parseMarkdownToBlocks("# Title\n\nDo the **first** thing.\n\n- a\n- b\n");
    const ann = [{ id: "a1", blockId: blocks[1].id, startOffset: 0, endOffset: 6, type: "COMMENT", text: "why?", originalText: "Do the", createdA: 1, images: [] }];
    this.out = JSON.stringify({ blocks: blocks.map(b => [b.id, b.type, b.content]), exp: P.exportAnnotations(blocks, ann, []) });
    cx.spawn(async () => { await exec("sh", ["-c", 'printf "%s\n" "$1" > /tmp/claude-1000/-home-iulian-Work-personal/4edee27b-a837-4b36-81ae-e04608bfbaf8/scratchpad/vendor-probe.json', "x", this.out]); });
  }
  render() { return v_flex().child(div().child(this.out)); }
}
