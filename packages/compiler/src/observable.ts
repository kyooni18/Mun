import * as ts from "typescript"
import { matching, skipComment, skipString, splitTopLevel } from "./scanner.js"
import { lowerSwiftInterpolation, rewriteMemberReferences } from "./struct-state.js"

const identifier = "[A-Za-z_$][A-Za-z0-9_$]*"
const statementBody = /^(?:return|const|let|var|if|for|while|switch|guard|throw)\b/m

/** Copy `source` with `transform` applied only outside strings and comments. */
function outsideLiterals(source: string, transform: (code: string) => string): string {
  let output = ""
  let code = ""
  let cursor = 0
  while (cursor < source.length) {
    const character = source[cursor]
    const comment = character === "/" && (source[cursor + 1] === "/" || source[cursor + 1] === "*")
    if (comment || character === "\"" || character === "'" || character === "`") {
      const end = comment ? skipComment(source, cursor) : skipString(source, cursor)
      output += transform(code) + source.slice(cursor, end)
      code = ""
      cursor = end
      continue
    }
    code += character
    cursor += 1
  }
  return output + transform(code)
}

/**
 * Swift key paths and metatypes used by the environment:
 * `\.colorScheme` becomes `"colorScheme"`, `Model.self` becomes `Model`.
 */
export function lowerSwiftKeyPaths(source: string): string {
  if (!source.includes("\\.") && !source.includes(".self")) return source
  return outsideLiterals(source, code => code
    .replace(new RegExp(`\\\\\\.(${identifier})`, "g"), (_, name: string) => JSON.stringify(name))
    .replace(new RegExp(`\\b([A-Z][A-Za-z0-9_$]*)\\.self\\b`, "g"), "$1"))
}

function lowerParameters(source: string): string {
  return splitTopLevel(source).map(parameter => {
    const match = new RegExp(`^\\s*(?:(?:_|${identifier})\\s+)?(${identifier})\\s*(:[\\s\\S]*)?$`).exec(parameter)
    return match ? `${match[1]}${match[2] ?? ""}` : parameter.trim()
  }).filter(Boolean).join(", ")
}

/** End of a stored-property initializer: the first top-level newline or `;`. */
function expressionEnd(source: string, start: number): number {
  let depth = 0
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor]
    if (character === "\"" || character === "'" || character === "`") { cursor = skipString(source, cursor) - 1; continue }
    if (character === "(" || character === "[" || character === "{") depth += 1
    else if (character === ")" || character === "]" || character === "}") depth -= 1
    else if (depth === 0 && (character === "\n" || character === ";")) return cursor
  }
  return source.length
}

