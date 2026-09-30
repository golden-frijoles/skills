// prose-guard.mjs — a PURE, mechanical check on machine-drafted prose before it reaches a human.
//
// PORTED from ~/dobby/golden-beans/scripts/lib/prose-guard.mjs (2026-07-26), with the reasoning
// intact and one rule added for this repo (`flag-state-claim`, see below). The comments here are
// not decoration: nearly every rule records a *measured* failure of a real draft, and the reason a
// rule exists is the only thing that stops someone deleting it as noise.
//
// ── Since jev-semantic-guards (2026-09-23): the four SEMANTIC families are decided by Jev ──────────
// Fix claim, invented beneficiary, liveness claim and invented commitment are judged by `judgeProse` (bottom of
// this file) whenever jev.config.json → rails.prose.mode is `jev`. The regex families below are now the
// OFFLINE FALLBACK — they decide, unchanged, when Jev cannot look or the rail is off, and `checkProse` still
// supplies the mechanical rules (length, banned words, tool names, unfinished) every time. Measured on 158
// labelled drafts: the judge 88.0%, these regexes alone 72.2%, every family at or above them (sprint-5.md).
// The incident comments on each family stay: they are the fallback's reasoning, and the eval fixtures.
//
// ── Why this exists ───────────────────────────────────────────────────────────────────────────
// Prompt instructions reduce hallucination; they do not eliminate it. Measured on golden-beans'
// commit-report rail (2026-07-25), a cheap model given a dense engineering commit produced material
// falsehoods on two of its first three runs: it invented customer impact for internal tooling, and
// it claimed a commit had FIXED an open-redirect bug when the commit only added tests for a fix
// that shipped weeks earlier. Both read as confident good news, which is exactly what makes them
// dangerous in a channel treated as status. the product owner reads the standup on their phone; a wrong report
// there is the real risk of this epic (README → "Risk tier").
//
// A guard cannot verify truth. What it CAN do is catch the specific, recurring shapes those
// failures take, and hand them back to the writer as a concrete revision note. That converts a
// silent falsehood into a retry with a named problem — which is the difference between "usually
// fine" and "fails loudly when it isn't".
//
// Everything here is pure and unit-tested: no I/O, no spawn, no clock. It runs on every draft
// regardless of which model wrote it (README D2 — the same module runs on the local rail and on the
// routine's `--post` step), so promoting or swapping the writer never silently drops the check.

import { jevContext } from './jev.mjs';
import { loadQuestions } from './jev-questions.mjs';

/**
 * Marketing vocabulary that signals the model has drifted from reporting into selling. Each one is
 * a word that adds emphasis without adding information — the tell that a sentence is decorating a
 * fact rather than stating one.
 */
export const BANNED_PHRASES = [
  'seamless',
  'seamlessly',
  'robust',
  'leverage',
  'leverages',
  'unlock',
  'unlocks',
  'empower',
  'empowers',
  'delighted',
  'excited to announce',
  'game-changing',
  'game changer',
  'revolutionary',
  'cutting-edge',
  'best-in-class',
  'world-class',
  'supercharge',
  'effortless',
  'blazing fast',
];

/**
 * Implementation nouns the reader either already knows or does not need. The brief says the
 * engineering story is already in the commit and the sprint doc; naming the stack is the most
 * common way a draft slides back into being an engineering report.
 *
 * Entries are regex fragments, matched on word boundaries so ordinary words are never caught —
 * "next" the adverb must not trip the "Next.js" rule, and "react" the verb must not trip React.
 *
 * A project adds ITS OWN stack's names (its commerce engine, auth provider, hosting, integrations —
 * the names its drafts actually reach for) through reporting.config.json's
 * `prose.extraBannedToolNames`, passed to checkProse as `evidence.extraBannedToolNames`. They are not
 * in this list because this list ships to every project.
 */
export const BANNED_TOOL_NAMES = [
  'playwright',
  'next\\.js',
  'nextjs',
  'supabase',
  'postgres',
  'postgresql',
  'vercel',
  'gemini',
  'gpt',
  'claude',
  'devin',
  'antigravity',
  'typescript',
  'javascript',
  'eslint',
  'prettier',
  'node\\.js',
  'github actions',
  'telegram',
  // DELIBERATELY ABSENT: 'react' and 'next' on their own — golden-beans' omission, carried over
  // with its reasoning. Both are ordinary English words — "the page does not react to a stale
  // value", "whoever ships next" — and a guard that rejects a correct sentence is worse than one
  // that misses a rare mention: it teaches whoever maintains this to bypass the check. `next\.js`
  // above still catches the framework by its real name. Same reason `stripe` is absent: "a stripe
  // of the catalog" is rare, but "Stripe" appears in our docs constantly as the *subject* of a
  // product decision, not as machinery — banning it would reject the sentences we most want.
];

