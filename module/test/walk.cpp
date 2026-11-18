/*
 * This file is part of mod-wrathbench, an AzerothCore module.
 * SPDX-License-Identifier: MIT
 *
 * Copyright (c) 2026 Mark Beukers
 * Licensed under the MIT License; see LICENSE in the module's root.
 */

// The walker's clock against its drift guard, run without an AzerothCore
// tree: WbWalk.h includes nothing of the core's. Built and run by
// scripts/module-route.test.ts; not part of the module (AzerothCore compiles
// src/ only). Prints one line per failed check and exits with their count.

#include "WbWalk.h"

#include <cstdint>
#include <cstdio>
#include <functional>

using namespace WrathBench;

static int failures = 0;

static void Check(bool ok, char const* what)
{
    if (ok)
        return;
    ++failures;
    std::printf("FAILED: %s\n", what);
}

// The fastest the character's own walk goes on the ground: an epic mount's
// +100% on the 7y/s run (14y/s) with the largest mounted-speed bonus on top
// (Crusader Aura's +20%), rounded up.
static constexpr float FASTEST_GROUND_PACE = 17.0f;

struct Outcome
{
    float worstLead{0};   // the largest gap a drift check saw, yards
    float walked{0};      // how far the walker went, yards
    bool interrupted{false};
};

// TickMover's order over a straight route that never ends: each world tick
// advances the walker by `step(elapsed)` at `pace`, and once a heartbeat
// falls due the drift guard compares the walker with the server, whose
// position is the last heartbeat's, then the heartbeat goes out. Ticks are
// `tickMs` apart over `totalMs`; one tick, the first at or after `stallAtMs`,
// comes `stallMs` late instead, the world having had no update in between.
// At `joltAtMs` the server moves the character `joltYards` back off the route
// (a knockback, a correction).
static Outcome Simulate(float pace, bool paced, int64_t tickMs, int64_t totalMs, int64_t stallAtMs, int64_t stallMs,
    std::function<int64_t(int64_t)> const& step = Walk::StepMs, int64_t joltAtMs = -1, float joltYards = 0.0f)
{
    Outcome o;
    float const tolerance = Walk::DriftTolerance(paced, pace);
    float walker = 0.0f, server = 0.0f;
    int64_t now = 0, last = 0, lastPacket = 0;
    bool stalled = stallMs <= 0;
    while (now < totalMs)
    {
        now += tickMs;
        if (!stalled && now >= stallAtMs)
        {
            now += stallMs;
            stalled = true;
        }
        int64_t const elapsed = now - last;
        last = now;
        walker += pace * float(step(elapsed)) / 1000.0f;
        if (joltAtMs >= 0 && now >= joltAtMs)
        {
            server -= joltYards;
            joltAtMs = -1;
        }
        if (now - lastPacket >= Walk::HEARTBEAT_MS)
        {
            float const lead = walker - server;
            if (lead > o.worstLead)
                o.worstLead = lead;
            if (lead > tolerance)
            {
                o.interrupted = true;
                break;
            }
            server = walker;
            lastPacket = now;
        }
    }
    o.walked = walker;
    return o;
}

static int64_t Unclamped(int64_t elapsed) { return elapsed > 0 ? elapsed : 0; }

static void Clock()
{
    Check(Walk::StepMs(50) == 50, "an ordinary tick advances the walker by its own length");
    Check(Walk::StepMs(Walk::STEP_MAX_MS) == Walk::STEP_MAX_MS, "a tick of the cap is whole");
    Check(Walk::StepMs(3000) == Walk::STEP_MAX_MS, "a 3s stall advances the walker by the cap alone");
    Check(Walk::StepMs(0) == 0 && Walk::StepMs(-40) == 0, "a clock that stood or stepped back advances nothing");
    Check(Walk::StallMs(50) == 0, "an ordinary tick holds no stall");
    Check(Walk::StallMs(3000) == 3000 - Walk::STEP_MAX_MS, "a 3s stall is the time the walker did not advance");
    Check(Walk::StallMs(-40) == 0, "a clock that stepped back is no stall");
    for (int64_t e : { int64_t(1), int64_t(249), int64_t(250), int64_t(251), int64_t(9000) })
        Check(Walk::StepMs(e) + Walk::StallMs(e) == e, "every tick is split into the walker's step and the stall");
}

