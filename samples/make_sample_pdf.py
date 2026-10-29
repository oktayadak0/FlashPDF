"""Generate samples/kalici-ogrenme.pdf without any third-party dependency.

The document ("Kalıcı Öğrenme") is an original short study guide in Turkish,
written for PiCODE and released under CC0 together with this script. It is
a real, multi-page, text-based PDF so that PDF.js can render it, extract its
text, and the demo analysis can cite exact passages from real pages.

Turkish letters: the standard PDF fonts (Helvetica) are used without
embedding. WinAnsiEncoding already covers ç ö ü Ç Ö Ü â, and a /Differences
table maps six otherwise unused codes to ğ Ğ ş Ş ı İ, so text extraction
returns correct Unicode and viewers draw the glyphs from their system fonts.

Run:  py samples/make_sample_pdf.py
"""

from pathlib import Path

PAGE_W, PAGE_H = 595, 842  # A4 in PDF points
MARGIN_X, TOP, BOTTOM = 64, 770, 76
TEXT_W = PAGE_W - 2 * MARGIN_X
OUTPUT = "kalici-ogrenme.pdf"

TITLE = "Kalıcı Öğrenme"
SUBTITLE = "Kanıta Dayalı Çalışma Tekniklerine Kısa Bir Rehber"

# Each page is a list of blocks: ("h1"|"sub"|"note"|"h2"|"p"|"li", text).
PAGES = [
    [
        ("h1", TITLE),
        ("sub", SUBTITLE),
        ("note", "PiCODE örnek belgesi - CC0 - tanıtım ve çalışma amacıyla yazılmıştır."),
        ("h2", "Giriş"),
        ("p", "Öğrencilerin çoğu çalışma zamanını notlarını yeniden okuyarak ve ders kitaplarının "
              "altını çizerek geçirir. Bu alışkanlıklar verimli hissettirir, çünkü konu tanıdık "
              "gelmeye başlar; ancak tanıdıklık, bilgiyi daha sonra hatırlayıp kullanabilmekle aynı "
              "şey değildir. Bu rehber, bilişsel psikoloji araştırmalarının uzun süreli akılda "
              "tutmayı tekrar tekrar iyileştirdiğini gösterdiği birkaç çalışma tekniğini özetler."),
        ("p", "Her bölüm bir fikri, neden işe yaradığını ve nasıl uygulanacağını açıklar. Bu "
              "teknikler birer hile değildir; öğrenmeyi o an için daha zor hissettirirler ve bu da "
              "az kullanılmalarının nedenlerinden biridir."),
        ("h2", "1. Neden Unutuyoruz?"),
        ("p", "Hermann Ebbinghaus 1885 yılında belleğe ilişkin ilk deneysel çalışmalardan birini "
              "yayımladı. Anlamsız hece listeleri öğrenip kendini farklı sürelerin ardından test "
              "ederek, unutmanın öğrenmeden hemen sonra en hızlı olduğunu ve ardından yavaşladığını "
              "buldu. Bu örüntü unutma eğrisi olarak bilinir."),
        ("p", "Ebbinghaus tasarrufu da ölçtü: bir listeyi yeniden öğrenmek, artık hatırlayamadığı "
              "durumlarda bile, ilk kez öğrenmekten daha kısa sürüyordu. Kaybolmuş gibi görünen "
              "anılar çoğu zaman kısmen hâlâ depolanmıştır; eski konuları tekrar etmenin işe "
              "yaramasının nedeni budur."),
        ("p", "Pratik ders basittir. Tek bir çalışma oturumunu, ne kadar uzun olursa olsun, hızlı "
              "bir unutma izler. Kalıcı öğrenme, konuya geri dönmekten ve onu etkin biçimde yeniden "
              "kurmaktan gelir."),
    ],
    [
        ("h2", "2. Geri Çağırma Pratiği"),
        ("p", "Geri çağırma pratiği, bilgiye yeniden bakmak yerine onu bilerek bellekten "
              "hatırlamaya çalışmak demektir. Bilgi kartları, alıştırma soruları ve bir konu "
              "hakkında hatırladığınız her şeyi yazmak, geri çağırmanın farklı biçimleridir."),
        ("p", "Geri çağırmanın sağladığı bu yarara test etkisi denir. Roediger ve Karpicke'nin "
              "2006 yılındaki bilinen çalışmasında öğrencilerden kısa metinler okumaları istendi. "
              "Bazı öğrenciler metinleri yeniden okurken, diğerleri hatırlama alıştırması "
              "testlerine girdi. Beş dakika sonra yapılan testte yeniden okuma biraz daha iyi "
              "görünüyordu. Bir hafta sonra yapılan testte ise geri çağırma pratiği yapan "
              "öğrenciler belirgin biçimde daha fazlasını hatırladı."),
        ("p", "Geri çağırma belleği güçlendirir, çünkü bir cevabı yeniden kurma eylemi o anıya "
              "gelecekte erişmeyi kolaylaştırır. Dolayısıyla test yalnızca öğrenmenin bir ölçüsü "
              "değildir; kendi başına bir öğrenme olayıdır."),
        ("h2", "Nasıl uygulanır?"),
        ("li", "Kitabı kapatın ve kontrol etmeden önce bellekten bir özet yazın."),
        ("li", "Başlıkları sorulara dönüştürün ve bakmadan cevaplayın."),
        ("li", "Cevaplarınızı sonradan kontrol edin. Geri bildirim hataları düzeltir ve yanlışları "
               "pekiştirmenizi önler."),
        ("li", "Geri çağırmanın zahmetli hissettirmesini bekleyin. Pratik sırasındaki zorluk "
               "normaldir ve onu etkili kılan şeyin bir parçasıdır."),
    ],
    [
        ("h2", "3. Aralıklı Çalışma"),
        ("p", "Aralıklama etkisi, aynı miktarda çalışmanın tek bir oturumda yığılmak yerine birkaç "
              "oturuma dağıtıldığında daha iyi uzun süreli akılda tutma sağladığı bulgusudur. "
              "Sınavdan önceki gece yapılan yoğun çalışma kısa vadeli performansı destekleyebilir, "
              "ancak öğrenilenlerin büyük kısmı kısa süre sonra unutulur."),
        ("p", "Cepeda ve arkadaşlarının 2006 yılında yaptığı kapsamlı bir derleme, yüzlerce "
              "aralıklama deneyini analiz etti. Derleme, aralıklı çalışmanın yığılmış çalışmadan "
              "daha başarılı olduğunu doğruladı ve oturumlar arasındaki en iyi aralığın konuyu ne "
              "kadar süre hatırlamanız gerektiğine bağlı olduğunu öne sürdü. Daha uzun akılda "
              "tutma hedefleri genellikle daha uzun aralıklar gerektirir."),
        ("p", "Aralıklama, geri çağırma pratiğiyle iyi bir uyum içinde çalışır: her aralıklı "
              "oturum, bir miktar unutma gerçekleştikten sonra konuyu hatırlamak için bir "
              "fırsattır; bu da geri çağırmayı daha zahmetli ve daha yararlı kılar."),
        ("h2", "4. Karma Çalışma"),
        ("p", "Karma çalışma, tek bir oturumda bir seferde tek bir türü çalışmak yerine farklı "
              "problem türlerini veya konuları karıştırmak anlamına gelir; tek türü art arda "
              "çalışmaya bloklu çalışma denir. Örneğin matematikte bloklu bir çalışma kâğıdı aynı "
              "türden yirmi problem içerirken, karma bir çalışma kâğıdı birkaç türü karıştırır."),
        ("p", "Bloklu pratik daha akıcı hissettirir, ancak karma pratik sizi her problem için hangi "
              "stratejinin uygun olduğuna karar vermeye zorlar. Rohrer ve Taylor'ın 2007 tarihli "
              "çalışması gibi matematik öğrenimi araştırmaları, karma pratiğin pratik sırasında "
              "daha zor hissettirmesine rağmen gecikmeli testte daha iyi performansa yol açtığını "
              "buldu."),
    ],
    [
        ("h2", "5. Ayrıntılandırma ve Kendine Açıklama"),
        ("p", "Ayrıntılandırma, nasıl ve neden soruları sorarak yeni bilgiyi zaten bildiklerinize "
              "bağlamaktır. Bir sürecin gerçekleştiğini ezberlemek yerine neden gerçekleştiğini ve "
              "dersteki diğer fikirlerle nasıl ilişkili olduğunu açıklarsınız."),
        ("p", "Kendine açıklama yakından ilişkili bir tekniktir: çözümlü bir örneği ya da bir ders "
              "kitabı bölümünü okurken her adımı kendi sözcüklerinizle kendinize açıklarsınız. "
              "Açıklamak, pasif okumanın gizlediği boşlukları ortaya çıkarır; çünkü gerçekten "
              "takip etmediğiniz bir adımı açıklayamazsınız."),
        ("p", "İyi ayrıntılandırma soruları şunlardır: Bu neden doğru? Bu, önceki kavramdan nasıl "
              "farklı? Bir koşul değişseydi ne olurdu? Bu fikri daha önce nerede gördüm?"),
        ("h2", "6. İkili Kodlama"),
        ("p", "İkili kodlama, psikolog Allan Paivio ile ilişkilendirilen ve bilginin hem sözel hem "
              "de görsel olarak temsil edilebileceğini öne süren fikirdir. Sözcükleri şemalar, "
              "zaman çizelgeleri veya çizimlerle birleştirmek, aynı fikre ulaşmanız için size iki "
              "yol sunar."),
        ("p", "İkili kodlama, notları ilgisiz resimlerle süslemek anlamına gelmez. Görsel bir anlam "
              "taşımalıdır: bir sürecin akış şeması, bir yapının etiketli diyagramı ya da olayların "
              "zaman çizelgesi gibi. Diyagramı bir geri çağırma pratiği olarak bellekten çizmeyi "
              "deneyin."),
    ],
    [
        ("h2", "7. Üstbiliş ve Akıcılık Yanılsaması"),
        ("p", "Üstbiliş, kendi öğrenmenizi izleme ve düzenleme becerisidir. Öğrenciler bir şeyi ne "
              "kadar iyi bildiklerini sıklıkla yanlış değerlendirir, çünkü yeniden okuma akıcılık "
              "yaratır: metni işlemek kolay gelir ve bu kolaylık ustalıkla karıştırılır."),
        ("p", "Bu uyumsuzluğa bazen akıcılık yanılsaması ya da yeterlilik yanılsaması denir. "
              "Bilginizi kontrol etmenin en güvenilir yolu onu test etmektir: bir fikri sayfa "
              "önünüzde olmadan açıklayamıyor ya da hatırlayamıyorsanız, onu henüz bir sınav için "
              "yeterince iyi bilmiyorsunuz demektir."),
        ("p", "Dunlosky ve arkadaşları 2013 yılında yaygın on öğrenme tekniğini inceledi. Alıştırma "
              "testlerini ve dağıtılmış pratiği yüksek yararlılıkta değerlendirdiler, çünkü "
              "bunlara ilişkin kanıtlar güçlü ve kapsamlıydı. Altını çizme, yeniden okuma ve "
              "özetleme ise düşük yararlılıkta değerlendirildi; bunun başlıca nedeni, tek "
              "başlarına kullanıldıklarında yararlarının küçük ya da tutarsız olmasıydı."),
        ("p", "Düşük yararlılık, yararsız anlamına gelmez. Altını çizmek önemli bölümleri daha "
              "sonra bulmanıza yardım edebilir ve konuyu anlamak için ilk okuma zaten gereklidir. "
              "Sorun, bu etkinlikler geri çağırmaya hazırlık yapmak yerine onun yerini aldığında "
              "ortaya çıkar."),
    ],
    [
        ("h2", "8. Hepsini Bir Araya Getirmek: Haftalık Plan"),
        ("p", "Bu rehberdeki teknikler doğal olarak birleşir. Bir ders için basit bir haftalık "
              "düzen şöyle olabilir:"),
        ("li", "1. gün: Yeni konuyu bir kez, dikkatle okuyun. Kenar boşluğuna ayrıntılandırma "
               "soruları yazın."),
        ("li", "2. gün: Notlara bakmadan hatırladıklarınızı yazın. Kontrol edin ve düzeltin."),
        ("li", "4. gün: Bu haftanın ve geçen haftanın konularını birleştiren karma alıştırma "
               "sorularını cevaplayın."),
        ("li", "7. gün: Ana fikirlerin diyagramını bellekten çizin, ardından metinle karşılaştırın."),
        ("p", "Kesin günler, örüntüden daha az önemlidir: konuya birkaç kez geri dönün, her "
              "seferinde etkin biçimde hatırlayın ve her konuyu ayrı ayrı çalışmak yerine konuları "
              "karıştırın."),
        ("h2", "Özet"),
        ("p", "Unutma hızlıdır ama yavaşlatılabilir. Geri çağırma pratiği ve aralıklı çalışma en "
              "güçlü kanıtlara sahiptir. Karma çalışma, ayrıntılandırma ve ikili kodlama esnek ve "
              "bağlantılı bilgi oluşturmanıza yardım eder. Etkili teknikler daha zor hissettirdiği "
              "için öğrenmenizi sayfanın ne kadar tanıdık geldiğine göre değil, neyi "
              "hatırlayabildiğinize göre değerlendirin."),
        ("h2", "Sözlük"),
        ("li", "Unutma eğrisi: belleğin zaman içinde önce hızlı, sonra daha yavaş azalması."),
        ("li", "Test etkisi: bilgiyi geri çağırmanın sağladığı daha iyi akılda tutma."),
        ("li", "Aralıklama etkisi: zamana yayılmış çalışmanın sağladığı daha iyi akılda tutma."),
        ("li", "Karma çalışma: tek bir alıştırma oturumunda farklı problem türlerini karıştırmak."),
    ],
]

