/*
 * This file is part of mod-wrathbench, an AzerothCore module.
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program. If not, see <http://www.gnu.org/licenses/>.
 */

// Tiny self-contained JSON. The module's wire shapes are small and flat, so a
// hand-rolled builder plus a minimal parser is less total risk than wiring a
// Boost.JSON link mode into AzerothCore's module build (see ADR-0009). Not a
// general JSON library: enough for module/PROTOCOL.md and nothing more.

#ifndef MOD_WRATHBENCH_WBJSON_H
#define MOD_WRATHBENCH_WBJSON_H

#include <cstdint>
#include <map>
#include <sstream>
#include <string>

namespace WrathBench::Json
{
    // ------------------------------------------------------------- building
    inline std::string Escape(std::string_view s)
    {
        std::string out;
        out.reserve(s.size() + 2);
        for (char c : s)
        {
            switch (c)
            {
                case '"':  out += "\\\""; break;
                case '\\': out += "\\\\"; break;
                case '\n': out += "\\n";  break;
                case '\r': out += "\\r";  break;
                case '\t': out += "\\t";  break;
                default:
                    if (static_cast<unsigned char>(c) < 0x20)
                    {
                        char buf[8];
                        std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                        out += buf;
                    }
                    else
                        out += c;
            }
        }
        return out;
    }

    inline std::string Str(std::string_view s) { return "\"" + Escape(s) + "\""; }

    // Incremental object writer: Writer w; w.Add("k", v); ... w.Str().
    class Writer
    {
    public:
        Writer& Key(std::string_view k)
        {
            if (_count++) _ss << ',';
            _ss << '"' << Escape(k) << "\":";
            return *this;
        }
        Writer& Add(std::string_view k, std::string_view v) { Key(k); _ss << '"' << Escape(v) << '"'; return *this; }
        Writer& Add(std::string_view k, const char* v) { return Add(k, std::string_view(v)); }
        Writer& Add(std::string_view k, bool v) { Key(k); _ss << (v ? "true" : "false"); return *this; }
        Writer& Add(std::string_view k, int64_t v) { Key(k); _ss << v; return *this; }
        Writer& Add(std::string_view k, uint64_t v) { Key(k); _ss << v; return *this; }
        Writer& Add(std::string_view k, int32_t v) { Key(k); _ss << v; return *this; }
        Writer& Add(std::string_view k, uint32_t v) { Key(k); _ss << v; return *this; }
        Writer& Add(std::string_view k, double v) { Key(k); _ss << v; return *this; }
        // Raw: value already valid JSON (nested object/array).
        Writer& Raw(std::string_view k, std::string_view rawJson) { Key(k); _ss << rawJson; return *this; }
        // Guids (and any u64 that can exceed 2^53) go on the wire as decimal
        // strings: 3.3.5a guids carry a high part (e.g. 0xF130...) that JSON
        // consumers backed by IEEE doubles would silently corrupt.
        Writer& AddGuid(std::string_view k, uint64_t v) { Key(k); _ss << '"' << v << '"'; return *this; }

        std::string Str() const { return "{" + _ss.str() + "}"; }

    private:
        std::ostringstream _ss;
        int _count{0};
    };

    // ------------------------------------------------------------- parsing
    // Minimal parser: objects, strings, numbers, bools, null. Flat is all the
    // request bodies need; nested values parse but are stored as raw strings.
    class Value
    {
    public:
        bool IsObject() const { return _isObject; }
        bool Has(std::string const& k) const { return _obj.find(k) != _obj.end(); }
        std::string GetString(std::string const& k, std::string const& dflt = "") const
        {
            auto it = _obj.find(k);
            return it == _obj.end() ? dflt : it->second;
        }
        // Numbers are stored as their textual form; convert on demand.
        int64_t GetInt(std::string const& k, int64_t dflt = 0) const
        {
            auto it = _obj.find(k);
            if (it == _obj.end() || it->second.empty()) return dflt;
            try { return std::stoll(it->second); } catch (...) { return dflt; }
        }

