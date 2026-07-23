/**
 * legal/content/privacy.ts
 *
 * Gizlilik Politikası içeriği (TR + EN). İçerik, kod tabanında DOĞRULANMIŞ
 * gerçek veri işleme davranışlarına dayanır:
 *   • Kimlik doğrulama: e-posta+şifre, Google ile Giriş, Apple ile Giriş —
 *     tümü Supabase Auth üzerinden.
 *   • Arka uç: Supabase (Auth, Postgres veritabanı, Edge Functions, Realtime).
 *   • Üçüncü taraflar: Apple (Giriş + App Store), Google (Giriş + web fontları),
 *     harita karo sağlayıcıları (MapTiler / OpenStreetMap tabanlı — yalnız
 *     harita modlarında), web statik barındırma.
 *   • Reklam ağı / üçüncü taraf analytics / izleme SDK'sı YOK; veri satışı YOK.
 *   • Hesap silme: uygulama içi Hesap Ayarları; cascade silme + geçmiş oyun
 *     kayıtlarının anonimleştirilmesi + Apple yetkilendirme iptali denemesi.
 *
 * Bölüm id'leri TR ve EN'de birebir aynıdır (assertParallelDoc dev kontrolü).
 */
import type { LegalDoc, Localized } from "./types";
import { CONTACT_EMAIL } from "./chrome";