# Turkish letters missing from WinAnsiEncoding -> otherwise unused single-byte codes.
TR_CODES = {"ğ": 0x80, "Ğ": 0x81, "ş": 0x82, "Ş": 0x83, "ı": 0x84, "İ": 0x85}
DIFFERENCES = "/Differences [128 /gbreve /Gbreve /scedilla /Scedilla /dotlessi /Idotaccent]"

# Approximate Helvetica glyph widths (fraction of font size) for line wrapping.
_NARROW = set("ijlıİ.,;:'!|`")
_SEMI = set("frt-()[] /\"I")
_WIDE = set("mwMW@%")


def char_w(ch: str, bold: bool) -> float:
    if ch in _NARROW:
        w = 0.24
    elif ch in _SEMI:
        w = 0.33
    elif ch in _WIDE:
        w = 0.86
    elif ch.isupper():
        w = 0.69
    else:
        w = 0.56
    return w * (1.07 if bold else 1.0)


def text_w(s: str, size: float, bold: bool = False) -> float:
    return sum(char_w(c, bold) for c in s) * size


def wrap(text: str, size: float, width: float, bold: bool = False) -> list[str]:
    lines, cur = [], ""
    for word in text.split():
        trial = f"{cur} {word}" if cur else word
        if text_w(trial, size, bold) <= width:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def pdf_string(s: str) -> str:
    """Escape for a PDF literal string and map Turkish letters to their custom codes."""
    s = s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    out = []
    for ch in s:
        if ch in TR_CODES:
            out.append(chr(TR_CODES[ch]))
        else:
            ch.encode("cp1252")  # raises for characters the font encoding cannot show
            out.append(ch)
    return "".join(out)


