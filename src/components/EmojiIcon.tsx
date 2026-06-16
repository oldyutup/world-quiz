/**
 * EmojiIcon.tsx — platform-bağımsız emoji ikonları (web).
 *
 * Native emoji glyph'leri işletim sistemine göre değişir (macOS Apple, Windows
 * Segoe, Android Noto vb.). Bu bileşen onların yerine Microsoft Fluent Emoji
 * SVG asset'lerini (MIT, bkz. src/assets/icons/LICENSE) <img> olarak basar —
 * Mac, Windows, Android tarayıcılarında aynı görünür. Tek görsel dil (Fluent
 * Color); başka ikon seti karıştırılmaz.
 *
 * İki kullanım biçimi:
 *   <EmojiIcon name="shield" />     → tip-güvenli, sabit ikon (mod/menü).
 *   <EmojiIcon char={bonus.icon} /> → veri-odaklı dinamik emoji string'i.
 *       Bilinen bir glyph ise SVG basar; bilinmiyorsa ham emoji'ye düşer
 *       (regresyon değil — sadece o glyph için SVG yok demektir).
 *
 * Boyut: varsayılan 1em; ikon kapsayıcının font-size'ını miras alır, böylece
 * mevcut hizalama/spacing bozulmaz. `size` (px) verilirse override eder.
 */
