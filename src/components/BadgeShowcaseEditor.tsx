/**
 * BadgeShowcaseEditor.tsx — "Rozetleri Sergile" seçim ekranı.
 *
 * Kullanıcı kazandığı başarım rozetlerinden (achievement avatarları, avatar_ach_*)
 * en fazla 5 tanesini seçip profil kartında sergiler. Seçim sırası = profil
 * kartındaki görüntü sırası. Kilitli başarımlar gri/disabled gösterilir, seçilemez.
 *
 * KALICILIK: profile_cosmetics.showcased_badge_ids (RLS: yalnız sahibi yazar —
 * bkz. 20260715121000_social_core.sql). Yeni migration GEREKMEZ; alan zaten var.
 * Mevcut achievement/avatar/XP/Gold sistemlerine dokunmaz; yalnız okuyup yazdığı
 * tek alan showcased_badge_ids.
 *
 * GÜVENLİK: yalnız gerçekten açılmış (sticky unlocked) rozetler seçilebilir;
 * kaydetmeden hemen önce ayrıca açıklık doğrulanır (client guard). Yazma yolu
 * RLS ile sahibe kilitli olduğundan başka kullanıcının vitrini değiştirilemez.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Profile } from "../lib/auth";
import { getAvatar } from "../data/avatars";
import { Avatar } from "./Avatar";
import {
  ACHIEVEMENT_TIERS,
  isAchievementTierUnlocked,
  useAchievementState,
  type AchievementTierMeta,
} from "../lib/achievementStats";
import { getMyCosmetics, saveShowcasedBadges } from "../lib/social";
import { useSocialOptional } from "./SocialContext";

const MAX_BADGES = 5;

/** Grup id → görünen aile adı (achievement tier'larıyla senkron). */
const GROUP_TITLES: Record<string, string> = {
  world_traveler: "Dünya Gezgini",
  flag_master: "Bayrak Ustası",
  streak_player: "Seri Oyuncu",
  versatile_player: "Çok Yönlü Oyuncu",
  win_streak: "Seri Galibiyet",
};

interface GroupView {
  groupId: string;
  title: string;
  tiers: AchievementTierMeta[];
}

/** ACHIEVEMENT_TIERS'i sırayı koruyarak ailelere böler. */
function buildGroups(): GroupView[] {
  const order: string[] = [];
  const map = new Map<string, AchievementTierMeta[]>();
  for (const meta of ACHIEVEMENT_TIERS) {
    if (!map.has(meta.groupId)) {
      map.set(meta.groupId, []);
      order.push(meta.groupId);
    }
    map.get(meta.groupId)!.push(meta);
  }
  return order.map((groupId) => ({
    groupId,
    title: GROUP_TITLES[groupId] ?? groupId,
    tiers: map.get(groupId)!,
  }));
}

interface Props {
  profile: Profile;
  onClose: () => void;
  /** Başarılı kayıttan sonra (toast + state) — App yönetir. */
  onSaved: (badgeIds: string[]) => void;
}

