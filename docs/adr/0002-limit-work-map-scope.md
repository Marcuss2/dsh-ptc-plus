# Limit Work Map Scope

PTC Plus exposes only the REPL facts represented by its runtime contracts: structured diagnostics, durable/volatile state, named states, capability metadata, leases, settlement, and replay evidence. It does not implement a Work Map, dynamic model-context materialization, semantic sidecar, or second session coordinator. Those features require upstream aggregation across goals, jobs, effects, and artifacts.
