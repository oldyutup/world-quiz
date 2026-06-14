/**
 * AvatarPickerModal.tsx — profile customization sheet (Avatar Phase 1B+).
 *
 * The only FUNCTIONAL surface is "Ücretsiz Avatarlar": the curated catalog
 * (src/data/avatars.ts) plus a "Varsayılan" tile that resets to the
 * username-initial fallback (avatar_id = null). Selection is local until
 * "Kaydet"; saving still calls updateAvatar(profile.id, selected), which writes
 * ONLY avatar_id + updated_at — byte-identical to before. On success the parent
 * patches profile.avatar_id in React state and closes the modal.
 *
 * "Başarımla Açılanlar" shows 5 achievement groups with hover/tap popovers.
 * Progress fields (progressValue, unlocked) use mock data; wire them to real
 * userStats in Phase 2 — see ACHIEVEMENT_GROUPS below.
 *
 * The remaining sections (premium, frames, own-photo) are purely visual
 * "Yakında" placeholders. Nothing here touches gameplay / auth / friends.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AVATARS } from "../data/avatars";
import { updateAvatar, type Profile } from "../lib/auth";
import {
  useAchievementState,
  getStatValue,
  avatarIdForTier,
  getClaimableRewards,
  claimAllAchievementRewards,
  type StatKey,
  type UserAchievementStats,
  type UserAchievementUnlocks,
} from "../lib/achievementStats";
import { Avatar } from "./Avatar";

// ── Achievement avatar imports ─────────────────────────────────────────────
import achievementWorldTraveler10 from "../assets/avatars/achievements/achievement_world_traveler_10.png";
import achievementWorldTraveler50 from "../assets/avatars/achievements/achievement_world_traveler_50.png";
import achievementWorldTraveler100 from "../assets/avatars/achievements/achievement_world_traveler_100.png";
import achievementFlagMaster25 from "../assets/avatars/achievements/achievement_flag_master_25.png";
import achievementFlagMaster100 from "../assets/avatars/achievements/achievement_flag_master_100.png";
import achievementFlagMaster250 from "../assets/avatars/achievements/achievement_flag_master_250.png";
import achievementStreakPlayer3 from "../assets/avatars/achievements/achievement_streak_player_3.png";
import achievementStreakPlayer5 from "../assets/avatars/achievements/achievement_streak_player_5.png";
import achievementStreakPlayer7 from "../assets/avatars/achievements/achievement_streak_player_7.png";
import achievementVersatilePlayer3 from "../assets/avatars/achievements/achievement_versatile_player_3.png";
import achievementVersatilePlayer5 from "../assets/avatars/achievements/achievement_versatile_player_5.png";
import achievementVersatilePlayer7 from "../assets/avatars/achievements/achievement_versatile_player_7.png";
import achievementWinStreak2 from "../assets/avatars/achievements/achievement_win_streak_2.png";
import achievementWinStreak3 from "../assets/avatars/achievements/achievement_win_streak_3.png";
import achievementWinStreak5 from "../assets/avatars/achievements/achievement_win_streak_5.png";

// ── Achievement types ─────────────────────────────────────────────────────
// Progress + unlocked are derived live from userStats (achievementStats.ts);
// only the static presentation (icon/title/requirement/reward/target) lives here.
type AchievementAvatarTier = {
  id: string;        // tier id, e.g. "world_traveler_10"
  avatarId: string;  // selectable avatar id, e.g. "avatar_ach_world_traveler_10"
  icon: string;
  title: string;
  requirement: string;
  rewardGold: number;
  targetValue: number;
};

type AchievementAvatarGroup = {
  id: string;
  title: string;
  statKey: StatKey;  // which userStats field drives every tier in this group
  tiers: readonly AchievementAvatarTier[];
};

// Per-tier live state computed from userStats + unlocks.
//   unlocked  → avatar is selectable (sticky: once earned, stays selectable)
//   claimable → reward is ready to collect (meets threshold now, not yet claimed)
//   claimed   → reward Gold already collected
type TierState = {
  progress: number;
  unlocked: boolean;
  claimable: boolean;
  claimed: boolean;
  selected: boolean;
};

function tierDef(
  id: string,
  icon: string,
  title: string,
  requirement: string,
  rewardGold: number,
  targetValue: number
): AchievementAvatarTier {
  return { id, avatarId: avatarIdForTier(id), icon, title, requirement, rewardGold, targetValue };
}

// ── Achievement group data ────────────────────────────────────────────────
const ACHIEVEMENT_GROUPS: readonly AchievementAvatarGroup[] = [
  {
    id: "world_traveler",
    title: "Dünya Gezgini",
    statKey: "uniqueCorrectCountries",
    tiers: [
      tierDef("world_traveler_10",  achievementWorldTraveler10,  "Dünya Gezgini I",   "10 farklı ülke doğru bil",  25, 10),
      tierDef("world_traveler_50",  achievementWorldTraveler50,  "Dünya Gezgini II",  "50 farklı ülke doğru bil",  50, 50),
      tierDef("world_traveler_100", achievementWorldTraveler100, "Dünya Gezgini III", "100 farklı ülke doğru bil", 75, 100),
    ],
  },
  {
    id: "flag_master",
    title: "Bayrak Ustası",
    statKey: "correctFlags",
    tiers: [
      tierDef("flag_master_25",  achievementFlagMaster25,  "Bayrak Ustası I",   "25 bayrak doğru bil",  25, 25),
      tierDef("flag_master_100", achievementFlagMaster100, "Bayrak Ustası II",  "100 bayrak doğru bil", 50, 100),
      tierDef("flag_master_250", achievementFlagMaster250, "Bayrak Ustası III", "250 bayrak doğru bil", 75, 250),
    ],
  },
  {
    id: "streak_player",
    title: "Seri Oyuncu",
    statKey: "dailyStreak",
    tiers: [
      tierDef("streak_player_3", achievementStreakPlayer3, "Seri Oyuncu I",   "3 gün üst üste en az 1 oyun tamamla", 25, 3),
      tierDef("streak_player_5", achievementStreakPlayer5, "Seri Oyuncu II",  "5 gün üst üste en az 1 oyun tamamla", 50, 5),
      tierDef("streak_player_7", achievementStreakPlayer7, "Seri Oyuncu III", "7 gün üst üste en az 1 oyun tamamla", 75, 7),
    ],
  },
  {
    id: "versatile_player",
    title: "Çok Yönlü Oyuncu",
    statKey: "completedModes",
    tiers: [
      tierDef("versatile_player_3", achievementVersatilePlayer3, "Çok Yönlü Oyuncu I",   "3 farklı modda oyun tamamla", 25, 3),
      tierDef("versatile_player_5", achievementVersatilePlayer5, "Çok Yönlü Oyuncu II",  "5 farklı modda oyun tamamla", 50, 5),
      tierDef("versatile_player_7", achievementVersatilePlayer7, "Çok Yönlü Oyuncu III", "7 farklı modda oyun tamamla", 75, 7),
    ],
  },
  {
    id: "win_streak",
    title: "Seri Galibiyet",
    statKey: "onlineWinStreak",
    tiers: [
      tierDef("win_streak_2", achievementWinStreak2, "Seri Galibiyet I",   "2 üst üste online galibiyet al", 25, 2),
      tierDef("win_streak_3", achievementWinStreak3, "Seri Galibiyet II",  "3 üst üste online galibiyet al", 50, 3),
      tierDef("win_streak_5", achievementWinStreak5, "Seri Galibiyet III", "5 üst üste online galibiyet al", 75, 5),
    ],
  },
];

// Live per-tier state from userStats + unlocks. progress is clamped to target.
function computeTierState(
  group: AchievementAvatarGroup,
  tier: AchievementAvatarTier,
  stats: UserAchievementStats,
  unlocks: UserAchievementUnlocks,
  selectedAvatarId: string | null
): TierState {
  const raw = getStatValue(group.statKey, stats);
  const meetsNow = raw >= tier.targetValue;
  const claimed = unlocks.claimedAchievementRewardIds.includes(tier.id);
  // Sticky selectable: meets now OR previously unlocked OR reward already claimed.
  const unlocked =
    meetsNow ||
    unlocks.unlockedAchievementAvatarIds.includes(tier.avatarId) ||
    claimed;
  return {
    progress: Math.min(raw, tier.targetValue),
    unlocked,
    claimable: meetsNow && !claimed,
    claimed,
    selected: selectedAvatarId === tier.avatarId,
  };
}

// Returns the highest unlocked tier icon; falls back to tier[0] when all locked.
function getRepresentativeIcon(
  group: AchievementAvatarGroup,
  stats: UserAchievementStats
): string {
  const raw = getStatValue(group.statKey, stats);
  for (let i = group.tiers.length - 1; i >= 0; i--) {
    if (raw >= group.tiers[i].targetValue) return group.tiers[i].icon;
  }
  return group.tiers[0].icon;
}

/* ── Placeholder previews ────────────────────────────────────────────────────
 * NONE of the entries below are selectable, persisted, or tied to any backend.
 * No id here ever reaches updateAvatar. They exist only to show users what is
 * coming, so the screen reads as future-ready without unlocking anything. */
