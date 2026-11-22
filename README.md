# Google Fotoğraflar Kopya Bulucu

Doğrudan photos.google.com üzerinde çalışan Chrome eklentisi. Hiçbir şey indirmeden kütüphanedeki
kopya fotoğraf/videoları bulur ve seçtiklerini Google Fotoğraflar'ın çöp kutusuna taşır.

## Kurulum (Chrome / Edge / Brave)

1. `chrome://extensions` → sağ üstte **Geliştirici modu**nu aç
2. **Paketlenmemiş öğe yükle** → bu projedeki `extension` klasörünü seç
3. Kod değiştiğinde: eklentinin ↻ düğmesine bas, **sonra açık Google Fotoğraflar sekmelerini F5 ile yenile**

## Kullanım

1. photos.google.com'u aç. Sağ altta **Kopya Bulucu** paneli çıkar.
2. **Kopyaları tara** → sayfa kendi kendine aşağı kayar, bütün öğeleri toplar. Sekme görünür kalsın.
3. **Sonuçlar** → önizlemeler incelenir, kopyalar gruplanır. Her grupta en yüksek çözünürlüklü
   öğe yeşil **tutulacak** etiketiyle gösterilir; 🔍 ile büyük hali açılır.
4. Silinecekleri seç (ya da **Her grupta en iyisi hariç seç**) → **Çöp kutusuna taşı**.
   Taşınanlar 60 gün boyunca çöp kutusundan geri alınabilir.

### Grup türleri

Google Fotoğraflar'daki çekim zamanına göre:

| Etiket | Anlamı |
|---|---|
| Aynı anda çekilmiş | Aynı saniye → neredeyse kesin aynı fotoğrafın kopyası |
| Seri çekim | 1-60 sn arayla → peş peşe çekilmiş, farklı kareler olabilir; bakarak seç |
| Farklı zamanlarda | WhatsApp vb. üzerinden gelmiş/indirilmiş kopya olabilir |

### Silme yöntemleri

- **Hızlı (toplu):** Kütüphane ızgarasında hedefleri işaretleyip tek seferde siler. Her işaretlemede
  Google'ın "N seçildi" sayacının tam 1 arttığı, silmeden önce de sayının tuttuğu doğrulanır;
  bir şey tutmazsa seçim temizlenir ve hiçbir şey silinmez.
- **Tek tek (yavaş):** Her öğeyi açıp çöp kutusuna taşır. Öğe başına birkaç saniye.

Hızlı yöntem bir sorunla durursa kalanlar için tek tek yönteme geçmeyi önerir.

## Nasıl çalışıyor

- `content.js` — Google Fotoğraflar sayfasında panel, otomatik kaydırma, silme
- `results.html/js` — önizlemeleri indirip pHash hesaplar, çözünürlüğü ölçer, gruplar, seçimi yönetir
- `hash.js` — pHash (Python `imagehash` ile birebir aynı sonuç) + BK-tree ile gruplama

Google'ın bu iş için resmi API'si yok; eklenti sayfanın yapısını okuyor. Google arayüzü değiştirirse
bir şey bozulabilir: paneldeki **Tanılama** düğmesi, düzeltmek için gereken bilgiyi panoya kopyalar.
