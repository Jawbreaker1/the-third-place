import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_ARGUMENT_FIELDS,
  CAPABILITY_CATALOG_ENTRIES,
} from "./catalog.js";

const directorUrl = new URL("../director.ts", import.meta.url);
const semanticRouterUrl = new URL("../semanticRouter.ts", import.meta.url);

const parseSource = (url: URL): ts.SourceFile => ts.createSourceFile(
  url.pathname,
  readFileSync(url, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

const parseDirector = (): ts.SourceFile => parseSource(directorUrl);

const visit = (node: ts.Node, callback: (candidate: ts.Node) => void): void => {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
};

const importedNames = (declaration: ts.ImportDeclaration): string[] => {
  const clause = declaration.importClause;
  if (!clause) return [];
  const names: string[] = [];
  if (clause.name) names.push("default");
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) names.push("*");
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      names.push(element.propertyName?.text ?? element.name.text);
    }
  }
  return names;
};

const sourceLocation = (source: ts.SourceFile, node: ts.Node): string => {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${position.line + 1}:${position.character + 1}`;
};

describe("turn-capability architecture boundary", () => {
  it("keeps the capability catalog complete with one generic external default", () => {
    const genericDefaults = CAPABILITY_CATALOG_ENTRIES.filter(
      (entry) => entry.routingClass === "generic_external_default",
    );
    expect(genericDefaults.map((entry) => entry.id)).toEqual(["web_search"]);

    const knownFields = new Set<string>(CAPABILITY_ARGUMENT_FIELDS);
    for (const entry of CAPABILITY_CATALOG_ENTRIES) {
      expect(typeof entry.external, `${entry.id} must declare boolean external metadata`).toBe("boolean");
      expect(entry.media.length, `${entry.id} must declare at least one medium`).toBeGreaterThan(0);
      expect(new Set(entry.media).size, `${entry.id} repeats a medium`).toBe(entry.media.length);
      expect(entry.routingGuidance.primary.trim().length, `${entry.id} needs primary guidance`).toBeGreaterThan(0);
      expect(entry.routingGuidance.verifier.trim().length, `${entry.id} needs verifier guidance`).toBeGreaterThan(0);
      expect(Array.isArray(entry.arguments.required), `${entry.id} needs required argument metadata`).toBe(true);
      expect(Array.isArray(entry.arguments.allowed), `${entry.id} needs allowed argument metadata`).toBe(true);

      const required = [...entry.arguments.required];
      const allowed = [...entry.arguments.allowed];
      const allowedFields = new Set<string>(allowed);
      expect(new Set(required).size, `${entry.id} repeats a required argument`).toBe(required.length);
      expect(new Set(allowed).size, `${entry.id} repeats an allowed argument`).toBe(allowed.length);
      expect(required.every((field) => allowed.includes(field)), `${entry.id} requires a forbidden argument`).toBe(true);
      expect(allowed.every((field) => knownFields.has(field)), `${entry.id} declares an unknown argument`).toBe(true);
      expect(
        Object.keys(entry.arguments.conditional ?? {}).every((field) => allowedFields.has(field)),
        `${entry.id} conditions an argument it does not allow`,
      ).toBe(true);
    }
  });

  it("keeps registered capability IDs out of Director control flow", () => {
    const source = parseDirector();
    const registeredIds = new Set<string>(CAPABILITY_CATALOG_ENTRIES.map((entry) => entry.id));
    const violations: string[] = [];

    visit(source, (node) => {
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        registeredIds.has(node.text)
      ) {
        violations.push(`${node.text} at ${sourceLocation(source, node)}`);
      }
    });

    expect(
      violations,
      "Director must consume CapabilityInvocation/EvidenceResolution metadata without comparing registered IDs",
    ).toEqual([]);
  });

  it("keeps capability-provider helpers and builtin adapters out of Director", () => {
    const source = parseDirector();
    const forbiddenDirectModules = new Set([
      "./weatherForecast.js",
      "./weatherForecast",
      "./evidenceResolver.js",
      "./evidenceResolver",
      "./timeResolver.js",
      "./timeResolver",
    ]);
    const violations: string[] = [];

    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const moduleName = statement.moduleSpecifier.text;
      const names = importedNames(statement);
      if (forbiddenDirectModules.has(moduleName)) {
        violations.push(`${moduleName} (${names.join(", ") || "side effect"}) at ${sourceLocation(source, statement)}`);
        continue;
      }
      if (moduleName.includes("capabilities/builtins")) {
        violations.push(`${moduleName} (${names.join(", ") || "side effect"}) at ${sourceLocation(source, statement)}`);
        continue;
      }
      if (moduleName === "./researchBroker.js" || moduleName === "./researchBroker") {
        const helperNames = names.filter((name) => name !== "ResearchBroker");
        if (helperNames.length > 0) {
          violations.push(`${moduleName} helpers (${helperNames.join(", ")}) at ${sourceLocation(source, statement)}`);
        }
      }
    }

    expect(
      violations,
      "Director may retain the ResearchBroker dependency temporarily, but adapters and provider helpers belong behind the capability registry",
    ).toEqual([]);
  });

  it("keeps registered capability IDs out of semantic-router control-flow branches", () => {
    const source = parseSource(semanticRouterUrl);
    const registeredIds = new Set<string>(CAPABILITY_CATALOG_ENTRIES.map((entry) => entry.id));
    const violations: string[] = [];

    visit(source, (node) => {
      if (ts.isBinaryExpression(node)) {
        for (const operand of [node.left, node.right]) {
          if (ts.isStringLiteral(operand) && registeredIds.has(operand.text)) {
            violations.push(`${operand.text} binary branch at ${sourceLocation(source, operand)}`);
          }
        }
      }
      if (
        ts.isCaseClause(node) &&
        ts.isStringLiteral(node.expression) &&
        registeredIds.has(node.expression.text)
      ) {
        violations.push(`${node.expression.text} switch branch at ${sourceLocation(source, node.expression)}`);
      }
    });

    expect(
      violations,
      "Semantic routing must derive schemas, validation and normalisation from catalog metadata rather than adding per-ID branches",
    ).toEqual([]);
  });
});
