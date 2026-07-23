/**
 * legal/content/support.ts
 *
 * Destek sayfası içeriği (TR + EN). Yalnızca uygulamada GERÇEKTEN bulunan
 * özelliklere dayanır:
 *   • Giriş: e-posta+şifre, Google ile Giriş, Apple ile Giriş; şifre sıfırlama
 *     (forgot / recovery) mevcut.
 *   • Hesap silme: uygulama içi Hesap Ayarları > "Hesap".
 *   • Kullanıcı adı değişimi (ilk ücretsiz, sonrası Gold + bekleme), avatar,
 *     profil düzenleme.
 *   • Arkadaşlık, engelleme, bildirim merkezi (temizleme dahil).
 *   • DM, oda kodları, çok oyunculu bağlantı.
 *   • Uygulama içi RAPORLAMA: profil kartından kullanıcı bildirme
 *     (Bildir / Bildir ve Engelle) + DM ve lobi/oyun sohbeti mesaj menüsünden
 *     mesaj bildirme. E-posta itiraz/ek destek kanalı olarak korunur.
 *
 * Bölüm id'leri TR ve EN'de birebir aynıdır (assertParallelDoc dev kontrolü).
 */
import type { LegalDoc, Localized } from "./types";
import { CONTACT_EMAIL } from "./chrome";

