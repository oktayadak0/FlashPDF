# FlashPDF

PDF okurken seçtiğiniz metinleri, tekrar döndüğünüz bölümleri ve sayfalarda geçirdiğiniz süreyi kullanarak çalışma notları hazırlayan yerel PDF okuyucu. Notlar özet, önemli noktalar, kaynak alıntıları ve tekrar soruları içerir.

## Özellikler

- PDF görüntüleme, metin seçimi, arama, yakınlaştırma ve sayfa gezintisi.
- Kullanıcının izniyle okuma süresi, metin seçimi ve tekrar okunan bölümlerin takibi.
- Seçilen ve tekrar okunan bölümlere öncelik veren not üretimi.
- Alıntıları ve sayfa numaralarını PDF metniyle karşılaştırma; kaynağa tıklayarak ilgili sayfaya dönme.
- Notları kaydetme, düzenleme, silme ve Markdown veya JSON olarak dışa aktarma.
- Açık ve koyu tema; dar ekranlara uyumlu arayüz.
- Model gerektirmeyen, örnek PDF için hazırlanmış demo modu.

## Nasıl çalışır?

Arayüz HTML, CSS ve JavaScript modüllerinden oluşur. PDF.js belgeleri tarayıcıda görüntüler ve metinlerini çıkarır. FastAPI arayüzü sunar ve model isteklerini iletir. Varsayılan model bağlantısı yerel Ollama üzerinden `gemma4:e2b` kullanır; OpenAI uyumlu sunucular için ayrı bir adaptör de bulunur.

Model, belgenin tamamı yerine okuma verilerine göre seçilmiş en fazla 8 metin parçası ve toplam 12.000 karakterlik alıntı alır. Dönen sonuç JSON şemasıyla kontrol edilir. Tarayıcı, alıntıları ve sayfa referanslarını çıkarılmış PDF metniyle karşılaştırır; desteklenmeyen öğeleri işaretler veya kaldırır.

## Kurulum

Python 3.10 veya üzeri gerekir. Node.js ve frontend derlemesi gerekmez. Canlı not üretimi için ayrıca Ollama ve bir model kurulmalıdır.

### Windows

`RUN.bat` dosyasını çalıştırın. Python ve Ollama bulunmuyorsa `winget` üzerinden kurmayı dener, sanal ortamı ve Python bağımlılıklarını hazırlar, ardından uygulamayı tarayıcıda açar. Model kurulu değilse demo kullanılabilir; model indirme adımı aşağıdadır.

Elle kurulum:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
.\.venv\Scripts\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

### macOS / Linux

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
.venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

Tarayıcıda <http://127.0.0.1:8000> adresini açın. Örnek belgeyi yükleyip **Demo** seçeneğiyle model olmadan deneyebilirsiniz. Demo sonuçları önceden hazırlanmıştır.

### Yerel model

