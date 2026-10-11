# SoL-Pi → opencode: efficiency transfer

This repository captures the research and implementation work for transferring the
efficiency concepts of [NVlabs/SoL-Pi](https://github.com/NVlabs/SoL-Pi) — four
token-efficiency mechanisms for coding-agent harnesses (Action Fusion,
ObservationPack, Evidence-Preserving Reducer, Online Context Compact) discovered
via scaled auto-research loops — into the coding agent **opencode**. The goal is
to make long-running opencode sessions cheaper (fewer model turns, less context
replay, smaller observations) without reducing the work or evidence the agent
needs to finish a task. Work targets opencode 1.x and 2.x, with opencode 1.x
first. `docs/research/` holds source research; `docs/plan/` holds the
implementation plan.
