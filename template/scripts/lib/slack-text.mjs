// Slack text helpers — platform naming + limit over the shared notification text rule.
//
// Slack's own mrkdwn escaping guide asks for the SAME three substitutions Telegram's HTML
// parse_mode needs: `&` -> `&amp;`, `<` -> `&lt;`, `>` -> `&gt;`. (Slack isn't rendering HTML —
// it just reserves those three characters for its own `<url|label>` link syntax and treats them
// the same way HTML does.) Because the escaping rule is identical, the truncate-then-escape
// convergence logic below is a straight port of escapeToFit's reasoning: escaping EXPANDS the
// string, so truncating the raw text to a budget and escaping afterwards can overshoot, and
// escaping first and truncating second can cut mid-entity. Same bug class, same fix.
//
// The shared implementation lives in notification-text.mjs because the substitution table is
// byte-identical. Slack keeps its own conservative limit here; a shared limit would erase a real
// platform/product decision.

// Conservative on purpose: Slack's Incoming Webhook `text` field tolerates far more than this in
// practice, but Block Kit's per-section text object caps at 3000, and keeping the ping terse and
// pager-friendly is the actual goal here (matching Telegram's terse-by-design pings), not "as much
// as Slack will technically accept."
export const SLACK_LIMIT = 3000;

export { escapeEntities as escapeMrkdwn, escapeToFit, truncateWords } from './notification-text.mjs';