import globeUrl from "../assets/icons/globe.svg";
import globeAmericasUrl from "../assets/icons/globe-americas.svg";
import globeAsiaUrl from "../assets/icons/globe-asia.svg";
import flagUrl from "../assets/icons/flag.svg";
import whiteFlagUrl from "../assets/icons/white-flag.svg";
import checkeredFlagUrl from "../assets/icons/checkered-flag.svg";
import labelUrl from "../assets/icons/label.svg";
import mapUrl from "../assets/icons/map.svg";
import compassUrl from "../assets/icons/compass.svg";
import targetUrl from "../assets/icons/target.svg";
import shieldUrl from "../assets/icons/shield.svg";
import detectiveUrl from "../assets/icons/detective.svg";
import trophyUrl from "../assets/icons/trophy.svg";
import bellUrl from "../assets/icons/bell.svg";
import peopleUrl from "../assets/icons/people.svg";
import swordsUrl from "../assets/icons/swords.svg";
import houseUrl from "../assets/icons/house.svg";
import keyUrl from "../assets/icons/key.svg";
import searchUrl from "../assets/icons/search.svg";
import searchLeftUrl from "../assets/icons/search-left.svg";
import lockUrl from "../assets/icons/lock.svg";
import unlockUrl from "../assets/icons/unlock.svg";
import castleUrl from "../assets/icons/castle.svg";
import japaneseCastleUrl from "../assets/icons/japanese-castle.svg";
import hourglassUrl from "../assets/icons/hourglass.svg";
import stopwatchUrl from "../assets/icons/stopwatch.svg";
import alarmUrl from "../assets/icons/alarm.svg";
import woodUrl from "../assets/icons/wood.svg";
import masksUrl from "../assets/icons/masks.svg";
import bridgeUrl from "../assets/icons/bridge.svg";
import crabUrl from "../assets/icons/crab.svg";
import jokerUrl from "../assets/icons/joker.svg";
import crystalBallUrl from "../assets/icons/crystal-ball.svg";
import eyeUrl from "../assets/icons/eye.svg";
import eyesUrl from "../assets/icons/eyes.svg";
import sheafUrl from "../assets/icons/sheaf.svg";
import anchorUrl from "../assets/icons/anchor.svg";
import gemUrl from "../assets/icons/gem.svg";
import daggerUrl from "../assets/icons/dagger.svg";
import nazarUrl from "../assets/icons/nazar.svg";
import holeUrl from "../assets/icons/hole.svg";
import giftUrl from "../assets/icons/gift.svg";
import questionUrl from "../assets/icons/question.svg";
import crownUrl from "../assets/icons/crown.svg";
import boltUrl from "../assets/icons/bolt.svg";
import fireUrl from "../assets/icons/fire.svg";
import doorUrl from "../assets/icons/door.svg";
import sunglassesUrl from "../assets/icons/sunglasses.svg";
import handshakeUrl from "../assets/icons/handshake.svg";
import skullUrl from "../assets/icons/skull.svg";
import medalGoldUrl from "../assets/icons/medal-gold.svg";
import medalSilverUrl from "../assets/icons/medal-silver.svg";
import medalBronzeUrl from "../assets/icons/medal-bronze.svg";
import gamepadUrl from "../assets/icons/gamepad.svg";
import bustUrl from "../assets/icons/bust.svg";
import clipboardUrl from "../assets/icons/clipboard.svg";
import partyUrl from "../assets/icons/party.svg";
import starUrl from "../assets/icons/star.svg";
import speechUrl from "../assets/icons/speech.svg";
import rocketUrl from "../assets/icons/rocket.svg";
import cardsUrl from "../assets/icons/cards.svg";
import fogUrl from "../assets/icons/fog.svg";
import warningUrl from "../assets/icons/warning.svg";
import coinUrl from "../assets/icons/coin.svg";
import buildingUrl from "../assets/icons/building.svg";
import satelliteUrl from "../assets/icons/satellite.svg";
import ballotUrl from "../assets/icons/ballot.svg";
import heartUrl from "../assets/icons/heart.svg";
import brokenHeartUrl from "../assets/icons/broken-heart.svg";
import speakerHighUrl from "../assets/icons/speaker-high.svg";
import speakerMedUrl from "../assets/icons/speaker-med.svg";
import speakerLowUrl from "../assets/icons/speaker-low.svg";
import speakerMuteUrl from "../assets/icons/speaker-mute.svg";
import gearUrl from "../assets/icons/gear.svg";
import ferrisUrl from "../assets/icons/ferris.svg";
import mosqueUrl from "../assets/icons/mosque.svg";
import redCircleUrl from "../assets/icons/red-circle.svg";
import blueCircleUrl from "../assets/icons/blue-circle.svg";
import yellowCircleUrl from "../assets/icons/yellow-circle.svg";
import greenCircleUrl from "../assets/icons/green-circle.svg";
import orangeCircleUrl from "../assets/icons/orange-circle.svg";
import bulbUrl from "../assets/icons/bulb.svg";
import puzzleUrl from "../assets/icons/puzzle.svg";
import smallOrangeDiamondUrl from "../assets/icons/small-orange-diamond.svg";
import largeOrangeDiamondUrl from "../assets/icons/large-orange-diamond.svg";
import waterWaveUrl from "../assets/icons/water-wave.svg";
import memoUrl from "../assets/icons/memo.svg";
import pensiveUrl from "../assets/icons/pensive.svg";
import disappointedUrl from "../assets/icons/disappointed.svg";
import sweatUrl from "../assets/icons/sweat.svg";
import crossMarkUrl from "../assets/icons/cross-mark.svg";
import checkButtonUrl from "../assets/icons/check-button.svg";
import refreshUrl from "../assets/icons/refresh.svg";
import repeatUrl from "../assets/icons/repeat.svg";
import shuffleUrl from "../assets/icons/shuffle.svg";
import tridentUrl from "../assets/icons/trident.svg";
import fleurUrl from "../assets/icons/fleur.svg";
import pinUrl from "../assets/icons/pin.svg";
import globeMeridiansUrl from "../assets/icons/globe-meridians.svg";
import tubeUrl from "../assets/icons/tube.svg";
import paletteUrl from "../assets/icons/palette.svg";
import whiteCircleUrl from "../assets/icons/white-circle.svg";

