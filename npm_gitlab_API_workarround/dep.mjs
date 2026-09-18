// Post npm-deprecation or ESLint findings onto a GitLab MR, using only Node's
// built-in fetch — for runners that have no curl.
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    log: { type: "string" },
    format: { type: "string", default: "npm" },
    marker: { type: "string" },
    title: { type: "string" },
  },
});

const die = (msg) => {
  console.error(`dep.mjs: ${msg}`);
  process.exit(1);
};

if (!args.log) die("--log <file> is required");
if (!args.marker) die("--marker <slug> is required");

const { GITLAB_TOKEN, CI_API_V4_URL, CI_PROJECT_ID, CI_MERGE_REQUEST_IID } = process.env;
if (!GITLAB_TOKEN) die("GITLAB_TOKEN is empty — is the CI variable protected while this branch is not?");
if (!CI_MERGE_REQUEST_IID) die("not a merge-request pipeline, nothing to comment on");

const MR = `${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/merge_requests/${CI_MERGE_REQUEST_IID}`;
const title = args.title ?? args.marker;
// Invisible HTML comment that lets a re-run recognise its own notes.
const tag = (suffix = "") => `<!-- ${args.marker}${suffix} -->`;

const api = async (path, init) => {
  const r = await fetch(MR + path, {
    ...init,
    headers: { "PRIVATE-TOKEN": GITLAB_TOKEN, "content-type": "application/json" },
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} on ${path}: ${await r.text()}`);
  return r.json();
};

// per_page tops out at 100, so walk every page — otherwise a busy MR hides our
// own marker behind page 1 and we post duplicates.
const apiAll = async (path) => {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await api(`${path}?per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) return out;
  }
};

const raw = await readFile(args.log, "utf8");
if (args.format === "eslint") await eslintComments(raw);
else await npmSummary(raw);

// Create or rewrite the single MR note carrying this marker. An empty body
// empties an existing note but never creates a new one.
async function upsertNote(mark, body) {
  const mine = (await apiAll("/notes")).find((n) => n.body?.includes(mark));
  if (!mine && !body) return;
  await api(mine ? `/notes/${mine.id}` : "/notes", {
    method: mine ? "PUT" : "POST",
    body: JSON.stringify({ body: `${mark}\n${body || "None. :white_check_mark:"}` }),
  });
}

async function npmSummary(log) {
  // npm 10 prints "npm warn deprecated", npm 9 and earlier "npm WARN deprecated".
  const found = [
    ...new Set(
      log
        .split("\n")
        .map((l) => l.match(/^npm\s+warn\s+deprecated\s+(\S+):\s*(.*)$/i))
        .filter(Boolean)
        .map(([, spec, msg]) => `- \`${spec}\` — ${msg.trim()}`)
    ),
  ].sort();

  await upsertNote(tag(), `### ${title} (${found.length})\n\n${found.join("\n")}`);
  console.log(`${found.length} deprecation(s) reported`);
}

// One inline diff comment per offending line, skipping lines already commented on.
// Anything GitLab refuses to anchor falls back to a summary note so it is not lost.
async function eslintComments(json) {
  const results = json.trim() ? JSON.parse(json) : []; // eslint may have died before writing
  const files = await diffFiles();
  const { base_sha, start_sha, head_sha } = (await api("")).diff_refs;
  const seen = (await apiAll("/discussions")).flatMap((d) => d.notes.map((n) => n.body ?? ""));

  const byLine = new Map();
  for (const file of results) {
    const path = relative(process.cwd(), file.filePath).replaceAll("\\", "/");
    for (const m of file.messages) {
      if (m.line == null) continue; // parse errors etc. have no line
      const key = `${path}:${m.line}`;
      if (!byLine.has(key)) byLine.set(key, { path, line: m.line, key, messages: [] });
      byLine.get(key).messages.push(m);
    }
  }

  let posted = 0;
  const unplaced = [];
  for (const { path, line, key, messages } of byLine.values()) {
    if (seen.some((b) => b.includes(tag(`:${key}`)))) continue;
    const list = messages.map((m) => `- **${m.ruleId ?? "n/a"}**: ${m.message}`).join("\n");
    const position = positionFor(files, path, line);
    if (position) {
      try {
        await api("/discussions", {
          method: "POST",
          body: JSON.stringify({
            body: `${tag(`:${key}`)}\n${title}:\n${list}`,
            position: { position_type: "text", base_sha, start_sha, head_sha, new_path: path, ...position },
          }),
        });
        posted++;
        continue;
      } catch (e) {
        // Only a refused position is recoverable; a dead token must still fail the job.
        if (!/^(400|422) /.test(e.message)) throw e;
        console.log(`could not anchor on ${key}: ${e.message.slice(0, 200)}`);
      }
    }
    unplaced.push(`- \`${key}\`\n${list.replace(/^/gm, "  ")}`);
  }

  await upsertNote(
    tag(":unplaced"),
    unplaced.length ? `### ${title} — could not be placed inline (${unplaced.length})\n\n${unplaced.join("\n")}` : ""
  );
  console.log(`${posted} inline comment(s) posted, ${unplaced.length} finding(s) fell back to a summary note`);
}

// GitLab wants new_line alone for an added line, but both old_line and new_line
// for a line that exists unchanged on both sides — including one outside every
// hunk, which it has to unfold the diff to reach.
function positionFor(files, path, line) {
  const f = files.get(path);
  if (!f) return null; // file not in the MR diff at all — nothing to anchor to
  if (f.inHunk.has(line)) {
    const old = f.inHunk.get(line);
    return old == null ? { new_line: line } : { old_line: old, new_line: line };
  }
  // Outside every hunk the line is unchanged, so derive old_line from the drift
  // accumulated by the hunks before it.
  let drift = 0;
  for (const c of f.marks) if (c.newEnd <= line) drift = c.newEnd - c.oldEnd;
  return { old_line: line - drift, new_line: line };
}

// Per file: new_line -> old_line inside the hunks (null for added lines), plus
// marks at each hunk boundary so lines between hunks can be mapped too.
async function diffFiles() {
  const map = new Map();
  for (const d of await apiAll("/diffs")) {
    if (d.deleted_file || !d.diff) continue; // binary, or too large to inline
    const inHunk = new Map();
    const marks = [{ newEnd: 0, oldEnd: 0 }];
    let n = 0;
    let o = 0;
    for (const l of d.diff.split("\n")) {
      const hunk = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (hunk) {
        marks.push({ newEnd: n, oldEnd: o });
        o = Number(hunk[1]);
        n = Number(hunk[2]);
      } else if (!l) continue; // trailing split artefact; a real blank line is " "
      else if (l.startsWith("\\")) continue; // "\ No newline at end of file"
      else if (l.startsWith("+")) inHunk.set(n++, null); // added: exists only in the new file
      else if (l.startsWith("-")) o++; // removed: absent from the new file
      else inHunk.set(n++, o++); // context: present on both sides
    }
    marks.push({ newEnd: n, oldEnd: o });
    map.set(d.new_path, { inHunk, marks });
  }
  return map;
}