const PREMIUM_PREVIEWS = [
  { emoji: "👑", gradient: "linear-gradient(135deg,#f9d423,#e6912b)" },
  { emoji: "💎", gradient: "linear-gradient(135deg,#43cea2,#185a9d)" },
  { emoji: "🔱", gradient: "linear-gradient(135deg,#654ea3,#eaafc8)" },
] as const;

const FRAME_PREVIEWS = [
  { ring: "apk-frame--gold", label: "Altın" },
  { ring: "apk-frame--neon", label: "Neon" },
  { ring: "apk-frame--aurora", label: "Aurora" },
] as const;

function LockIcon() {
  return (
    <svg
      className="apk-ico"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.5" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </svg>
  );
}

// ── Achievement tier row inside the popover ───────────────────────────────
// Unlocked tiers act as a selectable avatar; locked tiers are inert and report
// the attempt so the section can surface a small "unlocks via achievement" note.
function AchievementTierRow({
  tier,
  state,
  onSelect,
  onLockedAttempt,
}: {
  tier: AchievementAvatarTier;
  state: TierState;
  onSelect: (avatarId: string) => void;
  onLockedAttempt: () => void;
}) {
  const pct = tier.targetValue > 0
    ? Math.min(100, Math.round((state.progress / tier.targetValue) * 100))
    : 0;

  const handleClick = () => {
    if (state.unlocked) onSelect(tier.avatarId);
    else onLockedAttempt();
  };

  return (
    <button
      type="button"
      className={
        `apk-ach-tier` +
        (state.unlocked ? " apk-ach-tier--unlocked" : " apk-ach-tier--locked") +
        (state.selected ? " apk-ach-tier--selected" : "")
      }
      onClick={handleClick}
      aria-pressed={state.selected}
      aria-disabled={!state.unlocked}
      title={state.unlocked ? "Bu avatarı seç" : "Bu avatar başarımla açılır"}
    >
      <div className="apk-ach-tier-img-wrap">
        <img src={tier.icon} alt={tier.title} className="apk-ach-tier-img" />
        {state.unlocked ? (
          <span className="apk-ach-tier-badge apk-ach-tier-badge--done" aria-label="Açıldı">✓</span>
        ) : (
          <span className="apk-ach-tier-badge apk-ach-tier-badge--lock" aria-hidden="true">
            <LockIcon />
          </span>
        )}
      </div>
      <div className="apk-ach-tier-body">
        <span className="apk-ach-tier-name">{tier.title}</span>
        <span className="apk-ach-tier-req">{tier.requirement}</span>
        <div className="apk-ach-tier-meta">
          <span className="apk-ach-tier-reward">Ödül: {tier.rewardGold} Gold</span>
          <span
            className={
              `apk-ach-tier-status` +
              (state.claimed
                ? " apk-ach-tier-status--claimed"
                : state.claimable
                  ? " apk-ach-tier-status--ready"
                  : " apk-ach-tier-status--locked")
            }
          >
            {state.claimed ? "Ödül alındı" : state.claimable ? "Ödül hazır" : "Kilitli"}
          </span>
        </div>
        <div className="apk-ach-tier-prog">
          <div className="apk-ach-tier-bar">
            <div className="apk-ach-tier-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="apk-ach-tier-count">{state.progress}/{tier.targetValue}</span>
        </div>
      </div>
      {state.selected && <span className="apk-check" aria-hidden="true">✓</span>}
    </button>
  );
}

