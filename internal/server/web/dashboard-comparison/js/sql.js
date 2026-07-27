// sql.js — tiny, safe SQL syntax highlighter (escapes first, then wraps tokens).

const KEYWORDS = /\b(SELECT|FROM|WHERE|GROUP\s+BY|ORDER\s+BY|AS|AND|OR|EXEC|SUM|N)\b/gi;
const FUNCS = /\b(SUM|COUNT|AVG|CONVERT|CONVERT_IMPLICIT)\b/gi;

function escapeHTML(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Returns highlighted HTML for a SQL snippet. Input is escaped up-front. */
export function highlightSQL(sql) {
  let html = escapeHTML(sql);

  // Unicode literals N'...' -> flagged (orange). Handles doubled '' inside.
  html = html.replace(/N'(?:[^']|'')*'/g, m => `<span class="n">${m}</span>`);
  // Remaining single-quoted string literals -> green.
  html = html.replace(/(^|[^>])'(?:[^']|'')*'/g, (m, pre) =>
    `${pre}<span class="s">${m.slice(pre.length)}</span>`);
  // Keywords.
  html = html.replace(KEYWORDS, m => `<span class="k">${m}</span>`);
  // Function names (override keyword styling where they overlap is fine).
  html = html.replace(FUNCS, m => `<span class="f">${m}</span>`);
  return html;
}