export function BadgeShowcaseEditor({ profile, onClose, onSaved }: Props) {
  const { stats, unlocks } = useAchievementState();
  const social = useSocialOptional();
  const groups = useMemo(buildGroups, []);

  // Seçili rozetler (avatar_ach_* id), SIRA = sergileme sırası.
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Açık (seçilebilir) rozet avatar id seti — sticky unlock'a göre.
  const unlockedSet = useMemo(() => {
    const s = new Set<string>();
    for (const meta of ACHIEVEMENT_TIERS) {
      if (isAchievementTierUnlocked(meta, stats, unlocks)) s.add(meta.avatarId);
    }
    return s;
  }, [stats, unlocks]);

  const hasAnyUnlocked = unlockedSet.size > 0;

  // Mevcut vitrini yükle (kalıcı alandan). Yalnız geçerli achievement avatarları.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const cos = await getMyCosmetics(profile.id);
      if (!alive) return;
      const valid = cos.showcasedBadgeIds.filter((id) => !!getAvatar(id)).slice(0, MAX_BADGES);
      setSelected(valid);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [profile.id]);

  useEffect(
    () => () => {
      if (noteTimer.current) clearTimeout(noteTimer.current);
    },
    []
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  function flashNote(msg: string) {
    setNote(msg);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 2200);
  }

  function toggle(avatarId: string) {
    if (!unlockedSet.has(avatarId)) {
      flashNote("Bu rozet henüz açılmadı.");
      return;
    }
    setSelected((prev) => {
      if (prev.includes(avatarId)) return prev.filter((id) => id !== avatarId);
      if (prev.length >= MAX_BADGES) {
        flashNote(`En fazla ${MAX_BADGES} rozet sergileyebilirsin.`);
        return prev;
      }
      return [...prev, avatarId];
    });
  }

  function removeAt(index: number) {
    setSelected((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    try {
      // Client guard: yalnız gerçekten açık rozetleri, sırayı koruyarak yaz.
      const safe = selected.filter((id) => unlockedSet.has(id)).slice(0, MAX_BADGES);
      const res = await saveShowcasedBadges(profile.id, safe);
      if (res.ok) {
        social?.toast("Sergilenen rozetler güncellendi.");
        onSaved(safe);
      } else {
        flashNote("Kaydedilemedi, tekrar dene.");
      }
    } finally {
      setSaving(false);
    }
  }

  // Üst önizleme — 5 slot: seçilenler (sıralı) + boş dashed.
  const previewSlots = Array.from({ length: MAX_BADGES }, (_, i) => selected[i] ?? null);

  return (
    <div
      className="bse-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Rozetleri Sergile"
      onClick={() => !saving && onClose()}
    >
      <div className="bse-modal" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="bse-close"
          onClick={() => !saving && onClose()}
          aria-label="Kapat"
        >
          ×
        </button>

        <div className="bse-head">
          <h2 className="bse-title">Rozetleri Sergile</h2>
          <p className="bse-sub">
            Profilinde göstermek için en fazla {MAX_BADGES} başarım rozeti seç.
          </p>
        </div>

        {/* Profil önizlemesi */}
        <div className="bse-preview">
          <Avatar avatarId={profile.avatar_id} username={profile.username} size={48} />
          <div className="bse-preview-id">
            <span className="bse-preview-name">@{profile.username ?? "—"}</span>
            <span className="bse-preview-level">Seviye {profile.level}</span>
          </div>
          <div className="bse-preview-slots" aria-label="Sergilenen rozetler">
            {previewSlots.map((id, i) => {
              const def = id ? getAvatar(id) : null;
              return (
                <button
                  key={i}
                  type="button"
                  className={`bse-slot${def ? " bse-slot--filled" : " bse-slot--empty"}`}
                  onClick={def ? () => removeAt(i) : undefined}
                  disabled={!def}
                  title={def ? `${def.label} — kaldır` : undefined}
                  aria-label={def ? `${def.label} — kaldır` : "Boş slot"}
                >
                  {def ? (
                    <img src={def.image} alt={def.label} className="bse-slot-img" />
                  ) : (
                    <span className="bse-slot-plus" aria-hidden="true">
                      +
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="bse-body">
          {loading ? (
            <p className="bse-empty">Yükleniyor…</p>
          ) : !hasAnyUnlocked ? (
            <p className="bse-empty">Henüz sergileyebileceğin başarım yok.</p>
          ) : (
            groups.map((group) => (
              <section key={group.groupId} className="bse-group">
                <span className="bse-group-title">{group.title}</span>
                <div className="bse-grid">
                  {group.tiers.map((meta) => {
                    const def = getAvatar(meta.avatarId);
                    if (!def) return null;
                    const unlocked = unlockedSet.has(meta.avatarId);
                    const order = selected.indexOf(meta.avatarId);
                    const isSelected = order !== -1;
                    return (
                      <button
                        key={meta.avatarId}
                        type="button"
                        className={
                          "bse-tile" +
                          (unlocked ? "" : " bse-tile--locked") +
                          (isSelected ? " bse-tile--selected" : "")
                        }
                        onClick={() => toggle(meta.avatarId)}
                        aria-pressed={isSelected}
                        aria-disabled={!unlocked}
                        title={
                          unlocked ? def.label : `${def.label} — başarımla açılır`
                        }
                      >
                        <span className="bse-tile-img-wrap">
                          <img src={def.image} alt={def.label} className="bse-tile-img" />
                          {!unlocked && (
                            <span className="bse-tile-lock" aria-hidden="true">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                                <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.5" />
                                <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
                              </svg>
                            </span>
                          )}
                          {isSelected && (
                            <span className="bse-tile-order" aria-hidden="true">
                              {order + 1}
                            </span>
                          )}
                        </span>
                        <span className="bse-tile-label">{def.label}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))
          )}
        </div>

        {note && (
          <div className="bse-note" role="status">
            {note}
          </div>
        )}

        <div className="bse-actions">
          <button
            type="button"
            className="bse-btn bse-btn--ghost"
            onClick={() => !saving && onClose()}
            disabled={saving}
          >
            Vazgeç
          </button>
          <button
            type="button"
            className="bse-btn bse-btn--primary"
            onClick={handleSave}
            disabled={saving || loading}
          >
            {saving ? "Kaydediliyor…" : "Kaydet"}
          </button>
        </div>
      </div>
    </div>
  );
}
