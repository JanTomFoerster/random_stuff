// Post npm-deprecation or ESLint findings onto a GitLab MR, using only Node's
// built-in fetch — for runners that have no curl.
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
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

// Findings this far apart or less are merged into a single comment.
const GROUP_GAP = 5;

const fmt = (m) => `- **${m.ruleId ?? "n/a"}**: ${m.message}`;
const digest = (s) => createHash("sha1").update(s).digest("hex").slice(0, 10);

const sources = new Map(); // linted files, read lazily by source()

// At most this many findings are listed in the out-of-diff note.
const MAX_LISTED = 20;

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

// One inline diff comment per cluster of nearby findings, skipping clusters we
// have already commented on. GitLab will only anchor to a line inside the MR's
// hunks, so findings elsewhere in a changed file are collected into one note
// instead.
async function eslintComments(json) {
  const results = json.trim() ? JSON.parse(json) : []; // eslint may have died before writing
  // This script usually lives in the repo it is linting, so skip its own file.
  const self = relative(process.cwd(), fileURLToPath(import.meta.url)).replaceAll("\\", "/");
  const files = await diffFiles();
  const { base_sha, start_sha, head_sha } = (await api("")).diff_refs;
  const discussions = await apiAll("/discussions");
  const seen = discussions.flatMap((d) => d.notes.map((n) => n.body ?? ""));

  let posted = 0;
  const unplaced = [];
  const refused = new Map(); // GitLab's complaint -> how many positions drew it
  const live = new Set(); // markers that still correspond to a real finding
  for (const file of results) {
    const path = relative(process.cwd(), file.filePath).replaceAll("\\", "/");
    if (path === self) continue;
    // A file this MR does not touch is not this MR's business.
    const hunkLines = files.get(path);
    if (!hunkLines) continue;

    const byLine = new Map();
    for (const m of file.messages) {
      if (m.line == null) continue; // parse errors etc. have no line
      if (!byLine.has(m.line)) byLine.set(m.line, []);
      byLine.get(m.line).push(m);
    }
    if (!byLine.size) continue;

    const src = await source(path);
    const used = new Map();
    for (const group of cluster([...byLine.keys()].sort((a, b) => a - b), src)) {
      const list =
        group.length === 1
          ? byLine.get(group[0]).map(fmt).join("\n")
          : group.map((l) => `**line ${l}**\n${byLine.get(l).map(fmt).join("\n")}`).join("\n");
      const where = group.length === 1 ? `${path}:${group[0]}` : `${path}:${group[0]}-${group.at(-1)}`;

      // Key the marker on the findings themselves, not on line numbers: a later
      // push that shifts the file must not make every finding look new and post
      // a second copy of it one line further down.
      let key = `${path}:${digest(list)}`;
      const nth = (used.get(key) ?? 0) + 1;
      used.set(key, nth);
      if (nth > 1) key += `#${nth}`; // same findings twice in one file
      live.add(key);

      // Anchor on the first line of the group that is actually in a hunk; a
      // group can straddle the edge of one.
      const line = group.find((l) => hunkLines.has(l));
      if (line == null) {
        unplaced.push(`- \`${where}\`\n${list.replace(/^/gm, "  ")}`);
        continue;
      }
      if (seen.some((b) => b.includes(tag(`:${key}`)))) continue;

      const old = hunkLines.get(line);
      try {
        await api("/discussions", {
          method: "POST",
          body: JSON.stringify({
            body: `${tag(`:${key}`)}\n${title}:\n${list}`,
            position: {
              position_type: "text",
              base_sha,
              start_sha,
              head_sha,
              new_path: path,
              new_line: line,
              ...(old == null ? {} : { old_line: old }),
            },
          }),
        });
        posted++;
      } catch (e) {
        // Only a refused position is recoverable; a dead token must still fail
        // the job. Count the complaint rather than reprinting it per finding.
        if (!/^(400|422) /.test(e.message)) throw e;
        const why = e.message.slice(0, 120);
        refused.set(why, (refused.get(why) ?? 0) + 1);
        unplaced.push(`- \`${where}\`\n${list.replace(/^/gm, "  ")}`);
      }
    }
  }

  const shown = unplaced.slice(0, MAX_LISTED);
  const more = unplaced.length - shown.length;
  await upsertNote(
    tag(":unplaced"),
    unplaced.length
      ? `### ${title} — outside this MR's diff (${unplaced.length})\n\n${shown.join("\n")}${
          more ? `\n\n…and ${more} more.` : ""
        }`
      : ""
  );
  // An empty results array means eslint never wrote its report (it is run with
  // `|| true`), not that the repo is clean — resolving everything on that would
  // wipe the whole review. A clean repo still yields one entry per linted file.
  const closed = results.length ? await reconcile(discussions, live) : 0;
  if (!results.length) console.log("eslint produced no report; leaving existing threads alone");

  for (const [why, n] of refused) console.log(`GitLab refused ${n} position(s): ${why}`);
  console.log(
    `${posted} inline comment(s), ${closed} thread(s) resolved, ${unplaced.length} finding(s) outside the diff`
  );
}

