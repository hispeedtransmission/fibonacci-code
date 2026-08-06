# Fibonacci product thesis

## The job

Fibonacci is for engineers who live in a terminal and want a coding agent to feel
like a precise instrument rather than a debug console. Its single job is to make
the agent's state, action, and result continuously understandable without putting
the machinery in the user's way.

## Principles

1. **One surface, three layers.** Conversation is primary, activity is compact,
   and diagnostics stay folded until they are useful.
2. **State must be visible.** Ready, thinking, acting, stopped, and failed are
   distinct in language, color, and motion.
3. **Keyboard complete.** Every important action is reachable without leaving the
   composer.
4. **Provider details stop at the core.** The interface speaks Fibonacci's event
   vocabulary, not a provider's wire format.
5. **Trust is displayed, never implied.** The active provider, model, workspace,
   and sandbox mode remain visible.

## Visual identity

Fibonacci borrows from mathematical traces, neuroimaging workstations, CRT
material, and cinematic machine rooms. The result is cyberpunk through function:
every high-contrast element identifies state, trust, location, or control. It does
not imitate a medical device or add fake clinical telemetry.

- **Void** `#09111B`: the intended environmental dark when the terminal permits it.
- **Phosphor bone** `#F2EDE2`: primary transcript text.
- **Surgical cyan** `#62D9FF`: links, live traces, and machine activity.
- **Incision orange** `#FF6B35`: user intent, armed input, and active changes.
- **Verified green** `#8EF0B0`: ready state and completed checks.
- **Fault red** `#FF496C`: failed actions and unrecovered errors.
- **Telemetry steel** `#6F8197`: metadata, inactive structure, and folded detail.
- **Warning amber** `#FFC857`: stopped work and recoverable attention.

Terminal typography inherits the user's monospace face. Hierarchy comes from
weight, case, spacing, box-drawing, and inverse video: an uppercase instrument
identity, plain sentence-case instructions, and compact telemetry labels.

The signature element is the live sequence rail:

```text
TRACE 07/07  01━01━02━03━05━08━13
```

Its numeric position, stroke weight, color, and pulse communicate run phase. The
sequence is structural—the agent's work accumulates from intent through inspection
and action to verification. The surrounding HUD exposes provider/model (`LINK`),
sandbox (`FIELD`), working directory (`SITE`), and session (`SESSION`). Transcript
labels (`YOU//`, `FIB//`, `TRACE`, `LIVE`, `PASS`, `WARN`, and `FAULT`) preserve
the same state vocabulary in text and color. The transcript remains unboxed; only
the trust header and input channel form instrument panels.

## MVP boundary

The first slice supports one working directory, one Codex-backed session, streamed
normalized events, cancellation, transcript clearing, session reset, model
selection, deterministic offline showcase rendering, and a tested protocol core.

Not in the first slice: direct provider authentication, multiplexed agents,
extension loading, remote execution, voice, or a full session browser.
