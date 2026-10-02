function same(a, b) {
  return Object.is(a, b)
}

function diffValue(before, after, path, operations) {
  if (same(before, after)) return

  const beforeObject = before !== null && typeof before === 'object'
  const afterObject = after !== null && typeof after === 'object'
  if (!beforeObject || !afterObject || Array.isArray(before) !== Array.isArray(after)) {
    operations.push({ op: 'set', path, value: after })
    return
  }

  if (Array.isArray(before)) {
    if (before.length !== after.length) {
      operations.push({ op: 'set', path, value: after })
      return
    }
    for (let index = 0; index < before.length; index++) diffValue(before[index], after[index], [...path, index], operations)
    return
  }

  const beforeKeys = Object.keys(before)
  const afterKeys = Object.keys(after)
  const afterSet = new Set(afterKeys)
  for (const key of beforeKeys) if (!afterSet.has(key)) operations.push({ op: 'remove', path: [...path, key] })
  for (const key of afterKeys) {
    if (!Object.hasOwn(before, key)) operations.push({ op: 'set', path: [...path, key], value: after[key] })
    else diffValue(before[key], after[key], [...path, key], operations)
  }
}

export function diffProgram(before, after) {
  const operations = []
  diffValue(before, after, [], operations)
  return operations
}

function parentAt(root, path) {
  let current = root
  for (const part of path) {
    if (typeof part === 'number') {
      if (!Array.isArray(current) || part < 0 || part >= current.length) throw new Error(`Patch array index out of range: ${part}`)
      current = current[part]
    } else {
      if (current === null || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, part)) throw new Error(`Patch object path is missing: ${part}`)
      current = current[part]
    }
  }
  return current
}

/** Test/tooling mirror of the native dev host patch semantics. */
export function applyProgramPatch(program, operations) {
  let result = structuredClone(program)
  for (const operation of operations) {
    const path = operation.path
    if (!Array.isArray(path)) throw new Error('Patch path must be an array')
    if (path.length === 0) {
      if (operation.op !== 'set') throw new Error('Cannot remove the program root')
      result = structuredClone(operation.value)
      continue
    }
    const key = path.at(-1)
    const parent = parentAt(result, path.slice(0, -1))
    if (operation.op === 'set') {
      if (typeof key === 'number') {
        if (!Array.isArray(parent) || key < 0 || key >= parent.length) throw new Error(`Patch array index out of range: ${key}`)
        parent[key] = structuredClone(operation.value)
      } else {
        if (parent === null || typeof parent !== 'object' || Array.isArray(parent)) throw new Error('Patch object parent is invalid')
        parent[key] = structuredClone(operation.value)
      }
    } else if (operation.op === 'remove') {
      if (typeof key === 'number') throw new Error('Array element removal is not emitted; arrays are replaced atomically')
      if (parent === null || typeof parent !== 'object' || Array.isArray(parent) || !Object.hasOwn(parent, key)) throw new Error(`Patch remove path is missing: ${key}`)
      delete parent[key]
    } else {
      throw new Error(`Unsupported patch operation: ${operation.op}`)
    }
  }
  return result
}

/**
 * Choose the smaller dev update representation. Revisions are monotonic per
 * native process; the host rejects stale/out-of-order messages.
 */
export function createProgramUpdate(before, after, { baseRevision, revision, preserve, patchRatio = 0.9 }) {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 || !Number.isSafeInteger(revision) || revision !== baseRevision + 1) {
    throw new Error('Dev revisions must advance exactly by one')
  }
  const operations = diffProgram(before, after)
  const common = { baseRevision, revision, preserve }
  const patchPayload = { ...common, operations }
  const fullPayload = { ...common, program: after }
  const patchBytes = Buffer.byteLength(JSON.stringify({ type: 'patch', ...patchPayload }), 'utf8')
  const fullBytes = Buffer.byteLength(JSON.stringify({ type: 'update', ...fullPayload }), 'utf8')
  if (operations.length > 0 && patchBytes < fullBytes * patchRatio) {
    return { type: 'patch', payload: patchPayload, bytes: patchBytes, fullBytes, operationCount: operations.length }
  }
  return { type: 'update', payload: fullPayload, bytes: fullBytes, fullBytes, operationCount: operations.length }
}
