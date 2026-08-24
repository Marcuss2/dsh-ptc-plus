import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applySourceEdits,
  createMappedTextBuilder,
  identitySourceMap,
  mapSourcePosition,
  mapSourceSpan,
} from '../internal/source-position-map.js'

test('builds mapped text from explicit copied ranges', () => {
  const source = 'prefix value suffix'
  const builder = createMappedTextBuilder(source)
  builder.append('generated(')
  builder.appendSource(7, 12)
  builder.append(')')
  assert.deepEqual(builder.result(), {
    text: 'generated(value)',
    mappings: [{ generatedStart: 10, generatedEnd: 15, originalStart: 7, originalEnd: 12 }],
  })
  assert.throws(() => builder.appendSource(-1, 2), /bounded/)
  assert.throws(() => createMappedTextBuilder(source, -1), /valid/)
})

test('keeps unchanged positions exact and anchors generated replacement text', () => {
  const original = 'alpha beta omega'
  const rewritten = applySourceEdits(original, identitySourceMap(original.length), [{
    start: 6,
    end: 10,
    text: 'generated replacement',
  }])
  assert.equal(rewritten.code, 'alpha generated replacement omega')
  assert.deepEqual(
    mapSourcePosition({ line: 1, column: 7 }, rewritten.code, original, rewritten.sourceMap),
    { line: 1, column: 7 },
  )
  assert.deepEqual(
    mapSourcePosition({ line: 1, column: 29 }, rewritten.code, original, rewritten.sourceMap),
    { line: 1, column: 12 },
  )
})

test('composes insertions and deletions across CRLF source lines', () => {
  const original = 'first\r\nsecond\r\nthird'
  assert.deepEqual(
    mapSourcePosition({ line: 2, column: 1 }, original, original, identitySourceMap(original.length)),
    { line: 2, column: 1 },
  )
  const first = applySourceEdits(original, identitySourceMap(original.length), [
    { start: 0, end: 5, text: '' },
    { start: 7, end: 7, text: 'prefix ' },
  ])
  const secondStart = first.code.indexOf('second')
  const rewritten = applySourceEdits(first.code, first.sourceMap, [{
    start: secondStart,
    end: secondStart + 6,
    text: 'expanded-second',
  }])
  const thirdColumn = rewritten.code.split('\n')[2].indexOf('third') + 1
  assert.deepEqual(
    mapSourcePosition({ line: 3, column: thirdColumn }, rewritten.code, original, rewritten.sourceMap),
    { line: 3, column: 1 },
  )
})

test('leaves absent or invalid worker positions unchanged', () => {
  const sourceMap = identitySourceMap(1)
  assert.equal(mapSourcePosition(undefined, 'x', 'x', sourceMap), undefined)
  assert.deepEqual(
    mapSourcePosition({ line: 0, column: 1 }, 'x', 'x', sourceMap),
    { line: 0, column: 1 },
  )
  assert.deepEqual(
    mapSourcePosition({ line: 2, column: 1 }, 'x', 'x', []),
    { line: 1, column: 2 },
  )
})

test('maps anchored generated spans to exact original tokens', () => {
  const original = 'import { original as local }'
  const generated = 'const { original: local } = value'
  const localStart = generated.indexOf('local')
  const originalStart = original.indexOf('local')
  const rewritten = applySourceEdits(original, identitySourceMap(original.length), [{
    start: 0,
    end: original.length,
    text: generated,
    mappings: [{
      generatedStart: localStart,
      generatedEnd: localStart + 'local'.length,
      originalStart,
      originalEnd: originalStart + 'local'.length,
    }],
  }])
  assert.deepEqual(mapSourceSpan({
    line: 1,
    column: localStart + 1,
    end: { line: 1, column: localStart + 1 + 'local'.length },
  }, generated, original, rewritten.sourceMap), {
    line: 1,
    column: originalStart + 1,
    end: { line: 1, column: originalStart + 1 + 'local'.length },
  })
})

test('preserves an invalid span end for its diagnostic owner to reject', () => {
  const source = 'value'
  assert.deepEqual(mapSourceSpan({
    line: 1,
    column: 1,
    end: { line: 0, column: 1 },
  }, source, source, identitySourceMap(source.length)), {
    line: 1,
    column: 1,
    end: { line: 0, column: 1 },
  })
})

test('validates a batch once and handles thousands of edits without iterative map rebuilds', () => {
  const original = 'x'.repeat(100_000)
  const edits = Array.from({ length: 2_000 }, (_, index) => ({
    start: index * 40,
    end: index * 40 + 1,
    text: 'replacement',
  }))
  let iterations = 0
  const sourceMap = new Proxy(identitySourceMap(original.length), {
    get(target, property, receiver) {
      if (property === Symbol.iterator) iterations += 1
      return Reflect.get(target, property, receiver)
    },
  })
  const rewritten = applySourceEdits(original, sourceMap, edits)
  assert.equal(rewritten.code.length, 120_000)
  assert.equal(iterations, 0)
  assert.throws(() => applySourceEdits('abc', identitySourceMap(3), [
    { start: 0, end: 2, text: 'x' },
    { start: 1, end: 3, text: 'y' },
  ]), /non-overlapping/)
  assert.throws(() => applySourceEdits('abc', identitySourceMap(3), [
    { start: 0, end: 1, text: 'x', mappings: [{ generatedStart: 0, generatedEnd: 2, originalStart: 0, originalEnd: 1 }] },
  ]), /mappings/)
})

test('normalizes edit and mapping order without mutating caller arrays', () => {
  const source = 'alpha beta gamma'
  const mappings = [
    { generatedStart: 2, generatedEnd: 4, originalStart: 8, originalEnd: 10 },
    { generatedStart: 0, generatedEnd: 2, originalStart: 6, originalEnd: 8 },
  ]
  const edits = [
    { start: 11, end: 16, text: 'G' },
    { start: 6, end: 10, text: 'BETA', mappings },
  ]
  const originalEdits = structuredClone(edits)

  const rewritten = applySourceEdits(source, identitySourceMap(source.length), edits)
  assert.equal(rewritten.code, 'alpha BETA G')
  assert.deepEqual(edits, originalEdits)
  assert.deepEqual(mappings, originalEdits[1].mappings)
  assert.deepEqual(mapSourceSpan({
    line: 1,
    column: 7,
    end: { line: 1, column: 11 },
  }, rewritten.code, source, rewritten.sourceMap), {
    line: 1,
    column: 7,
    end: { line: 1, column: 11 },
  })
})