STYLES = {  # font, size, leading, space_before, space_after
    "h1": ("F2", 26, 32, 0, 4),
    "sub": ("F1", 14, 20, 0, 10),
    "note": ("F3", 9, 13, 0, 16),
    "h2": ("F2", 15, 20, 12, 6),
    "p": ("F1", 11, 15.2, 0, 8),
    "li": ("F1", 11, 15.2, 0, 4),
}


def page_stream(blocks, page_no: int, total: int) -> bytes:
    out = []
    y = TOP
    for kind, text in blocks:
        font, size, leading, before, after = STYLES[kind]
        y -= before
        x = MARGIN_X
        width = TEXT_W
        bold = font == "F2"
        if kind == "li":
            out.append(f"BT /F1 {size} Tf {x + 4} {y - size} Td (-) Tj ET")
            x += 16
            width -= 16
        for line in wrap(text, size, width, bold):
            y -= leading
            out.append(f"BT /{font} {size} Tf {x} {y + (leading - size):.1f} Td ({pdf_string(line)}) Tj ET")
        y -= after
        if y < BOTTOM:
            raise ValueError(f"Page {page_no} overflows; shorten its content")
    # Header rule and footer with page number (real page references for the demo).
    out.append("0.75 G 0.5 w 64 795 m 531 795 l S 0 G")
    out.append(f"BT /F3 9 Tf 64 803 Td ({pdf_string(TITLE)}) Tj ET")
    footer = f"Sayfa {page_no} / {total}"
    out.append(f"BT /F3 9 Tf {PAGE_W - MARGIN_X - text_w(footer, 9):.1f} 48 Td ({footer}) Tj ET")
    return "\n".join(out).encode("latin-1")


