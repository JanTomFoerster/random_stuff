      import { readFile } from "node:fs/promises";

      const { GITLAB_TOKEN, CI_API_V4_URL, CI_PROJECT_ID, CI_MERGE_REQUEST_IID } = process.env;
      const MARKER = "<!-- npm-deprecations -->";
      const MR = `${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/merge_requests/${CI_MERGE_REQUEST_IID}`;

      const api = (path, init) =>
        fetch(MR + path, {
          ...init,
          headers: { "PRIVATE-TOKEN": GITLAB_TOKEN, "content-type": "application/json" },
        }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} on ${path}`))));

      // npm 10 prints "npm warn deprecated", npm 9 and earlier "npm WARN deprecated".
      const log = await readFile("/tmp/npm.log", "utf8");
      const found = [
        ...new Set(
          log
            .split("\n")
            .map((l) => l.match(/^npm\s+warn\s+deprecated\s+(\S+):\s*(.*)$/i))
            .filter(Boolean)
            .map(([, spec, msg]) => `- \`${spec}\` — ${msg.trim()}`)
        ),
      ].sort();

      const body = `${MARKER}\n### npm deprecations (${found.length})\n\n${
        found.join("\n") || "None. :white_check_mark:"
      }`;

      const mine = (await api("/notes?per_page=100")).find((n) => n.body?.includes(MARKER));
      await api(mine ? `/notes/${mine.id}` : "/notes", {
        method: mine ? "PUT" : "POST",
        body: JSON.stringify({ body }),
      });
      console.log(`${found.length} deprecated`);