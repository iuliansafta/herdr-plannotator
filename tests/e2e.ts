// End to end against the installed `plannotator` CLI: each session gets the
// vendor builders' requests (no Origin header, as main.js sends them) and the
// CLI's stdout must carry the builders' feedback verbatim. Every decision
// names a page (`?client=`), as the 0.28.45 web app does.
// Run: bun tests/e2e.ts
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import * as P from "../mods/plannotator/vendor/plannotator.js";

const root = mkdtempSync(join(tmpdir(), "herdr-plannotator-e2e-"));
const dataDir = join(root, "data");
mkdirSync(dataDir);
const env = {
  ...process.env,
  PLANNOTATOR_DATA_DIR: dataDir,
  PLANNOTATOR_BROWSER: "none",
  PLANNOTATOR_UPDATE_CHECK: "0",
  PLANNOTATOR_AUTO_UPDATE: "0",
  PLANNOTATOR_GIT_REMOTE_CHECK: "0",
  PLANNOTATOR_REMOTE: "0",
};
const startedAt = Date.now();
const live = new Set<ReturnType<typeof Bun.spawn>>();
let failures = 0;

function check(ok: boolean, what: string, detail?: unknown) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) console.log("     ", typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
  }
}

async function session(cmd: string[], opts: { cwd: string; stdin?: string }) {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, env, stdin: opts.stdin ? new Blob([opts.stdin]) : "ignore", stdout: "pipe", stderr: "pipe" });
  live.add(proc);
  const stdout = new Response(proc.stdout).text();
  const reader = proc.stderr.getReader();
  let err = "";
  const deadline = Date.now() + 20_000;
  while (!/Plannotator session ready: (\S+)/.test(err)) {
    if (Date.now() > deadline) throw new Error(`no session URL from ${cmd.join(" ")}:\n${err}`);
    const { value, done } = await reader.read();
    if (done) throw new Error(`${cmd.join(" ")} exited early:\n${err}`);
    err += new TextDecoder().decode(value);
  }
  void (async () => { while (!(await reader.read()).done); })();
  const url = err.match(/Plannotator session ready: (\S+)/)![1].replace(/\/+$/, "");
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(url + path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const finish = async () => {
    const code = await Promise.race([proc.exited, Bun.sleep(20_000).then(() => "timeout")]);
    live.delete(proc);
    if (code === "timeout") proc.kill();
    return { code, stdout: await stdout };
  };
  return { url, call, decide: (d: any) => call(d.method, d.path, d.body), finish };
}

/** Draft files that still hold a comment with this id (tombstones hold none). */
function draftsMentioning(id: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (readFileSync(p, "utf-8").includes(id)) hits.push(p);
    }
  };
  walk(join(dataDir, "drafts"));
  return hits;
}

const RUN = `run-${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
const DOC = `# Rollout ${RUN}\n\nStep one: add the cache.\n\nStep two: delete the old table.\n`;
const docAnnotations = (blocks: any[], tag: string) => [
  { id: `${tag}-a1`, blockId: blocks[1].id, startOffset: 10, endOffset: 24, type: "COMMENT", text: "Which cache?", originalText: "add the cache.", createdA: 1, images: [] },
  { id: `${tag}-a2`, blockId: blocks[2].id, startOffset: 10, endOffset: 30, type: "DELETION", originalText: "delete the old table", createdA: 2, images: [] },
  { id: `${tag}-g1`, blockId: "", startOffset: 0, endOffset: 0, type: "GLOBAL_COMMENT", text: "Looks good otherwise.", originalText: "", createdA: 3, images: [] },
];

/** Runs a decisionRequest's requests in order, as main.js does; the first one is the decision. */
async function decideAll(s: { decide: (d: any) => Promise<{ status: number; json: any }> }, r: P.DecisionRequest | null) {
  if (!r) throw new Error("decisionRequest sent nothing");
  const results = [];
  for (const d of r.requests) {
    const res = await s.decide(d);
    results.push(res);
    if (res.status !== 200) break;
  }
  return results;
}

const lastJson = (stdout: string) => JSON.parse(stdout.trim().split("\n").pop()!);