/** Turn a BANNED_TOOL_NAMES regex fragment back into something readable for the finding note. */
function displayToolName(fragment) {
  return fragment.replace(/\\(.)/g, '$1').replace(/\?/g, '');
}

/**
 * Phrasings that assert a FIX, in the past tense, as an accomplished outcome.
 *
 * These are not banned outright — a change that genuinely fixes something should say so. They are
 * flagged only when the source data gives no evidence of a fix (`evidence.allowsFixClaim`), because
 * the observed failure was a draft asserting a fix that a DIFFERENT, earlier change had made. Our
 * commit messages and sprint docs routinely cite past incidents to explain why present work matters
 * — the whole `LEARNINGS.md` habit is built on it — and a cheap model cannot reliably tell "we
 * fixed X" from "X was fixed once, so we now test for it".
 */
const FIX_CLAIM_PATTERNS = [
  // Includes the -ING form on purpose. The real failing draft read "…is blocked, ELIMINATING a
  // potential open-redirect attack" — a participle, not a finite verb, and an earlier version of
  // this list matched only `eliminated|eliminates` and sailed straight past the exact sentence it
  // was written to catch. A claim is a claim whatever its inflection.
  /\b(?:fix(?:ed|es|ing)|resolv(?:ed|es|ing)|patch(?:ed|es|ing)|clos(?:ed|es|ing)|eliminat(?:ed|es|ing)|prevent(?:ed|s|ing)|remov(?:ed|es|ing))\b/i,
  /\bno longer (?:vulnerable|possible|happens|occurs|breaks|fails)\b/i,
  // The passive shape: the subject is the defect, and something has been done to it.
  /\b(?:bug|vulnerability|exploit|attack|bypass|breach|leak|regression)\b[^.]{0,60}\b(?:blocked|closed|removed|gone|impossible|shut)\b/i,
  /\b(?:blocked|closed|removed|gone|impossible)\b[^.]{0,60}\b(?:bug|vulnerability|exploit|attack|bypass|breach|leak|regression)\b/i,
  /\bis now (?:secure|safe|protected|impossible)\b/i,
];

/**
 * Invented commitments — the THIRD measured failure mode (2026-07-25, golden-beans' standup rail's
 * first live run).
 *
 * The draft ended: _"design sign-off on the Sprint 2 layout is owed before tomorrow"_. No such
 * commitment existed anywhere in the source data; the model manufactured a deadline and an owner
 * because a standup usually has one. This is more corrosive than the other two failures — a report
 * that invents obligations makes people chase work nobody agreed to, and it is completely plausible
 * on its face.
 *
 * Git history contains no deadlines, so ANY future-dated commitment in a git-derived report is
 * fabricated by construction. Flagged unconditionally, with no evidence flag to unlock it (D6).
 *
 * This fires MORE here than at golden-beans, not less: our roadmap docs are full of *target-shaped*
 * language — "owed to the product owner", "pending", "held on a smoke" — which is exactly the vocabulary a
 * model completes into a deadline. That is the reason it stays unconditional rather than becoming a
 * flag someone can switch off when it gets noisy.
 */
const INVENTED_COMMITMENT_PATTERNS = [
  /\b(?:by|before|due|no later than)\s+(?:tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|end of (?:day|week|month|the week)|eod|eow)\b/i,
  /\b(?:deadline|sign-?off|approval)\b[^.]{0,40}\b(?:owed|due|required|needed|pending)\b/i,
  /\b(?:owed|due|scheduled|slated|planned)\b\s+(?:for\s+)?(?:tomorrow|today|next week|this week|monday|friday)\b/i,
  /\bwill (?:ship|land|be (?:ready|done|live))\b[^.]{0,30}\b(?:tomorrow|today|next week|this week|by)\b/i,
];

/** Claims of customer/tenant/user impact — the second measured failure mode. */
const BENEFICIARY_PATTERNS = [
  /\b(?:customers?|tenants?|users?|clients?|buyers?|merchants?|shoppers?|subscribers?)\b/i,
];

/**
 * Sentences that mention a beneficiary only to DENY impact on them.
 *
 * Without this the guard contradicts its own brief. prose-lessons.md ends with "Say 'no user-visible
 * effect' when that is the truth", and the persona instructs the writer to state plainly that
 * customers are unaffected when work is internal — then the beneficiary rule fired on the very
 * sentence that complied. Measured 2026-07-26 on a hand-written draft whose opening clause was
 * "…rather than anything a shopper would see": flagged as an invented beneficiary.
 *
 * A guard that rejects the sentence its own lessons file demands is worse than no guard: it teaches
 * the writer to avoid the honest phrasing, which is precisely the failure the rule exists to prevent.
 * So a beneficiary mention inside a no-impact construction is allowed; a positive claim still is not.
 */
