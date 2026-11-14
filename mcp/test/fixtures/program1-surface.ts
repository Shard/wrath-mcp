/**
 * What a program's model is served at fan-out 1, as one JSON value: the
 * program tools as the plain render serves them (definition, the parameter
 * restatement a refusal ends with, the alias keys), the routine lines for a
 * fixed set of rows, and the sandbox's restart text for a program.
 * `program1-identity.test.ts` holds it byte for byte to
 * `program1-surface.json`, written before a program could run at fan-out
 * above 1, so that capability existing changes nothing for one character.
 */

import { PLAIN_RENDER } from "../../src/main";
import { STATE_LOSS_RECOVERY_PROGRAM } from "../../src/sandbox/host";
import { renderRoutines, routineDetailKey, type RoutineRow } from "../../src/sandbox/program-host";
import { programTools, type CoreToolRender, type ProgramToolContext } from "../../src/tools";

const NOW = 1_700_000_600_000;

/** One row of each state, as a single character's registry holds them. */
export const PROGRAM1_ROWS: RoutineRow[] = [
  { name: "grind", deploy: 7, startedAt: NOW - 720_000, state: "running", lastAction: { action: "cast_spell", ts: NOW - 3_000 } },
  { name: "idle", deploy: 7, startedAt: NOW - 1_000, state: "running" },
  { name: "trip", deploy: 6, startedAt: NOW - 200_000, endedAt: NOW - 60_000, state: "returned", value: '"done"' },
  { name: "heal", deploy: 5, startedAt: NOW - 5_000_000, endedAt: NOW - 3_900_000, state: "threw", error: { name: "TypeError", text: "TypeError: x is undefined", frames: ["at heal (main.ts:9:3)"], signature: "heal|TypeError|main.ts:9" } },
  { name: "scout", deploy: 7, startedAt: NOW - 90_000, endedAt: NOW - 30_000, state: "interrupted", note: "the sandbox was restarted for a blocked event loop while no snippet was running" },
  { name: "walk", deploy: 7, startedAt: NOW - 50_000, endedAt: NOW - 2_000, state: "stopped" },
];

export function program1Surface(): unknown {
  const specs = programTools(PLAIN_RENDER as CoreToolRender<ProgramToolContext>);
  const tools = Object.values(specs).map((s) => ({ def: s.def, help: s.help, aliases: s.aliases ?? null }));
  return {
    tools,
    routines: renderRoutines(PROGRAM1_ROWS, NOW),
    routinesShown: renderRoutines(PROGRAM1_ROWS, NOW, new Set(PROGRAM1_ROWS.flatMap((r) => routineDetailKey(r) ?? []))),
    noRoutines: renderRoutines([], NOW),
    stateLossRecovery: STATE_LOSS_RECOVERY_PROGRAM,
  };
}
