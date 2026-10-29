// Demo mode content for the bundled sample PDF (samples/kalici-ogrenme.pdf).
// Everything here is SIMULATED: hand-written example reading events and an
// example study note. It is never presented as Gemma output and never stored
// alongside real user data. Quotes are copied verbatim from the sample PDF, so
// the demo goes through the same grounding checks as real model output.

export const SAMPLE = Object.freeze({
  url: 'samples/kalici-ogrenme.pdf',
  name: 'kalici-ogrenme.pdf',
  pageCount: 6,
});

const SEL_P2 = 'Geri çağırmanın sağladığı bu yarara test etkisi denir.';
const SEL_P3 = 'oturumlar arasındaki en iyi aralığın konuyu ne kadar süre hatırlamanız gerektiğine bağlı olduğunu öne sürdü';
// The paragraphs around the selections (what the tracker sends as the selection's block).
const BLOCK_P2 = "Geri çağırmanın sağladığı bu yarara test etkisi denir. Roediger ve Karpicke'nin 2006 yılındaki bilinen çalışmasında öğrencilerden kısa metinler okumaları istendi. Bazı öğrenciler metinleri yeniden okurken, diğerleri hatırlama alıştırması testlerine girdi. Beş dakika sonra yapılan testte yeniden okuma biraz daha iyi görünüyordu. Bir hafta sonra yapılan testte ise geri çağırma pratiği yapan öğrenciler belirgin biçimde daha fazlasını hatırladı.";
const BLOCK_P3 = 'Cepeda ve arkadaşlarının 2006 yılında yaptığı kapsamlı bir derleme, yüzlerce aralıklama deneyini analiz etti. Derleme, aralıklı çalışmanın yığılmış çalışmadan daha başarılı olduğunu doğruladı ve oturumlar arasındaki en iyi aralığın konuyu ne kadar süre hatırlamanız gerektiğine bağlı olduğunu öne sürdü. Daha uzun akılda tutma hedefleri genellikle daha uzun aralıklar gerektirir.';

