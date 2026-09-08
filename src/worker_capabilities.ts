export interface IsolatedWorkerCapabilities {
  /** Tool names exposed directly to the worker session. */
  tools: readonly string[];
  /** Pi Long Task isolated sessions deliberately disable extension runtimes. */
  extensionsEnabled: boolean;
}

export type WorkerCapabilityWarningCode = "unavailable_browser_capability";

export interface WorkerCapabilityWarning {
  code: WorkerCapabilityWarningCode;
  requestedCapabilities: readonly string[];
  availableTools: readonly string[];
  message: string;
  planningConstraint: string;
}

const BROWSER_EXTENSION_REQUIREMENT_RE =
  /\b(?:must(?:\s+use)?|need(?:s|ed)?(?:\s+to\s+use)?|require(?:s|d)?|rely(?:ing)?\s+on|use|using|via|through|with)\s+(?:the\s+|an?\s+)?(?:google\s+)?(?:chrome|chromium|firefox|edge|browser)(?:\s+(?:browser|devtools?))?\s+(?:extension|mcp|connector)\b/i;
const REQUIRED_NAMED_BROWSER_EXTENSION_RE =
  /\b(?:chrome\s+devtools\s+(?:mcp|extension|tool)|(?:chrome|browser)\s+(?:mcp|extension(?:\s+tool)?|tool\s+extension))\s+(?:is\s+(?:required|needed)|must\s+be\s+used)\b/i;
const IMPERATIVE_CHROME_RE =
  /\b(?:open|launch|control|drive|browse\s+with|inspect\s+(?:with|using)|scrape\s+(?:with|using)|fetch\s+(?:with|using)|test\s+(?:with|using))\s+(?:google\s+)?chrome\b/i;
const EXPLICIT_BROWSER_TOOL_RE =
  /\b(?:must(?:\s+use)?|need(?:s|ed)?(?:\s+to\s+use)?|require(?:s|d)?|use|using|via|through|with)\s+(?:the\s+)?(browser|chrome|web[_-]?fetch|playwright|puppeteer)\s+tool\b/i;
const EXPLICIT_CHROME_RUNTIME_RE =
  /(?:\b(?:must\s+use|need(?:s|ed)?\s+to\s+use|use|using)\s+(?:google\s+)?chrome(?:\s+devtools?)?(?=\s+(?:to|for)\b|\s*[.,;:]|\s*$)|\b(?:via|through)\s+(?:google\s+)?chrome\b|\b(?:google\s+)?chrome(?:\s+devtools?)?\s+(?:is\s+required|must\s+be\s+used)\b)/i;
const NEGATED_CAPABILITY_RE =
  /\b(?:do\s+not|don't|dont|never|avoid|without)\s+(?:use|using|rely(?:ing)?\s+on|requiring?)?\s*(?:the\s+|an?\s+)?(?:google\s+)?(?:chrome(?:\s+(?:browser|devtools?))?|chromium|firefox|edge|browser|web[_-]?fetch|playwright|puppeteer)(?:\s+(?:extension|mcp|tool(?:ing)?|connector))?/gi;

/**
 * Detect only explicit requests to invoke a browser capability. Merely asking
 * workers to build or support a browser extension is implementation work and
 * does not imply that the extension must be loaded during the run.
 */
export function detectUnavailableWorkerCapabilities(
  requestText: string,
  capabilities: Readonly<IsolatedWorkerCapabilities>,
): WorkerCapabilityWarning[] {
  const text = requestText.replace(NEGATED_CAPABILITY_RE, " ");
  const extensionRequested =
    BROWSER_EXTENSION_REQUIREMENT_RE.test(text) ||
    REQUIRED_NAMED_BROWSER_EXTENSION_RE.test(text) ||
    IMPERATIVE_CHROME_RE.test(text);
  const browserToolMatch = EXPLICIT_BROWSER_TOOL_RE.exec(text);
  const requestedDirectTools = [
    browserToolMatch?.[1],
    EXPLICIT_CHROME_RUNTIME_RE.test(text) ? "chrome" : undefined,
  ].filter((item, index, all): item is string => Boolean(item) && all.indexOf(item) === index);
  const unavailableDirectTools = requestedDirectTools.filter(
    (requested) =>
      !capabilities.tools.some((available) => canonicalToolName(available) === canonicalToolName(requested)),
  );

  if ((!extensionRequested || capabilities.extensionsEnabled) && unavailableDirectTools.length === 0) {
    return [];
  }

  const requestedCapabilities = [
    extensionRequested && !capabilities.extensionsEnabled ? "Chrome/browser extension runtime" : undefined,
    unavailableDirectTools.length > 0 ? `${unavailableDirectTools.join("/")} direct tool` : undefined,
  ].filter((item): item is string => Boolean(item));
  const availableTools = [...capabilities.tools];
  const toolList = availableTools.length > 0 ? availableTools.join(", ") : "none";
  const alternatives = availableWorkerAlternatives(capabilities);
  const alternativeText = alternatives.join(", or ");

  return [
    {
      code: "unavailable_browser_capability",
      requestedCapabilities,
      availableTools,
      message:
        `Worker capability warning: isolated Pi Long Task workers disable extensions and expose only these direct tools: ${toolList}. ` +
        `They cannot silently use the requested ${requestedCapabilities.join(" or ")}. The run will continue, but it must use an available safe alternative when that satisfies the request: ${alternativeText}. ` +
        "If the exact extension or browser tool is mandatory, the affected task must report blocked instead of claiming it used that capability.",
      planningConstraint:
        `Isolated-worker capability constraint: extensions are disabled and workers have only these direct tools: ${toolList}. ` +
        `Do not create or execute tasks that assume the requested ${requestedCapabilities.join(" or ")} is available, and never claim it was used. ` +
        `When equivalent, ${alternativeText}. If the exact unavailable capability is mandatory, make the affected task report blocked with the required user action.`,
    },
  ];
}

function canonicalToolName(tool: string): string {
  return tool.toLowerCase().replace(/[-_]/g, "");
}

function availableWorkerAlternatives(capabilities: Readonly<IsolatedWorkerCapabilities>): string[] {
  const alternatives: string[] = [];
  if (capabilities.tools.includes("bash")) {
    alternatives.push(
      "fetch public content through a supported command-line mechanism via bash or run project-provided browser automation via bash when available",
    );
  }
  if (capabilities.tools.includes("read")) {
    alternatives.push("supply the page or source content to the run so workers can read it locally");
  }
  if (alternatives.length === 0) {
    alternatives.push("supply the needed source content to the run");
  }
  return alternatives;
}