def utf16_text(s: str) -> bytes:
    """PDF text string for metadata (UTF-16BE with BOM, hex form)."""
    return b"<FEFF" + s.encode("utf-16-be").hex().upper().encode() + b">"


def build_pdf() -> bytes:
    objects: list[bytes] = []

    def add(obj: bytes) -> int:
        objects.append(obj)
        return len(objects)

    catalog = add(b"")  # placeholder, filled below
    pages_id = add(b"")
    enc = add(f"<< /Type /Encoding /BaseEncoding /WinAnsiEncoding {DIFFERENCES} >>".encode())
    fonts = [add(f"<< /Type /Font /Subtype /Type1 /BaseFont /{name} /Encoding {enc} 0 R >>".encode())
             for name in ("Helvetica", "Helvetica-Bold", "Helvetica-Oblique")]
    info = add(b"<< /Title " + utf16_text(f"{TITLE} - {SUBTITLE}") +
               b" /Author (PiCODE contributors) /Subject " + utf16_text("Örnek belge, CC0") +
               b" /Lang (tr-TR) >>")

    page_ids = []
    total = len(PAGES)
    for i, blocks in enumerate(PAGES, start=1):
        data = page_stream(blocks, i, total)
        content = add(b"<< /Length %d >>\nstream\n" % len(data) + data + b"\nendstream")
        page_ids.append(add(
            f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
            f"/Resources << /Font << /F1 {fonts[0]} 0 R /F2 {fonts[1]} 0 R /F3 {fonts[2]} 0 R >> >> "
            f"/Contents {content} 0 R >>".encode()))

    objects[catalog - 1] = f"<< /Type /Catalog /Pages {pages_id} 0 R /Lang (tr-TR) >>".encode()
    kids = " ".join(f"{p} 0 R" for p in page_ids)
    objects[pages_id - 1] = f"<< /Type /Pages /Kids [{kids}] /Count {total} >>".encode()

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for n, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{n} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (f"trailer\n<< /Size {len(objects) + 1} /Root {catalog} 0 R /Info {info} 0 R >>\n"
            f"startxref\n{xref}\n%%EOF\n").encode()
    return bytes(out)


if __name__ == "__main__":
    target = Path(__file__).with_name(OUTPUT)
    target.write_bytes(build_pdf())
    print(f"Wrote {target} ({target.stat().st_size} bytes, {len(PAGES)} pages)")
