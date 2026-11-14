/*
 * This file is part of mod-wrathbench, an AzerothCore module.
 * SPDX-License-Identifier: MIT
 *
 * Copyright (c) 2026 Mark Beukers
 * Licensed under the MIT License; see LICENSE in the module's root.
 */

// The rules a lease holds its creates to, run without an AzerothCore tree:
// WbLease.h includes nothing of the core's. Built and run by
// scripts/module-bounds.test.ts; not part of the module (AzerothCore
// compiles src/ only). Prints one line per failed check and exits with their
// count.

#include "WbLease.h"

#include <cstdio>
#include <string>

using namespace WrathBench::LeaseRules;

static int failures = 0;

static void Check(bool ok, char const* what)
{
    if (ok)
        return;
    ++failures;
    std::printf("FAILED: %s\n", what);
}

int main()
{
    Check(SameName("Benchy", "benchy"), "names compare in any case");
    Check(!SameName("Benchy", "Bench"), "a prefix is another name");
    Check(!SameName("Benchy", "Benchz"), "one letter apart is another name");

    {
        // One create, then the binding holds.
        Binding b;
        b.epoch = 7;
        Check(b.Conflict("Alpha") == nullptr, "an unbound lease takes any name");
        Check(b.Reserve("Alpha"), "the first create holds the name");
        b.Settle(7, true);
        Check(b.character == "Alpha", "a success binds");
        Check(b.inFlight == 0 && b.pending.empty(), "the name is let go once settled");
        Check(b.Conflict("ALPHA") == nullptr, "the bound name in another case is the same character");
        Check(b.Conflict("Beta") && *b.Conflict("Beta") == "Alpha", "another name is refused, naming the bound one");
        Check(!b.Reserve("Alpha"), "a bound lease's create holds nothing");
    }
    {
        // Two first creates naming different characters, overlapping: the
        // second is refused while the first is in flight.
        Binding b;
        b.epoch = 1;
        Check(b.Reserve("Alpha"), "the first create holds the name");
        Check(b.Conflict("Beta") && *b.Conflict("Beta") == "Alpha", "an overlapping create naming another is refused");
        Check(b.Conflict("alpha") == nullptr, "an overlapping create naming the same one goes ahead");
        b.Settle(1, true);
        Check(b.character == "Alpha", "the one that went ahead is the one bound");
        Check(b.Conflict("Beta") != nullptr, "and the other stays refused");
    }
    {
        // A refused create binds nothing and lets the name go.
        Binding b;
        b.epoch = 1;
        b.Reserve("Alpha");
        b.Settle(1, false);
        Check(b.character.empty(), "a refused create binds nothing");
        Check(b.Conflict("Beta") == nullptr, "and another name may then be asked");
    }
    {
        // Two creates of the same name: the binding waits for the last, and
        // either one's success binds.
        Binding b;
        b.epoch = 1;
        b.Reserve("Alpha");
        b.Reserve("Alpha");
        b.Settle(1, false);
        Check(b.character.empty() && b.Conflict("Beta") != nullptr, "the name is held while one create is still in flight");
        b.Settle(1, true);
        Check(b.character == "Alpha", "the later success binds");
    }
    {
        // A reset in between: the earlier create cannot touch what follows.
        Binding b;
        b.epoch = 1;
        b.Reserve("Alpha");
        b.Reset(2);
        Check(b.character.empty() && b.inFlight == 0, "a reset starts unbound");
        b.Reserve("Beta");
        b.Settle(1, true);
        Check(b.character.empty() && b.inFlight == 1, "a create from before the reset settles nothing");
        b.Settle(2, true);
        Check(b.character == "Beta", "the create after it binds");
        b.Settle(2, true);
        Check(b.character == "Beta" && b.inFlight == 0, "a settle with nothing in flight changes nothing");
    }

    {
        LoginCount c;
        Check(c.Take(0) && c.Take(1) && c.Take(2), "off by default");
    }
    {
        int64_t const hour = LoginCount::kWindowMs;
        LoginCount c;
        c.perHour = 2;
        Check(c.Take(1000), "the first login");
        Check(c.Take(2000), "the second");
        Check(!c.Take(3000), "the third within the hour is refused");
        Check(!c.Take(1000 + hour - 1), "and still just before the hour is out");
        Check(c.Take(1000 + hour), "the hour from the first is over");
        Check(c.Take(1000 + hour + 5), "a new window has its own count");
        Check(!c.Take(1000 + hour + 10), "which runs out the same way");
        c.perHour = 5;
        Check(c.Take(1000 + hour + 20), "a re-lease's higher limit applies to the window in progress");
        c.perHour = 1;
        Check(!c.Take(1000 + hour + 30), "and a lower one too");
    }

    if (failures == 0)
        std::printf("ok\n");
    return failures;
}
