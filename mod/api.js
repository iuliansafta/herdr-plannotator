// HTTP client for one Plannotator session. The server guards writes by Origin;
// this client sends none, which the guard accepts (isSameOriginOrNoOrigin).

export class Api {
  constructor(origin) {
    this.origin = origin.replace(/\/+$/, "");
  }

  url(path) {
    return this.origin + path;
  }

  async get(path) {
    const res = await fetch(this.url(path));
    return { status: res.status, ok: res.ok, json: res.ok ? await res.json() : await safeJson(res) };
  }

  async send(method, path, body) {
    const res = await fetch(this.url(path), {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, ok: res.ok, json: await safeJson(res) };
  }

  /** Runs a vendor Decision ({method, path, body}). */
  decide(decision) {
    return this.send(decision.method, decision.path, decision.body);
  }
}

async function safeJson(res) {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** Which Plannotator server this is, from the endpoints it answers. */
export async function loadSession(api) {
  const plan = await api.get("/api/plan");
  if (plan.ok) {
    const s = plan.json;
    const kind = s.mode === "annotate" ? "annotate" : s.mode === "archive" ? "archive" : "plan";
    return { kind, data: s };
  }
  const diff = await api.get("/api/diff");
  if (diff.ok) return { kind: "review", data: diff.json };
  throw new Error(`Not a Plannotator session (GET /api/plan ${plan.status}, /api/diff ${diff.status})`);
}
