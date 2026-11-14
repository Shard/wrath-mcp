/*
 * This file is part of mod-wrathbench, an AzerothCore module.
 * SPDX-License-Identifier: MIT
 *
 * Copyright (c) 2026 Mark Beukers
 * Licensed under the MIT License; see LICENSE in the module's root.
 */

// The module's request bounds, run without an AzerothCore tree: WbBounds.h
// and WbJson.h include nothing of the core's. Built and run by
// scripts/module-bounds.test.ts; not part of the module (AzerothCore
// compiles src/ only). Prints one line per failed check and exits with their
// count.

#include "WbBounds.h"
#include "WbJson.h"

#include <cstdio>
#include <limits>
#include <string>

using namespace WrathBench;

static int failures = 0;

static void Check(bool ok, char const* what)
{
    if (ok)
        return;
    ++failures;
    std::printf("FAILED: %s\n", what);
}

// A body's number as HttpAction reads it.
static double Field(char const* body, char const* key)
{
    return Json::Parse(body).GetDouble(key);
}

int main()
{
    // A position axis or a facing: finite, within the limit, judged as the
    // double the body carried.
    Check(Bounds::FieldOk(0.0), "0 is a coordinate");
    Check(Bounds::FieldOk(-8913.2), "an ordinary coordinate");
    Check(Bounds::FieldOk(Bounds::kFieldLimit), "the limit itself");
    Check(Bounds::FieldOk(-Bounds::kFieldLimit), "the limit itself, negative");
    Check(!Bounds::FieldOk(Bounds::kFieldLimit + 1.0), "one past the limit");
    Check(!Bounds::FieldOk(std::numeric_limits<double>::quiet_NaN()), "NaN");
    Check(!Bounds::FieldOk(std::numeric_limits<double>::infinity()), "infinity");
    Check(!Bounds::FieldOk(-std::numeric_limits<double>::infinity()), "-infinity");
    // The bodies that reached the planner before: each parses, none is NaN.
    Check(!Bounds::FieldOk(Field(R"({"z":17000000000})", "z")), "z 1.7e10");
    Check(!Bounds::FieldOk(Field(R"({"z":1e39})", "z")), "z 1e39, a finite double and an infinite float");
    Check(!Bounds::FieldOk(Field(R"({"z":"1e39"})", "z")), "z as the string 1e39");
    Check(!Bounds::FieldOk(Field(R"({"z":inf})", "z")), "z inf");
    Check(!Bounds::FieldOk(Field(R"({"z":-Infinity})", "z")), "z -Infinity");
    Check(!Bounds::FieldOk(Field(R"({"z":nan})", "z")), "z nan");
    // Text the reader cannot make a double of reads as 0, as an absent field
    // does: never as a number out of range.
    Check(Field(R"({"orientation":1e400})", "orientation") == 0.0, "a number past a double reads as 0");
    Check(Field(R"({"z":null})", "z") == 0.0, "null reads as 0");
    Check(Bounds::FieldOk(Field(R"({"z":84.5})", "z")), "z 84.5");
    Check(Bounds::FieldOk(Field(R"({"orientation":-3.14159})", "orientation")), "a negative facing");

    // A move's reach, across and in height.
    Check(Bounds::kMoveReachYards == 250.0f, "one move reaches 250 yards");
    Check(Bounds::kTransportLegYards == 30.0f, "a transport leg reaches 30 yards");
    Check(Bounds::WithinReach(100.0f, 350.0f, Bounds::kMoveReachYards), "250 up is within reach");
    Check(Bounds::WithinReach(100.0f, -150.0f, Bounds::kMoveReachYards), "250 down is within reach");
    Check(!Bounds::WithinReach(100.0f, 350.5f, Bounds::kMoveReachYards), "250.5 up is not");
    Check(!Bounds::WithinReach(100.0f, 100000.0f, Bounds::kMoveReachYards), "the field limit is not");
    Check(!Bounds::WithinReach(100.0f, std::numeric_limits<float>::quiet_NaN(), Bounds::kMoveReachYards),
        "NaN is not within reach");
    Check(!Bounds::WithinReach(100.0f, std::numeric_limits<float>::infinity(), Bounds::kMoveReachYards),
        "infinity is not within reach");

    // Samples along a line: one at least, the bound at most, whatever the
    // length. The longest flown leg a move's reach lets through (250 across,
    // 250 up) at one per 4 yards is well under the bound.
    Check(Bounds::kSamplesMax == 256, "256 samples at most");
    Check(Bounds::Samples(0.0f, 4.0f) == 1, "no length, one sample");
    Check(Bounds::Samples(-1.0f, 4.0f) == 1, "a negative length, one sample");
    Check(Bounds::Samples(3.9f, 4.0f) == 1, "under one stretch");
    Check(Bounds::Samples(4.1f, 4.0f) == 2, "just over one stretch");
    Check(Bounds::Samples(353.6f, 4.0f) == 89, "the longest leg within reach");
    Check(Bounds::Samples(1024.0f, 4.0f) == 256, "exactly the bound");
    Check(Bounds::Samples(1.7e10f, 4.0f) == 256, "1.7e10 yards");
    Check(Bounds::Samples(std::numeric_limits<float>::max(), 4.0f) == 256, "the largest float");
    Check(Bounds::Samples(std::numeric_limits<float>::infinity(), 4.0f) == 256, "an infinite length");
    Check(Bounds::Samples(std::numeric_limits<float>::quiet_NaN(), 4.0f) == 1, "a length that is not a number");
    Check(Bounds::Samples(100.0f, 5.0f, 7) == 7, "a smaller budget");
    Check(Bounds::Samples(100.0f, 5.0f, 0) == 0, "a spent budget");

    // Audit text: never longer than the bound, never a split character.
    Check(Bounds::kAuditTextMax == 255, "255 bytes of caller text in a record");
    Check(Bounds::AuditText("hello") == "hello", "short text is kept whole");
    Check(Bounds::AuditText(std::string(255, 'a')).size() == 255, "255 bytes are kept whole");
    Check(Bounds::AuditText(std::string(256, 'a')).size() == 255, "256 bytes are cut to 255");
    Check(Bounds::AuditText(std::string(64 * 1024, 'a')).size() == 255, "a whole body of text is cut to 255");
    {
        // 127 two-byte characters fill 254 bytes; the next starts at 254 and
        // would be split at 255.
        std::string text;
        for (int i = 0; i < 200; ++i)
            text += "\xC3\xA9";
        std::string const cut = Bounds::AuditText(text);
        Check(cut.size() == 254, "a two-byte character is not split");
        Check((static_cast<unsigned char>(cut.back()) & 0xC0) == 0x80, "the cut ends on a whole character");
    }
    {
        std::string const cut = Bounds::AuditText(std::string(300, '\x80'));
        Check(cut.size() <= 255, "continuation bytes alone still end within the bound");
    }

    if (failures == 0)
        std::printf("ok\n");
    return failures;
}
