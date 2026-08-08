/**
 * GuestEndPrompt.tsx — misafir oyun-sonu "hesap oluştur" bölümü.
 *
 * Maç sonuç ekranında, normal sonuçların YANINDA gösterilen sade bir bölüm.
 * Sonuç kartının kendisine dokunmaz; modların mevcut "Lobiye Dön" / "Odadan
 * Ayrıl" butonları olduğu gibi kalır (bu bileşen onları TEKRAR ETMEZ).
 *
 * DÜRÜST METİN — NEDEN GEÇMİŞ MAÇIN ÖDÜLÜNÜ VAAT ETMİYORUZ:
 * Mevcut XP mimarisinde maç sonucu sunucuda yeniden hesaplanmıyor; istemci
 * kazanılan XP'yi kendisi gönderiyor ve sunucu yalnız [0,500] aralığına
 * clamp'liyor. Bu yüzden "misafirken kazandığın XP'yi hesabına aktar"
 * özelliği doğrulanabilir bir sunucu-tarafı maç kaydı olmadan güvenle
 * yapılamaz (isteyene XP veren uç nokta hâline gelirdi). V1'de geçmiş maç
 * ödülü AKTARILMAZ; oyuncu hesabını açar, odadaki yerini korur ve BİR SONRAKİ
 * turdan itibaren normal şekilde kazanır. Metin bunu net söyler.
 *
 * Butona basıldığında global bir olay yayınlanır; App.tsx bunu dinleyip auth
 * modalını açar. Böylece sekiz oyun bileşenine ayrı ayrı prop geçirmek
 * gerekmez ve oyun bileşenleri auth akışından habersiz kalır.
 */
import { playSound } from "../lib/sound";

/** App.tsx'in dinlediği olay adı (tek doğruluk kaynağı). */
export const GUEST_SIGNUP_EVENT = "torble:guest-signup";

export function requestGuestSignup(): void {
  try {
    window.dispatchEvent(new CustomEvent(GUEST_SIGNUP_EVENT));
  } catch {
    /* CustomEvent yoksa sessiz geç */
  }
}

interface Props {
  /** Yalnız misafirde render edilir; çağıran taraf `!profile?.username` geçer. */
  visible: boolean;
}

export default function GuestEndPrompt({ visible }: Props) {
  if (!visible) return null;

  return (
    <div className="gep-card" role="complementary" aria-label="Hesap oluştur">
      <div className="gep-head">
        <span className="gep-icon" aria-hidden="true">✨</span>
        <h4 className="gep-title">Torble'a devam etmek için hesap oluştur</h4>
      </div>
      <p className="gep-body">
        Hesap oluşturarak sonraki oyunlarda XP, altın ve istatistik kazanmaya
        başlayabilirsin.
      </p>
      <button
        type="button"
        className="gep-cta"
        onClick={() => {
          playSound("click");
          requestGuestSignup();
        }}
      >
        Hesap Oluştur
      </button>
      <button
        type="button"
        className="gep-login"
        onClick={() => {
          playSound("click");
          requestGuestSignup();
        }}
      >
        Zaten hesabın var mı? Giriş Yap
      </button>
    </div>
  );
}