[Ollama](https://ollama.com) kurulu ve çalışır durumdayken varsayılan modeli indirin:

```bash
ollama pull gemma4:e2b
```

Uygulamadaki **Model** ayarlarından sunucu adresini ve model etiketini kontrol edin. Varsayılan adres `http://127.0.0.1:11434` olur. Ollama kurulu modelleri ve model ailesini bildirir; OpenAI uyumlu sunucularda aile kontrolü model adına dayanır. Seçili model bulunamazsa Ollama adaptörü kurulu modellerden birini seçebilir; sonuçlarda kullanılan modelin adı gösterilir.

### Yapılandırma

| Ortam değişkeni | Varsayılan | Açıklama |
|---|---|---|
| `PICODE_RUNTIME` | `ollama` | `ollama` veya `openai` |
| `PICODE_MODEL_BASE_URL` | `http://127.0.0.1:11434` | Model sunucusu |
| `PICODE_MODEL` | `gemma4:e2b` | Model etiketi |
| `PICODE_TIMEOUT` | `300` | Yanıt parçaları arasındaki zaman aşımı, saniye |
| `PICODE_NUM_CTX` | `4096` | Ollama bağlam boyutu |
| `PICODE_API_KEY` | Boş | Gerekiyorsa model sunucusu için erişim anahtarı |

Model penceresinde kaydedilen sunucu ve model ayarları `backend/picode.config.json` dosyasında tutulur ve ilgili ortam değişkenlerinden önce uygulanır. Bu dosya Git dışında tutulur. PiCODE altyapısıyla uyumluluk için eski `FOCUSNOTE_*` değişkenleri ve `backend/focusnote.config.json` dosyası da okunur.

`RUN.bat` için `PICODE_PORT` portu belirler; `PICODE_NO_BROWSER=1` tarayıcının otomatik açılmasını kapatır. `RUN.bat --no-start` yalnızca kurulum adımlarını çalıştırır.

## Gizlilik ve veri saklama

PDF dosyası tarayıcıda okunur; uygulama dosyanın kendisini sunucuya yüklemez veya saklamaz. Notlar, oturum özetleri, son analiz ve tercihler tarayıcının IndexedDB veritabanında saklanır. Belgeye ait veriler veya tüm kayıtlar uygulama içinden silinebilir.

Okuma takibi izin gerektirir; duraklatılabilir ve kapatılabilir. Fare hareketi, klavye girdisi veya diğer uygulamalar takip edilmez. Analiz ancak kullanıcı istediğinde başlar. Gönderilecek metin parçaları ve okuma verileri önceden görüntülenebilir; kayıtlı notlar yalnızca ilgili seçenek işaretlenirse eklenir.

Yerel model kullanıldığında analiz cihazda kalır. Uzak bir model sunucusu yapılandırılırsa seçilen PDF metinleri ve okuma verileri o sunucuya gönderilir; uygulama her analiz öncesinde onay ister. Erişim anahtarı backend tarafında tutulur ve tarayıcıya verilmez. Analitik servisi, CDN veya harici font isteği bulunmaz.

## Testler

Proje kökünde, bağımlılıkların kurulu olduğu Python ortamıyla:

```bash
python -m unittest discover -s backend/tests -t .
```

Tarayıcı testleri için uygulamayı başlatıp <http://127.0.0.1:8000/tests/> adresini açın. Testler okuma sinyallerini, bağlam sınırlarını, alıntı doğrulamasını, yerel saklamayı ve dışa aktarmayı kapsar. Backend testleri taklit model yanıtları kullanır; canlı model kalitesini ölçmez. Ayrıntılar: [test rehberi](tests/README.md).

## Sınırlar

OCR bulunmaz; metin katmanı olmayan taramalar görüntülenebilir ancak analiz edilemez. PDF boyutu en fazla 100 MB, metin çıkarımı en fazla 2.000 sayfadır. Büyük belgelerin analizi seçilmiş parçalarla sınırlıdır. Çok sütunlu sayfalar ve tablolar metin sırasını etkileyebilir.

Okuma süresi ve tekrar okuma, kaydırma ve sayfa etkileşimlerinden çıkarılan yaklaşık ölçümlerdir; kullanıcının konuyu anladığını veya zorlandığını göstermez. Alıntı kontrolü notların tamamının doğru olduğunu garanti etmez. Her belge için yalnızca son analiz saklanır; model hızı donanıma ve model boyutuna bağlıdır.

## Dizinler

- `js/`: PDF okuyucu, okuma takibi, notlar ve yerel saklama.
- `backend/`: FastAPI, model adaptörleri, istemler ve testler.
- `schema/`: ortak analiz şeması.
- `samples/`: örnek PDF ve bağımlılıksız üretim betiği.
- `tests/`: tarayıcı testleri.
- `vendor/pdfjs/`: yerel sunulan PDF.js dosyaları.

Katkı süreci: [CONTRIBUTING.md](CONTRIBUTING.md).

## Lisanslar

PDF.js, [Apache 2.0](vendor/pdfjs/LICENSE) lisansıyla dağıtılır. Örnek *Kalıcı Öğrenme* belgesi ve üretim betiği CC0 olarak sunulmuştur. Projenin kendi kaynak kodu için henüz bir lisans dosyası bulunmuyor. Model kullanımı, seçilen modelin lisans koşullarına tabidir.
