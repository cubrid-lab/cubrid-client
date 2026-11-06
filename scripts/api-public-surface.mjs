// Normalize generated .d.ts files to their consumer-visible contract.
// Private class members and documentation comments are internal details.
import ts from "typescript";

export function publicDeclarationSurface(contents) {
  const source = ts.createSourceFile(
    "index.d.ts",
    contents.replace(/\r\n/g, "\n"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (source.parseDiagnostics.length > 0) {
    throw new Error("Cannot inspect invalid TypeScript declaration syntax");
  }
  const transformed = ts.transform(source, [
    (context) => (root) =>
      ts.visitNode(root, function visit(node) {
        if (ts.isClassDeclaration(node)) {
          const members = node.members.filter((member) => {
            const privateModifier = member.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword,
            );
            return !privateModifier && !(member.name && ts.isPrivateIdentifier(member.name));
          });
          return ts.factory.updateClassDeclaration(
            node,
            node.modifiers,
            node.name,
            node.typeParameters,
            node.heritageClauses,
            members,
          );
        }
        return ts.visitEachChild(node, visit, context);
      }),
  ]);
  try {
    return ts.createPrinter({
      removeComments: true,
      newLine: ts.NewLineKind.LineFeed,
    }).printFile(transformed.transformed[0]).trimEnd();
  } finally {
    transformed.dispose();
  }
}
