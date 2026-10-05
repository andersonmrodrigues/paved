---
name: frontend-performance
description: >-
  Improve perceived load time, interaction responsiveness, visual stability or client payload size. Use when profiling or a user-facing performance budget points to client loading, rendering or interaction.
---

# Frontend performance

## When to use

In the `implementation` phase of a `refactor` or `feature` run that targets performance, once `profiling` has located
the problem on the client side: loading, rendering or responding to input.

## Required context

The baseline measurement and profile from `profiling`. Useful: the technology context
and adapter knowledge for how the client is built and delivered.

## Preconditions

- A baseline measured under realistic conditions: a representative device class and
  network, a cold and a warm load, not only a fast development machine.
- The metric reflects what users perceive, not only total load time.

## Procedure

1. **Name the user-facing metric** that misses its target: time until the main content
   is visible, time until the page responds to input, delay between input and visible
   response, unexpected layout movement.
2. **Split the time** along the path to that moment: waiting for the server, downloading
   resources, executing client code, rendering. Fix the largest part first.
3. **Look for the usual causes**:
   - resources the first view does not need, loaded before it (code, images, fonts);
   - large resources that could be compressed, resized or split;
   - requests made one after another that could run in parallel or be combined;
   - long tasks on the main thread that block input;
   - repeated rendering of content that did not change;
   - space not reserved for content that arrives late, so the layout shifts.
4. **Fix one cause**, then measure again with `profiling`, under the same device and
   network conditions.
5. **Check the other metrics**: deferring a resource can improve one metric and hurt
   another.

## Tools

None. Measurement tools come from `profiling`, adapters or the project.

## Rules

None beyond those that apply by scope.

## Verification

Required: `performance`. Recommended: `e2e`, to show the flows still work after loading
order changed.

## Evidence

Baseline and result measurements with device class, network conditions and cache state.

## Completion criteria

- The user-facing metric meets its target under the conditions of the baseline.
- No other tracked metric got worse beyond its variance.

## Failure modes

| Failure | Signal | Response |
|---|---|---|
| Fast machine only | Gains vanish on the representative device | Re-measure under realistic conditions |
| Metric traded | One metric improves, another regresses | Balance, or report the trade-off to a human |
| Broken flow | Deferred code is missing when a user needs it | Restore the order; test the flow |
| Warm cache only | Improvement exists only on repeat visits | Measure cold loads too |

## References

None.
