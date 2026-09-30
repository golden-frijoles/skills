// Cross-channel notification text rules.
//
// Telegram HTML and Slack mrkdwn reserve the same three characters and require the same byte-for-
// byte substitutions. Keeping the expansion-aware truncation here makes "fits before escaping"
// impossible in either channel. Platform modules own only their distinct hard limit and the name
// their renderer uses for this same operation.

/** Escape the three characters reserved by both Telegram HTML and Slack mrkdwn. */
export function escapeEntities(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Truncate raw text on a word boundary. Never call this after entity escaping. */
export function truncateWords(text, max) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Escape raw text while guaranteeing that the escaped result fits `maxEscaped`.
 *
 * Escaping can expand one raw character to five. Truncating before escaping can therefore
 * overshoot, while truncating after escaping can split an entity. Converge on a raw budget,
 * re-measuring the escaped result each pass.
 */
export function escapeToFit(text, maxEscaped) {
  let budget = maxEscaped;
  for (let i = 0; i < 24; i++) {
    const escaped = escapeEntities(truncateWords(text, budget));
    if (escaped.length <= maxEscaped) return escaped;
    const ratio = escaped.length / Math.max(1, maxEscaped);
    budget = Math.max(1, Math.floor(budget / Math.max(1.25, ratio)));
  }
  return escapeEntities(truncateWords(text, 40));
}
