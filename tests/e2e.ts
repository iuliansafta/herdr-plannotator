// End to end against the installed `plannotator` CLI: each session gets the
// vendor builders' requests (no Origin header, as main.js sends them) and the
// CLI's stdout must carry the builders' feedback verbatim.
// Run: bun tests/e2e.ts
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import * as P from "../mod/vendor/plannotator.js";

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

async function annotateSendAndExit() {
  const file = join(root, "rollout.md");
  writeFileSync(file, DOC);
  const s = await session(["plannotator", "annotate", file, "--json", "--browser", "none"], { cwd: root });
  const plan = (await s.call("GET", "/api/plan")).json;
  check(plan.mode === "annotate", "annotate: /api/plan reports annotate mode");
  const blocks = P.parseMarkdownToBlocks(plan.plan);
  const annotations = docAnnotations(blocks, "e2e-annotate");

  const missing = await s.call("GET", "/api/draft");
  let gen = P.draftRestore(missing.json, 0).draftGeneration;
  const save = P.draftSave({ session: plan, blocks, annotations, draftGeneration: gen });
  check((await s.decide(save)).status === 200, "annotate: draft save accepted");
  gen = save.draftGeneration;
  const restored = P.draftRestore((await s.call("GET", "/api/draft")).json, 0);
  check(JSON.stringify(restored.annotations) === JSON.stringify(annotations) && restored.draftGeneration === gen,
    "annotate: GET /api/draft restores the saved annotations and generation", restored);

  const input = { session: plan, blocks, annotations, draftGeneration: gen };
  const res = await s.decide(P.annotateSend(input));
  check(res.status === 200, "annotate: /api/feedback accepted", res);
  await s.decide(P.draftDismiss(input)).catch(() => null);
  const out = await s.finish();
  const record = JSON.parse(out.stdout.trim().split("\n").pop()!);
  check(record.decision === "annotated" && record.feedback === P.docFeedback(input),
    "annotate: CLI --json feedback is the builder's feedback, verbatim", { stdout: out.stdout, expected: P.docFeedback(input) });
  check(draftsMentioning("e2e-annotate-a1").length === 0, "annotate: no draft holding the sent comments survives the decision", draftsMentioning("e2e-annotate-a1"));

  const again = await session(["plannotator", "annotate", file, "--json", "--browser", "none"], { cwd: root });
  const plan2 = (await again.call("GET", "/api/plan")).json;
  const draft2 = await again.call("GET", "/api/draft");
  check(draft2.status === 404 && P.draftRestore(draft2.json, 0).draftGeneration >= gen + 1,
    "annotate: the next session on the file offers no draft and reports the tombstone generation", draft2);
  const exitRes = await again.decide(P.annotateExit({ session: plan2, blocks, annotations: [], draftGeneration: P.draftRestore(draft2.json, 0).draftGeneration }));
  check(exitRes.status === 200, "annotate: /api/exit accepted", exitRes);
  const out2 = await again.finish();
  check(JSON.parse(out2.stdout.trim().split("\n").pop()!).decision === "dismissed", "annotate: close prints the dismissed decision", out2.stdout);
}

async function annotateGateApprove() {
  const file = join(root, "gate.md");
  writeFileSync(file, DOC);
  const s = await session(["plannotator", "annotate", file, "--gate", "--json", "--browser", "none"], { cwd: root });
  const plan = (await s.call("GET", "/api/plan")).json;
  const blocks = P.parseMarkdownToBlocks(plan.plan);
  const input = { session: plan, blocks, annotations: docAnnotations(blocks, "e2e-gate") };
  check(plan.gate === true, "gate: session advertises the gate");
  const res = await s.decide(P.annotateApprove(input));
  check(res.status === 200, "gate: /api/approve accepted", res);
  const record = JSON.parse((await s.finish()).stdout.trim().split("\n").pop()!);
  const expected = plan.approvalNotesSupported === true ? P.docFeedback(input) : undefined;
  check(record.decision === "approved" && (expected === undefined || record.feedback === expected),
    `gate: approved${expected ? " with the builder's notes verbatim" : " (host takes no notes)"}`, record);
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

async function planDeny() {
  const s = await session(["plannotator"], { cwd: root, stdin: hookInput(DOC) });
  const plan = (await s.call("GET", "/api/plan")).json;
  check(plan.mode === undefined && plan.origin === "claude-code", "plan: hook session is plan review from claude-code", { mode: plan.mode, origin: plan.origin });
  const blocks = P.parseMarkdownToBlocks(plan.plan);
  const input = { session: plan, blocks, annotations: docAnnotations(blocks, "e2e-deny") };
  const res = await s.decide(P.planDeny(input));
  check(res.status === 200, "plan: /api/deny accepted", res);
  const decision = JSON.parse((await s.finish()).stdout).hookSpecificOutput.decision;
  check(decision.behavior === "deny" && decision.message.includes(P.docFeedback(input)),
    "plan: deny message carries the builder's feedback verbatim", { decision, expected: P.docFeedback(input) });
}

async function planApprove() {
  const s = await session(["plannotator"], { cwd: root, stdin: hookInput(DOC) });
  const plan = (await s.call("GET", "/api/plan")).json;
  const blocks = P.parseMarkdownToBlocks(plan.plan);
  const res = await s.decide(P.planApprove({ session: plan, blocks, annotations: [] }));
  check(res.status === 200, "plan: /api/approve accepted", res);
  const decision = JSON.parse((await s.finish()).stdout).hookSpecificOutput.decision;
  check(decision.behavior === "allow" && decision.updatedPermissions?.[0]?.mode === "acceptEdits",
    "plan: approve allows and sets the browser's default permission mode", decision);
}

async function review(approved: boolean) {
  const repo = join(root, `repo-${approved ? "approve" : "send"}`);
  mkdirSync(repo);
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@x", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@x" } });
  git("init", "-q");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  git("add", ".");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\nexport const renamed = 2;\nexport const c = 3;\n");

  const s = await session(["plannotator", "review", "--json", "--browser", "none"], { cwd: repo });
  const diff = (await s.call("GET", "/api/diff")).json;
  check(diff.rawPatch.includes("renamed"), `review: /api/diff carries the change`);
  const annotations = [
    { id: "e2e-c1", type: "comment", scope: "line", filePath: "a.ts", lineStart: 2, lineEnd: 3, side: "new", text: "Why rename?", createdAt: 1 },
    { id: "e2e-c2", type: "comment", scope: "general", filePath: "", lineStart: 0, lineEnd: 0, side: "new", text: "Add a test.", createdAt: 2 },
  ];
  const input = { session: diff, annotations, approved };
  const res = await s.decide(P.reviewSend(input));
  check(res.status === 200, `review: /api/feedback (approved ${approved}) accepted`, res);
  const record = JSON.parse((await s.finish()).stdout.trim().split("\n").pop()!);
  // The CLI frames the feedback in its review prompt and trims its trailing blank lines.
  const expected = P.reviewFeedback(input).trimEnd();
  const carried = approved && diff.approvalNotesSupported !== true ? !record.message.includes(expected) : record.message.includes(expected);
  check(record.decision === (approved ? "approved" : "annotated") && carried,
    `review: ${approved ? "approve" : "send"} prints the builder's feedback verbatim`, { record, expected });
}

/** Files in the user's real data dirs written during this run that mention it. */
function realDataDirHits(): string[] {
  const dirs = [join(homedir(), ".plannotator"), join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "plannotator")];
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
  await annotateGateApprove();
  await planDeny();
  await planApprove();
  await review(false);
  await review(true);
  const hits = realDataDirHits();
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
