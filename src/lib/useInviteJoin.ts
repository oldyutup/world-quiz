import { useEffect, useRef } from "react";

/** Davet linki query parametre anahtarları. Conquest bu hook'u kullanmaz —
 *  conquest auto-join akışı App.tsx + ConquestMode.tsx içinde özel. */
export type InviteParamKey =
  | "duel"
  | "duelGroup"
  | "flagDuel"
  | "flagGroup"
  | "wheelDuel"
  | "wheelGroup"
  | "korNokta";

/** Davet linkinden gelen kodu standartlaştırır. Tüm modlarda oda kodu
 *  6 karakterli A-Z/0-9 olduğu için aynı normalize: trim → upper → strip
 *  → 6 karaktere kırp. Sonuç 6 karakterden kısaysa hook bunu "invalid" sayar
 *  ve auto-join tetiklemez. */
function normalizeInviteCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

interface UseInviteJoinOptions {
  paramKey: InviteParamKey;
  /** Modun lobby/setup ekranındaki oda kodu input state setter'ı. Misafir
   *  kullanıcı için tek görünür etki budur: kod inputa dolar. */
  setJoinCode: (code: string) => void;
  /** Auto-join koşulu: profile.username dolu, lobby/setup fazında ve henüz
   *  bir odaya bağlı değil. Parent false geçerse hook yalnızca prefill yapar. */
  canAutoJoin: boolean;
  /** Auto-join tetikleyici. Hook normalize edilmiş kodu argüman olarak verir;
   *  parent bunu join fonksiyonuna geçirmeli (joinCode state'i okumamalı,
   *  çünkü setJoinCode aynı render içinde henüz flush olmamış olabilir). */
  triggerJoin: (code: string) => void | Promise<void>;
}

/** Davet linki / oda kodu otomatik doldurma + giriş yapmış kullanıcı için
 *  tek-atış auto-join hook'u.
 *
 *  Akış:
 *  - Mount'ta URL'den `paramKey` query parametresini okur, normalize eder.
 *  - Geçerli (6 karakter) kodu setJoinCode ile input state'ine yazar.
 *  - `canAutoJoin` true olduğunda (mount sırasında ya da profile geç
 *    yüklendiği için sonradan true olduğunda) `triggerJoin(code)`'u
 *    bir kez çağırır.
 *  - Auto-join denendiği anda URL'den query param'ı temizler ki home'a
 *    dönüp moda tekrar gelindiğinde döngü oluşmasın. Misafir akışında
 *    auto-join hiç denenmediği için URL param'ı dokunulmaz; kullanıcı
 *    inputtaki kodu görmeye devam eder.
 *  - StrictMode double-mount ve canAutoJoin değişim re-run'larına karşı
 *    ref guard ile tek seferlik garanti. */
export function useInviteJoin({
  paramKey,
  setJoinCode,
  canAutoJoin,
  triggerJoin,
}: UseInviteJoinOptions): void {
  const inviteCodeRef = useRef<string | null>(null);
  const attemptedRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const raw = params.get(paramKey);
    if (!raw) return;
    const code = normalizeInviteCode(raw);
    if (!code) return;
    // Geçersiz (6'dan kısa) kod da inputa yazılır — kullanıcı linkten gelen
    // değeri görsün. Ama yalnızca tam 6 karakterli kod auto-join için
    // saklanır; aksi halde watcher sessizce atlar.
    setJoinCode(code);
    if (code.length === 6) {
      inviteCodeRef.current = code;
    }
    // setJoinCode kasten dep listesinde değil: hook ömrü boyunca aynı setter
    // beklenir ve yeniden binding'le mount logic'ini tekrarlamak istemiyoruz.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramKey]);

  useEffect(() => {
    if (!canAutoJoin) return;
    if (attemptedRef.current) return;
    const code = inviteCodeRef.current;
    if (!code || code.length !== 6) return;

    attemptedRef.current = true;

    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has(paramKey)) {
        url.searchParams.delete(paramKey);
        window.history.replaceState({}, "", url.toString());
      }
    } catch {
      /* history API yoksa sessiz geç */
    }

    void triggerJoin(code);
    // triggerJoin parent'tan render başına yeniden binding alabilir; attempted
    // ref guard nedeniyle tekrar çağrı tetiklenmez.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAutoJoin]);
}
