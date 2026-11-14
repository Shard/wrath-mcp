/*
 * This file is part of mod-wrathbench, an AzerothCore module.
 * SPDX-License-Identifier: MIT
 *
 * Copyright (c) 2026 Mark Beukers
 * Licensed under the MIT License; see LICENSE in the module's root.
 */

// The bounds on what one request may ask of the world thread or of the audit
// log, as arithmetic with no core type in it: a caller shapes every number
// and string an action carries, and each is held to a fixed limit before
// anything loops over it or writes it. Core-free so that the limits can be
// compiled and run without an AzerothCore tree (module/test/bounds.cpp).

#ifndef MOD_WRATHBENCH_WBBOUNDS_H
#define MOD_WRATHBENCH_WBBOUNDS_H

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

namespace WrathBench::Bounds
{
    // The largest magnitude a position axis or a facing may have on the wire.
    // The core's own ceiling for a height (MAX_HEIGHT), several times a map's
    // span in x and y, and far inside a float: a number past it names no
    // place, and one that is not finite passes every range test made of it
    // (each comparison is false).
    inline constexpr double kFieldLimit = 100000.0;

    // Judged as the double the body parsed to, before any narrowing: 1e39 is
    // a finite double and an infinite float.
    inline bool FieldOk(double v)
    {
        return std::isfinite(v) && std::fabs(v) <= kFieldLimit;
    }

    // How far one move reaches from where the mover stands: across (x and y
    // together), and up or down on a leg that goes to the z asked for rather
    // than to the ground the mesh finds there (a flown leg).
    inline constexpr float kMoveReachYards = 250.0f;
    // The straight leg onto or off a transport, across and up or down; a
    // longer one goes through the mesh.
    inline constexpr float kTransportLegYards = 30.0f;

    inline bool WithinReach(float from, float to, float reach)
    {
        return std::fabs(to - from) <= reach;
    }

    // The most samples one planned line or one route's estimate may take.
    // Each is a terrain or water read, some a line-of-sight query, made on
    // the world thread while every other session waits. A flown leg inside
    // kMoveReachYards on both counts needs under 90 of them.
    inline constexpr uint32_t kSamplesMax = 256;

    // The samples a stretch `len` yards long takes at one per `every` yards:
    // at least one, never more than `max`, whatever `len` is (a length that
    // is not finite takes `max`).
    inline uint32_t Samples(float len, float every, uint32_t max = kSamplesMax)
    {
        if (max == 0)
            return 0;
        if (!(len > 0.0f))
            return 1;
        if (!(len < every * float(max)))
            return max;
        uint32_t const n = uint32_t(std::ceil(len / every));
        return n < 1 ? 1 : (n > max ? max : n);
    }

    // The longest caller-written text an audit record carries, in bytes: what
    // the core accepts as a line of chat. A longer one is cut here and its
    // full length recorded beside it (AuditText's caller), so a record's size
    // never follows the request's.
    inline constexpr std::size_t kAuditTextMax = 255;

    // `text` cut to at most `max` bytes, on a UTF-8 character boundary.
    inline std::string AuditText(std::string_view text, std::size_t max = kAuditTextMax)
    {
        if (text.size() <= max)
            return std::string(text);
        std::size_t cut = max;
        // Back off continuation bytes (10xxxxxx) so no character is split.
        while (cut > 0 && (static_cast<unsigned char>(text[cut]) & 0xC0) == 0x80)
            --cut;
        return std::string(text.substr(0, cut));
    }
}

#endif // MOD_WRATHBENCH_WBBOUNDS_H
