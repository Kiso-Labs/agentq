import { AgentQError } from "./errors.ts";

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:\//;
const REGEXP_SPECIAL_CHARACTER = /[\\^$.*+?()[\]{}|]/;
const GLOB_META_CHARACTER = /[*?[]/;
const compiledPatterns = new Map<string, RegExp>();

export interface ScopePolicy {
  readonly allowedPaths?: readonly string[];
  readonly deniedPaths?: readonly string[];
  readonly maxChangedFiles?: number;
}

/**
 * Allow groups are conjunctive: a path must match at least one rule in every group.
 * Keeping queue and task rules in separate groups preserves true narrowing semantics.
 */
export interface EffectiveScopePolicy {
  readonly allowPathGroups: readonly (readonly string[])[];
  readonly deniedPaths: readonly string[];
  readonly maxChangedFiles?: number;
}

export type ScopePolicyViolation =
  | {
      readonly code: "invalid_changed_path";
      readonly path: string;
      readonly message: string;
    }
  | {
      readonly code: "denied_path";
      readonly path: string;
      readonly pattern: string;
      readonly message: string;
    }
  | {
      readonly code: "outside_allowed_paths";
      readonly path: string;
      readonly requiredPatternGroups: readonly (readonly string[])[];
      readonly message: string;
    }
  | {
      readonly code: "max_changed_files";
      readonly actual: number;
      readonly maximum: number;
      readonly message: string;
    };

export interface ScopePolicyEvaluation {
  readonly passed: boolean;
  readonly changedPaths: readonly string[];
  readonly violations: readonly ScopePolicyViolation[];
}

function invalidPattern(pattern: string, reason: string): never {
  throw new AgentQError(
    `Invalid scope pattern ${JSON.stringify(pattern)}: ${reason}`,
    "INVALID_SCOPE_PATTERN",
    2,
  );
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function escapeRegExpCharacter(character: string): string {
  return REGEXP_SPECIAL_CHARACTER.test(character) ? `\\${character}` : character;
}

function compileSegment(segment: string, wholePattern: string): string {
  let source = "";
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index] as string;
    if (character === "*") {
      while (segment[index + 1] === "*") index += 1;
      source += "[^/]*";
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    if (character === "]") {
      invalidPattern(wholePattern, "contains an unmatched closing bracket");
    }
    if (character !== "[") {
      source += escapeRegExpCharacter(character);
      continue;
    }

    const closingBracket = segment.indexOf("]", index + 1);
    if (closingBracket === -1) {
      invalidPattern(wholePattern, "contains an unclosed character class");
    }
    const rawClass = segment.slice(index + 1, closingBracket);
    const negated = rawClass.startsWith("!") || rawClass.startsWith("^");
    const classBody = negated ? rawClass.slice(1) : rawClass;
    if (!classBody) invalidPattern(wholePattern, "contains an empty character class");
    if (classBody.includes("[") || classBody.includes("\\") || classBody.includes("/")) {
      invalidPattern(wholePattern, "contains a malformed character class");
    }
    source += `[${negated ? "^" : ""}${classBody}]`;
    index = closingBracket;
  }
  return source;
}

function compileNormalizedPattern(pattern: string): RegExp {
  const segments = pattern.split("/");
  let source: string;

  if (segments.length === 1) {
    source = `(?:^|/)${compileSegment(segments[0] as string, pattern)}(?:$|/)`;
  } else {
    source = "^";
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] as string;
      const previous = segments[index - 1];
      if (segment === "**") {
        if (segments.length === 1) {
          source += ".*";
        } else if (index === 0) {
          source += "(?:[^/]+/)*";
        } else if (index === segments.length - 1) {
          source += "(?:/.*)?";
        } else {
          source += "(?:/[^/]+)*/";
        }
      } else {
        if (index > 0 && previous !== "**") source += "/";
        source += compileSegment(segment, pattern);
      }
    }
    source += "(?:$|/)";
  }

  try {
    return new RegExp(source);
  } catch {
    invalidPattern(pattern, "contains an invalid character range");
  }
}

function invalidChangedPath(path: string, reason: string): never {
  throw new AgentQError(
    `Invalid changed path ${JSON.stringify(path)}: ${reason}`,
    "INVALID_CHANGED_PATH",
    2,
  );
}

function normalizeChangedPath(path: string): string {
  if (typeof path !== "string") invalidChangedPath(String(path), "must be a string");
  if (!path) invalidChangedPath(path, "cannot be empty");
  if (containsControlCharacter(path)) invalidChangedPath(path, "contains a control character");
  if (path.startsWith("/") || WINDOWS_ABSOLUTE_PATH.test(path)) {
    invalidChangedPath(path, "must be relative to the repository root");
  }
  if (path.includes("\\")) {
    invalidChangedPath(path, "must use forward slashes as Git path separators");
  }
  if (path.includes("//") || path.endsWith("/")) {
    invalidChangedPath(path, "is not a canonical Git path");
  }
  for (const segment of path.split("/")) {
    if (segment === "." || segment === "..") {
      invalidChangedPath(path, "contains a traversal segment");
    }
  }
  return path;
}

