# Decisiones de Arquitectura e Ingeniería (`MyMusicAnywhere`)

Este documento registra las decisiones técnicas adoptadas en el proyecto, las mediciones reales que las motivaron y las compensaciones asumidas. Ningún valor sensible ni dato de infraestructura real está incluido en este archivo.

---

## 1. Formato AAC/m4a sin recodificar en lugar de MP3

- **Qué se decidió:** Descargar y empaquetar las pistas directamente en contenedor `.m4a` (AAC/MP4 con copia de flujo `-c:a copy` cuando el origen ya es compatible) en lugar de transcodificar sistemáticamente a `.mp3` con `libmp3lame`.
- **Por qué:** Medido en `<VPS_HOST>`, la recodificación completa a MP3 consumía más del **50 % de la CPU** durante **~7 s por canción**, provocando cuellos de botella cuando coincidían varias descargas. El remux directo a `.m4a` tarda **<1 s** por pista y libera inmediatamente la cola de CPU.
- **Coste asumido:** Los archivos resultantes ocupan aproximadamente un **~50 % más de espacio** en el almacenamiento local del navegador móvil (`CacheStorage`), a cambio de reducir drásticamente la latencia y la carga del servidor.

---

## 2. Separación Paso A (Red) / Paso B (CPU)

- **Qué se decidió:** Dividir cada descarga en dos etapas desacopladas:
  - **Paso A (Cola de Red):** `yt-dlp` descarga únicamente el flujo de audio crudo (`.raw.*`) sin `-x`, sin `--embed-metadata` y sin posprocesamiento.
  - **Paso B (Cola de CPU):** `ffmpeg` realiza el remux final a `.m4a` sin filtros de audio como `afade` (aplicar `afade` obliga a decodificar y recodificar todo el flujo).
- **Por qué:** Separar red y CPU impide que procesos `ffmpeg` bloqueen los huecos de descarga o saturen los núcleos del servidor. Además, al usar `--print` junto con `--progress` y `--newline` en `yt-dlp`, el porcentaje de avance se emite por **stdout** (comprobado en producción), permitiendo actualizar la barra de progreso en tiempo real vía NDJSON.

---

## 3. Dos colas independientes con reparto justo (Work-Conserving Fair Share)

- **Qué se decidió:** Mantener dos pools globales en `lib/download/queue.js`:
  - **Pool de red:** `MAX_NET_DOWNLOADS = 4` por defecto.
  - **Pool de CPU:** `MAX_CPU_JOBS = 2` por defecto.
  - El planificador (`pumpNetQueue`) calcula los usuarios presentes (`present = new Set([...netTurnOrder, ...netActiveByUser.keys()])`) y reparte los huecos en **2 pasadas**:
    1. **Pasada 1 (cuota justa):** garantiza a cada usuario presente hasta `Math.max(1, Math.floor(maxNetDownloads / present.size))` descargas simultáneas.
    2. **Pasada 2 (work-conserving):** si quedan huecos libres porque algún usuario solo pidió 1 canción, los asigna por turno hasta `MAX_PER_USER` para no desperdiciar ancho de banda.
- **Por qué:** Con un límite fijo estricto o mirando solo la cola en espera, un tercer usuario podía esperar de más o dejar huecos ociosos. Medido en pruebas de carga reales, un lote de 8 canciones bajó de **78 s a 43 s** manteniendo equidad entre usuarios concurrentes.

---

## 4. Orden dinámico de fuentes según disponibilidad de cookies

- **Qué se decidió:**
  - **Con cookies de YouTube válidas:** probar **YouTube primero**, seguido de SoundCloud y Audius.
  - **Sin cookies de YouTube:** probar **SoundCloud primero**, evitando el fallo inicial de YouTube antes de caer al respaldo.
  - **Bilibili siempre al final:** acotado a un límite estricto de **15 s** y desactivable mediante `ENABLE_BILIBILI=false`.
- **Por qué:** En mediciones reales de producción, Bilibili registró apenas **4 aciertos de 32 intentos** y añadía latencia innecesaria cuando iba delante de otras fuentes. Priorizar SoundCloud cuando no hay sesión autenticada evita esperas inútiles.

---

## 5. Búsqueda siempre sin cookies

- **Qué se decidió:** Las consultas de búsqueda (`ytsearch5:...`) y enriquecimiento de metadatos **nunca** pasan el archivo de cookies a `yt-dlp`; las cookies se reservan exclusivamente para la descarga del flujo de audio cuando hace falta.
- **Por qué:** Usar cookies en cada búsqueda gasta innecesariamente la sesión de Google y acelera la rotación o invalidación de las cookies. Además, se comprobó en los registros que los descartes en `ytsearch5` provenían de los filtros de calidad/duración (`evaluateCandidate`), no de bloqueos de búsqueda.

---

## 6. Proveedor de PO-Token (`bgutil`) en localhost y gestión de cookies

- **Qué se decidió:** Ejecutar el proveedor HTTP de PO-Token en `127.0.0.1:4416` como servicio auxiliar, combinado con cookies exportadas desde una **cuenta secundaria** en una **ventana privada que se cierra inmediatamente después de exportar**.
- **Por qué:** El PO-Token (`bgutil`) es necesario para los clientes web de YouTube, pero **no es suficiente por sí solo**: cuando YouTube marca la IP del centro de datos (`<VPS_HOST>`), el bloqueo anti-bot salta antes de validar el PO-Token. Exportar cookies desde una ventana privada cerrada evita que el navegador siga rotando los tokens de sesión en segundo plano.

---

## 7. Sin Web Audio API (`AudioContext`) en el reproductor

