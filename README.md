# qvac-mobile

**QVAC-BOARD per telefono** (iOS e Android): modelli AI che girano sul telefono con [QVAC](https://qvac.tether.io), e quando serve i modelli più grandi del tuo desktop ([qvac-web-server](https://github.com/bitcoininvenice/qvac-web-server)) via P2P. Niente cloud.

## Cosa fa

- **Chat** con un modello sul telefono (Qwen3 0.6B, anche offline) o con i modelli del desktop; connettori MCP del telefono e del desktop
- **Parla**: conversazione a voce a mani libere, con risposta frase per frase, interruzione a voce e memoria della conversazione; riconoscimento vocale sul dispositivo
- **Messaggi** cifrati end-to-end (Double Ratchet su libsodium): testo, emoji, foto e file tra i tuoi dispositivi e con altre persone (contatto con QR o codice), anche a desktop spento
- **Dispositivi**: abbinamento al desktop con QR o codice, rete mesh, invio di file nei due sensi
- **Home** con lo stato del desktop dal vivo

### Come si collega

Da solo, sempre sulla via migliore, cifrata con chiavi nuove a ogni collegamento:
🏠 rete locale → 🔵 Bluetooth → ⚡ Holepunch (P2P diretto) → 📡 relay Nostr.
Il P2P gira in un worker [Bare](https://bare.pears.com) dentro l'app (`p2p-worker/`).

## Requisiti

- Node **22.23.5** (`.nvmrc`: `nvm use`)
- iOS: Xcode, CocoaPods, iPhone **fisico** con iOS ≥ 17 (QVAC non gira nel simulatore)
- Android: Android SDK, NDK 29.0.14206865, JDK 17, telefono arm64 con Android ≥ 10; circa 5 GB liberi per compilare

## Compilare

```bash
npm install
npm run worker:pack          # dopo ogni modifica a p2p-worker/
npx expo prebuild            # genera ios/, android/ e il worker QVAC in qvac/
```

**iOS**: prima metti il tuo Apple Team ID in `.env.local` (ignorato da git; lo trovi in Xcode → Settings → Accounts), poi rigenera con `npx expo prebuild --platform ios`:

```bash
echo "APPLE_TEAM_ID=XXXXXXXXXX" > .env.local
```

Poi in `ios/`:

```bash
xcodebuild -workspace QVACBOARD.xcworkspace -scheme QVACBOARD -configuration Release \
  -destination 'generic/platform=iOS' -allowProvisioningUpdates build
```

Con un Apple ID gratuito l'app dura 7 giorni; al primo avvio: Impostazioni → Generali → VPN e gestione dispositivi → Autorizza.

**Android** (in `android/`):

```bash
./gradlew assembleRelease
```

`ios/`, `android/` e `qvac/` sono generati da `expo prebuild`: non si modificano a mano, si configura tutto in `app.json`.

## Aggiornare l'SDK QVAC

L'app usa `@qvac/sdk` da npm, più i motori nativi `@qvac/fabric-ios` e `@qvac/fabric-android-arm64`, che devono essere della versione richiesta dai motori dell'SDK.

```bash
npm install @qvac/sdk@latest
npm ls @qvac/fabric-ios               # mostra la versione di fabric che i motori si aspettano
npm install --save-exact @qvac/fabric-ios@<versione> @qvac/fabric-android-arm64@<versione>
npx expo prebuild --clean             # rigenera ios/, android/ e il worker QVAC in qvac/
```

Poi ricompila l'app (iOS e/o Android, vedi sopra). `qvac.config.json` decide quali motori finiscono nell'app (oggi solo la chat, per tenerla leggera).

**Da un fork di QVAC** (cartella `../qvac`, accanto a questa): dalla cartella di questo progetto lancia lo script di [qvac-web-server](https://github.com/bitcoininvenice/qvac-web-server#aggiornare-lsdk-qvac), che ricostruisce l'SDK e lo installa qui con un percorso relativo:

```bash
../qvac-web-server/scripts/qvac-sdk-sync.sh
npx expo prebuild --clean
```

Il worker P2P (`p2p-worker/`) non usa l'SDK: non serve reimpacchettarlo quando aggiorni QVAC.

## Struttura

- `App.tsx` — schede e chat
- `src/` — schermate (`Messages.tsx`, `VoiceScreen.tsx`, `Devices.tsx`, `SettingsScreen.tsx`…) e logica (`p2p.ts`, `voiceText.ts`, `connectors.ts`, `prompt.tsx`)
- `p2p-worker/` — worker Bare: `worker.js`, `msg-core.js` (messaggi cifrati), `nostr-link.js` (relay Nostr); `msg-core.js` e `nostr-link.js` hanno una copia identica in `qvac-web-server/p2p/`
- `p2p-worker-pkg/` — pacchetto generato da `npm run worker:pack` (incluso, serve a `npm install`)
- `modules/qvac-ble/` — modulo nativo Bluetooth (Swift e Kotlin)

## Nota

Progetto indipendente, non affiliato a Tether. QVAC è un marchio dei rispettivi proprietari.

## Licenza

MIT, vedi [LICENSE](LICENSE).