        double GetDouble(std::string const& k, double dflt = 0.0) const
        {
            auto it = _obj.find(k);
            if (it == _obj.end() || it->second.empty()) return dflt;
            try { return std::stod(it->second); } catch (...) { return dflt; }
        }

        std::map<std::string, std::string> const& Members() const { return _obj; }

        bool _isObject{false};
        std::map<std::string, std::string> _obj;
    };

    namespace detail
    {
        inline void SkipWs(std::string const& s, size_t& i)
        {
            while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) ++i;
        }

        inline bool ParseString(std::string const& s, size_t& i, std::string& out)
        {
            if (i >= s.size() || s[i] != '"') return false;
            ++i;
            out.clear();
            while (i < s.size())
            {
                char c = s[i++];
                if (c == '"') return true;
                if (c == '\\' && i < s.size())
                {
                    char e = s[i++];
                    switch (e)
                    {
                        case '"': out += '"'; break;
                        case '\\': out += '\\'; break;
                        case '/': out += '/'; break;
                        case 'n': out += '\n'; break;
                        case 'r': out += '\r'; break;
                        case 't': out += '\t'; break;
                        case 'b': out += '\b'; break;
                        case 'f': out += '\f'; break;
                        case 'u':
                            if (i + 4 <= s.size())
                            {
                                // Minimal: decode BMP codepoint to UTF-8. Adequate
                                // for the ASCII the SDK sends; not a full decoder.
                                unsigned cp = std::stoul(s.substr(i, 4), nullptr, 16);
                                i += 4;
                                if (cp < 0x80) out += char(cp);
                                else if (cp < 0x800) { out += char(0xC0 | (cp >> 6)); out += char(0x80 | (cp & 0x3F)); }
                                else { out += char(0xE0 | (cp >> 12)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
                            }
                            break;
                        default: out += e; break;
                    }
                }
                else
                    out += c;
            }
            return false;
        }

        // Consume a raw value's text (for nested/array/number/bool/null), storing it verbatim.
        inline bool ParseRaw(std::string const& s, size_t& i, std::string& out)
        {
            SkipWs(s, i);
            if (i >= s.size()) return false;
            if (s[i] == '"') return ParseString(s, i, out);
            if (s[i] == '{' || s[i] == '[')
            {
                char open = s[i], close = open == '{' ? '}' : ']';
                int depth = 0;
                size_t start = i;
                bool inStr = false;
                for (; i < s.size(); ++i)
                {
                    char c = s[i];
                    if (inStr) { if (c == '\\') ++i; else if (c == '"') inStr = false; continue; }
                    if (c == '"') inStr = true;
                    else if (c == open) ++depth;
                    else if (c == close) { if (--depth == 0) { ++i; out = s.substr(start, i - start); return true; } }
                }
                return false;
            }
            // number / true / false / null
            size_t start = i;
            while (i < s.size() && s[i] != ',' && s[i] != '}' && s[i] != ']' &&
                   s[i] != ' ' && s[i] != '\t' && s[i] != '\n' && s[i] != '\r') ++i;
            out = s.substr(start, i - start);
            return !out.empty();
        }
    }

    inline Value Parse(std::string const& s)
    {
        Value v;
        size_t i = 0;
        detail::SkipWs(s, i);
        if (i >= s.size() || s[i] != '{') return v; // not an object
        ++i;
        v._isObject = true;
        for (;;)
        {
            detail::SkipWs(s, i);
            if (i < s.size() && s[i] == '}') { ++i; break; }
            std::string key;
            if (!detail::ParseString(s, i, key)) break;
            detail::SkipWs(s, i);
            if (i >= s.size() || s[i] != ':') break;
            ++i;
            std::string val;
            if (!detail::ParseRaw(s, i, val)) break;
            v._obj[key] = val;
            detail::SkipWs(s, i);
            if (i < s.size() && s[i] == ',') { ++i; continue; }
            detail::SkipWs(s, i);
            if (i < s.size() && s[i] == '}') { ++i; break; }
            break;
        }
        return v;
    }
}

#endif // MOD_WRATHBENCH_WBJSON_H