// ── Achievement section: 5 group cards + interactive hover/tap popover ─────
// The popover is a *selection* panel, not just a tooltip. To let the pointer
// travel from a card into the popover (which sits above it with a small gap)
// without the panel vanishing, both the card and the popover share a single
// close timer: entering either cancels a pending close, leaving either arms a
// ~200ms close. An invisible bridge spans the gap so the hover path is
// continuous. On touch (no hover) it's a tap-to-open / tap-outside-to-close panel.
const CLOSE_DELAY_MS = 200;

function AchievementSection({
  stats,
  unlocks,
  selected,
  onSelect,
}: {
  stats: UserAchievementStats;
  unlocks: UserAchievementUnlocks;
  selected: string | null;
  onSelect: (avatarId: string) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [lockedNote, setLockedNote] = useState(false);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const lockedNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashLockedNote = () => {
    setLockedNote(true);
    if (lockedNoteTimer.current) clearTimeout(lockedNoteTimer.current);
    lockedNoteTimer.current = setTimeout(() => setLockedNote(false), 2200);
  };

  useEffect(() => () => {
    if (lockedNoteTimer.current) clearTimeout(lockedNoteTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  // Evaluated once at mount; does not change during a session.
  const canHover = useRef(
    typeof window !== "undefined" && window.matchMedia("(hover: hover)").matches
  ).current;

  function cancelClose() {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  function closeGroup() {
    cancelClose();
    setActiveId(null);
    setAnchor(null);
  }

  // Arm a delayed close so the pointer can cross the card→popover gap.
  function scheduleClose() {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setActiveId(null);
      setAnchor(null);
    }, CLOSE_DELAY_MS);
  }

  function openGroup(id: string) {
    cancelClose();
    const el = cardRefs.current.get(id);
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Center horizontally on the card, clamped so the 260px popover stays in viewport.
    const cx = Math.max(138, Math.min(r.left + r.width / 2, window.innerWidth - 138));
    setAnchor({ x: cx, y: r.top });
    setActiveId(id);
  }

  function toggleGroup(id: string) {
    if (activeId === id) closeGroup();
    else openGroup(id);
  }

  const activeGroup = activeId
    ? ACHIEVEMENT_GROUPS.find((g) => g.id === activeId) ?? null
    : null;

  return (
    <>
      <div className="apk-ach-row" aria-label="Başarım grupları">
        {ACHIEVEMENT_GROUPS.map((group) => {
          const icon = getRepresentativeIcon(group, stats);
          const raw = getStatValue(group.statKey, stats);
          const anyUnlocked =
            group.tiers.some((t) => raw >= t.targetValue) ||
            group.tiers.some(
              (t) =>
                unlocks.unlockedAchievementAvatarIds.includes(t.avatarId) ||
                unlocks.claimedAchievementRewardIds.includes(t.id)
            );
          const groupSelected = group.tiers.some((t) => selected === t.avatarId);
          const isActive = activeId === group.id;

          return (
            <div
              key={group.id}
              className={
                `apk-ach-card` +
                (isActive ? " apk-ach-card--active" : "") +
                (anyUnlocked ? " apk-ach-card--unlocked" : "") +
                (groupSelected ? " apk-ach-card--selected" : "")
              }
              ref={(el) => {
                if (el) cardRefs.current.set(group.id, el);
                else cardRefs.current.delete(group.id);
              }}
              role="button"
              tabIndex={0}
              aria-label={group.title}
              aria-expanded={isActive}
              onMouseEnter={canHover ? () => openGroup(group.id) : undefined}
              onMouseLeave={canHover ? scheduleClose : undefined}
              onClick={!canHover ? () => toggleGroup(group.id) : undefined}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleGroup(group.id);
                }
              }}
            >
              <div className="apk-ach-card-icon">
                <img src={icon} alt="" className="apk-ach-card-img" />
                {!anyUnlocked && (
                  <span className="apk-ach-card-lock" aria-hidden="true">
                    <LockIcon />
                  </span>
                )}
                {groupSelected && <span className="apk-check" aria-hidden="true">✓</span>}
              </div>
              <span className="apk-tile-label">{group.title}</span>
            </div>
          );
        })}
      </div>

      {lockedNote && (
        <p className="apk-ach-locked-note" role="status">
          Bu avatar başarımla açılır.
        </p>
      )}

      {activeGroup &&
        anchor &&
        createPortal(
          <>
            {!canHover && (
              <div className="apk-ach-backdrop" onClick={closeGroup} aria-hidden="true" />
            )}
            <div
              className="apk-ach-popover"
              style={{ left: anchor.x, top: anchor.y }}
              role="tooltip"
              aria-label={`${activeGroup.title} seviyeleri`}
              onMouseEnter={canHover ? cancelClose : undefined}
              onMouseLeave={canHover ? scheduleClose : undefined}
            >
              <div className="apk-ach-popover-title">{activeGroup.title}</div>
              {activeGroup.tiers.map((tier) => (
                <AchievementTierRow
                  key={tier.id}
                  tier={tier}
                  state={computeTierState(activeGroup, tier, stats, unlocks, selected)}
                  onSelect={onSelect}
                  onLockedAttempt={flashLockedNote}
                />
              ))}
              {/* Invisible bridge spanning the card→popover gap so the hover path
                  stays continuous. As a descendant it keeps the popover "hovered"
                  even though it visually overflows below the panel. */}
              {canHover && <span className="apk-ach-popover-bridge" aria-hidden="true" />}
            </div>
          </>,
          document.body
        )}
    </>
  );
}

