# Party Lab local combat

Phase 3C replaces the Phase 3B upright-capsule prototype. See [RAGDOLL.md](RAGDOLL.md)
for the current architecture, controls, tuning, checks, performance, and limitations.

There is only one local combat system. The old single-target `Grabs`, abstract
cone punch, instant heave impulse, and upright-only stun implementation are gone.
`grabbing.ts` and `stun.ts` were removed; their replacements live in `combat/`.
`combat.ts` remains the fixed-step coordinator, not a second gameplay mode.

The landing page and Phase 4A online room/chat code remain separate and unchanged.
No ragdoll, pose, punch, or grip state is sent over the network.