async function annotateSendAndExit() {
  const file = join(root, "rollout.md");
  writeFileSync(file, DOC);
  const s = await session(["plannotator", "annotate", file, "--json", "--browser", "none"], { cwd: root });
  const plan = (await s.call("GET", "/api/plan")).json;
  check(plan.mode === "annotate", "annotate: /api/plan reports annotate mode");
  const blocks = P.parseMarkdownToBlocks(plan.plan);
  const annotations = docAnnotations(blocks, "e2e-annotate");
  const clientId = P.newClientId();

  const missing = await s.decide(P.draftLoad({ session: plan, clientId }));
  let gen = P.draftRestore(missing.json, 0).draftGeneration;
  const save = P.draftSave({ session: plan, blocks, annotations, draftGeneration: gen, clientId });
  check((await s.decide(save)).status === 200, "annotate: draft save accepted");
  gen = save.draftGeneration!;
  const restored = P.draftRestore((await s.decide(P.draftLoad({ session: plan, clientId }))).json, 0);
  check(JSON.stringify(restored.annotations) === JSON.stringify(annotations) && restored.draftGeneration === gen,
    "annotate: GET /api/draft restores the saved annotations and generation", restored);

  const input = { session: plan, blocks, annotations, draftGeneration: gen, clientId };
  const res = await decideAll(s, P.decisionRequest("primary", input));
  check(res[0].status === 200, "annotate: Send Feedback (/api/feedback?client=) accepted", res);
  const out = await s.finish();
  const record = lastJson(out.stdout);
  check(record.decision === "annotated" && record.feedback === P.docFeedback(input),
    "annotate: CLI --json feedback is the builder's feedback, verbatim", { stdout: out.stdout, expected: P.docFeedback(input) });
  check(draftsMentioning("e2e-annotate-a1").length === 0, "annotate: no draft holding the sent comments survives the decision", draftsMentioning("e2e-annotate-a1"));

  const again = await session(["plannotator", "annotate", file, "--json", "--browser", "none"], { cwd: root });
  const plan2 = (await again.call("GET", "/api/plan")).json;
  const draft2 = await again.decide(P.draftLoad({ session: plan2 }));
  check(draft2.status === 404 && P.draftRestore(draft2.json, 0).draftGeneration >= gen + 1,
    "annotate: the next session on the file offers no draft and reports the tombstone generation", draft2);
  const exitRes = await again.decide(P.annotateExit({ session: plan2, blocks, annotations: [], draftGeneration: P.draftRestore(draft2.json, 0).draftGeneration, clientId }));
  check(exitRes.status === 200, "annotate: Close (/api/exit?...&client=) accepted", exitRes);
  const out2 = await again.finish();
  check(lastJson(out2.stdout).decision === "dismissed", "annotate: close prints the dismissed decision", out2.stdout);
}

async function annotateGateApproveWithNotes() {
  const file = join(root, "gate.md");
  writeFileSync(file, DOC);
  const s = await session(["plannotator", "annotate", file, "--gate", "--json", "--browser", "none"], { cwd: root });
  const plan = (await s.call("GET", "/api/plan")).json;
  const blocks = P.parseMarkdownToBlocks(plan.plan);
  const input = { session: plan, blocks, annotations: docAnnotations(blocks, "e2e-gate"), clientId: P.newClientId() };
  check(plan.gate === true && plan.approvalNotesSupported === true, "gate: session advertises the gate and approval notes", plan);
  const offered = P.buildDecisionSpec(P.decisionSpecInput("annotate", input)).items.map((i) => i.id);
  check(offered.includes("approve-with-notes"), "gate: the spec offers Approve with notes", offered);
  const res = await decideAll(s, P.decisionRequest("approve-with-notes", input));
  check(res[0].status === 200, "gate: Approve with notes (/api/approve?client=) accepted", res);
  const record = lastJson((await s.finish()).stdout);
  check(record.decision === "approved" && record.feedback === P.docFeedback(input),
    "gate: approved with the builder's notes verbatim", { record, expected: P.docFeedback(input) });
}

/**
 * Another page of the same session (the browser opened from the pane's
 * "Open in browser") comments on a linked document. The pane's decision
 * names its own page, so the server keeps that copy for the next session;
 * a decision without a page id clears every copy the session touched.
 */