function invalidPolicy(reason: string): never {
  throw new AgentQError(`Invalid scope policy: ${reason}`, "INVALID_SCOPE_POLICY", 2);
}

function normalizePatternList(patterns: readonly string[] | undefined, field: string): string[] {
  if (patterns === undefined) return [];
  if (!Array.isArray(patterns) || !patterns.every((pattern) => typeof pattern === "string")) {
    invalidPolicy(`${field} must be an array of strings`);
  }
  return [...new Set(patterns.map((pattern) => normalizeScopePattern(pattern)))];
}

function normalizeFileLimit(limit: number | undefined, field: string): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    invalidPolicy(`${field} must be a non-negative safe integer`);
  }
  return limit;
}

/**
 * Validates and canonicalizes one repository-relative gitignore-style path pattern.
 *
 * Patterns use Git's `/` separator. Negated patterns are intentionally unsupported:
 * callers express allow and deny policy in separate fields, with deny taking precedence.
 */
export function normalizeScopePattern(pattern: string): string {
  if (typeof pattern !== "string") invalidPattern(String(pattern), "must be a string");
  if (pattern.length === 0) invalidPattern(pattern, "cannot be empty");
  if (pattern.trim() !== pattern) {
    invalidPattern(pattern, "leading or trailing whitespace is ambiguous");
  }
  if (containsControlCharacter(pattern)) invalidPattern(pattern, "contains a control character");
  if (pattern.startsWith("/") || WINDOWS_ABSOLUTE_PATH.test(pattern)) {
    invalidPattern(pattern, "must be relative to the repository root");
  }
  if (pattern.includes("\\")) {
    invalidPattern(pattern, "must use forward slashes as Git path separators");
  }
  if (pattern.startsWith("!")) {
    invalidPattern(pattern, "negation is not supported; use an explicit deny rule");
  }
  if (pattern.includes("//")) invalidPattern(pattern, "contains an empty path segment");
  if (pattern.includes("***")) invalidPattern(pattern, "contains an invalid globstar");

  const directoryPattern = pattern.endsWith("/");
  const withoutTrailingSlash = directoryPattern ? pattern.slice(0, -1) : pattern;
  if (!withoutTrailingSlash) invalidPattern(pattern, "cannot target the repository root");

  const segments = withoutTrailingSlash.split("/");
  for (const [index, segment] of segments.entries()) {
    if (segment === "." || segment === "..") {
      invalidPattern(pattern, "contains a traversal segment");
    }
    if (segment === "**" && segments[index - 1] === "**") {
      invalidPattern(pattern, "contains adjacent globstar segments");
    }
  }

  const alreadyRecursive = withoutTrailingSlash === "**" || withoutTrailingSlash.endsWith("/**");
  const normalized =
    directoryPattern && !alreadyRecursive ? `${withoutTrailingSlash}/**` : withoutTrailingSlash;
  compileNormalizedPattern(normalized);
  return normalized;
}

/**
 * Matches a canonical Git path against one validated scope pattern.
 */
export function matchesScopePattern(path: string, pattern: string): boolean {
  const normalizedPath = normalizeChangedPath(path);
  const normalizedPattern = normalizeScopePattern(pattern);
  return matchesNormalizedPattern(normalizedPath, normalizedPattern);
}

/**
 * Returns false only when two path patterns are provably disjoint.
 *
 * Glob intersection is intentionally conservative. Shared literal prefixes,
 * basename patterns, and differing wildcard suffixes may overlap and therefore
 * serialize under enforced file concurrency. Distinct literal directory
 * prefixes can safely execute in parallel.
 */
export function scopePatternsMayOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeScopePattern(left);
  const normalizedRight = normalizeScopePattern(right);
  if (normalizedLeft === normalizedRight) return true;

  const leftPrefix = literalDirectoryPrefix(normalizedLeft);
  const rightPrefix = literalDirectoryPrefix(normalizedRight);
  if (!leftPrefix || !rightPrefix) return true;

  return (
    leftPrefix === rightPrefix ||
    leftPrefix.startsWith(`${rightPrefix}/`) ||
    rightPrefix.startsWith(`${leftPrefix}/`)
  );
}

/**
 * Missing declarations represent repository-wide access and must serialize.
 */
export function scopePatternSetsMayOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length === 0 || right.length === 0) return true;
  return left.some((leftPattern) =>
    right.some((rightPattern) => scopePatternsMayOverlap(leftPattern, rightPattern)),
  );
}

function matchesNormalizedPattern(path: string, pattern: string): boolean {
  let matcher = compiledPatterns.get(pattern);
  if (!matcher) {
    matcher = compileNormalizedPattern(pattern);
    compiledPatterns.set(pattern, matcher);
  }
  return matcher.test(path);
}

