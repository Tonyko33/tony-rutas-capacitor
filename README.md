# Tony Repartos (Capacitor)

App para organizar paquetes, escanear QR, tomar fotos, optimizar rutas y abrirlas en Google Maps. Lista para compilar APK con Capacitor.

## Requisitos (local)
- Node 18+ y npm
- Java 17
- Android Studio (SDK y emulador o dispositivo)

## Pasos (local)
```bash
npm i
npm run build
npm run cap:add:android   # solo la primera vez
npm run cap:sync:android
cd android
./gradlew assembleDebug
# APK en android/app/build/outputs/apk/debug/app-debug.apk
```

## GitHub Actions (nube) — sin Android Studio
1. Sube este repo a GitHub (rama `main`).
2. Ve a **Actions** → **Build Android APK** → **Run workflow**.
3. Descarga el artefacto `app-debug.apk` (instalable en tu Android).

## Firma (release)
- Crea un keystore y variables de entorno en GitHub Secrets (KEYSTORE_BASE64, KEYSTORE_PASSWORD, KEY_ALIAS, KEY_PASSWORD).
- Cambia el job a `assembleRelease` y añade el paso de firmado/zipalign.
- O firma desde Android Studio.

## Permisos
- Cámara (escáner QR).
- Geolocalización (origen de ruta).

## Notas
- Geocodificación: OpenStreetMap/Nominatim (uso responsable).
- Google Maps waypoints (~9 máx. por ruta); divide rutas largas.
- Datos en `localStorage`.
