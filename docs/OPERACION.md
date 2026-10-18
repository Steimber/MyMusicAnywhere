# Guía de Operación y Mantenimiento (`MyMusicAnywhere`)

Manual operativo para despliegue, reversión, servicios auxiliares, configuración de entorno y mantenimiento periódico. Todos los identificadores de infraestructura utilizan marcadores genéricos (`<VPS_HOST>`, `<APP_DIR>`, `<DOMINIO_BACKEND>`, `<ADMIN_USERNAME>`, `<REDACTED>`).

---

## 1. Procedimiento de Despliegue

Toda versión nueva debe revisarse y pasar las suites de pruebas y auditoría antes de actualizar el servicio en `<VPS_HOST>`:

```bash
cd <APP_DIR>
git pull origin main

# Ejecutar npm ci únicamente si cambiaron package.json o package-lock.json
npm ci

# Verificar tests unitarios, ausencia de secretos y compilación de producción
npm test
npm run check:secrets
npm run build

# Reiniciar el proceso en PM2
pm2 restart mymusicanywhere
```

---

## 2. Procedimiento para Volver Atrás (Rollback)

### Copia preventiva antes de actualizaciones mayores
Antes de actualizar versiones mayores del framework o dependencias críticas, conservar una copia local en `<VPS_HOST>` de `node_modules`, `.next`, `package.json` y `package-lock.json`:

```bash
cp -a <APP_DIR>/node_modules <APP_DIR>/.next <APP_DIR>/package.json <APP_DIR>/package-lock.json <APP_DIR>-rollback-$(date +%Y%m%d_%H%M)/
```

### Reversión rápida a un commit anterior
Si un despliegue presenta fallos en producción:

```bash
cd <APP_DIR>
git checkout <COMMIT_ANTERIOR>
npm ci
npm run build
pm2 restart mymusicanywhere
```

---

## 3. Servicios Auxiliares en `<VPS_HOST>`

1. **Proveedor de PO-Token (`bgutil`):**
   - Escucha exclusivamente en `127.0.0.1:4416` (sin exponer puertos al exterior).
   - Gestionado bajo `pm2` con límite de reinicio por memoria de **250 MB** (`--max-memory-restart 250M`).
2. **Rotación de registros (`pm2-logrotate`):**
   - Configurado con tamaño máximo de **10 MB** por archivo (`max_size: 10M`) y retención de **5 archivos** rotados (`retain: 5`) para evitar llenar el disco con trazas de descargas.

---

## 4. Variables de Entorno (`.env`)

En el archivo `.env` local (nunca versionado en Git) se configuran las siguientes variables:

| Variable | Valor por defecto | Descripción |
|---|---|---|
| `MAX_NET_DOWNLOADS` | `4` | Número máximo de descargas simultáneas de red (`yt-dlp`). |
| `MAX_CPU_JOBS` | `2` | Número máximo de procesos `ffmpeg` simultáneos en la cola de CPU. |
| `MAX_PER_USER` | `2` | Tope de descargas activas simultáneas para un mismo usuario cuando hay competencia. |
| `MAX_QUEUED_PER_USER` | `8` | Máximo de descargas en espera en el servidor por usuario. |
| `ENABLE_BILIBILI` | `true` | Permite habilitar (`true`) o desactivar (`false`) el respaldo de Bilibili. |
| `YTDLP_BIN` | `yt-dlp` | Ruta al binario de `yt-dlp` en el servidor. |
| `FFMPEG_BIN` | `ffmpeg` | Ruta al binario de `ffmpeg` en el servidor. |
| `YTDLP_POT_PROVIDER_URL` | `http://127.0.0.1:4416` | Endpoint local del proveedor de PO-Token para YouTube. |
| `SESSION_SECRET` | `<REDACTED>` | Clave secreta HMAC para firmar las cookies de sesión (`HttpOnly`). |
| `ADMIN_USERNAME` | `<ADMIN_USERNAME>` | Nombre de usuario de la cuenta administradora inicial. |
| `ADMIN_PASSWORD` | `<REDACTED>` | Contraseña inicial del administrador (almacenada como hash `scrypt`). |
| `VAPID_PUBLIC_KEY` | `<REDACTED>` | Clave pública VAPID (si se utilizan notificaciones push). |
| `VAPID_PRIVATE_KEY` | `<REDACTED>` | Clave privada VAPID. |
| `VAPID_SUBJECT` | `mailto:<REDACTED>` | Identificador de contacto para notificaciones VAPID. |
| `VPS_BACKEND_URL` | `https://<DOMINIO_BACKEND>` | *(Solo en Vercel)* URL base del backend hacia donde `next.config.mjs` redirige `/api/*`. |

---

## 5. Mantenimiento Periódico

1. **Actualizar `yt-dlp` con frecuencia:**
   - Los extractores de YouTube y SoundCloud cambian con regularidad. Actualizar el binario en `<VPS_HOST>` (`yt-dlp -U` o mediante `pip install -U yt-dlp`) ante caídas en la tasa de éxito.
2. **Renovar cookies de YouTube desde el panel de Admin:**
   - Cuando YouTube empiece a rechazar descargas por sesión caducada, abrir una **ventana de incógnito/privada**, iniciar sesión con una **cuenta secundaria**, exportar las cookies en formato Netscape, **cerrar la ventana privada de inmediato** (para que el navegador no rote las cookies) y pegarlas en el panel de administración de la app.
3. **Copia de seguridad externa de `data/store.json`:**
   - El archivo `data/store.json` contiene los usuarios, invitaciones, bibliotecas y listas personalizadas.
   - Generar copias con permisos `600` en `<VPS_HOST>` y descargarlas periódicamente fuera del servidor a un equipo local:
     ```bash
     scp <SSH_USER>@<VPS_HOST>:<APP_DIR>/data/store.json ./mymusic-store-backup-$(date +%Y%m%d).json
     ```

---

## 6. Registros (`Logs`) Útiles y Diagnóstico

Las trazas del servidor incluyen prefijos estructurados para diagnosticar el comportamiento de búsqueda y descarga:

- **`[download] OK ...` / `[download] skip ...`**: muestra qué fuente (`yt`, `sc`, `au`, `bi`) resolvió cada canción o por qué se descartó un candidato.
- **`[search-filter]`**: detalla qué candidatos fueron descartados por duración, Shorts, remixes no solicitados o enlaces con DRM.

### Comandos rápidos de inspección

Contar aciertos y descartes por fuente en los registros recientes de PM2:

```bash
# Ver las últimas líneas de descarga y filtrado
pm2 logs mymusicanywhere --lines 100 --nostream | grep -E '\[download\]|\[search-filter\]'

# Contar aciertos (OK) vs descartes (skip) en el archivo de log actual
grep '\[download\] OK' ~/.pm2/logs/mymusicanywhere-out.log | wc -l
grep '\[download\] skip' ~/.pm2/logs/mymusicanywhere-out.log | wc -l
```