async function linkedCopyOfAnotherPage(withClient: boolean) {
  const dir = join(root, `linked-${withClient ? "client" : "bare"}`);
  mkdirSync(dir);
  const file = join(dir, "root.md");
  const linked = join(dir, "design.md");
  writeFileSync(file, `${DOC}\nSee [design](design.md).\n`);
  writeFileSync(linked, "# Design\n\nBody\n");
  const open = () => session(["plannotator", "annotate", file, "--json", "--browser", "none"], { cwd: dir });
  const s = await open();
  const plan = (await s.call("GET", "/api/plan")).json;
  check(plan.documentDrafts === true, "linked: the session keeps per-document copies", plan.documentDrafts);
  const theirs = { id: `browser-${withClient}`, blockId: "", startOffset: 0, endOffset: 4, type: "COMMENT", text: "from the browser", originalText: "Body", createdA: 1, images: [] };
  const wrote = await s.call("POST", "/api/draft/document?client=browser-page", { documents: [{ path: linked, annotations: [theirs] }] });
  check(wrote.status === 200, "linked: the other page saved its copy", wrote);
  const blocks = P.parseMarkdownToBlocks(plan.plan);
  const ours = { session: plan, blocks, annotations: docAnnotations(blocks, `e2e-linked-${withClient}`), ...(withClient ? { clientId: P.newClientId() } : {}) };
  const res = await decideAll(s, P.decisionRequest("primary", ours));
  check(res[0].status === 200, `linked: the pane's send ${withClient ? "with" : "without"} a page id accepted`, res);
  await s.finish();

  const next = await open();
  const copy = await next.call("GET", `/api/draft/document?path=${encodeURIComponent(linked)}`);
  const kept = copy.status === 200 && copy.json.annotations?.some((a: any) => a.id === theirs.id);
  check(kept === withClient, withClient
    ? "linked: with the pane's page id, the other page's comments survive for the next session"
    : "linked: without a page id, the decision clears the other page's comments too", copy);
  await next.decide(P.annotateExit({ session: (await next.call("GET", "/api/plan")).json, blocks, annotations: [] }));
  await next.finish();
}

const hookInput = (plan: string) => JSON.stringify({
  session_id: "herdr-plannotator-e2e",
  transcript_path: join(root, "transcript.jsonl"),
  cwd: root,
  permission_mode: "plan",
  hook_event_name: "PermissionRequest",
  tool_name: "ExitPlanMode",
  tool_input: { plan },
});

async function planSession(tag: string) {
  const s = await session(["plannotator"], { cwd: root, stdin: hookInput(DOC) });
  const plan = (await s.call("GET", "/api/plan")).json;
  const blocks = P.parseMarkdownToBlocks(plan.plan);
  return { s, plan, input: { session: plan, blocks, annotations: docAnnotations(blocks, tag), clientId: P.newClientId() } };
}

async function planPrimaryDenies() {
  const { s, plan, input } = await planSession("e2e-deny");
  check(plan.mode === undefined && plan.origin === "claude-code", "plan: hook session is plan review from claude-code", { mode: plan.mode, origin: plan.origin });
  const primary = P.buildDecisionSpec(P.decisionSpecInput("plan", input)).primary.label;
  check(primary === "Send Feedback", "plan: with annotations the primary is Send Feedback", primary);
  const res = await decideAll(s, P.decisionRequest("primary", input));
  check(res[0].status === 200, "plan: the primary's /api/deny?client= accepted", res);
  const decision = JSON.parse((await s.finish()).stdout).hookSpecificOutput.decision;
  check(decision.behavior === "deny" && decision.message.includes(P.docFeedback(input)),
    "plan: deny message carries the builder's feedback verbatim", { decision, expected: P.docFeedback(input) });
}

async function planDiscardAndFinish() {
  const { s, input } = await planSession("e2e-discard");
  const res = await decideAll(s, P.decisionRequest("discard-and-finish", { ...input, settings: { permissionMode: "default" } }));
  check(res[0].status === 200, "plan: discard-and-finish's /api/approve?client= accepted", res);
  const decision = JSON.parse((await s.finish()).stdout).hookSpecificOutput.decision;
  check(decision.behavior === "allow" && decision.updatedPermissions?.[0]?.mode === "default" && !JSON.stringify(decision).includes("Which cache?"),
    "plan: discard allows without the annotations, in the permission mode the settings name", decision);
}

async function planApprove() {
  const { s, input } = await planSession("e2e-approve");
  const res = await decideAll(s, P.decisionRequest("primary", { ...input, annotations: [] }));
  check(res[0].status === 200, "plan: the empty primary's /api/approve accepted", res);
  const decision = JSON.parse((await s.finish()).stdout).hookSpecificOutput.decision;
  check(decision.behavior === "allow" && decision.updatedPermissions?.[0]?.mode === "acceptEdits",
    "plan: approve allows and sets the browser's default permission mode", decision);
}

async function reviewSession(tag: string) {
  const repo = join(root, `repo-${tag}`);
  mkdirSync(repo);
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@x", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@x" } });
  git("init", "-q");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  git("add", ".");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\nexport const renamed = 2;\nexport const c = 3;\n");
  const s = await session(["plannotator", "review", "--json", "--browser", "none"], { cwd: repo });
  const diff = (await s.call("GET", "/api/diff")).json;
  // The web stamps a local review's comments with the target on screen (useAnnotationFactory withPRContext).
  const annotations = [
    { id: `e2e-${tag}-c1`, type: "comment", scope: "line", filePath: "a.ts", lineStart: 2, lineEnd: 3, side: "new", text: "Why rename?", createdAt: 1, localReviewTarget: diff.localDraftTarget },
  ];
  return { s, diff, input: { session: diff, annotations, clientId: P.newClientId() } };
}

