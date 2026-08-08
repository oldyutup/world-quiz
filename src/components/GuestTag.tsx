/**
 * GuestTag.tsx — lobi/oyuncu listelerindeki küçük "Misafir" etiketi.
 *
 * Misafir oyuncular normal oyuncular gibi görünür; yanlarında yalnız sade bir
 * etiket bulunur. Amaç kayıtlı bir oyuncunun taklit edilme riskini azaltmak,
 * arayüzü kalabalıklaştırmak DEĞİL.
 *
 * Kaynak sinyal: oyuncu satırındaki `profile_id === null`. Ayrı bir kolon veya
 * client bayrağı YOKTUR — sunucudaki satırın kendisi tek doğruluk kaynağıdır,
 * bu yüzden istemci tarafından sahtelenemez.
 *
 * Görsel: mevcut `.duel-tag` ailesinin sessiz bir varyantı (`.duel-tag.guest`),
 * kayıtlı kullanıcı rozeti gibi görünmez ve mobilde satırı taşırmaz.
 */
export function GuestTag({ className }: { className?: string }) {
  return (
    <span
      className={"duel-tag guest" + (className ? " " + className : "")}
      title="Bu oyuncu misafir olarak katıldı"
    >
      Misafir
    </span>
  );
}

export default GuestTag;