static void Budget()
{
    // The worst lead after a stall is a heartbeat's interval walked (the
    // heartbeat is due once that much has passed) plus one capped step, and
    // it must sit inside the own walk's 15y at any ground pace.
    float const worst = FASTEST_GROUND_PACE * float(Walk::HEARTBEAT_MS + Walk::STEP_MAX_MS) / 1000.0f;
    Check(worst < Walk::OWN_DRIFT_YARDS, "a heartbeat plus a capped step at the fastest ground pace stays inside 15y");
    // A flight's or another unit's tolerance follows its pace, 0.8s of it
    // plus 10y: a heartbeat plus a step is 0.75s, inside it at any pace.
    for (float pace : { 7.0f, 14.0f, 26.6f, 40.0f, 80.0f })
        Check(pace * float(Walk::HEARTBEAT_MS + Walk::STEP_MAX_MS) / 1000.0f < Walk::DriftTolerance(true, pace),
            "a paced walk's tolerance covers a heartbeat plus a capped step");
    Check(Walk::DriftTolerance(false, 40.0f) == Walk::OWN_DRIFT_YARDS, "the own walk keeps 15y at any pace");
    Check(Walk::DriftTolerance(true, 1.0f) == Walk::OWN_DRIFT_YARDS, "a slow paced walk is never under 15y");
}

static void Stall()
{
    // The smoke's walk: run speed, a 3s stall mid-route. Without the cap the
    // walker stood 21y ahead and the guard ended the walk; with it the walk
    // goes on.
    Outcome const before = Simulate(7.0f, false, 50, 10000, 2400, 3000, Unclamped);
    Check(before.interrupted, "unclamped, a 3s stall at run speed trips the 15y guard (the bug)");
    Outcome const after = Simulate(7.0f, false, 50, 10000, 2400, 3000);
    Check(!after.interrupted, "clamped, a 3s stall at run speed does not end the walk");

    // Every phase of the heartbeat interval, every world tick length up to
    // the cap, stalls from just over the cap to ten seconds, at run, mount
    // and the fastest ground pace on the own walk, and at flight paces on a
    // paced one: no stall ends a walk.
    for (int64_t tick : { int64_t(10), int64_t(50), int64_t(100), int64_t(250) })
        for (int64_t at = 1000; at < 1000 + Walk::HEARTBEAT_MS + tick; at += 10)
            for (int64_t stall : { int64_t(300), int64_t(2000), int64_t(3000), int64_t(10000) })
            {
                for (float pace : { 7.0f, 14.0f, FASTEST_GROUND_PACE })
                    Check(!Simulate(pace, false, tick, at + stall + 2000, at, stall).interrupted,
                        "a stall never ends the own walk on the ground");
                for (float pace : { 26.6f, 60.0f })
                    Check(!Simulate(pace, true, tick, at + stall + 2000, at, stall).interrupted,
                        "a stall never ends a flight");
            }

    // A stall delays the walk by its length: the walker covers what the time
    // it was given covers, the stall's time beyond the cap added nothing.
    Outcome const steady = Simulate(7.0f, false, 50, 10000, 0, 0);
    Check(steady.walked > 69.9f && steady.walked < 70.1f, "an ordinary walk covers its pace over its time");
    // The stall is the tick at 2400ms arriving 3s late: 3050ms elapsed.
    float const expected = 7.0f * float(10000 - Walk::StallMs(3050)) / 1000.0f;
    Check(after.walked > expected - 0.1f && after.walked < expected + 0.1f,
        "a stalled walk covers its time less the stall");

    // The guard still sees a real interruption: the server putting the
    // character 12y off the walker's point is caught at the next heartbeat,
    // with or without a stall before it; a few yards' correction is not.
    Check(Simulate(7.0f, false, 50, 10000, 0, 0, Walk::StepMs, 3020, 12.0f).interrupted,
        "a 12y knockback ends the walk");
    Check(Simulate(7.0f, false, 50, 10000, 2400, 3000, Walk::StepMs, 6020, 12.0f).interrupted,
        "a 12y knockback after a stall ends the walk");
    Check(!Simulate(7.0f, false, 50, 10000, 0, 0, Walk::StepMs, 3020, 3.0f).interrupted,
        "a 3y correction does not");
}

int main()
{
    Clock();
    Budget();
    Stall();
    if (failures == 0)
        std::printf("ok\n");
    return failures;
}