// The CLI frames review feedback in its prompt and trims its trailing blank lines.
const reviewCarries = (record: any, input: P.ReviewInput) => record.message.includes(P.reviewFeedback(input).trimEnd());

async function reviewPrimarySends() {
  const { s, diff, input } = await reviewSession("send");
  check(diff.rawPatch.includes("renamed"), "review: /api/diff carries the change");
  const res = await decideAll(s, P.decisionRequest("primary", input));
  check(res[0].status === 200, "review: the primary's /api/feedback?client= accepted", res);
  const record = lastJson((await s.finish()).stdout);
  check(record.decision === "annotated" && reviewCarries(record, input), "review: Send Feedback prints the builder's feedback verbatim", record);
}

async function reviewNoteWithFeedback() {
  const { s, input } = await reviewSession("note");
  const r = P.decisionRequest("note-with-feedback", input, "Add a test.")!;
  const res = await decideAll(s, r);
  check(res[0].status === 200, "review: Send with a note accepted", res);
  const record = lastJson((await s.finish()).stdout);
  const sent = { ...input, annotations: [...input.annotations, r.note as any] };
  check(record.decision === "annotated" && reviewCarries(record, sent) && record.message.includes("## General\n\nAdd a test."),
    "review: the note reaches the agent as the general comment, after the line comments", { record, expected: P.reviewFeedback(sent) });
}

async function reviewApproveWithNotes() {
  const { s, diff, input } = await reviewSession("approve");
  check(diff.approvalNotesSupported === true, "review: session advertises approval notes", diff.approvalNotesSupported);
  const res = await decideAll(s, P.decisionRequest("approve-with-notes", input));
  check(res[0].status === 200, "review: Approve with notes accepted", res);
  const record = lastJson((await s.finish()).stdout);
  check(record.decision === "approved" && reviewCarries(record, input), "review: approve with notes prints the builder's feedback verbatim", record);
}

async function reviewDraftThenExit() {
  const { s, diff, input } = await reviewSession("exit");
  check(typeof diff.localDraftTarget === "string" && diff.localDraftTarget.length > 0, "review: a local review names its draft target", diff.localDraftTarget);
  const save = P.draftSave(input);
  check((await s.decide(save)).status === 200, "review: draft save on ?target=&client= accepted");
  const restored = P.draftRestore((await s.decide(P.draftLoad(input))).json, 0);
  check(JSON.stringify(restored.annotations) === JSON.stringify(input.annotations) && restored.draftGeneration === save.draftGeneration,
    "review: the target-pinned draft restores", restored);
  const exit = await s.decide(P.reviewExit({ ...input, draftGeneration: save.draftGeneration }));
  check(exit.status === 200, "review: Close (/api/exit?client=&draftGeneration=) accepted", exit);
  const out = await s.finish();
  check(out.code === 0 && lastJson(out.stdout).decision === "dismissed", "review: close prints the dismissed decision", out);
  check(draftsMentioning("e2e-exit-c1").length === 0, "review: Close clears the draft it saved", draftsMentioning("e2e-exit-c1"));
}

/** Files under these dirs written during this run that mention it. */
function runHits(dirs: string[]): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.mtimeMs >= startedAt && st.size < 5_000_000 && readFileSync(p, "utf-8").includes(RUN)) hits.push(p);
    }
  };
  for (const dir of dirs) walk(dir);
  return hits;
}

try {
  await annotateSendAndExit();
  await annotateGateApproveWithNotes();
  await linkedCopyOfAnotherPage(true);
  await linkedCopyOfAnotherPage(false);
  await planPrimaryDenies();
  await planDiscardAndFinish();
  await planApprove();
  await reviewPrimarySends();
  await reviewNoteWithFeedback();
  await reviewApproveWithNotes();
  await reviewDraftThenExit();
  check(runHits([dataDir]).length > 0, "the run's own data dir holds its records");
  const realDirs = [join(homedir(), ".plannotator"), join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "plannotator")];
  const hits = runHits(realDirs);
  check(hits.length === 0, "nothing from this run written to the user's real data dir", hits);
} catch (e) {
  failures++;
  console.log("FAIL", e);
} finally {
  for (const p of live) p.kill();
  if (failures === 0) rmSync(root, { recursive: true, force: true });
  else console.log(`kept ${root} for inspection`);
}
console.log(failures === 0 ? "e2e: all passed" : `e2e: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