export type EmojiIconName =
  | "globe" | "globe-americas" | "globe-asia"
  | "flag" | "white-flag" | "checkered-flag" | "label"
  | "map" | "compass" | "target" | "shield" | "detective"
  | "trophy" | "bell" | "people" | "swords"
  | "house" | "key" | "search" | "search-left" | "lock" | "unlock"
  | "castle" | "japanese-castle"
  | "hourglass" | "stopwatch" | "alarm"
  | "wood" | "masks" | "bridge" | "crab" | "joker" | "crystal-ball"
  | "eye" | "eyes" | "sheaf" | "anchor" | "gem" | "dagger" | "nazar"
  | "hole" | "gift" | "question" | "crown" | "bolt" | "fire" | "door"
  | "sunglasses" | "handshake" | "skull"
  | "medal-gold" | "medal-silver" | "medal-bronze"
  | "gamepad" | "bust" | "clipboard" | "party" | "star" | "speech"
  | "rocket" | "cards" | "fog" | "warning" | "coin" | "building"
  | "satellite" | "ballot" | "heart" | "broken-heart"
  | "speaker-high" | "speaker-med" | "speaker-low" | "speaker-mute"
  | "gear" | "ferris" | "mosque"
  | "red-circle" | "blue-circle" | "yellow-circle" | "green-circle" | "orange-circle"
  | "bulb" | "puzzle" | "small-orange-diamond" | "large-orange-diamond" | "water-wave"
  | "memo" | "pensive" | "disappointed" | "sweat" | "cross-mark" | "check-button"
  | "refresh" | "repeat" | "shuffle" | "trident" | "fleur" | "pin"
  | "globe-meridians" | "tube" | "palette" | "white-circle";

const ICON_SRC: Record<EmojiIconName, string> = {
  "globe": globeUrl, "globe-americas": globeAmericasUrl, "globe-asia": globeAsiaUrl,
  "flag": flagUrl, "white-flag": whiteFlagUrl, "checkered-flag": checkeredFlagUrl, "label": labelUrl,
  "map": mapUrl, "compass": compassUrl, "target": targetUrl, "shield": shieldUrl, "detective": detectiveUrl,
  "trophy": trophyUrl, "bell": bellUrl, "people": peopleUrl, "swords": swordsUrl,
  "house": houseUrl, "key": keyUrl, "search": searchUrl, "search-left": searchLeftUrl,
  "lock": lockUrl, "unlock": unlockUrl, "castle": castleUrl, "japanese-castle": japaneseCastleUrl,
  "hourglass": hourglassUrl, "stopwatch": stopwatchUrl, "alarm": alarmUrl,
  "wood": woodUrl, "masks": masksUrl, "bridge": bridgeUrl, "crab": crabUrl, "joker": jokerUrl,
  "crystal-ball": crystalBallUrl, "eye": eyeUrl, "eyes": eyesUrl, "sheaf": sheafUrl,
  "anchor": anchorUrl, "gem": gemUrl, "dagger": daggerUrl, "nazar": nazarUrl,
  "hole": holeUrl, "gift": giftUrl, "question": questionUrl, "crown": crownUrl,
  "bolt": boltUrl, "fire": fireUrl, "door": doorUrl, "sunglasses": sunglassesUrl,
  "handshake": handshakeUrl, "skull": skullUrl,
  "medal-gold": medalGoldUrl, "medal-silver": medalSilverUrl, "medal-bronze": medalBronzeUrl,
  "gamepad": gamepadUrl, "bust": bustUrl, "clipboard": clipboardUrl, "party": partyUrl,
  "star": starUrl, "speech": speechUrl, "rocket": rocketUrl, "cards": cardsUrl,
  "fog": fogUrl, "warning": warningUrl, "coin": coinUrl, "building": buildingUrl,
  "satellite": satelliteUrl, "ballot": ballotUrl, "heart": heartUrl, "broken-heart": brokenHeartUrl,
  "speaker-high": speakerHighUrl, "speaker-med": speakerMedUrl, "speaker-low": speakerLowUrl,
  "speaker-mute": speakerMuteUrl, "gear": gearUrl, "ferris": ferrisUrl, "mosque": mosqueUrl,
  "red-circle": redCircleUrl, "blue-circle": blueCircleUrl, "yellow-circle": yellowCircleUrl,
  "green-circle": greenCircleUrl, "orange-circle": orangeCircleUrl,
  "bulb": bulbUrl, "puzzle": puzzleUrl, "small-orange-diamond": smallOrangeDiamondUrl,
  "large-orange-diamond": largeOrangeDiamondUrl, "water-wave": waterWaveUrl,
  "memo": memoUrl, "pensive": pensiveUrl, "disappointed": disappointedUrl, "sweat": sweatUrl,
  "cross-mark": crossMarkUrl, "check-button": checkButtonUrl, "refresh": refreshUrl,
  "repeat": repeatUrl, "shuffle": shuffleUrl, "trident": tridentUrl, "fleur": fleurUrl,
  "pin": pinUrl, "globe-meridians": globeMeridiansUrl, "tube": tubeUrl,
  "palette": paletteUrl, "white-circle": whiteCircleUrl,
};

