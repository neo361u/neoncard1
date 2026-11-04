# Neon Card Arena — V5 | Ayrı Seçim Ekranı + Düello Masası

## Başlatma
Node.js 18+ gerektirir.

```bash
npm install
npm start
```

Tarayıcıdan http://localhost:3000 sayfasını aç.

## Render
- Repo: bu klasörün `package.json` dosyasını içeren dizini
- Root Directory: `neon-card-arena-v5` (GitHub deposuna bu klasörü olduğu gibi yüklediysen)
- Build Command: `npm install`
- Start Command: `npm start`
- Runtime: Node

## Oyun
- 2 oyuncu; şifreli odalar ve izleyici modu.
- Oyuncular, ayrı seçim ekranında sırayla 3 ana kart ve 2 destek kartı seçer.
- 4D6 toplamından maç bütçesi; 10'dan düşükse +2 telafi.
- Her el ana kartlar gizli oynanır, iki kart seçilince birlikte açılır.
- Sonra her oyuncu 2D6 atar: 1. zar saldırı, 2. zar RAM testi.
- RAM testi başarısızsa bonus ve destek hakkı yoktur; başarılıysa bonus eklenir, fazla RAM ile destek oynanır.
- Hafif destekler Cost 0, RAM 2'dir (Dexter ve Johnny). Geçici dengeleme: Dexter +2 güç, Johnny +4 güç.
- Destek kartı Cost içerirse ancak oynandığı anda maç bütçesinden düşülür (sunucu kuralları bunu destekler).
- Bütçesiyle hiçbir ana kartı oynayamayan oyuncu otomatik pas geçer; rakip eli kazanır.
- 3 el veya 2 galibiyet sonu maç biter.

## Notlar
- İki maliyetsiz orijinal kart mevcut olduğundan seçim havuzunda her bir destek kartının iki kopyası vardır. Böylece iki oyuncu da 2 destek seçebilir. Kartların gerçek özel yetenekleri için ayrıca kart yeteneği tanımlaması gerekir.
- Odalar sunucu belleğinde tutulur; Render uykuya geçtiğinde veya yeniden başlatıldığında sıfırlanır.