export const SUPPORT: Localized<LegalDoc> = {
  /* ─────────────────────────────── TÜRKÇE ─────────────────────────────── */
  tr: {
    kind: "support",
    title: "Destek",
    tagline:
      "Torble ile ilgili en sık karşılaşılan konular ve bize nasıl ulaşabileceğin.",
    metaDescription:
      "Torble Destek — giriş ve şifre, Apple/Google ile giriş, hesap silme, kullanıcı adı, arkadaşlık, mesajlaşma ve gizlilik konularında yardım.",
    intro: [
      {
        type: "p",
        text: "Torble destek sayfasına hoş geldin. Aşağıda en sık sorulan konulara yanıtlar var. Aradığını bulamazsan e-posta ile bize her zaman ulaşabilirsin.",
      },
    ],
    sections: [
      {
        id: "contact",
        heading: "İletişim",
        blocks: [
          {
            type: "p",
            text: "Her türlü soru, sorun ve talep için tek iletişim kanalımız:",
          },
          {
            type: "contact",
            label: "E-posta",
            email: CONTACT_EMAIL,
          },
          {
            type: "p",
            text: "Yardımcı olabilmemiz için mümkünse kullanıcı adını ve karşılaştığın sorunu kısaca anlat.",
          },
        ],
      },
      {
        id: "login",
        heading: "Hesaba giriş ve şifre sıfırlama",
        blocks: [
          {
            type: "p",
            text: "Torble'a e-posta ve şifre, Google ile Giriş veya Apple ile Giriş kullanarak girebilirsin.",
          },
          {
            type: "list",
            items: [
              "Şifreni unuttuysan, giriş ekranındaki şifre sıfırlama akışını kullanarak e-posta adresine bir sıfırlama bağlantısı isteyebilirsin.",
              "Sıfırlama e-postasını göremiyorsan spam/gereksiz klasörünü kontrol et ve e-posta adresini doğru yazdığından emin ol.",
              "Google veya Apple ile giriş yaptıysan ve ayrıca bir şifre belirlemek istersen, giriş yaptıktan sonra Hesap Ayarları'ndaki Şifre bölümünden şifre oluşturabilirsin.",
            ],
          },
        ],
      },
      {
        id: "social-login",
        heading: "Apple ve Google ile giriş sorunları",
        blocks: [
          {
            type: "p",
            text: "Apple ya da Google ile girişte sorun yaşıyorsan şunları deneyebilirsin:",
          },
          {
            type: "list",
            items: [
              "Cihazında ilgili Apple veya Google hesabında oturum açık olduğundan emin ol.",
              "İnternet bağlantını kontrol et ve giriş penceresini kapatıp yeniden dene.",
              "Apple ile Giriş'te \"E-postamı Gizle\" seçtiysen, sana ulaşan bildirimler bir yönlendirme adresi üzerinden gelebilir.",
              "Sorun sürerse uygulamayı kapatıp yeniden açmayı dene; devam ederse e-posta ile bize bildir.",
            ],
          },
        ],
      },
      {
        id: "delete-account",
        heading: "Hesap silme",
        blocks: [
          {
            type: "p",
            text: "Hesabını uygulama içinden kalıcı olarak silebilirsin. Bu işlem geri alınamaz.",
          },
          {
            type: "list",
            ordered: true,
            items: [
              "Profil menüsünden Hesap Ayarları'nı aç.",
              "\"Hesap\" bölümüne geç.",
              "Silme onayını ver; e-posta+şifre ile giriş yapıyorsan mevcut şifreni doğrula. Apple ile Giriş kullanıyorsan bir Apple onay penceresi açılır.",
            ],
          },
          {
            type: "p",
            text: "Silme sonrası hesabın ve kişisel verilerin kaldırılır; geçmiş çok oyunculu maç kayıtlarındaki adın anonimleştirilir. Ayrıntılar için Gizlilik Politikası'nın hesap silme bölümüne bakabilirsin.",
          },
        ],
      },
      {
        id: "username-profile",
        heading: "Kullanıcı adı ve profil sorunları",
        blocks: [
          {
            type: "p",
            text: "Kullanıcı adını, avatarını ve profil görünümünü uygulama içinden yönetebilirsin.",
          },
          {
            type: "list",
            items: [
              "İlk kullanıcı adı seçimin ücretsizdir; sonraki değişiklikler bir miktar Gold gerektirir ve belirli bir bekleme süresine tabidir.",
              "Kullanıcı adları benzersizdir; seçtiğin ad başkası tarafından kullanılıyorsa farklı bir ad denemen gerekir.",
              "Avatarını ve profil görünümünü profil düzenleme bölümünden güncelleyebilirsin.",
            ],
          },
        ],
      },
      {
        id: "friends",
        heading: "Arkadaşlık, engelleme ve bildirimler",
        blocks: [
          {
            type: "list",
            items: [
              "Diğer oyunculara arkadaşlık isteği gönderebilir, sana gelen istekleri kabul edebilir veya reddedebilirsin.",
              "İstenmeyen etkileşimleri sınırlamak için bir kullanıcıyı engelleyebilir, dilediğinde engeli kaldırabilirsin.",
              "Bildirim merkezinden arkadaşlık isteği, oyun daveti ve başarım gibi bildirimlerini görebilir; bildirimlerini temizleyebilirsin.",
            ],
          },
        ],
      },
      {
        id: "multiplayer",
        heading: "Mesaj, oda ve çok oyunculu bağlantı sorunları",
        blocks: [
          {
            type: "p",
            text: "Çok oyunculu modlar ve mesajlaşma gerçek zamanlı bir bağlantıya dayanır. Sorun yaşarsan:",
          },
          {
            type: "list",
            items: [
              "İnternet bağlantının kararlı olduğundan emin ol; zayıf bağlantı, odalara katılmayı ve mesajların iletilmesini etkileyebilir.",
              "Bir odaya kodla katılırken kodun doğru ve güncel olduğundan emin ol; odalar bir süre sonra kapanabilir.",
              "Bağlantı göstergesi sorunu işaret ediyorsa, ekranı yenilemeyi veya odadan çıkıp yeniden katılmayı dene.",
              "Özel mesajların (DM) iletilmediğini düşünüyorsan bağlantını kontrol et ve tekrar dene.",
            ],
          },
        ],
      },
      {
        id: "report",
        heading: "Uygunsuz kullanıcı veya içerik bildirimi",
        blocks: [
          {
            type: "p",
            text: "Uygunsuz bir kullanıcı adı, profil ya da mesajla karşılaşırsan bunu doğrudan uygulama içinden bildirebilirsin.",
          },
          {
            type: "list",
            items: [
              "Bir kullanıcıyı bildirmek için profil kartını aç ve \"Bildir\" veya \"Bildir ve Engelle\" seçeneğini kullan.",
              "Bir mesajı bildirmek için (özel mesaj ya da oyun/lobi sohbeti) mesajın yanındaki seçenekler menüsünü açıp \"Mesajı bildir\"i seç.",
              "Bir neden seç; istersen kısa bir açıklama ekleyebilirsin. Bildirimin, bildirdiğin kişiye gösterilmez.",
              "Dilersen bildirmeyle birlikte kullanıcıyı engelleyerek etkileşimleri hemen sınırlayabilirsin.",
            ],
          },
          {
            type: "p",
            text: `Bildirimler güvenlik ekibimizce incelenir; gerekli gördüğümüzde içeriği kaldırma, uyarı, hesabı geçici olarak kısıtlama veya kalıcı olarak yasaklama gibi işlemler uygulayabiliriz. Uygulama içinden çözemediğin durumlar, itirazlar veya ek destek için her zaman ${CONTACT_EMAIL} adresinden bize yazabilirsin.`,
          },
        ],
      },
      {
        id: "privacy-requests",
        heading: "Gizlilik talepleri",
        blocks: [
          {
            type: "p",
            text: "Kişisel verilerine erişmek, bunları düzeltmek veya silmek istersen çoğu işlemi doğrudan uygulama içinden yapabilirsin (profilini düzenleyebilir, hesabını silebilirsin).",
          },
          {
            type: "p",
            text: `Ek gizlilik talepleri için ${CONTACT_EMAIL} adresinden bize ulaş. Verilerini nasıl işlediğimizin ayrıntıları Gizlilik Politikası'nda yer alır.`,
          },
        ],
      },
      {
        id: "faq",
        heading: "Sık sorulan sorular",
        blocks: [
          {
            type: "subheading",
            text: "Torble ücretsiz mi?",
          },
          {
            type: "p",
            text: "Torble ücretsizdir. Bazı tek oyunculu modları hesap oluşturmadan deneyebilirsin. Çevrim içi oyunlar, arkadaşlık, mesajlaşma, sıralamalar ve ilerleme özellikleri için hesap gerekir. Gold, oynayarak kazanılan uygulama içi bir sanal birimdir ve uygulama dışında parasal değeri yoktur.",
          },
          {
            type: "subheading",
            text: "Gold nedir, satın alınabilir mi?",
          },
          {
            type: "p",
            text: "Gold, oyun içinde (örneğin günlük bonus ve oynanışla) kazanılan ve kullanıcı adı değişikliği gibi bazı işlemlerde harcanan sanal bir birimdir.",
          },
          {
            type: "subheading",
            text: "Şifremi nasıl değiştiririm?",
          },
          {
            type: "p",
            text: "Giriş yaptıktan sonra Hesap Ayarları'ndaki Şifre bölümünden şifreni değiştirebilir veya (Google/Apple ile giriş yapıyorsan) bir şifre belirleyebilirsin.",
          },
          {
            type: "subheading",
            text: "Verilerim üçüncü taraflara satılıyor mu?",
          },
          {
            type: "p",
            text: "Hayır. Verilerini satmıyor, reklam amacıyla üçüncü taraflarla paylaşmıyoruz. Ayrıntılar için Gizlilik Politikası'na bakabilirsin.",
          },
        ],
      },
      {
        id: "privacy-link",
        heading: "Gizlilik Politikası",
        blocks: [
          {
            type: "p",
            text: "Verilerini nasıl işlediğimizi öğrenmek için Gizlilik Politikamızı okuyabilirsin. Bu sayfanın altındaki bağlantıdan ulaşabilirsin.",
          },
        ],
      },
    ],
  },

  /* ─────────────────────────────── ENGLISH ────────────────────────────── */
  en: {
    kind: "support",
    title: "Support",
    tagline: "The most common Torble topics and how to reach us.",
    metaDescription:
      "Torble Support — help with login and password, Apple/Google sign-in, account deletion, usernames, friends, messaging, and privacy.",
    intro: [
      {
        type: "p",
        text: "Welcome to Torble support. Below are answers to the most common topics. If you can't find what you're looking for, you can always reach us by email.",
      },
    ],
    sections: [
      {
        id: "contact",
        heading: "Contact",
        blocks: [
          {
            type: "p",
            text: "Our single contact channel for any question, issue, or request:",
          },
          {
            type: "contact",
            label: "Email",
            email: CONTACT_EMAIL,
          },
          {
            type: "p",
            text: "To help us assist you, please include your username and a short description of the issue where possible.",
          },
        ],
      },
      {
        id: "login",
        heading: "Account login and password reset",
        blocks: [
          {
            type: "p",
            text: "You can sign in to Torble using email and password, Sign in with Google, or Sign in with Apple.",
          },
          {
            type: "list",
            items: [
              "If you forgot your password, you can request a reset link to your email address using the password reset flow on the sign-in screen.",
              "If you don't see the reset email, check your spam/junk folder and make sure you entered your email address correctly.",
              "If you signed in with Google or Apple and also want to set a password, you can create one from the Password section in Account Settings after signing in.",
            ],
          },
        ],
      },
      {
        id: "social-login",
        heading: "Apple and Google sign-in issues",
        blocks: [
          {
            type: "p",
            text: "If you're having trouble signing in with Apple or Google, you can try the following:",
          },
          {
            type: "list",
            items: [
              "Make sure you're signed in to the relevant Apple or Google account on your device.",
              "Check your internet connection and try closing and reopening the sign-in window.",
              "If you chose \"Hide My Email\" with Sign in with Apple, notifications may reach you via a relay address.",
              "If the problem persists, try closing and reopening the app; if it continues, let us know by email.",
            ],
          },
        ],
      },
      {
        id: "delete-account",
        heading: "Account deletion",
        blocks: [
          {
            type: "p",
            text: "You can permanently delete your account from inside the app. This action cannot be undone.",
          },
          {
            type: "list",
            ordered: true,
            items: [
              "Open Account Settings from the profile menu.",
              "Go to the \"Account\" section.",
              "Confirm deletion; if you sign in with email and password, verify your current password. If you use Sign in with Apple, an Apple confirmation prompt will open.",
            ],
          },
          {
            type: "p",
            text: "After deletion, your account and personal data are removed, and your name in past multiplayer match records is anonymized. For details, see the account deletion section of the Privacy Policy.",
          },
        ],
      },
      {
        id: "username-profile",
        heading: "Username and profile issues",
        blocks: [
          {
            type: "p",
            text: "You can manage your username, avatar, and profile appearance from inside the app.",
          },
          {
            type: "list",
            items: [
              "Your first username choice is free; subsequent changes require some Gold and are subject to a cooldown period.",
              "Usernames are unique; if the name you want is already in use, you'll need to try a different one.",
              "You can update your avatar and profile appearance from the profile editing section.",
            ],
          },
        ],
      },
      {
        id: "friends",
        heading: "Friends, blocking, and notifications",
        blocks: [
          {
            type: "list",
            items: [
              "You can send friend requests to other players and accept or decline the requests you receive.",
              "To limit unwanted interactions, you can block a user and unblock them whenever you like.",
              "From the notification center you can see notifications such as friend requests, game invites, and achievements, and you can clear your notifications.",
            ],
          },
        ],
      },
      {
        id: "multiplayer",
        heading: "Message, room, and multiplayer connection issues",
        blocks: [
          {
            type: "p",
            text: "Multiplayer modes and messaging rely on a realtime connection. If you run into issues:",
          },
          {
            type: "list",
            items: [
              "Make sure your internet connection is stable; a weak connection can affect joining rooms and delivering messages.",
              "When joining a room with a code, make sure the code is correct and current; rooms can close after a while.",
              "If the connection indicator signals a problem, try refreshing the screen or leaving and rejoining the room.",
              "If you think your direct messages (DMs) aren't being delivered, check your connection and try again.",
            ],
          },
        ],
      },
      {
        id: "report",
        heading: "Reporting inappropriate users or content",
        blocks: [
          {
            type: "p",
            text: "If you come across an inappropriate username, profile, or message, you can report it directly from inside the app.",
          },
          {
            type: "list",
            items: [
              "To report a user, open their profile card and use \"Report\" or \"Report and Block\".",
              "To report a message (a direct message or a game/lobby chat message), open the options menu next to the message and choose \"Report message\".",
              "Pick a reason; you can add a short note if you like. Your report is not shown to the person you reported.",
              "If you wish, you can block the user together with reporting to immediately limit interactions.",
            ],
          },
          {
            type: "p",
            text: `Reports are reviewed by our safety team; where necessary, we may take actions such as removing content, issuing a warning, temporarily restricting an account, or permanently banning it. For anything you can't resolve in the app, for appeals, or for extra support, you can always email us at ${CONTACT_EMAIL}.`,
          },
        ],
      },
      {
        id: "privacy-requests",
        heading: "Privacy requests",
        blocks: [
          {
            type: "p",
            text: "If you want to access, correct, or delete your personal data, you can do most of it directly inside the app (you can edit your profile and delete your account).",
          },
          {
            type: "p",
            text: `For additional privacy requests, contact us at ${CONTACT_EMAIL}. Details of how we process your data are in the Privacy Policy.`,
          },
        ],
      },
      {
        id: "faq",
        heading: "Frequently asked questions",
        blocks: [
          {
            type: "subheading",
            text: "Is Torble free?",
          },
          {
            type: "p",
            text: "Torble is free. You can try some single-player modes without creating an account. Online games, friends, messaging, leaderboards, and progression features require an account. Gold is an in-app virtual currency earned by playing and has no monetary value outside the app.",
          },
          {
            type: "subheading",
            text: "What is Gold, and can it be purchased?",
          },
          {
            type: "p",
            text: "Gold is a virtual currency earned in the game (for example, through the daily bonus and gameplay) and spent on certain actions such as changing your username.",
          },
          {
            type: "subheading",
            text: "How do I change my password?",
          },
          {
            type: "p",
            text: "After signing in, you can change your password from the Password section in Account Settings, or (if you sign in with Google/Apple) set a password there.",
          },
          {
            type: "subheading",
            text: "Is my data sold to third parties?",
          },
          {
            type: "p",
            text: "No. We do not sell your data or share it with third parties for advertising. For details, see the Privacy Policy.",
          },
        ],
      },
      {
        id: "privacy-link",
        heading: "Privacy Policy",
        blocks: [
          {
            type: "p",
            text: "To learn how we process your data, you can read our Privacy Policy. You can reach it from the link at the bottom of this page.",
          },
        ],
      },
    ],
  },
};