/** Swift class members (`var`, `let`, computed `var`, `func`, `init`) as TypeScript class members. */
function lowerClassMembers(body: string): string {
  const access = "(?:(?:private|fileprivate|internal|public)\\s+)?"
  const property = new RegExp(`${access}(static\\s+)?(?:var|let)\\s+(${identifier})\\s*(?::\\s*([^=\\n{;]*[^=\\n{;\\s]))?\\s*`, "y")
  const method = new RegExp(`${access}(static\\s+)?(?:mutating\\s+)?func\\s+(${identifier})\\s*(<[^>(]*>)?\\s*\\(`, "y")
  const initializer = /(?:(?:public|internal)\s+)?init\s*\(/y
  let output = ""
  let cursor = 0
  while (cursor < body.length) {
    const character = body[cursor]
    if (/\s/.test(character)) { output += character; cursor += 1; continue }
    if (character === "/" && (body[cursor + 1] === "/" || body[cursor + 1] === "*")) {
      const end = skipComment(body, cursor)
      output += body.slice(cursor, end)
      cursor = end
      continue
    }
    property.lastIndex = cursor
    method.lastIndex = cursor
    initializer.lastIndex = cursor
    const propertyMatch = property.exec(body)
    if (propertyMatch) {
      const [text, isStatic, name, type] = propertyMatch
      const next = cursor + text.length
      const prefix = isStatic ? "static " : ""
      if (body[next] === "{" && type) {
        const close = matching(body, next, "{", "}")
        const getter = body.slice(next + 1, close).trim()
        output += `${prefix}get ${name}(): ${type} { ${statementBody.test(getter) ? getter : `return (${getter})`} }`
        cursor = close + 1
      } else if (body[next] === "=") {
        const end = expressionEnd(body, next + 1)
        output += `${prefix}${name}${type ? `: ${type}` : ""} = ${body.slice(next + 1, end).trim()};`
        cursor = body[end] === ";" ? end + 1 : end
      } else {
        output += `${prefix}${name}!${type ? `: ${type}` : ""};`
        cursor = next
      }
      continue
    }
    const methodMatch = method.exec(body) ?? initializer.exec(body)
    if (methodMatch) {
      const open = cursor + methodMatch[0].length - 1
      const close = matching(body, open, "(", ")")
      const brace = body.indexOf("{", close)
      const effects = body.slice(close + 1, brace)
      const asynchronous = /\basync\b/.test(effects)
      const returnType = /->\s*([\s\S]*?)\s*$/.exec(effects)?.[1]
      const name = methodMatch[0].trimStart().startsWith("init") && !methodMatch[2] ? "constructor" : methodMatch[2]
      const blockClose = matching(body, brace, "{", "}")
      const signatureType = returnType ? `: ${asynchronous ? `Promise<${returnType}>` : returnType}` : ""
      output += `${methodMatch[1] ? "static " : ""}${asynchronous ? "async " : ""}${name}${methodMatch[3] ?? ""}(${lowerParameters(body.slice(open + 1, close))})${signatureType} ${body.slice(brace, blockClose + 1)}`
      cursor = blockClose + 1
      continue
    }
    const lineEnd = body.indexOf("\n", cursor)
    const end = lineEnd < 0 ? body.length : lineEnd
    output += body.slice(cursor, end)
    cursor = end
  }
  return output
}

/** Swift's implicit `self`: member names inside method bodies become `this.name`, and `self` becomes `this`. */
function lowerImplicitSelf(classSource: string): string {
  const file = ts.createSourceFile("mun-observable.ts", classSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declaration = file.statements.find(ts.isClassDeclaration)
  if (!declaration) return classSource
  const members = new Set<string>()
  const instanceMembers = declaration.members.filter(member => !ts.canHaveModifiers(member) || !ts.getModifiers(member)?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword))
  for (const member of instanceMembers) if (member.name && ts.isIdentifier(member.name)) members.add(member.name.text)
  members.add("self")
  const bodies = declaration.members.flatMap((member): ts.Node[] => {
    if ((ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member) || ts.isConstructorDeclaration(member)) && member.body) {
      return [...member.parameters.flatMap(parameter => parameter.initializer ? [parameter.initializer] : []), member.body]
    }
    if (ts.isPropertyDeclaration(member) && member.initializer) return [member.initializer]
    return []
  })
  return rewriteMemberReferences(classSource, file, bodies, members, name => name === "self" ? "this" : `this.${name}`, {}, declaration)
}

/**
 * `@Observable class Model { var count = 0; func increment() { count += 1 } }`
 * becomes an `Observable(class ...)` whose stored properties are tracked State,
 * plus a same-named instance type so `let model: Model` keeps type-checking.
 */
/**
 * Swift constructs a class without `new` and with argument labels:
 * `Model(start: 1)` becomes `new Model(1)`.
 */
function lowerObservableConstruction(source: string, names: ReadonlySet<string>): string {
  if (names.size === 0) return source
  const call = new RegExp(`\\b(${[...names].join("|")})\\s*\\(`, "g")
  let output = ""
  let cursor = 0
  for (const match of source.matchAll(call)) {
    const start = match.index ?? 0
    if (start < cursor) continue
    const before = source.slice(Math.max(0, start - 12), start)
    if (/(?:\bnew|\bclass|\btypeof|\.)\s*$/.test(before) || /InstanceType<typeof\s*$/.test(before)) continue
    const open = start + match[0].length - 1
    const close = matching(source, open, "(", ")")
    const args = splitTopLevel(source.slice(open + 1, close))
      .map(argument => argument.replace(new RegExp(`^\\s*${identifier}\\s*:(?!:)\\s*`), "").trim())
      .filter(Boolean)
    output += `${source.slice(cursor, start)}new ${match[1]}(${args.join(", ")})`
    cursor = close + 1
  }
  return output + source.slice(cursor)
}

export function lowerObservableClasses(source: string): string {
  if (!source.includes("@Observable")) return source
  const header = new RegExp(`(^|\\n)([ \\t]*)(export\\s+)?@Observable\\s+(?:final\\s+)?class\\s+(${identifier})\\s*\\{`, "g")
  const matches = [...source.matchAll(header)]
  let output = source
  for (const match of matches.reverse()) {
    const [text, lineBreak, indent, exported, name] = match
    const start = (match.index ?? 0) + lineBreak.length
    const brace = (match.index ?? 0) + text.length - 1
    const close = matching(source, brace, "{", "}")
    const members = lowerClassMembers(lowerSwiftInterpolation(source.slice(brace + 1, close)))
    const classSource = lowerImplicitSelf(`class ${name} {${members}}`)
    const exportKeyword = exported ? "export " : ""
    const replacement = `${exportKeyword}const ${name} = Observable(${classSource})\n${indent}${exportKeyword}type ${name} = InstanceType<typeof ${name}>`
    output = output.slice(0, start) + indent + replacement + output.slice(close + 1)
  }
  return lowerObservableConstruction(output, new Set(matches.map(match => match[4])))
}
