# Isolate REPL Redeclaration Convenience

## Problem

The persistent REPL uses one worker lexical environment so later cells can refer to earlier top-level bindings. That convenience is not JavaScript's module or function semantics, and mixed old/new destructuring requires a policy for combining declaration and assignment. Keeping that policy inside `internal/cell-analysis.js` makes core parsing and durability analysis depend on one replaceable persistence strategy.

## Decision

`internal/cell-analysis.js` owns cell parsing, binding inventory, durability classification, return rewriting, and execution preparation. Shared binding-pattern traversal lives in `internal/binding-pattern.js`. `internal/repl-convenience.js` owns the optional loose-redeclaration policy, including all-existing replacement and mixed destructuring lowering; it returns executable source, collisions, redeclaration metadata, and rewrite provenance through one narrow function. The current persistent REPL continues to enable this policy, so the user-facing convenience and journal behavior remain unchanged. A future state/frame persistence implementation can replace this policy without changing the cell language analyzer.

## Alternatives considered

**Keep redeclaration lowering in cell analysis.** This keeps calls local, but couples the language analyzer to one REPL implementation and makes a future independent cell scope harder to introduce or verify.

**Delete loose redeclaration convenience.** This would give the smallest semantic surface, but repeated top-level declarations are an intentional PTC Plus workflow and removing them would make ordinary iterative model use less effective.

**Create a full compiler pipeline immediately.** A general destructuring compiler could cover more syntax, but it would add a larger dependency and semantic surface before the persistence boundary is settled. Isolating the existing policy leaves that decision reversible.

## Consequences

The core analyzer has no mixed-redeclaration lowering helpers and can be tested independently of the REPL convenience policy. The compatibility module remains responsible for its custom hybrid semantics and its focused tests; it must not be described as native JavaScript semantics. Future persistence work can introduce fresh cell lexical frames while retaining or replacing the convenience adapter at one explicit boundary.
