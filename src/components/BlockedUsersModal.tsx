/**
 * BlockedUsersModal.tsx — "Engellenen Kullanıcılar" yönetim ekranı.
 *
 * ProfileEditModal hub'ının 4. seçeneğinden açılır. Kullanıcının engellediği
 * oyuncuları (list_blocked_users RPC) listeler; her satırda avatar + @kullanıcı
 * adı + seviye + "Engeli Kaldır" butonu vardır. Engel kaldırma unblock_user
 * RPC'sinden geçer (SECURITY DEFINER; client doğrudan tabloya yazmaz). Engel
 * kaldırmak otomatik arkadaşlık KURMAZ.
 *
 * Premium koyu-mavi cam modal dili (.pem-* shell + .bul-* liste). Desktop/mobil
 * web ortak; native özel dosyalara dokunulmaz.
 */
import { useEffect, useState } from "react";
import { PlayerAvatar } from "./PlayerAvatar";
import { listBlockedUsers, unblockUser, type BlockedUserRow } from "../lib/social";
import { useSocialOptional } from "./SocialContext";

interface Props {
  onClose: () => void;
}

export function BlockedUsersModal({ onClose }: Props) {
  const social = useSocialOptional();
  const [rows, setRows] = useState<BlockedUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  /** Engeli kaldırılırken kilitlenen satırın profil id'si. */
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const data = await listBlockedUsers();
      if (!alive) return;
      setRows(data);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleUnblock(profileId: string) {
    if (busyId) return;
    setBusyId(profileId);
    const res = await unblockUser(profileId);
    if (res.ok) {
      setRows((prev) => prev.filter((r) => r.profileId !== profileId));
      social?.toast("Engel kaldırıldı.");
    } else {
      social?.toast("Engel kaldırılamadı, tekrar dene.");
    }
    setBusyId(null);
  }

  return (
    <div
      className="pem-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Engellenen Kullanıcılar"
      onClick={onClose}
    >
      <div className="pem-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="pem-close" onClick={onClose} aria-label="Kapat">
          ×
        </button>

        <div className="pem-head">
          <h2 className="pem-title">Engellenen Kullanıcılar</h2>
          <p className="pem-sub">Engellediğin kullanıcıları buradan kaldırabilirsin.</p>
        </div>

        <div className="bul-list">
          {loading ? (
            <p className="bul-empty">Yükleniyor…</p>
          ) : rows.length === 0 ? (
            <p className="bul-empty">Engellediğin kullanıcı yok.</p>
          ) : (
            rows.map((r) => (
              <div key={r.profileId} className="bul-row">
                <PlayerAvatar
                  avatarId={r.avatarId}
                  username={r.username}
                  size="md"
                  frameId={r.activeAvatarFrameId}
                />
                <div className="bul-id">
                  <span className="bul-name">@{r.username ?? "—"}</span>
                  <span className="bul-level">Seviye {r.level}</span>
                </div>
                <button
                  type="button"
                  className="bul-unblock"
                  onClick={() => void handleUnblock(r.profileId)}
                  disabled={busyId === r.profileId}
                >
                  {busyId === r.profileId ? "…" : "Engeli Kaldır"}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