const NO_IMPACT_PATTERNS = [
  /\bno (?:user|customer|tenant|merchant|buyer|client|shopper|subscriber)[- ]visible\b/i,
  /\b(?:nothing|none|no)\b[^.]{0,40}\b(?:customers?|tenants?|users?|clients?|buyers?|merchants?|shoppers?|subscribers?)\b[^.]{0,40}\b(?:see|saw|notice|noticed|observe)\b/i,
  /\b(?:customers?|tenants?|users?|clients?|buyers?|merchants?|shoppers?|subscribers?)\b[^.]{0,40}\b(?:are|is|were|was)\s+(?:not|un)(?:affected|changed|impacted)\b/i,
  /\b(?:not|nothing)\b[^.]{0,30}\b(?:a|any)\s+(?:customers?|tenants?|users?|clients?|buyers?|merchants?|shoppers?|subscribers?)\b[^.]{0,30}\b(?:would|will|can|could)\s+(?:see|notice|observe)\b/i,
  /\bunaffected\b/i,
  // "…rather than anything a shopper would see" — the phrasing a real draft actually used. The
  // negation here is carried by "rather than"/"instead of"/"other than", not by a "no"/"not" token,
  // which is why the patterns above missed it.
  /\b(?:rather than|instead of|other than)\b[^.]{0,60}\b(?:customers?|tenants?|users?|clients?|buyers?|merchants?|shoppers?|subscribers?)\b/i,
  /\banything\b[^.]{0,30}\b(?:customers?|tenants?|users?|clients?|buyers?|merchants?|shoppers?|subscribers?)\b[^.]{0,30}\b(?:would|will|could|can)\s+(?:see|notice|observe)\b/i,
];

/**
 * ── NEW RULE, ours, not golden-beans' (README D6) ─────────────────────────────────────────────
 * `flag-state-claim` — a draft asserting a capability is live/enabled/available/in production when
 * the evidence pack does not say so.
 *
 * golden-beans does not need this: it ships straight to production. We do not. Every one of the
 * last five epics shipped DARK behind a default-OFF flag and was flipped later, sometimes days
 * later, sometimes never (`promoter.partner_portfolio_enabled` was born OFF and is still OFF). A
 * report saying a capability "is live" when its flag is OFF is our single highest-risk falsehood:
 * it is confident, it is plausible, it reads as good news, and it is the exact sentence that would
 * stop the product owner from doing the flip the epic is waiting on.
 *
 * `evidence.liveFlags` is the corroboration: the list of things the pack can actually prove are on.
 * Entries are usually flag keys (`promoter.activation_crm_enabled`), but any capability NAME works
 * — a change with no flag at all is corroborated by listing the capability itself. That is
 * deliberate: the escape valve is shaped like evidence, not like a boolean someone can set to true
 * to make the guard quiet.
 */
const LIVENESS_CLAIM_PATTERNS = [
  /\b(?:is|are|was|were|went|goes|now)\s+live\b/i,
  /\blive\s+(?:now|today|in production|for everyone)\b/i,
  /\bis now (?:enabled|available|switched on|turned on|on)\b/i,
  /\b(?:enabled|turned on|switched on|flipped on|rolled out|shipped|released)\s+(?:to|for|in)\s+(?:everyone|all|production|prod)\b/i,
  /\b(?:runs|running|available|enabled|active)\s+in production\b/i,
  /\bin production (?:now|today)\b/i,
  // "can now <do X>" — ADDED after cross-review found the original omission was a real hole.
  //
  // The omission was reasoned as "D5 asks the persona to lead with what someone can DO now, so
  // banning this would reject the sentences the epic exists to buy", and a test pinned it as legal.
  // That reasoning conflated two different escape valves. "A shop owner can now hand a partner one
  // shop" is FALSE when the flag is off — in substance it is a liveness claim, and it is precisely
  // the shape prose-lessons.md warns about.
  //
  // The right valve is not "don't match the pattern"; it is "match it, and let EVIDENCE clear it" —
  // exactly how every rule above works. With the flag on, `liveFlags` corroborates and the sentence
  // passes; with it off, the claim is caught. The persona keeps its register and the guard keeps its
  // teeth, where the omission gave up the teeth to protect the register.
  /\bcan now\b/i,
];