// Group line numbers that sit within GROUP_GAP of each other, splitting wherever
// the source suggests the two findings are in different functions.
function cluster(lines, src) {
  const groups = [];
  for (const line of lines) {
    const g = groups.at(-1);
    if (g && line - g.at(-1) <= GROUP_GAP && !boundaryBetween(src, g.at(-1), line)) g.push(line);
    else groups.push([line]);
  }
  return groups;
}

// Heuristic: a closing brace or a declaration at column 0 ends whatever function
// we were in, so findings either side of it are not really neighbours and
// merging them would be misleading. This also stops top-level findings from
// being merged at all, which is what we want. Without the source file (it was
// linted but not readable here) we fall back to distance alone.
function boundaryBetween(src, from, to) {
  if (!src) return false;
  for (let l = from + 1; l <= to; l++) {
    if (/^(\}|(export\s+)?(default\s+)?(async\s+)?(function|class|const|let|var)\b)/.test(src[l - 1] ?? "")) return true;
  }
  return false;
}

// Read a linted file so cluster() can see where functions end. Cached, and null
// if it cannot be read.
async function source(path) {
  if (!sources.has(path)) {
    sources.set(
      path,
      await readFile(path, "utf8").then(
        (s) => s.split("\n"),
        () => null
      )
    );
  }
  return sources.get(path);
}


// Per changed file: new_line -> old_line for every line inside a hunk, with null
// for a line this MR added. GitLab rejects a position outside the hunks, so a
// line missing from this map cannot be commented on at all.
async function diffFiles() {
  const map = new Map();
  for (const d of await apiAll("/diffs")) {
    if (d.deleted_file || !d.diff) continue; // binary, or too large to inline
    const lines = new Map();
    let n = 0;
    let o = 0;
    for (const l of d.diff.split("\n")) {
      const hunk = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (hunk) {
        o = Number(hunk[1]);
        n = Number(hunk[2]);
      } else if (!l) continue; // trailing split artefact; a real blank line is " "
      else if (l.startsWith("\\")) continue; // "\ No newline at end of file"
      else if (l.startsWith("+")) lines.set(n++, null); // added: exists only in the new file
      else if (l.startsWith("-")) o++; // removed: absent from the new file
      else lines.set(n++, o++); // context: present on both sides
    }
    map.set(d.new_path, lines);
  }
  return map;
}

// Resolve the threads we opened for findings that are now gone. Only threads
// carrying our marker are touched, so a reviewer's own comments are never
// affected, and resolving keeps the thread and any replies on it.
async function reconcile(discussions, live) {
  const ours = new RegExp(`<!--\\s*${escapeRe(args.marker)}:(\\S+?)\\s*-->`);
  let closed = 0;
  for (const d of discussions) {
    const first = d.notes?.[0];
    const key = first?.body?.match(ours)?.[1];
    if (!key || key === "unplaced") continue; // not ours, or the summary note
    if (live.has(key)) continue; // the finding is still there
    if (!first.resolvable || d.notes.every((n) => n.resolved)) continue;
    await api(`/discussions/${d.id}`, { method: "PUT", body: JSON.stringify({ resolved: true }) });
    closed++;
  }
  return closed;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