/** Example aggregated reading session (ReadingAggregator#toJSON format). No pointer data. */
export function demoAggregate(now = Date.now()) {
  const t = (minAgo) => new Date(now - minAgo * 60000).toISOString();
  const CRIT = 'CRITICAL_IMPORTANCE', HIGH = 'HIGH_RELEVANCE';
  return {
    version: 2,
    startedAt: now - 14 * 60000,
    totalActiveSeconds: 580,
    skimmedSeconds: 6,
    idleIgnoredSeconds: 0,
    ignoredShortVisits: 3,
    lastSettledPage: 5,
    pages: {
      1: { page: 1, dwellSeconds: 95, visits: 1, revisits: 0, rereads: 0, lastVisitEnd: now - 12.4 * 60000, visitLog: [] },
      2: { page: 2, dwellSeconds: 210, visits: 3, revisits: 2, rereads: 2, lastVisitEnd: now - 3 * 60000, visitLog: [] },
      3: { page: 3, dwellSeconds: 140, visits: 2, revisits: 1, rereads: 1, lastVisitEnd: now - 2 * 60000, visitLog: [] },
      4: { page: 4, dwellSeconds: 60, visits: 1, revisits: 0, rereads: 0, lastVisitEnd: now - 6 * 60000, visitLog: [] },
      5: { page: 5, dwellSeconds: 75, visits: 1, revisits: 0, rereads: 0, lastVisitEnd: null, visitLog: [] },
    },
    rereads: {
      '2:2-3': { page: 2, yStart: 0.2, yEnd: 0.29, count: 2, lastAt: t(4.2), relevance: HIGH },
      '3:2-3': { page: 3, yStart: 0.218, yEnd: 0.305, count: 1, lastAt: t(2.5), relevance: HIGH },
    },
    selections: {
      [`2:${SEL_P2.toLowerCase()}`]: { page: 2, text: SEL_P2, block: BLOCK_P2, count: 2, firstAt: t(10), lastAt: t(3.5), ny: 0.21, importance: CRIT },
      [`3:${SEL_P3.toLowerCase()}`]: { page: 3, text: SEL_P3, block: BLOCK_P3, count: 1, firstAt: t(7), lastAt: t(7), ny: 0.26, importance: CRIT },
    },
    events: [
      { pageNumber: 1, eventType: 'page_visit', timestamp: t(12.4), dwellTimeSeconds: 95, revisitCount: 0 },
      { pageNumber: 2, eventType: 'text_selection', timestamp: t(10), selectedText: SEL_P2, selectionCount: 1, importance: CRIT },
      { pageNumber: 2, eventType: 'page_visit', timestamp: t(8.5), dwellTimeSeconds: 120, revisitCount: 0 },
      { pageNumber: 3, eventType: 'text_selection', timestamp: t(7), selectedText: SEL_P3, selectionCount: 1, importance: CRIT },
      { pageNumber: 3, eventType: 'page_visit', timestamp: t(6.6), dwellTimeSeconds: 85, revisitCount: 0 },
      { pageNumber: 4, eventType: 'page_visit', timestamp: t(6), dwellTimeSeconds: 60, revisitCount: 0 },
      { pageNumber: 2, eventType: 'page_revisit', timestamp: t(5.9), revisitCount: 1, secondsSinceLastVisit: 155 },
      { pageNumber: 2, eventType: 'page_visit', timestamp: t(4.8), dwellTimeSeconds: 55, revisitCount: 1 },
      { pageNumber: 2, eventType: 'text_reread', timestamp: t(4.2), revisitCount: 2, relevance: HIGH, region: { band: 2, yStart: 0.2, yEnd: 0.29 } },
      { pageNumber: 2, eventType: 'page_revisit', timestamp: t(4), revisitCount: 2, secondsSinceLastVisit: 48 },
      { pageNumber: 2, eventType: 'text_selection', timestamp: t(3.5), selectedText: SEL_P2, selectionCount: 2, importance: CRIT },
      { pageNumber: 2, eventType: 'page_visit', timestamp: t(3), dwellTimeSeconds: 35, revisitCount: 2 },
      { pageNumber: 3, eventType: 'page_revisit', timestamp: t(2.9), revisitCount: 1, secondsSinceLastVisit: 220 },
      { pageNumber: 3, eventType: 'text_reread', timestamp: t(2.5), revisitCount: 1, relevance: HIGH, region: { band: 2, yStart: 0.218, yEnd: 0.305 } },
      { pageNumber: 3, eventType: 'page_visit', timestamp: t(2), dwellTimeSeconds: 55, revisitCount: 1 },
    ],
  };
}
/** Example study note in the same schema as real model output (task "note"). */
export const DEMO_ANALYSIS = {
  studyNote: {
    title: 'Kalıcı Öğrenme: Çalışma Notu',
    highlights: [
      { text: 'Test etkisi: bilgiyi bellekten geri çağırmak, yeniden okumaktan daha kalıcı öğrenme sağlar.', page: 2, importance: 'CRITICAL_IMPORTANCE', evidence: SEL_P2 },
      { text: 'Oturumlar arasındaki en iyi aralık, bilgiyi ne kadar süre hatırlamanız gerektiğine bağlıdır.', page: 3, importance: 'CRITICAL_IMPORTANCE', evidence: SEL_P3 },
      { text: 'Bir hafta sonraki testte geri çağırma pratiği yapanlar, yeniden okuyanlardan belirgin biçimde daha fazlasını hatırladı.', page: 2, importance: 'HIGH_RELEVANCE', evidence: 'Bir hafta sonra yapılan testte ise geri çağırma pratiği yapan öğrenciler belirgin biçimde daha fazlasını hatırladı.' },
      { text: 'Cepeda ve arkadaşlarının derlemesine göre aralıklı çalışma, yığılmış çalışmadan daha başarılıdır.', page: 3, importance: 'HIGH_RELEVANCE', evidence: 'aralıklı çalışmanın yığılmış çalışmadan daha başarılı olduğunu doğruladı' },
      { text: 'Yeniden okumanın verdiği kolaylık hissi ustalıkla karıştırılır; bilgiyi kontrol etmenin en güvenilir yolu test etmektir.', page: 5, importance: 'KEY_POINT', evidence: 'metni işlemek kolay gelir ve bu kolaylık ustalıkla karıştırılır' },
    ],
    overview: 'Rehber, unutmanın öğrenmeden hemen sonra en hızlı olduğunu ve bilginin ancak konuya tekrar tekrar dönülüp etkin biçimde hatırlanmasıyla kalıcı hale geldiğini anlatır. Bu temel üzerine beş teknik kurar: geri çağırma pratiği, aralıklı çalışma, karma çalışma, ayrıntılandırma ve ikili kodlama. En güçlü kanıta sahip olanlar geri çağırma ve aralıklı çalışmadır. Rehberin ortak mesajı şudur: etkili teknikler çalışırken daha zor hissettirir; yeniden okumanın verdiği tanıdıklık hissi ise öğrenmenin ölçüsü değildir.',
    sections: [
      {
        heading: 'Neden unutuyoruz?', page: 1, depth: 'standard',
        content: 'Ebbinghaus\'un 1885\'teki deneyleri, unutmanın öğrenmeden hemen sonra en hızlı olduğunu, ardından yavaşladığını gösterdi; bu örüntüye unutma eğrisi denir. Ebbinghaus ayrıca tasarrufu ölçtü: bir listeyi yeniden öğrenmek ilk öğrenmeden daha kısa sürüyordu. Yani unutulmuş görünen bilgi çoğu zaman kısmen depolanmış durumdadır ve tekrar bu yüzden işe yarar.',
        keyPoints: ['Unutma eğrisi: önce hızlı, sonra yavaş unutma.', 'Tasarruf: yeniden öğrenmek ilk öğrenmeden daha kısa sürer.'],
        evidence: 'unutmanın öğrenmeden hemen sonra en hızlı olduğunu ve ardından yavaşladığını buldu',
        readerNote: '', signal: 'none',
      },
      {
        heading: 'Geri çağırma pratiği ve test etkisi', page: 2, depth: 'deep',
        content: 'Unutmayı yavaşlatmanın ilk ve en güçlü yolu geri çağırma pratiğidir: bilgiye yeniden bakmak yerine onu bilerek bellekten hatırlamaya çalışmak. Bilgi kartları, alıştırma soruları ya da bir konu hakkında hatırlanan her şeyi yazmak bu tekniğin farklı biçimleridir. Geri çağırmanın sağladığı yarara test etkisi denir ve rehberin en önemli kavramlarından biridir: test yalnızca öğrenmeyi ölçmez, kendi başına bir öğrenme olayıdır. Bir cevabı yeniden kurma eylemi, o bilgiye gelecekte erişmeyi kolaylaştırır.\n\nRoediger ve Karpicke\'nin 2006 çalışması bu etkiyi açıkça gösterir. Kısa metinleri okuyan öğrencilerin bir kısmı metinleri yeniden okudu, diğerleri hatırlama testlerine girdi. Beş dakika sonra yeniden okuyanlar biraz daha iyi görünse de bir hafta sonra geri çağırma yapanlar belirgin biçimde daha fazlasını hatırladı. Buradaki ders, kısa vadeli rahatlığın uzun vadeli öğrenmeyle karıştırılmaması gerektiğidir; bu fikir 7. bölümdeki akıcılık yanılsamasıyla doğrudan bağlantılıdır. Uygulamada kitabı kapatıp bellekten özet yazmak, başlıkları soruya çevirmek ve cevapları sonradan kontrol etmek önerilir; zahmet hissi, tekniği etkili kılan şeyin bir parçasıdır.',
        keyPoints: [
          'Test etkisi: hatırlamaya çalışmak, yeniden okumaktan daha kalıcı öğrenme sağlar.',
          'Roediger ve Karpicke (2006): 5 dakika sonra yeniden okuma biraz önde, 1 hafta sonra geri çağırma belirgin biçimde önde.',
          'Test bir ölçüm aracı olduğu kadar bir öğrenme olayıdır.',
          'Geri bildirim önemlidir: cevaplar kontrol edilmezse yanlışlar pekişebilir.',
          'Zahmet hissi normaldir ve etkinin bir parçasıdır.',
        ],
        evidence: 'Dolayısıyla test yalnızca öğrenmenin bir ölçüsü değildir; kendi başına bir öğrenme olayıdır.',
        readerNote: 'Roediger ve Karpicke deneyini anlatan paragrafa iki kez geri kaydırıp yeniden okudunuz. Öneri: sayfaya bakmadan deneyin iki sonucunu kendi cümlelerinizle yazın, sonra kontrol edin.',
        signal: 'reread',
      },
      {
        heading: 'Aralıklı çalışma ve karma çalışma', page: 3, depth: 'deep',
        content: 'Geri çağırmanın etkisini artıran ikinci teknik aralıklı çalışmadır. Aralıklama etkisine göre aynı miktarda çalışma, tek oturumda yığılmak yerine birkaç oturuma dağıtıldığında daha iyi uzun süreli akılda tutma sağlar. Sınavdan önceki gece yapılan yoğun çalışma kısa vadede işe yarayabilir, ancak öğrenilenlerin çoğu kısa sürede unutulur. Cepeda ve arkadaşlarının 2006 derlemesi yüzlerce deneyi inceleyerek bunu doğruladı ve önemli bir ayrıntı ekledi: oturumlar arasındaki en iyi aralık, bilgiyi ne kadar süre hatırlamanız gerektiğine bağlıdır. Uzun vadeli hedefler daha uzun aralıklar ister. Aralıklama, bir önceki bölümdeki geri çağırmayla birlikte çalışır; her yeni oturum, biraz unutma olduktan sonra hatırlamayı daha zahmetli ve daha yararlı kılar.\n\nKarma çalışma ise bir oturumda farklı problem türlerini karıştırmaktır; tek türü art arda çalışmaya bloklu çalışma denir. Bloklu pratik daha akıcı hissettirir, fakat karma pratik her problem için hangi stratejinin uygun olduğuna karar vermeyi gerektirir. Rohrer ve Taylor\'ın 2007 çalışması gibi matematik araştırmaları, karma pratiğin daha zor hissettirmesine rağmen gecikmeli testte daha iyi sonuç verdiğini buldu.',
        keyPoints: [
          'Dağıtılmış çalışma, yığılmış çalışmadan daha kalıcıdır.',
          'En iyi aralık, hedeflenen hatırlama süresine bağlıdır (Cepeda ve ark., 2006).',
          'Aralıklama, geri çağırmayla birlikte en etkili halini alır.',
          'Karma çalışma strateji seçmeyi zorunlu kılar ve gecikmeli testte daha iyi sonuç verir (Rohrer ve Taylor, 2007).',
        ],
        evidence: SEL_P3,
        readerNote: 'Oturumlar arasındaki aralığı anlatan cümleyi seçtiniz ve bu sayfaya bir kez geri döndünüz. Öneri: bu konu için bir sonraki tekrar oturumunuzu birkaç gün sonrasına planlayın.',
        signal: 'selection',
      },
      {
        heading: 'Ayrıntılandırma ve ikili kodlama', page: 4, depth: 'standard',
        content: 'Bu tekniklerin yanında rehber, bilgiyi birbirine bağlayan iki yöntem daha önerir. Ayrıntılandırma, nasıl ve neden soruları sorarak yeni bilgiyi önceden bilinenlere bağlamaktır. Kendine açıklamada her adım kendi sözcüklerinizle açıklanır; bu, pasif okumanın gizlediği boşlukları ortaya çıkarır. İkili kodlama ise bilgiyi hem sözel hem görsel olarak temsil etmektir; görsel süs değil, anlam taşıyan bir şema olmalıdır.',
        keyPoints: ['Neden ve nasıl soruları yeni bilgiyi eskisine bağlar.', 'Açıklayamadığınız adım, gerçekten takip etmediğiniz adımdır.', 'Anlamlı görseller bilgiye ikinci bir erişim yolu sağlar.'],
        evidence: 'Açıklamak, pasif okumanın gizlediği boşlukları ortaya çıkarır',
        readerNote: '', signal: 'none',
      },
      {
        heading: 'Üstbiliş ve akıcılık yanılsaması', page: 5, depth: 'standard',
        content: 'Bütün bu tekniklerin neden gerekli olduğunu üstbiliş açıklar: yeniden okuma metni tanıdık ve kolay hissettirir; bu kolaylık ustalıkla karıştırılır. Buna akıcılık ya da yeterlilik yanılsaması denir. Bilgiyi kontrol etmenin en güvenilir yolu onu test etmektir. Dunlosky ve arkadaşlarının 2013 incelemesi alıştırma testlerini ve dağıtılmış pratiği yüksek, altını çizme ve yeniden okumayı düşük yararlılıkta değerlendirdi.',
        keyPoints: ['Tanıdıklık hissi, öğrenmenin kanıtı değildir.', 'Yüksek yararlılık: alıştırma testleri ve dağıtılmış pratik (Dunlosky ve ark., 2013).'],
        evidence: 'Bu uyumsuzluğa bazen akıcılık yanılsaması ya da yeterlilik yanılsaması denir.',
        readerNote: 'Bu sayfada yaklaşık 75 saniye okudunuz. Öneri: akıcılık yanılsaması kavramını sayfaya bakmadan bir örnekle açıklamayı deneyin.',
        signal: 'dwell',
      },
    ],
    reviewLater: [
      { page: 2, reason: 'Deney paragrafını iki kez yeniden okudunuz ve test etkisi tanımını iki kez seçtiniz.', signal: 'reread' },
      { page: 3, reason: 'Aralıklama ile ilgili bir cümle seçtiniz ve sayfaya bir kez geri döndünüz.', signal: 'selection' },
    ],
    questions: [
      { question: 'Ebbinghaus\'un ölçtüğü "tasarruf" ne anlama gelir?', answer: 'Bir listeyi yeniden öğrenmenin, artık hatırlanamasa bile, ilk öğrenmeden daha kısa sürmesi.', page: 1, evidence: 'bir listeyi yeniden öğrenmek, artık hatırlayamadığı durumlarda bile, ilk kez öğrenmekten daha kısa sürüyordu' },
      { question: 'Roediger ve Karpicke çalışmasında sonuçlar beş dakika sonra ve bir hafta sonra nasıl farklılaştı?', answer: 'Beş dakika sonra yeniden okuma biraz daha iyiydi; bir hafta sonra geri çağırma pratiği yapanlar belirgin biçimde daha fazlasını hatırladı.', page: 2, evidence: 'Beş dakika sonra yapılan testte yeniden okuma biraz daha iyi görünüyordu.' },
      { question: 'Oturumlar arasındaki en iyi aralık neye bağlıdır?', answer: 'Bilgiyi ne kadar süre hatırlamanız gerektiğine; daha uzun hedefler daha uzun aralıklar ister.', page: 3, evidence: 'Daha uzun akılda tutma hedefleri genellikle daha uzun aralıklar gerektirir.' },
      { question: 'Akıcılık yanılsaması nedir?', answer: 'Yeniden okumanın yarattığı işleme kolaylığının ustalıkla karıştırılması.', page: 5, evidence: 'metni işlemek kolay gelir ve bu kolaylık ustalıkla karıştırılır' },
    ],
  },
};
