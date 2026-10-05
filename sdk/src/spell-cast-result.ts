/**
 * The pinned core's `SpellCastResult` names, shared by every cast-failure
 * packet schema (`SMSG_CAST_FAILED`, `SMSG_SPELL_FAILURE`,
 * `SMSG_PET_CAST_FAILED`): its own module so `protocol.ts` and
 * `protocol-social.ts` can both read it without importing each other.
 */

/**
 * `enum SpellCastResult` in the pinned core (`SharedDefines.h`), indexed by
 * code: each `SPELL_FAILED_<NAME>` as `<name>` in lower case. Every value
 * there is explicit and the run is contiguous from 0 to 187, so the index is
 * the code. 255 (`SPELL_CAST_OK`) is never sent to a client.
 */
const SPELL_CAST_RESULT_NAMES: readonly string[] = [
  /*   0 */ "success", "affecting_combat", "already_at_full_health", "already_at_full_mana", "already_at_full_power", "already_being_tamed",
  /*   6 */ "already_have_charm", "already_have_summon", "already_open", "aura_bounced", "autotrack_interrupted", "bad_implicit_targets",
  /*  12 */ "bad_targets", "cant_be_charmed", "cant_be_disenchanted", "cant_be_disenchanted_skill", "cant_be_milled", "cant_be_prospected",
  /*  18 */ "cant_cast_on_tapped", "cant_duel_while_invisible", "cant_duel_while_stealthed", "cant_stealth", "caster_aurastate", "caster_dead",
  /*  24 */ "charmed", "chest_in_use", "confused", "dont_report", "equipped_item", "equipped_item_class",
  /*  30 */ "equipped_item_class_mainhand", "equipped_item_class_offhand", "error", "fizzle", "fleeing", "food_lowlevel",
  /*  36 */ "highlevel", "hunger_satiated", "immune", "incorrect_area", "interrupted", "interrupted_combat",
  /*  42 */ "item_already_enchanted", "item_gone", "item_not_found", "item_not_ready", "level_requirement", "line_of_sight",
  /*  48 */ "lowlevel", "low_castlevel", "mainhand_empty", "moving", "need_ammo", "need_ammo_pouch",
  /*  54 */ "need_exotic_ammo", "need_more_items", "nopath", "not_behind", "not_fishable", "not_flying",
  /*  60 */ "not_here", "not_infront", "not_in_control", "not_known", "not_mounted", "not_on_taxi",
  /*  66 */ "not_on_transport", "not_ready", "not_shapeshift", "not_standing", "not_tradeable", "not_trading",
  /*  72 */ "not_unsheathed", "not_while_ghost", "not_while_looting", "no_ammo", "no_charges_remain", "no_champion",
  /*  78 */ "no_combo_points", "no_dueling", "no_endurance", "no_fish", "no_items_while_shapeshifted", "no_mounts_allowed",
  /*  84 */ "no_pet", "no_power", "nothing_to_dispel", "nothing_to_steal", "only_abovewater", "only_daytime",
  /*  90 */ "only_indoors", "only_mounted", "only_nighttime", "only_outdoors", "only_shapeshift", "only_stealthed",
  /*  96 */ "only_underwater", "out_of_range", "pacified", "possessed", "reagents", "requires_area",
  /* 102 */ "requires_spell_focus", "rooted", "silenced", "spell_in_progress", "spell_learned", "spell_unavailable",
  /* 108 */ "stunned", "targets_dead", "target_affecting_combat", "target_aurastate", "target_dueling", "target_enemy",
  /* 114 */ "target_enraged", "target_friendly", "target_in_combat", "target_is_player", "target_is_player_controlled", "target_not_dead",
  /* 120 */ "target_not_in_party", "target_not_looted", "target_not_player", "target_no_pockets", "target_no_weapons", "target_no_ranged_weapons",
  /* 126 */ "target_unskinnable", "thirst_satiated", "too_close", "too_many_of_item", "totem_category", "totems",
  /* 132 */ "try_again", "unit_not_behind", "unit_not_infront", "wrong_pet_food", "not_while_fatigued", "target_not_in_instance",
  /* 138 */ "not_while_trading", "target_not_in_raid", "target_freeforall", "no_edible_corpses", "only_battlegrounds", "target_not_ghost",
  /* 144 */ "transform_unusable", "wrong_weather", "damage_immune", "prevented_by_mechanic", "play_time", "reputation",
  /* 150 */ "min_skill", "not_in_arena", "not_on_shapeshift", "not_on_stealthed", "not_on_damage_immune", "not_on_mounted",
  /* 156 */ "too_shallow", "target_not_in_sanctuary", "target_is_trivial", "bm_or_invisgod", "expert_riding_requirement", "artisan_riding_requirement",
  /* 162 */ "not_idle", "not_inactive", "partial_playtime", "no_playtime", "not_in_battleground", "not_in_raid_instance",
  /* 168 */ "only_in_arena", "target_locked_to_raid_instance", "on_use_enchant", "not_on_ground", "custom_error", "cant_do_that_right_now",
  /* 174 */ "too_many_sockets", "invalid_glyph", "unique_glyph", "glyph_socket_locked", "no_valid_targets", "item_at_max_charges",
  /* 180 */ "not_in_barbershop", "fishing_too_low", "item_enchant_trade_window", "summon_pending", "max_sockets", "pet_can_rename",
  /* 186 */ "target_cannot_be_resurrected", "unknown",
];

/**
 * The pinned core's name for a `SpellCastResult` code (`97` → `"out_of_range"`,
 * `67` → `"not_ready"`), or `undefined` for a code outside the enum. The name
 * is the enum's, which is what the client's own failure text is keyed on —
 * client-visible knowledge, as `inventoryResultText` is for inventory codes.
 */
export function spellCastResultName(result: number): string | undefined {
  return Number.isInteger(result) ? SPELL_CAST_RESULT_NAMES[result] : undefined;
}

/**
 * Decode-time decoration for the two cast-failure packets: the numeric
 * `result` stays, and `reason` names it. Runs read their cast failures as
 * bare numbers and decoded them from memory, when they decoded them at all
 * (operator decision, 2026-10-05: name the codes).
 */
export const withCastReason = <T extends { result: number }>(d: T): T & { reason: string | undefined } => ({
  ...d,
  reason: spellCastResultName(d.result),
});
