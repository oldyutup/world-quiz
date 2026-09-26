import { PROP_FAMILIES, type PropFamilyId } from "../../../../shared/party-lab/maps/propHuntProps";
import { PLAYERS, type PlayerId } from "../players";

/** The result's line for a hider still hidden: "Bulunamadı: Player 2 · Sandalye" (the local player marked "(sen)"). */
export function revealLabel(id: PlayerId, family: PropFamilyId | null) {
  const who = `${PLAYERS[id].label}${id === 0 ? " (sen)" : ""}`,
    what = family ? PROP_FAMILIES[family].name : "kılıksız";
  return { who, what, text: `Bulunamadı: ${who} · ${what}` };
}
