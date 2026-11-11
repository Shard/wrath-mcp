/**
 * Point `solid-js` at the reactive build, for every inspector test.
 *
 * `bun test` resolves the bare specifier under the node condition, which is
 * Solid's server build: its effects run once and its signals never notify. A
 * test of the map's fit (`views/lib/mapfit.ts`) against it would not test the
 * graph at all, so the browser build has to stand behind the name the views
 * import.
 *
 * A preload rather than a `mock.module` in the test file, because resolution
 * happens once per process: any earlier test whose subject imports Solid would
 * pin the server build, and the redirect would silently lose. Registered in
 * `bunfig.toml` at the repository root and in `inspector/`, because bun reads
 * its config from the working directory and the suite runs from both. A
 * harness that runs this suite from its own root installs the same redirect
 * (WrathBench's `dashboard/test/preload-solid.ts`).
 */

import { mock } from "bun:test";

/* Through a variable, because the package's exports declare no types for its
   dist entry; what the views see is still typed by the bare name. */
const reactiveBuild = "solid-js/dist/solid.js";
const reactive = (await import(reactiveBuild)) as typeof import("solid-js");
mock.module("solid-js", () => reactive);
