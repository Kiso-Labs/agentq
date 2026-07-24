import { describe, expect, test } from "bun:test";
import { AgentQError } from "../src/core/errors.ts";
import {
  evaluateScopePolicy,
  matchesScopePattern,
  normalizeScopePattern,
  resolveEffectiveScopePolicy,
  scopePatternSetsMayOverlap,
  scopePatternsMayOverlap,
} from "../src/core/scope-policy.ts";

describe("scope policy patterns", () => {
  test("accepts canonical repository-relative gitignore patterns", () => {
    expect(normalizeScopePattern("src/services/**")).toBe("src/services/**");
    expect(normalizeScopePattern("**/*.test.ts")).toBe("**/*.test.ts");
    expect(normalizeScopePattern("docs/")).toBe("docs/**");
    expect(normalizeScopePattern("src/**/")).toBe("src/**");
    expect(normalizeScopePattern("src/?pi/[a-z]*.ts")).toBe("src/?pi/[a-z]*.ts");
  });

  test("rejects patterns that are unsafe or ambiguous", () => {
    const invalidPatterns = [
      "",
      " src/**",
      "/src/**",
      "C:/src/**",
      "../src/**",
      "src/../api/**",
      "./src/**",
      "src//api/**",
      String.raw`src\api\**`,
      "!src/api/**",
      "src/[abc",
      "src/***/file.ts",
    ];

    for (const pattern of invalidPatterns) {
      try {
        normalizeScopePattern(pattern);
        throw new Error(`Expected ${JSON.stringify(pattern)} to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(AgentQError);
        expect((error as AgentQError).code).toBe("INVALID_SCOPE_PATTERN");
      }
    }
  });
});

describe("scope policy evaluation", () => {
  test("enforces deny precedence, conjunctive allow groups, and the changed-file limit", () => {
    const policy = resolveEffectiveScopePolicy(
      {
        allowedPaths: ["src/**", "tests/**"],
        deniedPaths: ["src/api/**"],
        maxChangedFiles: 4,
      },
      {
        allowedPaths: ["src/services/**", "tests/services/**"],
        deniedPaths: ["src/services/private/**"],
        maxChangedFiles: 3,
      },
    );

    const result = evaluateScopePolicy(policy, [
      "src/services/order.ts",
      "tests/services/order.test.ts",
      "src/services/private/token.ts",
      "src/api/schema.ts",
      "docs/guide.md",
      "src/services/order.ts",
    ]);

    expect(result.passed).toBe(false);
    expect(result.changedPaths).toEqual([
      "src/services/order.ts",
      "tests/services/order.test.ts",
      "src/services/private/token.ts",
      "src/api/schema.ts",
      "docs/guide.md",
    ]);
    expect(result.violations.map(({ code }) => code)).toEqual([
      "denied_path",
      "denied_path",
      "outside_allowed_paths",
      "max_changed_files",
    ]);
    expect(result.violations[0]).toMatchObject({
      code: "denied_path",
      path: "src/services/private/token.ts",
      pattern: "src/services/private/**",
    });
    expect(result.violations[1]).toMatchObject({
      code: "denied_path",
      path: "src/api/schema.ts",
      pattern: "src/api/**",
    });
    expect(result.violations[3]).toMatchObject({
      code: "max_changed_files",
      actual: 5,
      maximum: 3,
    });
  });

  test("fails closed with structured violations for non-canonical changed paths", () => {
    const result = evaluateScopePolicy(resolveEffectiveScopePolicy(), [
      "/etc/passwd",
      "../outside.ts",
      String.raw`src\api.ts`,
      "src/service.ts",
    ]);

    expect(result.passed).toBe(false);
    expect(result.violations.map(({ code }) => code)).toEqual([
      "invalid_changed_path",
      "invalid_changed_path",
      "invalid_changed_path",
    ]);
    expect(
      result.violations.map((violation) => ("path" in violation ? violation.path : "")),
    ).toEqual(["/etc/passwd", "../outside.ts", String.raw`src\api.ts`]);
  });

  test("passes valid paths when no configured rule is violated", () => {
    const policy = resolveEffectiveScopePolicy(
      { allowedPaths: ["src/**"], maxChangedFiles: 2 },
      { allowedPaths: ["src/services/**"] },
    );

    expect(evaluateScopePolicy(policy, ["src/services/order.ts"])).toEqual({
      passed: true,
      changedPaths: ["src/services/order.ts"],
      violations: [],
    });
  });
});

describe("scope pattern matching", () => {
  test("matches gitignore-style root, basename, directory, and globstar rules", () => {
    expect(matchesScopePattern("src/services/order.ts", "src/services/**")).toBe(true);
    expect(matchesScopePattern("src/services/order.ts", "src/services")).toBe(true);
    expect(matchesScopePattern("src/services/nested/order.ts", "src/services/**")).toBe(true);
    expect(matchesScopePattern("src/api/order.ts", "src/services/**")).toBe(false);

    expect(matchesScopePattern("order.test.ts", "**/*.test.ts")).toBe(true);
    expect(matchesScopePattern("test/unit/order.test.ts", "**/*.test.ts")).toBe(true);
    expect(matchesScopePattern("packages/app/README.md", "*.md")).toBe(true);
    expect(matchesScopePattern("packages/build/output.js", "build")).toBe(true);

    expect(matchesScopePattern("docs/guides/start.md", "docs/")).toBe(true);
    expect(matchesScopePattern("src/generated/types.ts", "src/**/generated/*.ts")).toBe(true);
    expect(matchesScopePattern("src/client/generated/types.ts", "src/**/generated/*.ts")).toBe(
      true,
    );
    expect(
      matchesScopePattern("src/client/generated/nested/types.ts", "src/**/generated/*.ts"),
    ).toBe(false);
  });

  test("proves only distinct literal path regions are safe to run concurrently", () => {
    expect(scopePatternsMayOverlap("src/services/**", "src/api/**")).toBe(false);
    expect(scopePatternsMayOverlap("packages/web/**", "packages/worker/**")).toBe(false);
    expect(scopePatternsMayOverlap("src/services/**", "src/services/orders/**")).toBe(true);
    expect(scopePatternsMayOverlap("src/**/*.ts", "src/**/*.test.ts")).toBe(true);
    expect(scopePatternsMayOverlap("*.md", "packages/app/**")).toBe(true);
    expect(scopePatternsMayOverlap("src/api.ts", "src/api/**")).toBe(false);
  });

  test("treats undeclared or ambiguous task scopes as repository-wide", () => {
    expect(scopePatternSetsMayOverlap([], ["src/api/**"])).toBe(true);
    expect(scopePatternSetsMayOverlap(["src/api/**"], [])).toBe(true);
    expect(scopePatternSetsMayOverlap(["src/api/**"], ["src/services/**"])).toBe(false);
    expect(
      scopePatternSetsMayOverlap(
        ["src/api/**", "tests/api/**"],
        ["src/services/**", "tests/services/**"],
      ),
    ).toBe(false);
    expect(scopePatternSetsMayOverlap(["src/**"], ["src/services/**"])).toBe(true);
  });
});

describe("effective scope policies", () => {
  test("unions deny rules, intersects allow groups, and chooses the strictest file limit", () => {
    const effective = resolveEffectiveScopePolicy(
      {
        allowedPaths: ["src/**", "tests/**"],
        deniedPaths: ["src/api/**"],
        maxChangedFiles: 20,
      },
      {
        allowedPaths: ["src/services/**", "tests/services/**"],
        deniedPaths: ["**/*.snap", "src/api/**"],
        maxChangedFiles: 8,
      },
    );

    expect(effective).toEqual({
      allowPathGroups: [
        ["src/**", "tests/**"],
        ["src/services/**", "tests/services/**"],
      ],
      deniedPaths: ["src/api/**", "**/*.snap"],
      maxChangedFiles: 8,
    });
  });

  test("treats an omitted allow list as unrestricted without widening the other policy", () => {
    expect(
      resolveEffectiveScopePolicy(
        { allowedPaths: ["src/services/**"], maxChangedFiles: 0 },
        { deniedPaths: ["src/services/private/**"] },
      ),
    ).toEqual({
      allowPathGroups: [["src/services/**"]],
      deniedPaths: ["src/services/private/**"],
      maxChangedFiles: 0,
    });
  });
});