export const PRIVACY: Localized<LegalDoc> = {
  /* ─────────────────────────────── TÜRKÇE ─────────────────────────────── */
  tr: {
    kind: "privacy",
    title: "Gizlilik Politikası",
    tagline:
      "Torble'da hangi bilgileri işlediğimizi, neden işlediğimizi ve üzerinde ne gibi haklarının olduğunu sade bir dille anlatır.",
    metaDescription:
      "Torble Gizlilik Politikası — topladığımız veriler, kullanım amaçları, hizmet sağlayıcılar, saklama, hesap silme ve kullanıcı hakları.",
    intro: [
      {
        type: "p",
        text: "Torble, dünya coğrafyasını öğrenmeyi eğlenceli bir oyuna dönüştüren bir coğrafya bilgi yarışması uygulamasıdır. Bu Gizlilik Politikası, Torble'ı web'de ve mobil uygulama olarak kullandığında hangi kişisel verileri işlediğimizi, bunları neden işlediğimizi ve haklarını nasıl kullanabileceğini açıklar. Bu metin, aynı zamanda 6698 sayılı Kişisel Verilerin Korunması Kanunu (KVKK) kapsamında bir bilgilendirme (aydınlatma) amacı da taşır.",
      },
      {
        type: "p",
        text: "Amacımız gizliliğine saygılı, sade bir hizmet sunmak. Reklam göstermiyor, üçüncü taraf reklam ağları veya izleme SDK'ları kullanmıyor ve verilerini satmıyoruz.",
      },
    ],
    sections: [
      {
        id: "scope",
        heading: "1. Torble ve bu politikanın kapsamı",
        blocks: [
          {
            type: "p",
            text: "Bu politika, Torble uygulamasının kendisi (iOS uygulaması ve web sürümü) tarafından işlenen verileri kapsar. Torble içinde hesabınla oynadığında, arkadaş eklediğinde, mesajlaştığında ya da çok oyunculu maçlara katıldığında oluşan verilerden söz eder.",
          },
          {
            type: "p",
            text: "Torble dışındaki üçüncü taraf sitelerin veya hizmetlerin kendi gizlilik uygulamaları vardır; bu politika onları kapsamaz.",
          },
        ],
      },
      {
        id: "collected",
        heading: "2. Topladığımız bilgiler",
        blocks: [
          {
            type: "p",
            text: "Topladığımız bilgilerin çoğunu doğrudan sen sağlarsın (hesap oluşturmak, kullanıcı adı seçmek, mesaj yazmak gibi). Bir kısmı ise oyunu kullanman sırasında teknik olarak oluşur (oturum, bağlantı, skor gibi). Kısaca işlediğimiz kategoriler:",
          },
          {
            type: "list",
            items: [
              "Hesap ve kimlik doğrulama bilgileri",
              "Profil ve sosyal özellik verileri",
              "Arkadaşlık, engelleme, mesaj ve bildirim verileri",
              "Raporlama ve moderasyon verileri",
              "Oyun odaları, skorlar, sıralamalar, XP, Gold, başarımlar ve görev verileri",
              "Teknik, güvenlik ve oturum verileri",
            ],
          },
          {
            type: "p",
            text: "Bu bilgileri farklı yollarla ediniriz: Torble'ın web sitesinde veya iOS uygulamasında hesap oluşturduğunda; profil, sosyal, mesajlaşma ve oyun özellikleriyle gerçekleştirdiğin işlemler sırasında; hizmet çalışırken otomatik olarak oluşan sınırlı teknik, güvenlik, bağlantı ve oturum kayıtlarıyla; ve Apple ile Google gibi kimlik doğrulama sağlayıcılarından alınan sınırlı hesap tanımlayıcıları ve giriş bilgileriyle.",
          },
          {
            type: "p",
            text: "Her kategori aşağıda ayrıntılı anlatılıyor. Adres, telefon numarası, kimlik belgesi veya ödeme kartı gibi bilgileri toplamıyoruz.",
          },
        ],
      },
      {
        id: "account",
        heading: "3. Hesap ve kimlik doğrulama bilgileri",
        blocks: [
          {
            type: "p",
            text: "Torble hesabını üç yoldan biriyle oluşturabilirsin: e-posta ve şifre, Google ile Giriş veya Apple ile Giriş. Kimlik doğrulama altyapımız Supabase Auth tarafından sağlanır.",
          },
          {
            type: "list",
            items: [
              "E-posta ile kayıt: e-posta adresin ve bir şifre. Şifreni asla düz metin olarak görmez veya saklamayız; şifreler yalnızca Supabase Auth tarafından güvenli biçimde yönetilir.",
              "Google ile Giriş: Google, giriş için e-posta adresin ve temel hesap tanımlayıcın gibi bilgileri bizimle paylaşır.",
              "Apple ile Giriş: Apple, giriş için bir hesap tanımlayıcı ve (paylaşmayı seçtiysen) bir e-posta adresi paylaşır. Apple'ın \"E-postamı Gizle\" özelliğini kullanırsan bize yalnızca bir yönlendirme adresi ulaşır.",
            ],
          },
          {
            type: "p",
            text: "Bu bilgiler hesabını oluşturmak, seni güvenli biçimde tanımak ve oturumunu sürdürmek için kullanılır. Dilersen tek bir e-posta hesabına hem şifre belirleyebilir hem de Google/Apple girişini kullanabilirsin.",
          },
        ],
      },
      {
        id: "profile",
        heading: "4. Profil ve sosyal özellik verileri",
        blocks: [
          {
            type: "p",
            text: "Hesabına bağlı bir oyuncu profilin olur. Bu profil diğer oyunculara açık olabilecek bilgiler içerir:",
          },
          {
            type: "list",
            items: [
              "Seçtiğin kullanıcı adı (ve kullanıcı adı değişiklik geçmişin)",
              "Seçtiğin avatar",
              "Sergilediğin kozmetik unvan veya efekt gibi görünüm tercihleri",
              "Seviye, XP ve başarım rozetleri gibi oyun ilerleme bilgilerin",
            ],
          },
          {
            type: "p",
            text: "Kullanıcı adın ve avatarın gibi bilgiler, seni bulmaları, arkadaş eklemeleri veya çok oyunculu maçlarda görmeleri için diğer oyunculara gösterilebilir. Gerçek adını veya iletişim bilgilerini profilinde paylaşmak zorunda değilsin.",
          },
        ],
      },
      {
        id: "social",
        heading: "5. Arkadaşlık, engelleme, mesaj ve bildirim verileri",
        blocks: [
          {
            type: "p",
            text: "Torble'ın sosyal özelliklerini kullandığında aşağıdaki veriler oluşur:",
          },
          {
            type: "list",
            items: [
              "Arkadaşlık istekleri ve arkadaş listen",
              "Engellediğin kullanıcılar",
              "Diğer oyuncularla gönderdiğin ve aldığın özel mesajlar (DM)",
              "Aldığın bildirimler (arkadaşlık isteği, oyun daveti, başarım gibi)",
              "Oyun lobilerinde ve odalarında yazdığın sohbet mesajları",
            ],
          },
          {
            type: "p",
            text: "Mesajlarını, ilgili sohbeti karşındaki oyuncuya iletmek ve geçmişi göstermek için işleriz. Bir kullanıcıyı engellediğinde bu ilişki, ilgili etkileşimleri kısıtlamak için saklanır.",
          },
          {
            type: "subheading",
            text: "Raporlama ve moderasyon",
          },
          {
            type: "p",
            text: "Bir kullanıcıyı veya mesajı uygulama içinden bildirdiğinde, bildirimin incelenebilmesi için aşağıdaki bilgileri işleriz:",
          },
          {
            type: "list",
            items: [
              "Seçtiğin bildirme nedeni ve (girdiysen) kısa açıklaman",
              "Bildirilen profilin veya mesajın tanımlayıcısı",
              "Bildirilen kullanıcı adının veya mesaj içeriğinin, bildirim anındaki sınırlı bir kopyası (anlık görüntü)",
              "Bildirimin durumu ve moderasyon ekibimizin iç değerlendirme notları",
            ],
          },
          {
            type: "p",
            text: "Bu bilgileri yalnızca güvenlik, kötüye kullanımın önlenmesi ve topluluk kurallarının uygulanması amacıyla işleriz. Bildirimi yapan olarak kimliğin, bildirdiğin kullanıcıya gösterilmez. Bildirilen içerik sonradan silinse bile, güvenlik incelemesi için alınan sınırlı anlık görüntü kaydı saklanabilir.",
          },
        ],
      },
      {
        id: "gameplay",
        heading:
          "6. Oyun odaları, skorlar, sıralamalar, XP, Gold, başarımlar ve görev verileri",
        blocks: [
          {
            type: "p",
            text: "Oynadıkça oyunla ilgili veriler oluşur. Bunlar hem ilerlemeni kaydetmek hem de çok oyunculu deneyimi işletmek için gereklidir:",
          },
          {
            type: "list",
            items: [
              "Oluşturduğun veya katıldığın oyun odaları ve oda kodları",
              "Maçlardaki skorların, tur sonuçları ve maç geçmişin",
              "Sıralama (leaderboard) tablolarındaki konumun",
              "XP ve seviye ilerlemen",
              "Gold: uygulama içi oynanışla kazanılan sanal bir birimdir; uygulama dışında parasal bir değeri yoktur",
              "Kazandığın başarımlar ve rozetler",
              "Günün Görevi ilerlemen ve ödül geçmişin",
            ],
          },
          {
            type: "p",
            text: "Çok oyunculu maçlarda kullanıcı adın, avatarın ve skorların, aynı maçtaki diğer oyunculara gösterilir. Sıralama tabloları, oyuncuları karşılaştırmak için kullanıcı adı ve skor gibi bilgileri açık biçimde gösterir.",
          },
        ],
      },
      {
        id: "technical",
        heading: "7. Teknik, güvenlik ve oturum verileri",
        blocks: [
          {
            type: "p",
            text: "Hizmeti çalıştırmak ve güvenli tutmak için sınırlı teknik veriler işlenir:",
          },
          {
            type: "list",
            items: [
              "Oturum ve kimlik doğrulama jetonları (Supabase Auth tarafından yönetilir; oturumun açık kalmasını sağlar)",
              "Çevrimiçi/bağlantı durumu bilgisi — arkadaşlarına çevrimiçi göründüğün ve canlı maçların çalışması için kullanılan kısa aralıklı \"varlık\" (presence) sinyalleri",
              "İnternet üzerinden yapılan her isteğin doğası gereği oluşan teknik bilgiler (ör. IP adresi ve cihaz/tarayıcı türü), altyapı sağlayıcılarımız tarafından hizmeti sunmak ve kötüye kullanımı önlemek için işlenebilir",
            ],
          },
          {
            type: "note",
            text: "Torble, üçüncü taraf reklam ağları, analytics platformları veya izleme SDK'ları kullanmaz. Davranışsal reklam amacıyla profil çıkarımı yapmayız.",
          },
        ],
      },
      {
        id: "purposes",
        heading: "8. Verileri kullanım amaçlarımız",
        blocks: [
          {
            type: "p",
            text: "İşlediğimiz verileri yalnızca aşağıdaki amaçlarla kullanırız:",
          },
          {
            type: "list",
            items: [
              "Hesabını oluşturmak, seni tanımak ve oturumunu güvenli biçimde sürdürmek",
              "Oyunu, çok oyunculu odaları, sıralamaları ve ilerleme sistemini (XP, Gold, başarım, görev) işletmek",
              "Arkadaşlık, mesajlaşma, bildirim ve engelleme gibi sosyal özellikleri sağlamak",
              "Hile, kötüye kullanım ve güvenlik sorunlarını önlemek ve hizmetin bütünlüğünü korumak",
              "Yasal yükümlülüklere uymak ve gerektiğinde destek taleplerini yanıtlamak",
            ],
          },
          {
            type: "p",
            text: "Bu işlemler farklı hukuki sebeplere dayanır. Çoğu işlem, Torble hizmetinin kurulması ve sana sunulması ile sözleşmenin kurulması veya ifasıyla doğrudan ilgilidir. Güvenliğin sağlanması, kötüye kullanımın önlenmesi ve hizmet bütünlüğünün korunması ile temel hak ve özgürlüklerine zarar vermemek kaydıyla meşru menfaatlerimiz de dayanak oluşturabilir. Belirli durumlarda hukuki yükümlülüklerimizi yerine getirmek için verileri işleriz. Açık rızaya ise yalnızca gerçekten gerekli olduğu hâllerde başvururuz.",
          },
        ],
      },
      {
        id: "providers",
        heading: "9. Hizmet sağlayıcılar ve üçüncü taraflar",
        blocks: [
          {
            type: "p",
            text: "Torble'ı çalıştırmak için sınırlı sayıda güvenilir hizmet sağlayıcıdan yararlanırız. Bu sağlayıcılar yalnızca hizmeti sunmak için gereken verileri işler:",
          },
          {
            type: "list",
            items: [
              "Supabase — kimlik doğrulama, veritabanı, sunucu fonksiyonları ve gerçek zamanlı altyapımız. Hesap ve oyun verilerinin çoğu burada işlenir ve saklanır.",
              "Apple — Apple ile Giriş özelliği ve iOS uygulamasının App Store üzerinden dağıtımı.",
              "Google — Google ile Giriş özelliği; ayrıca web sürümünde yazı tiplerinin gösterilmesi için Google Fonts kullanılır (font yüklenirken tarayıcının isteği Google'a ulaşır).",
              "Harita karo sağlayıcıları — harita tabanlı oyun modlarında harita görselleri üçüncü taraf karo sağlayıcılarından (ör. MapTiler ve OpenStreetMap tabanlı karolar) yüklenir; karolar yüklenirken standart teknik istek bilgileri (ör. IP adresi) bu sağlayıcılara ulaşır.",
              "Web barındırma sağlayıcısı — web sürümü, statik içerik olarak bir barındırma sağlayıcısı (Vercel) üzerinden sunulur; hesap ve oyun verilerin bu katmanda saklanmaz.",
            ],
          },
        ],
      },
      {
        id: "sharing",
        heading: "10. Verilerin paylaşılması",
        blocks: [
          {
            type: "p",
            text: "Verilerini satmayız ve reklam amacıyla üçüncü taraflarla paylaşmayız. Verilerini yalnızca şu durumlarda paylaşırız veya erişilebilir kılarız:",
          },
          {
            type: "list",
            items: [
              "Diğer oyuncularla — yalnızca oyunun doğası gereği görünen bilgiler (kullanıcı adın, avatarın, çok oyunculu maçlardaki skorların, sıralamalar ve gönderdiğin mesajlar).",
              "Hizmet sağlayıcılarımızla — yukarıda listelenen ve hizmeti sunmak için gereken sağlayıcılarla.",
              "Yasal zorunluluk halinde — geçerli bir yasal talep olması, haklarımızı korumamız veya kullanıcıların güvenliğini sağlamamız gerektiğinde.",
            ],
          },
        ],
      },
      {
        id: "security",
        heading: "11. Veri güvenliği",
        blocks: [
          {
            type: "p",
            text: "Verilerini korumak için makul teknik ve organizasyonel önlemler alırız. Kimlik doğrulama ve veri iletimi şifreli bağlantılar üzerinden yürür; şifreler yalnızca Supabase Auth tarafından güvenli biçimde saklanır ve bizim tarafımızdan görülmez. Sunucu tarafındaki yetkilendirme kuralları, kullanıcıların yalnızca erişmeye yetkili oldukları verilere ulaşmasını sağlar.",
          },
          {
            type: "p",
            text: "Hiçbir sistem yüzde yüz güvenli değildir; ancak hesabını korumana yardımcı olmak için güçlü bir şifre kullanmanı ve giriş bilgilerini gizli tutmanı öneririz.",
          },
        ],
      },
      {
        id: "retention",
        heading: "12. Saklama süreleri",
        blocks: [
          {
            type: "p",
            text: "Hesap ve profil verilerini, hesabın aktif olduğu sürece saklarız. Hesabını sildiğinde, kişisel verilerin bu politikada anlatıldığı şekilde silinir veya anonimleştirilir.",
          },
          {
            type: "p",
            text: "Silme işleminden sonra, sınırlı sayıda kaydın kısa bir süre için rutin yedeklerde kalabileceğini ve zamanla olağan akışta üzerine yazılacağını unutma. Teknik veya yasal bir zorunluluk bulunması halinde sınırlı kayıtlar daha uzun süre tutulabilir; bunu yalnızca gerçekten gerekli olduğunda yaparız.",
          },
          {
            type: "p",
            text: "Güvenlik ve kötüye kullanımın önlenmesi amacıyla oluşturulan bildirim (rapor) kayıtları, hesabın silinmesinden sonra da güvenlik ve uyuşmazlık incelemesi için tutulabilir. Bu durumda kayıtlardaki kişisel bağlantı azaltılır: bildiren ve bildirilen hesap bağlantıları kaldırılır ve geriye yalnızca güvenlik incelemesi için gereken sınırlı anlık görüntü ile moderasyon bilgisi kalır.",
          },
        ],
      },
      {
        id: "deletion",
        heading: "13. Hesap ve veri silme",
        blocks: [
          {
            type: "p",
            text: "Hesabını dilediğin an kalıcı olarak silebilirsin. Silme işlemi uygulama içindeki Hesap Ayarları bölümünden başlatılır ve geri alınamaz.",
          },
          {
            type: "subheading",
            text: "Silme nasıl çalışır",
          },
          {
            type: "list",
            items: [
              "Silme, uygulama içindeki Hesap Ayarları'nın \"Hesap\" bölümünden yapılır ve açık bir onay gerektirir. E-posta+şifre ile giriş yapıyorsan önce mevcut şifreni doğrulaman istenir.",
              "Kimlik doğrulama hesabın ve buna bağlı profil bağlantıların kaldırılır.",
              "Arkadaşların, arkadaşlık isteklerin, engel listen, özel mesajların, bildirimlerin, Gold, XP, seviye, başarımların, günlük görev ilerlemen, kozmetik tercihlerin ve çevrimiçi durum kayıtların gibi kişisel verilerin silinir.",
              "Sıralama tablolarındaki ve aktif kullanıcı listelerindeki bağlantıların temizlenir; artık seninle ilişkilendirilmezler.",
              "Apple ile Giriş kullanan bir hesapta, uygulama silme sırasında Apple yetkilendirmesini iptal etmeye çalışır (aşağıya bakınız).",
            ],
          },
          {
            type: "subheading",
            text: "Apple ile Giriş kullanıyorsan",
          },
          {
            type: "p",
            text: "Apple ile Giriş kullanan hesaplarda, silme anında Apple yetkilendirmesinin iptal edilmesi denenir. Bu iptal teknik bir nedenle otomatik tamamlanamazsa, uygulama sana iOS ayarlarından Torble erişimini nasıl elle kaldırabileceğini gösterir.",
          },
        ],
      },
      {
        id: "anonymization",
        heading: "14. Silme sırasında anonimleştirilen geçmiş oyun kayıtları",
        blocks: [
          {
            type: "p",
            text: "Çok oyunculu maçlar birden fazla oyuncunun ortak geçmişini oluşturur. Diğer oyuncuların maç geçmişini bozmamak için, geçmiş maçlarla ilgili bazı oyun kayıtları (örneğin bir maçtaki oyuncu satırları, skorlar, oda içi sohbet mesajları ve oda sahibi adı gibi bilgiler) silinmek yerine anonimleştirilebilir.",
          },
          {
            type: "p",
            text: "Anonimleştirmede, bu kayıtlardaki kişisel bağlantı kaldırılır: kullanıcı adın anonim bir yer tutucuyla değiştirilir ve kayıt artık hesabınla ilişkilendirilmez. Böylece diğer oyuncuların maç geçmişi tutarlı kalırken senin kimliğin bu kayıtlardan ayrılmış olur.",
          },
        ],
      },
      {
        id: "rights",
        heading: "15. Kullanıcı tercihleri ve hakların",
        blocks: [
          {
            type: "p",
            text: "Verilerin üzerinde bir dizi hakkın ve tercihin var. Bunların çoğunu doğrudan uygulama içinden kullanabilirsin:",
          },
          {
            type: "list",
            items: [
              "Erişim ve güncelleme: profilini, kullanıcı adını ve avatarını uygulama içinden görüntüleyip düzenleyebilirsin.",
              "Silme: hesabını ve kişisel verilerini uygulama içindeki Hesap Ayarları'ndan kalıcı olarak silebilirsin.",
              "Hesap kullanımını sonlandırma: Dilediğin an çıkış yapabilir veya hesabını kalıcı olarak silebilirsin.",
              "Sosyal denetim: istenmeyen etkileşimleri sınırlamak için kullanıcıları engelleyebilir, bildirimlerini yönetebilirsin.",
            ],
          },
          {
            type: "subheading",
            text: "Kişisel verilerine ilişkin yasal hakların",
          },
          {
            type: "p",
            text: "Yürürlükteki kişisel verilerin korunması mevzuatı kapsamında, kişisel verilerinle ilgili olarak aşağıdaki haklara sahipsin:",
          },
          {
            type: "list",
            items: [
              "Kişisel verilerinin işlenip işlenmediğini öğrenme",
              "İşlenmişse buna ilişkin bilgi talep etme",
              "Verilerinin hangi amaçlarla işlendiğini ve bu amaçlara uygun kullanılıp kullanılmadığını öğrenme",
              "Verilerinin aktarıldığı alıcıları veya alıcı gruplarını öğrenme",
              "Eksik veya yanlış işlenmiş verilerinin düzeltilmesini isteme",
              "Şartları oluştuğunda verilerinin silinmesini veya yok edilmesini isteme",
              "Düzeltme veya silme işlemlerinin, verilerinin aktarıldığı alıcılara bildirilmesini isteme",
              "Verilerinin yalnızca otomatik sistemlerle analiz edilmesi sonucunda aleyhine bir sonuç ortaya çıkmasına itiraz etme",
              "Verilerinin kanuna aykırı işlenmesi nedeniyle bir zarara uğrarsan bu zararın giderilmesini talep etme",
            ],
          },
          {
            type: "p",
            text: `Bu taleplerini ${CONTACT_EMAIL} adresine iletebilirsin. Bulunduğun yere göre veri koruma mevzuatı kapsamında ek hakların da olabilir.`,
          },
        ],
      },
      {
        id: "children",
        heading: "16. Çocukların gizliliği",
        blocks: [
          {
            type: "p",
            text: "Torble çocuklara özel olarak tasarlanmamıştır. Bulunduğun ülkede dijital hizmetleri kullanmak için ebeveyn veya yasal temsilci onayı gerekiyorsa Torble'ı yalnızca bu onayla kullanmalısın.",
          },
          {
            type: "p",
            text: `Bir çocuğa ait kişisel verilerin uygun olmayan şekilde işlendiğini düşünüyorsan ${CONTACT_EMAIL} adresinden bize ulaşabilirsin.`,
          },
        ],
      },
      {
        id: "transfers",
        heading: "17. Uluslararası veri aktarımı",
        blocks: [
          {
            type: "p",
            text: "Altyapı ve hizmet sağlayıcılarımız (örneğin Supabase) verileri farklı ülkelerdeki sunucularda işleyip saklayabilir. Bu, verilerinin yaşadığın ülkenin dışına aktarılabileceği anlamına gelir.",
          },
          {
            type: "p",
            text: "Böyle bir aktarım söz konusu olduğunda, sağlayıcılarımızın uyguladığı koruma önlemlerine dayanırız. Verilerini yalnızca hizmeti sunmak için gerekli olduğu ölçüde işleriz.",
          },
        ],
      },
      {
        id: "changes",
        heading: "18. Bu politikadaki değişiklikler",
        blocks: [
          {
            type: "p",
            text: "Bu politikayı zaman zaman güncelleyebiliriz. Önemli bir değişiklik olduğunda, bu sayfadaki \"Son güncelleme\" tarihini güncelleriz. Güncel sürümü her zaman bu adreste bulabilirsin.",
          },
        ],
      },
      {
        id: "contact",
        heading: "19. İletişim",
        blocks: [
          {
            type: "p",
            text: "Bu Gizlilik Politikası veya kişisel verilerin hakkında sorun ya da talebin olursa bizimle iletişime geçebilirsin:",
          },
          {
            type: "contact",
            label: "E-posta",
            email: CONTACT_EMAIL,
          },
          {
            type: "p",
            text: `Torble hizmetinin işletilmesinden ve bu politika kapsamındaki kişisel veri işleme faaliyetlerinden Enes Kandemir sorumludur. Gizlilik ve kişisel veri taleplerin için ${CONTACT_EMAIL} adresinden iletişime geçebilirsin.`,
          },
        ],
      },
    ],
  },

  /* ─────────────────────────────── ENGLISH ────────────────────────────── */
  en: {
    kind: "privacy",
    title: "Privacy Policy",
    tagline:
      "A plain-language explanation of what information Torble processes, why we process it, and the rights you have over it.",
    metaDescription:
      "Torble Privacy Policy — the data we collect, how we use it, our service providers, retention, account deletion, and your rights.",
    intro: [
      {
        type: "p",
        text: "Torble is a geography quiz app that turns learning about the world into a game. This Privacy Policy explains what personal data we process when you use Torble on the web and as a mobile app, why we process it, and how you can exercise your rights.",
      },
      {
        type: "p",
        text: "Our goal is a simple, privacy-respecting service. We do not show ads, we do not use third-party advertising networks or tracking SDKs, and we do not sell your data.",
      },
    ],
    sections: [
      {
        id: "scope",
        heading: "1. Torble and the scope of this policy",
        blocks: [
          {
            type: "p",
            text: "This policy covers the data processed by the Torble app itself (the iOS app and the web version). It concerns the data created when you play with your account, add friends, send messages, or join multiplayer matches inside Torble.",
          },
          {
            type: "p",
            text: "Third-party sites or services outside Torble have their own privacy practices; this policy does not cover them.",
          },
        ],
      },
      {
        id: "collected",
        heading: "2. Information we collect",
        blocks: [
          {
            type: "p",
            text: "Most of the information we hold is provided directly by you (creating an account, choosing a username, writing a message). Some is generated technically as you use the game (session, connection, scores). In short, the categories we process are:",
          },
          {
            type: "list",
            items: [
              "Account and authentication information",
              "Profile and social feature data",
              "Friendship, blocking, message, and notification data",
              "Reporting and moderation data",
              "Game room, score, leaderboard, XP, Gold, achievement, and quest data",
              "Technical, security, and session data",
            ],
          },
          {
            type: "p",
            text: "We obtain this information in several ways: when you create an account on the Torble website or iOS app; through the actions you take using the profile, social, messaging, and game features; through the limited technical, security, connection, and session records generated automatically while the service runs; and through the limited account identifiers and sign-in information received from authentication providers such as Apple and Google.",
          },
          {
            type: "p",
            text: "Each category is described in detail below. We do not collect information such as your postal address, phone number, identity documents, or payment card details.",
          },
        ],
      },
      {
        id: "account",
        heading: "3. Account and authentication information",
        blocks: [
          {
            type: "p",
            text: "You can create a Torble account in one of three ways: email and password, Sign in with Google, or Sign in with Apple. Our authentication is provided by Supabase Auth.",
          },
          {
            type: "list",
            items: [
              "Email sign-up: your email address and a password. We never see or store your password in plain text; passwords are managed securely by Supabase Auth only.",
              "Sign in with Google: Google shares information such as your email address and a basic account identifier with us for sign-in.",
              "Sign in with Apple: Apple shares an account identifier and (if you choose to share it) an email address for sign-in. If you use Apple's \"Hide My Email\" feature, only a relay address reaches us.",
            ],
          },
          {
            type: "p",
            text: "This information is used to create your account, recognize you securely, and keep you signed in. If you like, you can both set a password for and use Google/Apple sign-in on a single email account.",
          },
        ],
      },
      {
        id: "profile",
        heading: "4. Profile and social feature data",
        blocks: [
          {
            type: "p",
            text: "Your account has a player profile. This profile contains information that may be visible to other players:",
          },
          {
            type: "list",
            items: [
              "The username you choose (and your username change history)",
              "The avatar you choose",
              "Appearance preferences such as a cosmetic title or effect you display",
              "Game progress information such as your level, XP, and achievement badges",
            ],
          },
          {
            type: "p",
            text: "Information such as your username and avatar may be shown to other players so they can find you, add you as a friend, or see you in multiplayer matches. You are not required to share your real name or contact details on your profile.",
          },
        ],
      },
      {
        id: "social",
        heading: "5. Friendship, blocking, message, and notification data",
        blocks: [
          {
            type: "p",
            text: "When you use Torble's social features, the following data is created:",
          },
          {
            type: "list",
            items: [
              "Friend requests and your friends list",
              "Users you have blocked",
              "Direct messages (DMs) you send to and receive from other players",
              "Notifications you receive (such as friend requests, game invites, and achievements)",
              "Chat messages you write in game lobbies and rooms",
            ],
          },
          {
            type: "p",
            text: "We process your messages to deliver the relevant conversation to the other player and to show history. When you block a user, that relationship is stored so we can restrict the related interactions.",
          },
          {
            type: "subheading",
            text: "Reporting and moderation",
          },
          {
            type: "p",
            text: "When you report a user or a message from inside the app, we process the following information so the report can be reviewed:",
          },
          {
            type: "list",
            items: [
              "The report reason you selected and (if you entered one) your short note",
              "An identifier of the reported profile or message",
              "A limited snapshot of the reported username or message content as it was at the time of the report",
              "The status of the report and our moderation team's internal review notes",
            ],
          },
          {
            type: "p",
            text: "We process this information solely for safety, abuse prevention, and enforcing our community rules. Your identity as the reporter is not shown to the user you reported. Even if the reported content is later deleted, the limited snapshot taken for safety review may be retained.",
          },
        ],
      },
      {
        id: "gameplay",
        heading:
          "6. Game room, score, leaderboard, XP, Gold, achievement, and quest data",
        blocks: [
          {
            type: "p",
            text: "As you play, game-related data is created. This is needed both to save your progress and to run the multiplayer experience:",
          },
          {
            type: "list",
            items: [
              "Game rooms and room codes you create or join",
              "Your scores in matches, round results, and match history",
              "Your position on leaderboards",
              "Your XP and level progress",
              "Gold: a virtual in-game currency earned through play; it has no monetary value outside the app",
              "Achievements and badges you earn",
              "Your Daily Quest progress and reward history",
            ],
          },
          {
            type: "p",
            text: "In multiplayer matches, your username, avatar, and scores are shown to the other players in the same match. Leaderboards openly display information such as username and score in order to compare players.",
          },
        ],
      },
      {
        id: "technical",
        heading: "7. Technical, security, and session data",
        blocks: [
          {
            type: "p",
            text: "To run the service and keep it secure, limited technical data is processed:",
          },
          {
            type: "list",
            items: [
              "Session and authentication tokens (managed by Supabase Auth; these keep you signed in)",
              "Online/connection status — short-interval \"presence\" signals used so you appear online to friends and so live matches work",
              "Technical information inherent to any request over the internet (such as your IP address and device/browser type), which may be processed by our infrastructure providers to deliver the service and prevent abuse",
            ],
          },
          {
            type: "note",
            text: "Torble does not use third-party advertising networks, analytics platforms, or tracking SDKs. We do not build profiles about you for behavioral advertising.",
          },
        ],
      },
      {
        id: "purposes",
        heading: "8. How we use data",
        blocks: [
          {
            type: "p",
            text: "We use the data we process only for the following purposes:",
          },
          {
            type: "list",
            items: [
              "To create your account, recognize you, and keep your session secure",
              "To run the game, multiplayer rooms, leaderboards, and the progression system (XP, Gold, achievements, quests)",
              "To provide social features such as friendship, messaging, notifications, and blocking",
              "To prevent cheating, abuse, and security issues and to protect the integrity of the service",
              "To comply with legal obligations and to respond to support requests when needed",
            ],
          },
          {
            type: "p",
            text: "This processing relies on different legal grounds. Most of it is directly related to setting up and providing the Torble service and to entering into or performing our agreement with you. Protecting security, preventing abuse, and safeguarding the integrity of the service — as well as our legitimate interests, provided they do not override your fundamental rights and freedoms — may also serve as a basis. In certain cases we process data to comply with our legal obligations. We rely on your explicit consent only where it is genuinely necessary.",
          },
        ],
      },
      {
        id: "providers",
        heading: "9. Service providers and third parties",
        blocks: [
          {
            type: "p",
            text: "We rely on a small number of trusted service providers to run Torble. These providers only process the data needed to deliver the service:",
          },
          {
            type: "list",
            items: [
              "Supabase — our authentication, database, server functions, and realtime infrastructure. Most account and game data is processed and stored here.",
              "Apple — the Sign in with Apple feature and distribution of the iOS app via the App Store.",
              "Google — the Sign in with Google feature; the web version also uses Google Fonts to display typefaces (your browser's request reaches Google when a font loads).",
              "Map tile providers — in map-based game modes, map imagery is loaded from third-party tile providers (such as MapTiler and OpenStreetMap-based tiles); standard technical request data (such as your IP address) reaches these providers when tiles load.",
              "Web hosting provider — the web version is served as static content through a hosting provider (Vercel); your account and game data are not stored in that layer.",
            ],
          },
        ],
      },
      {
        id: "sharing",
        heading: "10. How data is shared",
        blocks: [
          {
            type: "p",
            text: "We do not sell your data and do not share it with third parties for advertising. We only share or make your data accessible in the following cases:",
          },
          {
            type: "list",
            items: [
              "With other players — only the information that is visible by the nature of the game (your username, avatar, scores in multiplayer matches, leaderboards, and the messages you send).",
              "With our service providers — the providers listed above that are needed to deliver the service.",
              "When legally required — when there is a valid legal request, or when we need to protect our rights or the safety of users.",
            ],
          },
        ],
      },
      {
        id: "security",
        heading: "11. Data security",
        blocks: [
          {
            type: "p",
            text: "We take reasonable technical and organizational measures to protect your data. Authentication and data transmission run over encrypted connections; passwords are stored securely by Supabase Auth only and are not visible to us. Server-side authorization rules ensure that users can only reach data they are permitted to access.",
          },
          {
            type: "p",
            text: "No system is 100% secure; however, to help protect your account, we recommend using a strong password and keeping your login details confidential.",
          },
        ],
      },
      {
        id: "retention",
        heading: "12. Retention periods",
        blocks: [
          {
            type: "p",
            text: "We keep account and profile data for as long as your account is active. When you delete your account, your personal data is deleted or anonymized as described in this policy.",
          },
          {
            type: "p",
            text: "Note that after deletion, a limited number of records may remain in routine backups for a short time and will be overwritten in the ordinary course over time. Where there is a technical or legal requirement, limited records may be kept for longer; we only do this when it is genuinely necessary.",
          },
          {
            type: "p",
            text: "Report records created for safety and abuse prevention may be retained after your account is deleted for safety and dispute review. In that case, the personal link in these records is reduced: the reporter and reported account associations are removed, leaving only the limited snapshot and moderation information needed for safety review.",
          },
        ],
      },
      {
        id: "deletion",
        heading: "13. Account and data deletion",
        blocks: [
          {
            type: "p",
            text: "You can permanently delete your account at any time. Deletion is started from the Account Settings section inside the app and cannot be undone.",
          },
          {
            type: "subheading",
            text: "How deletion works",
          },
          {
            type: "list",
            items: [
              "Deletion is done from the \"Account\" section of Account Settings inside the app and requires an explicit confirmation. If you sign in with email and password, you are first asked to verify your current password.",
              "Your authentication account and the profile links connected to it are removed.",
              "Your personal data — such as your friends, friend requests, block list, direct messages, notifications, Gold, XP, level, achievements, daily quest progress, cosmetic preferences, and online-status records — is deleted.",
              "Your connections in leaderboards and active-user lists are cleared; they are no longer associated with you.",
              "On an account that uses Sign in with Apple, the app attempts to revoke the Apple authorization during deletion (see below).",
            ],
          },
          {
            type: "subheading",
            text: "If you use Sign in with Apple",
          },
          {
            type: "p",
            text: "For accounts that use Sign in with Apple, revocation of the Apple authorization is attempted at the moment of deletion. If this revocation cannot be completed automatically for a technical reason, the app shows you how to manually remove Torble's access from your iOS settings.",
          },
        ],
      },
      {
        id: "anonymization",
        heading: "14. Historical game records anonymized during deletion",
        blocks: [
          {
            type: "p",
            text: "Multiplayer matches form a shared history among several players. To avoid breaking other players' match history, some game records related to past matches (for example, the player rows in a match, scores, in-room chat messages, and the room host name) may be anonymized instead of deleted.",
          },
          {
            type: "p",
            text: "In anonymization, the personal link in these records is removed: your username is replaced with an anonymous placeholder and the record is no longer associated with your account. This keeps other players' match history consistent while separating your identity from these records.",
          },
        ],
      },
      {
        id: "rights",
        heading: "15. Your preferences and rights",
        blocks: [
          {
            type: "p",
            text: "You have a range of rights and choices over your data. You can exercise most of them directly inside the app:",
          },
          {
            type: "list",
            items: [
              "Access and update: you can view and edit your profile, username, and avatar from inside the app.",
              "Deletion: you can permanently delete your account and personal data from Account Settings inside the app.",
              "Ending your use of the account: you can sign out or permanently delete your account at any time.",
              "Social control: you can block users and manage your notifications to limit unwanted interactions.",
            ],
          },
          {
            type: "subheading",
            text: "Your legal rights over your data",
          },
          {
            type: "p",
            text: "Depending on where you live, applicable data protection laws may give you rights over your personal data. Where they apply, these can include:",
          },
          {
            type: "list",
            items: [
              "Learning whether your personal data is being processed",
              "Requesting information about that processing where it takes place",
              "Learning the purposes of processing and whether your data is used in line with them",
              "Learning the recipients or categories of recipients to whom your data is transferred",
              "Requesting that incomplete or inaccurate data be corrected",
              "Requesting that your data be deleted or erased where the conditions are met",
              "Requesting that any correction or deletion be communicated to the recipients your data was shared with",
              "Objecting to an outcome that works against you resulting solely from automated analysis of your data",
              "Requesting compensation if you suffer damage due to unlawful processing of your data",
            ],
          },
          {
            type: "p",
            text: `To make any of these requests, you can contact us at ${CONTACT_EMAIL}.`,
          },
        ],
      },
      {
        id: "children",
        heading: "16. Children's privacy",
        blocks: [
          {
            type: "p",
            text: "Torble is not specifically designed for children. If using digital services where you live requires the consent of a parent or legal guardian, you should use Torble only with that consent.",
          },
          {
            type: "p",
            text: `If you believe a child's personal data has been processed inappropriately, you can contact us at ${CONTACT_EMAIL}.`,
          },
        ],
      },
      {
        id: "transfers",
        heading: "17. International data transfers",
        blocks: [
          {
            type: "p",
            text: "Our infrastructure and service providers (for example, Supabase) may process and store data on servers in different countries. This means your data may be transferred outside the country where you live.",
          },
          {
            type: "p",
            text: "Where such a transfer occurs, we rely on the safeguards implemented by our providers. We only process your data to the extent necessary to deliver the service.",
          },
        ],
      },
      {
        id: "changes",
        heading: "18. Changes to this policy",
        blocks: [
          {
            type: "p",
            text: "We may update this policy from time to time. When there is a significant change, we update the \"Last updated\" date on this page. You can always find the current version at this address.",
          },
        ],
      },
      {
        id: "contact",
        heading: "19. Contact",
        blocks: [
          {
            type: "p",
            text: "If you have any questions or requests about this Privacy Policy or your personal data, you can get in touch with us:",
          },
          {
            type: "contact",
            label: "Email",
            email: CONTACT_EMAIL,
          },
          {
            type: "p",
            text: `Torble is operated from Türkiye. For privacy and personal data requests, contact ${CONTACT_EMAIL}.`,
          },
        ],
      },
    ],
  },
};