interface Props {
  profile: Profile;
  onClose: () => void;
  /** Fires with the saved avatar id (or null for default) after a successful
   *  write so the parent can patch profile state. */
  onSuccess: (avatarId: string | null) => void;
}

export function AvatarPickerModal({ profile, onClose, onSuccess }: Props) {
  const [selected, setSelected] = useState<string | null>(profile.avatar_id ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { stats, unlocks } = useAchievementState();

  // "Ödülleri Topla" — claimable reward summary + collect flow.
  const claimable = getClaimableRewards(stats, unlocks);
  const [claiming, setClaiming] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  async function handleClaimRewards() {
    if (claiming || claimable.count === 0) return;
    setClaiming(true);
    try {
      const res = await claimAllAchievementRewards();
      if (res.ok && res.goldAwarded > 0) {
        showToast(`${res.goldAwarded} Gold kazandın!`);
      } else if (res.ok) {
        showToast("Toplanacak ödül kalmadı.");
      } else if (res.code === "guest") {
        showToast("Ödülleri toplamak için giriş yapmalısın.");
      } else {
        showToast("Ödüller toplanamadı, tekrar dene.");
      }
    } finally {
      setClaiming(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  const current = profile.avatar_id ?? null;
  const unchanged = selected === current;

  async function handleSave() {
    if (submitting || unchanged) return;
    setError(null);
    setSubmitting(true);
    try {
      const { data, error: updErr } = await updateAvatar(profile.id, selected);
      if (updErr || !data) {
        setError(updErr?.message || "Avatar kaydedilemedi, tekrar dene.");
        return;
      }
      onSuccess(data.avatar_id ?? null);
    } catch {
      setError("Bağlantı hatası, tekrar dene.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="apk-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Avatarını Seç"
      onClick={() => !submitting && onClose()}
    >
      <div className="apk-modal" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="apk-close"
          onClick={() => !submitting && onClose()}
          aria-label="Kapat"
        >
          ×
        </button>

        <div className="apk-head">
          <h2 className="apk-title">Avatarını Seç</h2>
          <p className="apk-sub">Profilini kişiselleştir.</p>
        </div>

        <div className="apk-body">
          {/* Section A — Ücretsiz Avatarlar (the only active surface). */}
          <section className="apk-section">
            <header className="apk-section-head">
              <span className="apk-section-label">Ücretsiz Avatarlar</span>
            </header>
            <div className="apk-free-row" role="group" aria-label="Ücretsiz Avatarlar">
              {/* Varsayılan / null — reset to the username-initial fallback. */}
              <button
                type="button"
                className={`apk-tile${selected === null ? " apk-tile--active" : ""}`}
                onClick={() => setSelected(null)}
                aria-pressed={selected === null}
              >
                <Avatar avatarId={null} username={profile.username} size={56} />
                <span className="apk-tile-label">Varsayılan</span>
                {selected === null && <span className="apk-check" aria-hidden="true">✓</span>}
              </button>

              {AVATARS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`apk-tile${selected === a.id ? " apk-tile--active" : ""}`}
                  onClick={() => setSelected(a.id)}
                  aria-pressed={selected === a.id}
                  title={a.label}
                >
                  <Avatar avatarId={a.id} username={profile.username} size={56} />
                  <span className="apk-tile-label">{a.label}</span>
                  {selected === a.id && <span className="apk-check" aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
          </section>

          {/* Section B — Başarımla Açılanlar: 5 achievement groups with popover. */}
          <section className="apk-section apk-section--locked">
            <header className="apk-section-head">
              <span className="apk-section-label">Başarımla Açılanlar</span>
              {claimable.count > 0 ? (
                <button
                  type="button"
                  className="apk-claim-btn"
                  onClick={handleClaimRewards}
                  disabled={claiming}
                  title="Tamamlanan başarımların Gold ödüllerini topla"
                >
                  <span aria-hidden="true">🎁</span>
                  {claiming
                    ? "Toplanıyor…"
                    : `Ödülleri Topla · ${claimable.totalGold} Gold`}
                </button>
              ) : (
                <span className="apk-badge apk-badge--locked">
                  <LockIcon />
                  Başarımla açılır
                </span>
              )}
            </header>
            <AchievementSection
              stats={stats}
              unlocks={unlocks}
              selected={selected}
              onSelect={setSelected}
            />
          </section>

          {/* Section C — Premium Avatarlar (locked preview, no prices, no payment). */}
          <section className="apk-section apk-section--locked">
            <header className="apk-section-head">
              <span className="apk-section-label">Premium Avatarlar</span>
              <span className="apk-badge apk-badge--soon">Yakında</span>
            </header>
            <div className="apk-premium" aria-disabled="true">
              <div className="apk-premium-orbs">
                {PREMIUM_PREVIEWS.map((p) => (
                  <span className="apk-premium-orb" style={{ background: p.gradient }} key={p.emoji}>
                    <span aria-hidden="true">{p.emoji}</span>
                  </span>
                ))}
                <span className="apk-premium-orb apk-premium-orb--more" aria-hidden="true">
                  <LockIcon />
                </span>
              </div>
              <p className="apk-section-note">Özel avatar paketleri yakında.</p>
            </div>
          </section>

          {/* Section D — Profil Çerçeveleri (locked preview, no frame_id). */}
          <section className="apk-section apk-section--locked">
            <header className="apk-section-head">
              <span className="apk-section-label">Profil Çerçeveleri</span>
              <span className="apk-badge apk-badge--soon">Yakında</span>
            </header>
            <div className="apk-frame-row" aria-disabled="true">
              {FRAME_PREVIEWS.map((f) => (
                <span className={`apk-frame-prev ${f.ring}`} key={f.label}>
                  <Avatar avatarId={profile.avatar_id} username={profile.username} size={44} />
                </span>
              ))}
            </div>
            <p className="apk-section-note">Avatar çerçeveleri yakında.</p>
          </section>

          {/* Section E — Kendi Fotoğrafın (locked, no file picker / storage). */}
          <section className="apk-section apk-section--locked">
            <header className="apk-section-head">
              <span className="apk-section-label">Kendi Fotoğrafın</span>
              <span className="apk-badge apk-badge--soon">Yakında</span>
            </header>
            <div className="apk-photo-card" aria-disabled="true">
              <span className="apk-photo-glyph" aria-hidden="true">
                <svg
                  className="apk-ico"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.7}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.4l.9-1.5A1.5 1.5 0 0 1 10.1 3.8h3.8a1.5 1.5 0 0 1 1.3.7l.9 1.5h1.4A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z" />
                  <circle cx="12" cy="12.5" r="3.1" />
                </svg>
              </span>
              <p className="apk-section-note">
                Kendi fotoğrafını profilinde kullanma özelliği yakında.
              </p>
            </div>
          </section>
        </div>

        {toast && (
          <div className="apk-claim-toast" role="status">
            {toast}
          </div>
        )}

        {error && <div className="apk-error">{error}</div>}

        <div className="apk-actions">
          <button
            type="button"
            className="apk-btn apk-btn--ghost"
            onClick={() => !submitting && onClose()}
            disabled={submitting}
          >
            Vazgeç
          </button>
          <button
            type="button"
            className="apk-btn apk-btn--primary"
            onClick={handleSave}
            disabled={submitting || unchanged}
          >
            {submitting ? "Kaydediliyor…" : "Kaydet"}
          </button>
        </div>
      </div>
    </div>
  );
}
