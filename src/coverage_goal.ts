export interface CoverageGoal {
  thresholdPercent: number;
  thresholdText: string;
  relation: "above" | "at least";
}

const PERCENT_RE = /(\d+(?:\.\d+)?)\s*%/;
const COVERAGE_RE = /\b(?:test(?:ing)?\s+)?(?:line\s+)?coverage\b/i;
const ABOVE_RE = /(?:\babove\b|\bover\b|\bgreater\s+than\b|\bmore\s+than\b|>)/i;
const AT_LEAST_RE = /(?:\bat\s+least\b|\bminimum\b|\bmin\b|\bno\s+less\s+than\b|>=)/i;

export function parseCoverageGoal(text: string | undefined): CoverageGoal | undefined {
  const trimmed = text?.trim();
  if (!trimmed || !COVERAGE_RE.test(trimmed)) {
    return undefined;
  }

  const percent = PERCENT_RE.exec(trimmed);
  if (!percent?.[1]) {
    return undefined;
  }

  const thresholdPercent = Number.parseFloat(percent[1]);
  if (!Number.isFinite(thresholdPercent) || thresholdPercent < 0 || thresholdPercent > 100) {
    return undefined;
  }

  return {
    thresholdPercent,
    thresholdText: formatPercent(thresholdPercent),
    relation: coverageRelation(trimmed),
  };
}

export function coverageGoalPhrase(goal: CoverageGoal): string {
  return `testing line coverage ${goal.relation} ${goal.thresholdText}%`;
}

export function coverageGoalAction(goal: CoverageGoal): string {
  return `Raise or maintain ${coverageGoalPhrase(goal)}.`;
}

export function coverageGoalVerification(goal: CoverageGoal): string {
  return `Run the repository's coverage command and confirm line coverage is ${goal.relation} ${goal.thresholdText}%; report the command and resulting line coverage.`;
}

export function coverageGoalVerifyBullet(goal: CoverageGoal): string {
  return `- ${coverageGoalVerification(goal)}`;
}

export function inferCoverageGoalText(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!parseCoverageGoal(normalized)) {
    return undefined;
  }

  const coverageIndex = normalized.search(/(?:test(?:ing)?\s+)?(?:line\s+)?coverage/i);
  if (coverageIndex < 0) {
    return normalized;
  }

  const prefix = normalized.slice(0, coverageIndex).trimEnd();
  const action = /(have|reach|raise|maintain|keep|increase|get|achieve|hit|ensure)\s*$/i.exec(prefix);
  const start = action?.index ?? coverageIndex;
  return normalizeCoverageGoalText(normalized.slice(start));
}

function normalizeCoverageGoalText(text: string): string | undefined {
  const trimmed = text
    .replace(/^\b(?:to|for|that)\b\s+/i, "")
    .replace(/[.,;:!?]+$/g, "")
    .trim();
  return trimmed || undefined;
}

function coverageRelation(text: string): CoverageGoal["relation"] {
  const percentIndex = text.search(PERCENT_RE);
  const relationWindow = percentIndex >= 0 ? text.slice(Math.max(0, percentIndex - 40), percentIndex + 8) : text;
  if (AT_LEAST_RE.test(relationWindow)) {
    return "at least";
  }
  if (ABOVE_RE.test(relationWindow)) {
    return "above";
  }
  return "at least";
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(/0+$/g, "").replace(/\.$/, "");
}
