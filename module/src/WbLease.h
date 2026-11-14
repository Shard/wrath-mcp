/*
 * This file is part of mod-wrathbench, an AzerothCore module.
 * SPDX-License-Identifier: MIT
 *
 * Copyright (c) 2026 Mark Beukers
 * Licensed under the MIT License; see LICENSE in the module's root.
 */

// What a lease decides about the creates made under it, as state with no core
// type in it: which character its token is bound to, and how many logins it
// has had this hour. The Manager keeps one of each in every lease and calls
// them under the lock that guards the lease, so a check and what it records
// are one step. Core-free so that the rules can be compiled and run without an
// AzerothCore tree (module/test/lease.cpp).

#ifndef MOD_WRATHBENCH_WBLEASE_H
#define MOD_WRATHBENCH_WBLEASE_H

#include <cstdint>
#include <string>
#include <string_view>

namespace WrathBench::LeaseRules
{
    // Character names compare as the core compares them: ASCII, any case.
    inline bool SameName(std::string_view a, std::string_view b)
    {
        if (a.size() != b.size())
            return false;
        for (size_t i = 0; i < a.size(); ++i)
        {
            char x = a[i], y = b[i];
            if (x >= 'A' && x <= 'Z') x = char(x - 'A' + 'a');
            if (y >= 'A' && y <= 'Z') y = char(y - 'A' + 'a');
            if (x != y)
                return false;
        }
        return true;
    }

    // The character a lease's token plays (PROTOCOL.md, "Authentication").
    // The first create that succeeds binds it; a create the core refused
    // binds nothing. While a create is in flight on an unbound lease, the
    // name it asked for is held: a create naming another character is
    // refused as if the lease were bound to it, so two first creates that
    // overlap cannot both go ahead and leave the token playing one character
    // and bound to the other.
    struct Binding
    {
        std::string character;      // empty until the first successful create
        std::string pending;        // unbound: the name the creates in flight ask for
        uint32_t inFlight{0};       // creates in flight under `pending`
        // Which binding this is: given afresh (from a counter the caller
        // keeps across every lease) when the lease is made and whenever it is
        // reset, so that a create admitted before cannot settle the state
        // after, nor a released lease's create the token's next lease.
        uint64_t epoch{0};

        // The name a create asking for `name` collides with, or nullptr when
        // it may go ahead.
        std::string const* Conflict(std::string_view name) const
        {
            if (!character.empty())
                return SameName(name, character) ? nullptr : &character;
            if (inFlight && !SameName(name, pending))
                return &pending;
            return nullptr;
        }

        // Admit a create Conflict() let through. True when it holds the name
        // (the lease is unbound) and must Settle() when its reply is known.
        bool Reserve(std::string_view name)
        {
            if (!character.empty())
                return false;
            if (inFlight++ == 0)
                pending = std::string(name);
            return true;
        }

        // A create Reserve() admitted under `atEpoch` has its reply. Only a
        // success binds; the name is let go with the last create holding it.
        void Settle(uint64_t atEpoch, bool succeeded)
        {
            if (atEpoch != epoch || inFlight == 0)
                return;
            if (succeeded && character.empty())
                character = pending;
            if (--inFlight == 0)
                pending.clear();
        }

        // The token starts unbound (re-leased onto another account).
        void Reset(uint64_t newEpoch)
        {
            character.clear();
            pending.clear();
            inFlight = 0;
            epoch = newEpoch;
        }
    };

    // Logins under one lease, against the per-hour limit its POST /lease
    // stated (0 is off). Every create the lease admits is one, whatever the
    // core then answers: each is a login flow on the world thread. Counted in
    // windows of an hour from the first login of each.
    struct LoginCount
    {
        static constexpr int64_t kWindowMs = 3600 * 1000;

        uint32_t perHour{0};
        int64_t windowAtMs{0};
        uint32_t inWindow{0};

        // Count one login at nowMs (a steady clock), or refuse it.
        bool Take(int64_t nowMs)
        {
            if (!perHour)
                return true;
            if (inWindow == 0 || nowMs - windowAtMs >= kWindowMs)
            {
                windowAtMs = nowMs;
                inWindow = 0;
            }
            if (inWindow >= perHour)
                return false;
            ++inWindow;
            return true;
        }
    };
}

#endif // MOD_WRATHBENCH_WBLEASE_H
