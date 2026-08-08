/**
 * LoginRequiredModal — "bu özellik için giriş yap" ekranı.
 *
 * NEDEN VAR: Misafire kapalı bir özelliğe (Kuşatma "Oda Kur" / "Odalara Göz
 * At") basıldığında butonu GİZLEMEK ya da sessizce hiçbir şey yapmamak ürün
 * davranışını belirsizleştirir. Kullanıcı butona basabilmeli ve özelliğin
 * neden kapalı olduğunu ANLAMALI — üstelik misafir olarak hâlâ ne
 * yapabileceğini (oda koduyla katılma) öğrenmeli.
 *
 * TASARIM: Mevcut seçim modallarının kabuğunu (`.overlay` + `.modal` +
 * `.modal-btn`) aynen kullanır. Kuşatma menüsünün görünümü ve yerleşimi
 * DEĞİŞTİRİLMEZ; bu ekran onun ÜSTÜNE gelir, yerine geçmez. Masaüstü ve mobil
 * aynı bileşeni paylaşır (ayrı yüzey yok).
 *
 * Bu bileşen bir GÜVENLİK KONTROLÜ DEĞİLDİR. Asıl yetki sunucudadır:
 *   • liste  → `conquest_list_public_rooms()` yalnız `authenticated`
 *   • kurma  → `conquest_rooms` INSERT policy'si yalnız `authenticated`
 * Buradaki kapı, kullanıcıya sunucunun zaten reddedeceği bir yolculuğu
 * baştan açıklamak içindir.
 */
import { playSound } from "../lib/sound";
import type { CSSProperties } from "react";

/** Hangi işlem için giriş isteniyor? Metinler buradan seçilir. */
export type LoginRequiredIntent = "conquest-browse" | "conquest-create";

/** Kullanıcının seçtiği yol — App auth modalını bu kipte açar. */
export type LoginRequiredChoice = "login" | "signup";

const COPY: Record<LoginRequiredIntent, { title: string; body: string }> = {
  "conquest-browse": {
    title: "Odalara göz atmak için giriş yap",
    body:
      "Açık odaları görüntülemek için giriş yapman veya hesap oluşturman " +
      "gerekiyor. Davet edildiğin bir odaya oda koduyla kayıt olmadan " +
      "katılabilirsin.",
  },
  "conquest-create": {
    title: "Oda kurmak için giriş yap",
    body:
      "Yeni bir oda oluşturmak için giriş yapman veya hesap oluşturman " +
      "gerekiyor. Davet edildiğin bir odaya oda koduyla kayıt olmadan " +
      "katılabilirsin.",
  },
};

interface Props {
  intent: LoginRequiredIntent;
  overlayStyle?: CSSProperties;
  themeAttr?: string;
  /** "Giriş Yap" / "Hesap Oluştur" — App auth modalını ilgili kipte açar ve
   *  bekleyen işlemi (liste / oda kurma) saklar. */
  onChoose: (choice: LoginRequiredChoice) => void;
  /** "Vazgeç" — hiçbir bekleyen işlem bırakmadan kapatır. */
  onCancel: () => void;
}

export default function LoginRequiredModal({
  intent,
  overlayStyle,
  themeAttr,
  onChoose,
  onCancel,
}: Props) {
  const copy = COPY[intent];

  return (
    <div
      className="overlay"
      style={overlayStyle}
      data-theme={themeAttr}
      role="dialog"
      aria-modal="true"
      aria-label={copy.title}
      onClick={onCancel}
    >
      <div className="modal lrm-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="lrm-title">{copy.title}</h2>

        <p className="lrm-body">{copy.body}</p>

        <button
          type="button"
          className="modal-btn lrm-primary"
          onClick={() => {
            playSound("click");
            onChoose("login");
          }}
        >
          Giriş Yap
        </button>

        <button
          type="button"
          className="modal-btn"
          onClick={() => {
            playSound("click");
            onChoose("signup");
          }}
        >
          Hesap Oluştur
        </button>

        <button
          type="button"
          className="lrm-cancel"
          onClick={() => {
            playSound("click");
            onCancel();
          }}
        >
          Vazgeç
        </button>

        <button
          type="button"
          className="modal-close"
          aria-label="Kapat"
          onClick={() => {
            playSound("click");
            onCancel();
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
