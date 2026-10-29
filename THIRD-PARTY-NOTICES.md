# Third-party notices

## AzerothCore

`module/` is an AzerothCore module. It is built by copying it into an
AzerothCore tree as `modules/mod-wrathbench` and compiling it with the core
(`README.md`, "Building the module into a worldserver"); it includes the core's
headers by name and links against the core. AzerothCore's root license is GNU
GPL version 2, and its source headers permit use under GPL version 2 or, at the
recipient's option, a later version. No AzerothCore source is in this
repository. AzerothCore's copyright and licensing are not changed by this
repository's licences (`README.md`, "Licence").

Dependencies pinned in `bun.lock` are fetched from the npm registry at install
time and redistributed by nothing here; each retains its own terms. Blizzard
client files, extracted assets and game text are not distributed in this
repository.