/**
 * Glyph → ikon adı eşlemesi. Bir ikon birden çok temsil ile gelebilir
 * (variation-selector'lı/'siz, skin-tone'lu, ZWJ'li). Aşağıdaki listede ham
 * glyph'ler verilir; lookup tablosu ayrıca FE0F/FE0E/ZWJ/skin-tone temizlenmiş
 * varyantları da içerir, böylece "🛡️" ve "🛡" aynı ikona düşer.
 */
const NAME_GLYPHS: Partial<Record<EmojiIconName, string[]>> = {
  "globe": ["🌍"], "globe-americas": ["🌎"], "globe-asia": ["🌏"],
  "globe-meridians": ["🌐"],
  "flag": ["🚩"], "white-flag": ["🏳️"], "checkered-flag": ["🏁"], "label": ["🏷️"],
  "map": ["🗺️"], "compass": ["🧭"], "target": ["🎯"], "shield": ["🛡️"],
  "detective": ["🕵️‍♂️", "🕵️‍♀️", "🕵️", "🕵"],
  "trophy": ["🏆"], "bell": ["🔔"], "people": ["👥"], "swords": ["⚔️"],
  "house": ["🏠"], "key": ["🔑"], "search": ["🔎"], "search-left": ["🔍"],
  "lock": ["🔒"], "unlock": ["🔓"], "castle": ["🏰"], "japanese-castle": ["🏯"],
  "hourglass": ["⏳", "⌛"], "stopwatch": ["⏱️"], "alarm": ["⏰"],
  "wood": ["🪵"], "masks": ["🎭"], "bridge": ["🌉"], "crab": ["🦀"], "joker": ["🃏"],
  "crystal-ball": ["🔮"], "eye": ["👁️", "👁"], "eyes": ["👀"], "sheaf": ["🌾"],
  "anchor": ["⚓"], "gem": ["💎"], "dagger": ["🗡️"], "nazar": ["🧿"],
  "hole": ["🕳️"], "gift": ["🎁"], "question": ["❓", "❔"], "crown": ["👑"],
  "bolt": ["⚡"], "fire": ["🔥"], "door": ["🚪"], "sunglasses": ["🕶️"],
  "handshake": ["🤝"], "skull": ["💀", "☠️"],
  "medal-gold": ["🥇"], "medal-silver": ["🥈"], "medal-bronze": ["🥉"],
  "gamepad": ["🎮"], "bust": ["👤"], "clipboard": ["📋"], "party": ["🎉"],
  "star": ["⭐", "🌟"], "speech": ["💬"], "rocket": ["🚀"], "cards": ["🎴"],
  "fog": ["🌫️"], "warning": ["⚠️"], "coin": ["🪙"], "building": ["🏛️"],
  "satellite": ["📡"], "ballot": ["🗳️"], "heart": ["❤️", "❤"], "broken-heart": ["💔"],
  "speaker-high": ["🔊"], "speaker-med": ["🔉"], "speaker-low": ["🔈"], "speaker-mute": ["🔇"],
  "gear": ["⚙️"], "ferris": ["🎡"], "mosque": ["🕌"],
  "red-circle": ["🔴"], "blue-circle": ["🔵"], "yellow-circle": ["🟡"],
  "green-circle": ["🟢"], "orange-circle": ["🟠"],
  "bulb": ["💡"], "puzzle": ["🧩"], "small-orange-diamond": ["🔸"],
  "large-orange-diamond": ["🔶"], "water-wave": ["🌊"], "memo": ["📝"],
  "pensive": ["😔"], "disappointed": ["😞"], "sweat": ["😓"],
  "cross-mark": ["❌"], "check-button": ["✅"], "refresh": ["🔄"],
  "repeat": ["🔁"], "shuffle": ["🔀"], "trident": ["🔱"], "fleur": ["⚜️"],
  "pin": ["📍"], "tube": ["🧪"], "palette": ["🎨"], "white-circle": ["⚪"],
};

