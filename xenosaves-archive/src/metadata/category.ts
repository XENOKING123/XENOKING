/**
 * Keyword-based category suggestion. Results are always labelled `keyword-heuristic` —
 * a suggestion derived from the source's own description, never presented as verified fact.
 */
export const CATEGORIES = [
  'Platinum',
  '100% Completion',
  'Starter Save',
  'New Game+',
  'Max Level',
  'Max Money',
  'Modded',
  'Trophy Set',
  'Chapter Save',
  'Collectibles',
  'Story Complete',
  'Before Final Boss',
  'Special Equipment',
  'Other',
] as const;
export type Category = (typeof CATEGORIES)[number];

const RULES: Array<[Category, RegExp]> = [
  ['Platinum', /\bplat(inum)?\b/i],
  ['100% Completion', /\b100\s*%|\bhundred percent\b|\bfull(y)? complet|\beverything unlocked\b|\ball unlocked\b|\bunlock(ed)? (all|everything)\b/i],
  ['Modded', /\bmod(ded|s)?\b|\bhack(ed)?\b|\bglitch(ed)?\b|\binfinite\b|\bunlimited\b/i],
  ['Max Money', /\bmax(imum|ed)?\s*(money|cash|gold|coins?|credits|souls|runes|currency)\b|\b(999,?999,?999|9{6,})\b/i],
  ['Max Level', /\bmax(imum|ed)?\s*(level|lvl|rank|stats?)\b|\blevel\s*(99|100|999)\b/i],
  ['New Game+', /\bn(ew)?\s*g(ame)?\s*\+|\bng\+\d*|\bnew game plus\b/i],
  ['Before Final Boss', /\bbefore (the )?(final|last) boss\b|\bpre[- ]final boss\b/i],
  ['Story Complete', /\b(story|game|campaign) (complete|completed|finished|beaten|cleared)\b|\bpost[- ]game\b|\bend ?game\b/i],
  ['Chapter Save', /\bchapter\s*\d+|\bch\.?\s*\d+\b|\bmission\s*\d+|\bepisode\s*\d+/i],
  ['Collectibles', /\bcollectibles?\b|\ball (items|collectables|trophies)\b/i],
  ['Trophy Set', /\btroph(y|ies)\b/i],
  ['Starter Save', /\b(start(er|ing)?|beginning|fresh|early[- ]game|new character)\b/i],
  ['Special Equipment', /\b(dlc|special|rare|legendary|exotic)\s+(gear|equipment|weapons?|items?|armou?r)\b/i],
];

export function suggestCategories(text: string | null | undefined): Category[] {
  if (!text) return [];
  const out: Category[] = [];
  for (const [cat, re] of RULES) if (re.test(text)) out.push(cat);
  return out;
}

/** Primary category = first match in priority order; null when the text gives no signal. */
export function suggestCategory(text: string | null | undefined): Category | null {
  return suggestCategories(text)[0] ?? null;
}