/**
 * Negation immediately preceding a liveness claim. An honest report about a dark epic reads "the
 * rail exists; nothing is live yet because the flag is off" (D5 explicitly wants that sentence),
 * and flagging it would be the guard rejecting the truth it was written to protect.
 *
 * Scoped to a short window BEFORE the claim rather than to the whole sentence. Sentence-wide was
 * the first cut and it is too generous: "the portfolio is live for every merchant, and no smoke has
 * run yet" would be excused by a negation that belongs to a different clause — laundering the exact
 * false claim this rule exists for.
 */
const LIVENESS_NEGATORS =
  /\b(?:not|isn'?t|aren'?t|wasn'?t|weren'?t|never|no|nothing|nobody|none|neither|nor|without|yet to)\b[^a-z0-9]*$/i;

/** How far back to look for a negator. Long enough for "nothing yet", short enough to stay a clause. */
const NEGATOR_WINDOW = 40;

/** Split into sentence-ish spans. Not linguistics — enough to scope a negation to its own clause. */
export function sentences(text) {
  return String(text ?? '')
    .split(/(?<=[.!?;])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Tokens a `liveFlags` entry can be recognised by in prose. `promoter.partner_portfolio_enabled`
 * → ['partner', 'portfolio']: the namespace and the `_enabled`/`_disabled` suffix are plumbing a
 * report would never say out loud, the middle is the capability's actual name.
 *
 * Deliberately generous — one matching token corroborates. The rule's job is to catch "we said
 * live and NOTHING is live", not to do semantic matching a regex cannot do honestly. A stricter
 * match would produce false positives on correct reports, which is the failure mode that gets a
 * guard bypassed.
 */
export function flagTokens(flagKey) {
  return String(flagKey ?? '')
    .toLowerCase()
    .replace(/_(enabled|disabled)\b/g, '')
    .split('.')
    .slice(-1)[0]
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4);
}

/**
 * Sentence-final punctuation, or a close-paren/quote after it. Used to detect a draft that ran out
 * of room mid-clause — a trailing fragment reads as a broken tool, not as brevity.
 */
// The `unfinished` check exists for CHAT-MESSAGE surfaces, where a trailing fragment reads as a broken
// tool. It misfires on INTERNAL artifacts, which legitimately end in structural markdown — and that
// misfire is not cosmetic: measured on the first real prose-draft run (2026-07-26), every `--kind poster`
// draft ended with the house table row
//   | [slug](slug/) | one-line what | ✅ **Shipped …** |
// and was flagged `unfinished` on both writers, through all four attempts. A guard that rejects correct
// output is worse than one that misses a rare fault: it trains whoever maintains this to ignore the
// flag, which then hides the real findings it exists to surface (the same reasoning that keeps bare
// `react`/`next` out of BANNED_TOOL_NAMES).
//
// So a structural ending — a table row, a list item, a heading, a fenced block — counts as clean when
// the surface is allowed structural markdown. Prose surfaces keep the strict sentence-final rule.
function endsCleanly(text, { allowsMarkdown = false } = {}) {
  const trimmed = String(text ?? '').trim();
  if (/[.!?]["')\]]?\s*$/.test(trimmed)) return true;
  if (!allowsMarkdown) return false;
  const lastLine = trimmed.split('\n').pop().trim();
  return (
    /\|\s*$/.test(lastLine) || // a markdown table row
    /^#{1,6}\s/.test(lastLine) || // a heading
    /^([-*+]|\d+\.)\s/.test(lastLine) || // a list item
    /^```/.test(lastLine) || // a fenced block delimiter
    /^\[GAP:/.test(lastLine) // the documented "source material insufficient" marker
  );
}

/** Split into sentences well enough to count them. Not linguistics — just a length sanity check. */
export function countSentences(text) {
  return (String(text ?? '').match(/[^.!?]+[.!?]/g) ?? []).length;
}

export function countWords(text) {
  return String(text ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * Check a draft against the mechanical rules.
 *
 * `evidence` describes what the SOURCE DATA actually supports, so the guard can distinguish a
 * legitimate claim from an invented one:
 *   - `allowsFixClaim`   — the change genuinely fixes something (e.g. the commit subject is a
 *                          `fix:`). When false, past-tense fix language is a finding.
 *   - `allowsBeneficiary`— the change plausibly touches a surface a merchant/buyer can observe.
 *                          When false, naming customers/merchants/users is a finding.
 *   - `liveFlags`        — capabilities the pack can PROVE are on (flag keys, or capability names
 *                          for unflagged work). Empty ⇒ no liveness may be asserted (D6).
 *   - `maxWords`/`minWords` — the length budget for this surface.
 *
 * Note what is NOT here: any switch that turns off `invented-commitment`. Both the flags above
 * describe something the source data can genuinely support; no source data can support a date that
 * does not exist, so there is nothing for a flag to gate.
 *
 * Returns `{ ok, findings }`. Each finding carries a `note` written to be handed straight back to
 * the writer as a revision instruction — a guard that only says "rejected" produces another guess;
 * one that says what is wrong produces a correction.
 */
export function checkProse(draft, evidence = {}) {
  const {
    allowsFixClaim = false,
    allowsBeneficiary = false,
    liveFlags = [],
    maxWords = 60,
    minWords = 8,
    // Internal engineering artifacts (retros, poster entries, sprint-wraps) are REQUIRED to use
    // structural markdown; chat-message reports are forbidden from it. Only the `unfinished` check
    // varies on this — every other rule applies identically to both surfaces.
    allowsMarkdown = false,
  } = evidence;
  const text = String(draft ?? '').trim();
  const findings = [];

  if (!text) {
    return { ok: false, findings: [{ code: 'empty', note: 'The draft is empty. Write the report.' }] };
  }

  const words = countWords(text);
  if (words > maxWords) {
    findings.push({
      code: 'too-long',
      note: `The draft is ${words} words; the limit is ${maxWords}. Cut it down — decide what the single point is and say only that.`,
    });
  }
  if (words < minWords) {
    findings.push({
      code: 'too-short',
      note: `The draft is only ${words} words. That is not a report — say who is affected and what changed for them.`,
    });
  }

  if (!endsCleanly(text, { allowsMarkdown })) {
    findings.push({
      code: 'unfinished',
      note: 'The last sentence is unfinished. End on a complete sentence — stop at the previous full stop rather than starting a clause you cannot complete.',
    });
  }

  const lower = text.toLowerCase();

  const banned = BANNED_PHRASES.filter((p) =>
    new RegExp(`\\b${p.replace(/[-\s]/g, '[-\\s]')}\\b`, 'i').test(lower)
  );
  if (banned.length) {
    findings.push({
      code: 'marketing-language',
      note: `Remove marketing words and state the fact plainly: ${banned.join(', ')}.`,
    });
  }

  const tools = [...BANNED_TOOL_NAMES, ...(evidence.extraBannedToolNames || [])].filter((t) =>
    new RegExp(`\\b${t}\\b`, 'i').test(lower)
  );
  if (tools.length) {
    findings.push({
      code: 'names-implementation',
      note: `Do not name tools, frameworks or models — the reader either knows them or does not need them. Found: ${tools.map(displayToolName).join(', ')}.`,
    });
  }

  if (!allowsFixClaim) {
    const claimed = FIX_CLAIM_PATTERNS.some((re) => re.test(text));
    if (claimed) {
      findings.push({
        code: 'unsupported-fix-claim',
        note:
          'The draft claims something was fixed, resolved or prevented, but the source data does not show this change making that fix. ' +
          'Commit messages and sprint docs here often mention a PAST incident to explain why the present work matters — that is context, never the outcome. ' +
          'Describe what this change itself did.',
      });
    }
  }

  // Unconditional: git history and roadmap docs contain no deadlines, so a future-dated commitment
  // in a derived report is fabricated by construction. There is no evidence flag that could
  // legitimately unlock it, which is why this check sits outside the `allows*` gates (D6).
  if (INVENTED_COMMITMENT_PATTERNS.some((re) => re.test(text))) {
    findings.push({
      code: 'invented-commitment',
      note:
        'The draft states a deadline, due date or sign-off that appears nowhere in the source data. ' +
        'Commits and roadmap docs contain no deadlines, so any date or commitment here is invented — ' +
        'and a report that manufactures obligations makes people chase work nobody agreed to. ' +
        'Remove it. If something is genuinely owed, say what and to whom, with no date attached.',
    });
  }

  if (!allowsBeneficiary) {
    // Per SENTENCE: a mention that DENIES impact is the honest internal framing the persona asks for,
    // but it only excuses its own sentence. Tested against the whole draft, one "no customer-visible
    // effect" would launder a separate invented benefit elsewhere — measured failure 1 again.
    // Split on line breaks too: a bullet list has no terminal punctuation, and "- no customer-visible
    // effect" must not excuse the NEXT bullet's claim.
    const named = text
      .split(/(?<=[.!?])\s+|\n+/)
      .some(
        (sentence) =>
          BENEFICIARY_PATTERNS.some((re) => re.test(sentence)) &&
          !NO_IMPACT_PATTERNS.some((re) => re.test(sentence))
      );
    if (named) {
      findings.push({
        code: 'invented-beneficiary',
        note:
          'The draft names customers/merchants/users, but this change does not touch a surface they can observe. ' +
          'Say plainly that it is internal, and name the real beneficiary and the real effect — a bug class that can no longer reach production, ' +
          'a mistake caught in seconds instead of after a deploy.',
      });
    }
  }

  // ── flag-state-claim (D6) ──────────────────────────────────────────────────────────────────
  // Scoped per SENTENCE, twice over: a negator only excuses the clause it sits in ("the rail
  // exists, but nothing is live yet"), and corroboration has to come from the same sentence that
  // made the claim — otherwise one genuinely-live capability elsewhere in the paragraph would
  // launder every other liveness claim in it.
  const unsupported = sentences(text).filter((s) => {
    // EVERY occurrence, not just the first: "nothing is live yet, though the rail is live" carries
    // one negated claim and one bare one, and stopping at the first would excuse the second.
    const asserted = LIVENESS_CLAIM_PATTERNS.flatMap((re) => [
      ...s.matchAll(new RegExp(re.source, 'gi')),
    ]).some((m) => !LIVENESS_NEGATORS.test(s.slice(Math.max(0, m.index - NEGATOR_WINDOW), m.index)));
    if (!asserted) return false;
    const sl = s.toLowerCase();
    return !liveFlags.some((f) => {
      const tokens = flagTokens(f);
      return tokens.length > 0 && tokens.some((t) => sl.includes(t));
    });
  });
  if (unsupported.length) {
    findings.push({
      code: 'flag-state-claim',
      note:
        'The draft says a capability is live, enabled or in production, and the evidence pack does not show that. ' +
        (liveFlags.length
          ? `The only capabilities the pack proves are on are: ${liveFlags.join(', ')}. `
          : 'The pack lists NO capability as on. ') +
        'Almost everything here ships dark behind a default-off flag and is flipped later, so "it landed" and "it is live" are different facts and only one of them is in evidence. ' +
        'Say what shipped and say plainly that it is off until the flag is flipped. ' +
        `Rewrite this: "${unsupported[0]}"`,
    });
  }

  return { ok: findings.length === 0, findings };
}

/** Render findings as a revision instruction to hand back to the writer on a retry. */
export function findingsToRevisionNote(findings) {
  return [
    'Your previous draft was rejected by an automated check. Fix EVERY point below and rewrite it in full.',
    '',
    ...findings.map((f, i) => `${i + 1}. ${f.note}`),
    '',
    'Output only the corrected report — no preamble, no explanation of the changes.',
  ].join('\n');
}

// ── Jev decides the SEMANTIC families (jev-semantic-guards D4/D6) ───────────────────────────────────
// Four of the rules above are language judgements wearing regexes: a FIX claim, an invented BENEFICIARY, a
// LIVENESS claim, an invented COMMITMENT. Each carries an incident comment for the phrasing it missed last
// time, and NO_IMPACT_PATTERNS exists only because honest negations ("rather than anything a shopper would
// see") kept tripping them. `judgeProse` asks Jev those four questions instead — one Noul per sentence per
// family, in one batched call — by `jev.config.json → rails.prose.mode`:
//   off    → exactly `checkProse`; no call, no log line. The kill-switch.
//   shadow → `checkProse` decides; Jev is asked and both verdicts are logged.
//   jev    → the mechanical rules (length, banned phrases, tool names, unfinished) still come from
//            `checkProse` — they are real if-statements. Each semantic family comes from Jev (claim at
//            noul ≥ thresholds.claim); a family Jev could not look at falls back to the regex, alone.
// What Jev does NOT decide: the EVIDENCE. `allowsFixClaim` / `allowsBeneficiary` still skip those families
// outright, and a liveness claim is still cleared only by a `liveFlags` token in the same sentence — Jev says
// whether the sentence ASSERTS liveness, code says whether the pack CORROBORATES it. And invented-commitment
// still has no evidence flag that disables it. Findings carry the same codes and the same notes as
// `checkProse`, so the writer's revision loop does not change.

export const SEMANTIC_CODES = [
  'unsupported-fix-claim',
  'invented-beneficiary',
  'flag-state-claim',
  'invented-commitment',
];

/** More (sentence × family) questions than this are split into parallel calls. */
export const PROSE_CHUNK = 120;

// The four questions are DATA (compiled-prompts D2): `lib/jev-questions/prose.json`, each with its measurement
// beside it. Their wording was measured, not guessed: the first liveness question ("does it assert something is
// live, enabled… or usable now?") flagged sentences that merely describe behaviour ("now groups", "no longer
// breaks"), and separating RELEASE STATE from BEHAVIOUR fixed it (2026-09-23). A recording pins the wording by
// hash, so an edit fails `node scripts/jev-eval.mjs` until `--live` re-measures it.
//
// What stays in code is the EVIDENCE gate — which family a draft's evidence pack lets Jev be asked at all.
const EVIDENCE_SKIPS = {
  fix: (ev) => Boolean(ev.allowsFixClaim),
  beneficiary: (ev) => Boolean(ev.allowsBeneficiary),
  live: () => false,
  commitment: () => false,
};

export const PROSE_FAMILIES = loadQuestions('prose').map((q) => {
  const skip = EVIDENCE_SKIPS[q.id];
  if (!skip) throw new Error(`prose-guard: jev-questions/prose.json has family "${q.id}", which has no evidence gate`);
  return { code: q.code, key: q.id, skip, question: q.instructions, criteria: q.criteria };
});

/** The notes `checkProse` writes for each semantic family — one map, held to its text by a spec. */
export function semanticNote(code, { liveFlags = [], sentence = '' } = {}) {
  switch (code) {
    case 'unsupported-fix-claim':
      return (
        'The draft claims something was fixed, resolved or prevented, but the source data does not show this change making that fix. ' +
        'Commit messages and sprint docs here often mention a PAST incident to explain why the present work matters — that is context, never the outcome. ' +
        'Describe what this change itself did.'
      );
    case 'invented-commitment':
      return (
        'The draft states a deadline, due date or sign-off that appears nowhere in the source data. ' +
        'Commits and roadmap docs contain no deadlines, so any date or commitment here is invented — ' +
        'and a report that manufactures obligations makes people chase work nobody agreed to. ' +
        'Remove it. If something is genuinely owed, say what and to whom, with no date attached.'
      );
    case 'invented-beneficiary':
      return (
        'The draft names customers/merchants/users, but this change does not touch a surface they can observe. ' +
        'Say plainly that it is internal, and name the real beneficiary and the real effect — a bug class that can no longer reach production, ' +
        'a mistake caught in seconds instead of after a deploy.'
      );
    case 'flag-state-claim':
      return (
        'The draft says a capability is live, enabled or in production, and the evidence pack does not show that. ' +
        (liveFlags.length
          ? `The only capabilities the pack proves are on are: ${liveFlags.join(', ')}. `
          : 'The pack lists NO capability as on. ') +
        'Almost everything here ships dark behind a default-off flag and is flipped later, so "it landed" and "it is live" are different facts and only one of them is in evidence. ' +
        'Say what shipped and say plainly that it is off until the flag is flipped. ' +
        `Rewrite this: "${sentence}"`
      );
    default:
      return '';
  }
}

/**
 * The units Jev judges: the guard's own `sentences()`, further split on line breaks so each bullet of a list
 * (which has no terminal punctuation) is its own unit — the same reason the beneficiary rule splits on `\n`.
 */
export function proseUnits(text) {
  return (
    sentences(text)
      .flatMap((s) => s.split(/\n+/))
      // A markdown HEADING is structure, never a claim: "## What shipped" scored 0.50–0.78 as a liveness
      // claim across the 2026-09-23 retrospective backtest, and no heading can assert anything on its own.
      .filter((s) => !/^\s*#{1,6}\s/.test(s))
      .map((s) => s.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').trim())
      .filter((s) => /[a-z]/i.test(s))
  );
}

/** Is this liveness sentence corroborated by the pack? The same token test `checkProse` applies. */
const corroborated = (sentence, liveFlags) => {
  const sl = sentence.toLowerCase();
  return liveFlags.some((f) => {
    const tokens = flagTokens(f);
    return tokens.length > 0 && tokens.some((t) => sl.includes(t));
  });
};

/** Build the batched questions for a draft. Pure. Returns [{ id, unit, family, question }]. */
export function proseQuestions(units, evidence = {}) {
  const families = PROSE_FAMILIES.filter((f) => !f.skip(evidence));
  return units.flatMap((unit, i) =>
    families.map((f) => ({
      id: `s${i}_${f.key}`,
      unit: i,
      family: f.code,
      question: {
        type: 'noul',
        instructions: { sentence: unit, question: f.question },
        criteria: f.criteria,
      },
    }))
  );
}

/**
 * Pure: the semantic findings Jev's answers imply. answers: { [id]: noul }. Families whose answers are missing
 * are returned in `unanswered` so the caller can fall back to the regex for exactly those.
 */
export function decideProse({ units, questions, answers, evidence = {}, threshold }) {
  const liveFlags = evidence.liveFlags ?? [];
  const byFamily = new Map();
  const unanswered = new Set();
  let confidence = 0;
  for (const q of questions) {
    const noul = answers[q.id];
    if (typeof noul !== 'number' || noul < 0 || noul > 1) {
      unanswered.add(q.family);
      continue;
    }
    confidence = Math.max(confidence, noul);
    if (noul < threshold) continue;
    const sentence = units[q.unit];
    if (q.family === 'flag-state-claim' && corroborated(sentence, liveFlags)) continue;
    if (!byFamily.has(q.family)) byFamily.set(q.family, { sentence, noul });
  }
  // Every claim Jev DID find is a finding — including in a family where some other chunk could not look.
  // Dropping those would let a caught claim through whenever one chunk hit a 529 (fresh review, PR #36);
  // the caller unions them with the regex for exactly those families.
  const findings = SEMANTIC_CODES.filter((c) => byFamily.has(c)).map((code) => {
    const { sentence, noul } = byFamily.get(code);
    const note = semanticNote(code, { liveFlags, sentence });
    return {
      code,
      note: code === 'flag-state-claim' ? note : `${note} The sentence: "${sentence}"`,
      sentence,
      noul,
    };
  });
  return { findings, unanswered: [...unanswered], confidence };
}

/** The draft as Jev sees it: the full text for context; each question points at one `sentence`. */
const proseState = (draft) => ({ report_draft: String(draft) });

/**
 * THE JUDGE. async; never throws on a Jev failure (a malformed jev.config.json DOES throw — loudly).
 * Returns the `checkProse` shape `{ ok, findings }` plus `{ decider, mode, regexCodes, jevCodes, fallback }`.
 * deps: see jevContext (config, key, ask, log, root) — the same injection as the review judge.
 */
export async function judgeProse(draft, evidence = {}, deps = {}) {
  const regex = checkProse(draft, evidence);
  const ctx = jevContext('prose', deps);
  const regexCodes = regex.findings.map((f) => f.code).filter((c) => SEMANTIC_CODES.includes(c));
  const units = proseUnits(draft);
  const questions = proseQuestions(units, evidence);
  if (ctx.mode === 'off' || !questions.length || !String(draft ?? '').trim()) {
    // `why` names what kept Jev out (`egress not answered`, `no TYPESAFE_API_KEY`, …), the way the review judge's
    // reason does, so a regex-decided draft never reads like the configured path.
    return { ...regex, decider: 'regex', mode: ctx.mode, why: ctx.why, regexCodes, jevCodes: null, fallback: [] };
  }

  const chunks = [];
  for (let i = 0; i < questions.length; i += PROSE_CHUNK) chunks.push(questions.slice(i, i + PROSE_CHUNK));
  const results = await Promise.all(
    chunks.map((c) =>
      ctx.ask({ state: proseState(draft), questions: Object.fromEntries(c.map((q) => [q.id, q.question])) })
    )
  );
  const answers = {};
  const errors = [];
  results.forEach((r) => {
    if (!r.ok) return errors.push(r.error);
    for (const [id, a] of Object.entries(r.answers ?? {})) answers[id] = a?.noul;
  });
  const jev = decideProse({ units, questions, answers, evidence, threshold: ctx.rail.thresholds.claim });
  const jevCodes = jev.findings.map((f) => f.code);
  const fallback = jev.unanswered;

  let out;
  if (ctx.mode === 'shadow') {
    out = { ...regex, decider: 'regex' };
  } else {
    const mechanical = regex.findings.filter((f) => !SEMANTIC_CODES.includes(f.code));
    // A fallback family is the UNION of the regex's verdict and whatever Jev found in the chunks that answered.
    const jevHit = new Set(jevCodes);
    const fromRegex = regex.findings.filter((f) => fallback.includes(f.code) && !jevHit.has(f.code));
    const findings = [...mechanical, ...jev.findings, ...fromRegex];
    out = { ok: findings.length === 0, findings, decider: fallback.length ? 'jev+regex' : 'jev' };
  }
  ctx.log({
    rail: 'prose',
    mode: ctx.mode,
    decider: out.decider,
    regex: regexCodes,
    jev: jevCodes,
    confidence: Number(jev.confidence.toFixed(3)),
    text: draft,
    // What the draft was judged against, so a disagreement can become a labelled fixture (jev-report).
    evidence: {
      allowsFixClaim: Boolean(evidence.allowsFixClaim),
      allowsBeneficiary: Boolean(evidence.allowsBeneficiary),
      allowsMarkdown: Boolean(evidence.allowsMarkdown),
      liveFlags: evidence.liveFlags ?? [],
      ...(evidence.maxWords ? { maxWords: evidence.maxWords } : {}),
      ...(evidence.minWords ? { minWords: evidence.minWords } : {}),
    },
    error: errors.length ? errors[0] : null,
  });
  return { ...out, mode: ctx.mode, regexCodes, jevCodes, fallback, errors };
}
