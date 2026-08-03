// sql.js — tiny, safe SQL syntax highlighter (escapes first, then wraps tokens).

const KEYWORDS = /\b(SELECT|FROM|WHERE|GROUP\s+BY|ORDER\s+BY|AS|AND|OR|EXEC)\b/gi;
const FUNCS = /\b(SUM|COUNT|AVG|CONVERT|CONVERT_IMPLICIT)\b/gi;

// Private-use delimiters wrap a literal's index while the keyword pass runs, so
// the placeholder never collides with SQL content (e.g. the "0" in "TBL0") and
// carries no word chars for \b keyword/func regexes to catch. Built at runtime
// from code points so the source stays plain ASCII.
const PH_OPEN = String.fromCharCode(0xe000);
const PH_CLOSE = String.fromCharCode(0xe001);
const PH_RESTORE = new RegExp(PH_OPEN + "(\\d+)" + PH_CLOSE, "g");

function escapeHTML(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Returns highlighted HTML for a SQL snippet. Input is escaped up-front.
 *
 * String literals are stashed behind placeholders BEFORE the keyword pass runs,
 * so (a) keywords inside a literal are never highlighted and (b) the keyword
 * regex can never match the class name of a span we just inserted — the bug that
 * turned N'...' literals into `class="<span…>n</span>">` garbage.
 */
export function highlightSQL(sql) {
  const literals = [];
  const stash = (cls, text) => {
    const token = PH_OPEN + literals.length + PH_CLOSE;
    literals.push(`<span class="${cls}">${text}</span>`);
    return token;
  };

  let html = escapeHTML(sql)
    // Unicode literals N'...' -> flagged (orange). Handles doubled '' inside.
    .replace(/N'(?:[^']|'')*'/g, m => stash("n", m))
    // Remaining single-quoted string literals -> green.
    .replace(/'(?:[^']|'')*'/g, m => stash("s", m));

  // Keywords + function names, now that no string literal text remains.
  html = html
    .replace(KEYWORDS, m => `<span class="k">${m}</span>`)
    .replace(FUNCS, m => `<span class="f">${m}</span>`);

  // Restore the highlighted literals in place of their placeholders.
  return html.replace(PH_RESTORE, (_, i) => literals[+i]);
}
