import { serverEndpoint } from "./endpoint";
import { Client } from "@colyseus/sdk";

export function createLobbyClient() {
  const endpoint = serverEndpoint(
    import.meta.env.VITE_PARTY_LAB_SERVER_URL,
    import.meta.env.DEV,
    window.location
  );
  return new Client(endpoint);
}

export function lobbyError(error: unknown): string {
  const data = error as { code?: number; message?: string } | null;
  const message = data?.message ?? "";
  if (message === "SERVER_NOT_CONFIGURED")
    return "Çevrimiçi lobi henüz bu ortamda açık değil. Yerel arenayı deneyebilirsin.";
  if (message === "PROTOCOL_MISMATCH")
    return "Party Lab güncellendi. Sayfayı yenileyip tekrar dene.";
  if (message === "INVALID_NICKNAME")
    return "Takma adın 3–16 harf, rakam, _ veya - içermeli.";
  if (message === "INVALID_CODE")
    return "Oda kodunu kontrol et. 6 karakter kullan; I, O, 0 ve 1 kodlarda yer almaz.";
  if (/full|locked/i.test(message))
    return "Oda dolu. En fazla 3 kişi katılabilir; yeniden bağlanan arkadaşların yeri kısa süre tutulur.";
  if (
    data?.code === 522 ||
    /not found|not defined|does not exist/i.test(message)
  )
    return "Oda bulunamadı. Kodu kontrol et veya yeni bir oda oluştur.";
  if (data?.code === 400)
    return "Odaya katılım kabul edilmedi. Bilgilerini kontrol edip tekrar dene.";
  return "Lobi sunucusuna ulaşılamadı. Bağlantını kontrol edip tekrar dene.";
}
