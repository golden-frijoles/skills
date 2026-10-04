// review-shape.mjs — "is this text a review at all?", with no dependencies, so a runner can ask it without
// pulling review-guard's Jev machinery into its closure. review-guard re-exports assertReviewOutput and uses it as
// the offline fallback; cross-agent-cli's isTruncatedReview asks the same function, so there is one definition.

const SEVERITY_HEADING =
  /^\s{0,3}(?:[-*+]\s+|\d+\.\s+|>\s*|\|\s*)?(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:🔴|🟠|🟡|⚪)?\s*(?:blocking|should[- ]fix|nits?|important|critical|findings?|correctness(?:\s*(?:&|and)\s*architecture)?|security(?: review)? findings?)\b/im;
const CLEAN_VERDICT =
  /(?:^\s{0,3}(?:[-*+]\s+)?(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:clean|none)\b|\bassessment:\s*(?:\*\*)?\s*clean\b|\bno\s+(?:\*\*)?(?:blocking|security|should[- ]fix|nit)\b[^.\n]{0,80}\b(?:findings|issues|problems)\b|\bno (?:findings|issues|problems)\b|\bnothing (?:to report|found|blocking)\b|\blooks clean\b|\bdiff (?:is|looks) clean\b|\bno concerns\b)/im;
// A reviewer that emitted a raw tool call instead of a review — observed twice from vibe on real PRs
// (`read_file{"path": …}`, `write_file…{"file_path": …}`). Its JSON can CONTAIN review-shaped words, so
// this is checked first and wins.
export const TOOL_TRANSCRIPT = /^\s*[a-z_]+\S*\s*\{\s*"/i;

/**
 * THE GUARD. Pure. Returns { ok, reason }.
 * ok when the reply has a severity heading or an explicit clean verdict; fails on empty, whitespace,
 * or prose with neither (a CLI banner, an error page, a truncated tool transcript).
 */
export function assertReviewOutput(text) {
  const t = String(text ?? '').trim();
  if (!t) return { ok: false, reason: 'the reviewer returned no output' };
  if (TOOL_TRANSCRIPT.test(t))
    return { ok: false, reason: `the reviewer emitted a raw tool call, not a review ("${t.slice(0, 80)}")` };
  if (SEVERITY_HEADING.test(t)) return { ok: true, reason: 'severity-structured findings' };
  if (CLEAN_VERDICT.test(t)) return { ok: true, reason: 'explicit clean verdict' };
  return {
    ok: false,
    reason: `the reviewer's reply has no severity heading and no clean verdict — not a review (first line: "${t.split('\n')[0].slice(0, 120)}")`,
  };
}