/** Görünmez emoji modifier'larını (VS16/VS15, ZWJ, skin-tone) ayıkla. */
function normalizeGlyph(s: string): string {
  return Array.from(s)
    .filter((ch) => {
      const cp = ch.codePointAt(0)!;
      if (cp === 0xfe0f || cp === 0xfe0e) return false;        // variation selectors
      if (cp === 0x200d) return false;                          // ZWJ
      if (cp >= 0x1f3fb && cp <= 0x1f3ff) return false;         // skin tones
      if (cp === 0x2640 || cp === 0x2642) return false;         // gender signs
      return true;
    })
    .join("");
}

const CHAR_TO_NAME: Map<string, EmojiIconName> = (() => {
  const m = new Map<string, EmojiIconName>();
  (Object.keys(NAME_GLYPHS) as EmojiIconName[]).forEach((name) => {
    for (const glyph of NAME_GLYPHS[name] ?? []) {
      if (!m.has(glyph)) m.set(glyph, name);
      const norm = normalizeGlyph(glyph);
      if (norm && !m.has(norm)) m.set(norm, name);
    }
  });
  return m;
})();

/** Public: bir emoji string'i ikon registry'sinde var mı? */
export function emojiIconName(char: string): EmojiIconName | null {
  return CHAR_TO_NAME.get(char) ?? CHAR_TO_NAME.get(normalizeGlyph(char)) ?? null;
}

interface BaseProps {
  className?: string;
  /** Piksel boyutu. Verilmezse kapsayıcının font-size'ından 1em miras alır. */
  size?: number;
  /** Erişilebilir etiket; verilmezse ikon dekoratif (aria-hidden) sayılır. */
  title?: string;
}
type EmojiIconProps =
  | (BaseProps & { name: EmojiIconName; char?: never })
  | (BaseProps & { char: string; name?: never });

export function EmojiIcon(props: EmojiIconProps) {
  const { className, size, title } = props;
  const resolvedName: EmojiIconName | null =
    "name" in props && props.name ? props.name : emojiIconName(props.char ?? "");

  // Bilinmeyen dinamik glyph → ham emoji'ye düş (kayıpsız fallback).
  if (!resolvedName) {
    return <span className={className} aria-hidden={title ? undefined : true}>{props.char}</span>;
  }

  return (
    <img
      src={ICON_SRC[resolvedName]}
      className={"emoji-icon" + (className ? " " + className : "")}
      style={size ? { width: size, height: size } : undefined}
      alt={title ?? ""}
      aria-hidden={title ? undefined : true}
      draggable={false}
    />
  );
}
