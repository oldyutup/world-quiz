/**
 * ConquestMapSelect — Kuşatma lobby/setup "Harita" seçimi.
 *
 * Artık ortak `ConquestIconSelect` üzerine ince bir sarmalayıcıdır: harita
 * listesini (CONQUEST_MAPS) seçenek dizisine çevirip delege eder. DAVRANIŞ
 * aynen korunur — yalnız `onChange(map)` çağrılır, host değilse devre dışıdır.
 * Harita ikonları diğer seçenek ikonlarından biraz daha belirgin (22px) gösterilir.
 */

import { CONQUEST_MAPS, type ConquestMapId } from "./types";
import { ConquestIconSelect } from "./ConquestIconSelect";
import { getConquestMapAsset } from "./conquestIcons";

interface Props {
  value: ConquestMapId;
  disabled?: boolean;
  onChange: (id: ConquestMapId) => void;
}

const MAP_ICON_PX = 22; // harita ikonları biraz daha büyük (trim sonrası belirgin)

export function ConquestMapSelect({ value, disabled = false, onChange }: Props) {
  return (
    <ConquestIconSelect<ConquestMapId>
      value={value}
      disabled={disabled}
      ariaLabel="Harita seç"
      iconSize={MAP_ICON_PX}
      onChange={onChange}
      options={CONQUEST_MAPS.map(m => ({
        value: m.id,
        label: m.label,
        iconSrc: getConquestMapAsset(m.id) ?? null,
        fallbackChar: m.icon,
      }))}
    />
  );
}