function literalDirectoryPrefix(pattern: string): string {
  const segments = pattern.split("/");
  const literalSegments: string[] = [];
  for (const segment of segments) {
    if (segment === "**" || GLOB_META_CHARACTER.test(segment)) break;
    literalSegments.push(segment);
  }

  if (literalSegments.length === 0) return "";
  if (literalSegments.length === segments.length) {
    return literalSegments.join("/");
  }
  return literalSegments.join("/");
}

/**
 * Resolves inherited queue policy and task policy without weakening either source.
 */
export function resolveEffectiveScopePolicy(
  queuePolicy: ScopePolicy = {},
  taskPolicy: ScopePolicy = {},
): EffectiveScopePolicy {
  const queueAllowed = normalizePatternList(queuePolicy.allowedPaths, "queue allowedPaths");
  const taskAllowed = normalizePatternList(taskPolicy.allowedPaths, "task allowedPaths");
  const deniedPaths = [
    ...new Set([
      ...normalizePatternList(queuePolicy.deniedPaths, "queue deniedPaths"),
      ...normalizePatternList(taskPolicy.deniedPaths, "task deniedPaths"),
    ]),
  ];
  const queueLimit = normalizeFileLimit(queuePolicy.maxChangedFiles, "queue maxChangedFiles");
  const taskLimit = normalizeFileLimit(taskPolicy.maxChangedFiles, "task maxChangedFiles");
  const maxChangedFiles =
    queueLimit === undefined
      ? taskLimit
      : taskLimit === undefined
        ? queueLimit
        : Math.min(queueLimit, taskLimit);
  const allowPathGroups = [queueAllowed, taskAllowed].filter((group) => group.length > 0);

  return {
    allowPathGroups,
    deniedPaths,
    ...(maxChangedFiles === undefined ? {} : { maxChangedFiles }),
  };
}

function normalizeEffectivePolicy(policy: EffectiveScopePolicy): EffectiveScopePolicy {
  if (!policy || typeof policy !== "object") invalidPolicy("effective policy must be an object");
  if (!Array.isArray(policy.allowPathGroups)) {
    invalidPolicy("allowPathGroups must be an array of pattern arrays");
  }
  const allowPathGroups = policy.allowPathGroups.map((group, index) => {
    if (!Array.isArray(group)) {
      invalidPolicy(`allowPathGroups[${index}] must be an array of strings`);
    }
    return normalizePatternList(group, `allowPathGroups[${index}]`);
  });
  if (!Array.isArray(policy.deniedPaths)) {
    invalidPolicy("deniedPaths must be an array of strings");
  }
  const deniedPaths = normalizePatternList(policy.deniedPaths, "deniedPaths");
  const maxChangedFiles = normalizeFileLimit(policy.maxChangedFiles, "maxChangedFiles");
  return {
    allowPathGroups: allowPathGroups.filter((group) => group.length > 0),
    deniedPaths,
    ...(maxChangedFiles === undefined ? {} : { maxChangedFiles }),
  };
}

/**
 * Evaluates the complete set of paths reported by Git. Invalid paths fail closed,
 * deny rules win over allow rules, and duplicate paths count only once.
 */
export function evaluateScopePolicy(
  policy: EffectiveScopePolicy,
  changedPaths: readonly string[],
): ScopePolicyEvaluation {
  const effective = normalizeEffectivePolicy(policy);
  if (!Array.isArray(changedPaths)) invalidPolicy("changedPaths must be an array");

  const uniquePaths = [
    ...new Set(changedPaths.map((path) => (typeof path === "string" ? path : String(path)))),
  ];
  const violations: ScopePolicyViolation[] = [];

  for (const rawPath of uniquePaths) {
    let path: string;
    try {
      path = normalizeChangedPath(rawPath);
    } catch (error) {
      if (error instanceof AgentQError && error.code === "INVALID_CHANGED_PATH") {
        violations.push({
          code: "invalid_changed_path",
          path: rawPath,
          message: error.message,
        });
        continue;
      }
      throw error;
    }

    const deniedBy = effective.deniedPaths.find((pattern) =>
      matchesNormalizedPattern(path, pattern),
    );
    if (deniedBy) {
      violations.push({
        code: "denied_path",
        path,
        pattern: deniedBy,
        message: `${path} is denied by ${deniedBy}`,
      });
      continue;
    }

    const unmatchedGroups = effective.allowPathGroups.filter(
      (group) => !group.some((pattern) => matchesNormalizedPattern(path, pattern)),
    );
    if (unmatchedGroups.length > 0) {
      violations.push({
        code: "outside_allowed_paths",
        path,
        requiredPatternGroups: unmatchedGroups,
        message: `${path} is outside the configured allowed paths`,
      });
    }
  }

  if (effective.maxChangedFiles !== undefined && uniquePaths.length > effective.maxChangedFiles) {
    violations.push({
      code: "max_changed_files",
      actual: uniquePaths.length,
      maximum: effective.maxChangedFiles,
      message: `${uniquePaths.length} changed files exceeds the limit of ${effective.maxChangedFiles}`,
    });
  }

  return {
    passed: violations.length === 0,
    changedPaths: uniquePaths,
    violations,
  };
}