- **Qué se decidió:** Descartar el uso de `AudioContext` y `createMediaElementSource(audio)` en el cliente para efectos de sonido envolvente o ecualizador.
- **Por qué:** `createMediaElementSource` secuestra de forma irreversible la salida del elemento `<audio>` durante toda la vida del nodo DOM. En iOS (WebKit), el sistema suspende el `AudioContext` al bloquear la pantalla o al cambiar de pista en segundo plano (`onEnded`), dejando el reproductor en silencio. Para proteger la reproducción con pantalla bloqueada en iPhone, el `<audio>` se mantiene 100 % nativo.
- **Alternativa futura:** Si se desea ofrecer perfiles de ecualización, aplicarlos en el servidor mediante filtros de `ffmpeg` al generar el archivo.

---

## 8. Ruta síncrona intocable para reproducción en iOS

- **Qué se decidió:** `startTrackAtIndexImmediate` y el manejador `onEnded` deben ejecutarse de forma **estrictamente síncrona**, asignando `.src` y llamando a `audio.play()` en el mismo tick sin ningún `await` intermedio ni operaciones que puedan lanzar excepciones.
- **Por qué:** En iOS Safari y PWAs instaladas en iPhone, cualquier promesa o retraso asíncrono antes de `audio.play()` rompe el contexto de activación de audio o impide que la siguiente canción de la cola arranque con la pantalla bloqueada.

---

## 9. View Transitions con `flushSync` y animaciones en GPU

- **Qué se decidió:**
  - Envolver los cambios de pestaña y librería (`setActiveTab`, `setSelectedLibrary`) en `document.startViewTransition` usando `flushSync` (`react-dom`) para que React 18 confirme el DOM dentro del callback de transición.
  - Restringir todas las animaciones CSS a propiedades compuestas en GPU (`transform` y `opacity`) con curvas `linear()` y respaldo `cubic-bezier`, desactivándolas automáticamente bajo `prefers-reduced-motion: reduce`.
- **Por qué:** Sin `flushSync`, React 18 difiere el renderizado fuera del frame de captura de `startViewTransition`. Limitar las animaciones a `transform` y `opacity` garantiza 60 fps en móviles sin recalcular layout ni interferir con el hilo de audio.

---

## 10. Mezcla equilibrada (Balanced Dithered Shuffle)

- **Qué se decidió:** Extraer el algoritmo de mezcla aleatoria a un módulo puro y testeable (`lib/shuffle.js`) basado en el enfoque **Balanced Dithered Shuffle**:
  - Agrupa pistas por artista, baraja internamente cada grupo y distribuye sus posiciones virtuales en `[0, 1)` con un desfase aleatorio y jitter (`wrap01(offset + (i + jitter) / k)`).
  - Incluye un pase de reparación acotado (`repairAdjacentArtists`) para evitar que suenen dos canciones seguidas del mismo artista siempre que sea matemáticamente posible, manteniendo fija `order[0]` cuando el usuario elige la primera canción manualmente (`startIdx >= 0`).
  - Aplica una ventana de enfriamiento (`recentKeys`) para no repetir en las primeras 5 posiciones las canciones recién escuchadas en la sesión.
  - La normalización de artistas (`createArtistKeyResolver`) es **contextual a la biblioteca**: limpia siempre `feat.`/`ft.`/`with`, pero solo separa en `,` o ` & ` si el artista principal existe por separado en la lista y no forma parte de un nombre de banda o dúo legítimo (preservando intactos casos como *"Simon & Garfunkel"*, *"Earth, Wind & Fire"* y *"Tyler, The Creator"*).
- **Por qué:** Un Fisher–Yates puro produce rachas frecuentes del mismo artista en bibliotecas grandes y no permite pruebas deterministas si vive acoplado al componente de cliente.

---

## 11. Seguridad de ejecución, red y sesiones

- **Qué se decidió:**
  - Ejecutar `yt-dlp` y `ffmpeg` exclusivamente mediante `spawn(bin, args, { shell: false })`.
  - Validar cualquier URL externa frente a una lista blanca estricta de dominios permitidos (`ALLOWED_MEDIA_HOSTS`), bloqueando direcciones locales o privadas (anti-SSRF).
  - Escribir cookies temporales en `/tmp` con permisos `0o600` y eliminarlas al terminar.
  - Separar los límites de intentos de inicio de sesión en `app/api/auth/route.js`: máximo **5 intentos fallidos por usuario** y **20 por IP** cada 15 minutos, emitiendo cookies de sesión con atributos `HttpOnly`, `SameSite=Lax` y `Secure` en producción.
  - Actualizar `next` a `^16.4.2` manteniendo `0` vulnerabilidades en `npm audit --omit=dev`.
- **Por qué:** Evita inyección de comandos, protege a usuarios que comparten IP (NAT móvil o Wi-Fi doméstico) frente a bloqueos cruzados y mantiene el árbol de dependencias libre de CVEs conocidos.

---

## 12. Limitación de widgets en iPhone (iOS PWA)

- **Qué se decidió:** No desarrollar código nativo de WidgetKit dentro del repositorio web; documentar como alternativa el uso de un widget del sistema en la app **Atajos (Shortcuts)** de iOS con las acciones *"Reproducir/Pausar"* y *"Siguiente pista"*.
- **Por qué:** iOS no permite que una PWA instalada desde el navegador registre extensiones de WidgetKit en la pantalla de inicio. Como la app ya expone sus controles al sistema mediante `navigator.mediaSession`, los Atajos nativos de iOS controlan la reproducción directamente sin necesidad de una app nativa en la App Store.
