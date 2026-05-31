# CERTUS / STELA

Sistema de conteo preliminar para procesos electorales, construido desde el Documento de Especificaciones Funcionales del curso SI720.

## Alcance implementado

- Captura/carga de cedula digital y procesamiento simulado preparado para reemplazo por escaner/IA real.
- Escaner virtual por QR general que asigna aleatoriamente una de las mesas disponibles.
- Votacion virtual desde celular, tablet o proyector.
- Registro ciudadano por DNI, correo y codigo de verificacion enviado por Resend.
- Deteccion de marcas, determinacion de candidato y clasificacion de voto valido, nulo o en blanco.
- Registro centralizado por mesa, control de duplicidad, hash de integridad y trazabilidad de estados.
- Respaldo digital cifrado de imagenes de cedulas.
- Resultados preliminares generales y detalle por mesa.
- Validacion cruzada con actas fisicas, incidencias y reportes automaticos.
- Gestion de usuarios, roles, permisos e historial de acciones.
- UI responsive minimalista con paleta institucional `#1D3096` y `#5B6EA6`.

## Comandos

```powershell
npm install
npm run build
npm test
npm start
```

La app queda disponible en `http://localhost:3000` despues de `npm start`.

## Conexion con Supabase

El proyecto usa Supabase como base remota de sincronizacion:

- URL: `https://otxywgtcqpnqaxsqtcny.supabase.co`
- Votos: se sincronizan con las tablas de Supabase usando `SUPABASE_SERVICE_ROLE_KEY` en el servidor.
- Auth ciudadano: se maneja dentro de CERTUS con DNI + correo + codigo OTP; OAuth externo ya no se usa para votantes.
- Perfil remoto: al validar el OTP, el servidor crea o reutiliza un usuario en Supabase Auth y guarda `supabaseUserId` para cumplir las FK de recibos y auditoria.
- Produccion en Vercel: usa `CERTUS_REMOTE_DB=true` para guardar el estado de la app en Supabase y no depender del filesystem serverless.

No coloques `SUPABASE_SERVICE_ROLE_KEY` en variables `VITE_`; esa llave solo debe existir en backend. Si quieres exigir que cada voto quede escrito en Supabase antes de responder, usa `CERTUS_REQUIRE_SUPABASE_SYNC=true`.

## Registro ciudadano

- El votante ingresa nombres y apellidos, DNI y correo.
- CERTUSPE envia un codigo de 6 digitos por correo.
- Al validar el codigo, se crea o reutiliza la cuenta ciudadana.
- La app bloquea doble voto por usuario ciudadano dentro del proceso electoral.
- El dashboard operativo sigue usando correo y contrasena para administrador, auditor y miembro de mesa.

## Votacion por QR general aleatorio

1. Ingresa como administrador o miembro de mesa.
2. En `Escaneo`, usa el bloque `Escaner virtual`.
3. Usa `Mostrar QR` para proyectarlo o `Abrir votacion aleatoria` para probarlo en la misma PC.
4. El QR abre `/votar`.
5. El sistema asigna al azar una mesa entre `M-014`, `M-018`, `M-021` y `M-037`.
6. El votante valida DNI y correo, marca la cedula virtual y envia el voto.
7. El sistema muestra una pantalla final de voto procesado, genera hash, respaldo digital, comprobante por correo y bloquea nuevos votos de esa cuenta en el proceso actual.

Los usuarios ciudadanos no acceden al dashboard operativo. Si entran al dominio principal, solo veran una pantalla que les indica escanear el QR de su mesa.

## Correo de verificacion del voto

- El comprobante confirma que el voto fue registrado, pero no revela por quien voto la persona.
- En local, el comprobante queda guardado en la bandeja interna `emailReceipts` dentro de `data/db.json`.
- En produccion, usa Resend para enviarlo al correo del votante. SMTP queda como respaldo opcional:

```powershell
$env:RESEND_API_KEY="tu_api_key_de_resend"
$env:RESEND_FROM="CERTUSPE <admin@certuspe.com>"
$env:RESEND_OTP_TEMPLATE_ID="fb981630-09a8-4d5f-8d13-cff3dff31c7b"
$env:RESEND_CONFIRMATION_TEMPLATE_ID="00e2e4d2-14f5-4bef-b624-5ded77c8df2a"
npm start
```

Si `RESEND_API_KEY` no esta configurada, el sistema intenta SMTP. Si tampoco hay SMTP, deja el comprobante en la bandeja local.

## Despliegue en Vercel

Variables requeridas en Vercel:

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
CERTUS_REQUIRE_SUPABASE_SYNC=true
CERTUS_REMOTE_DB=true
CERTUS_DATA_KEY=
CERTUS_SESSION_SECRET=
RESEND_API_KEY=
RESEND_FROM=CERTUSPE <admin@certuspe.com>
RESEND_OTP_TEMPLATE_ID=fb981630-09a8-4d5f-8d13-cff3dff31c7b
RESEND_CONFIRMATION_TEMPLATE_ID=00e2e4d2-14f5-4bef-b624-5ded77c8df2a
PUBLIC_APP_URL=https://certuspe.com
```

`CERTUS_DATA_KEY` y `CERTUS_SESSION_SECRET` deben ser secretos largos y estables. Si cambian, las sesiones se invalidan y los respaldos cifrados antiguos pueden no descifrarse.

## Como escanear en la version local

1. Ingresa como administrador o miembro de mesa.
2. Abre la vista `Escaneo`.
3. Selecciona mesa y codigo de cedula.
4. Usa `Valido`, `En blanco` o `Nulo` para simular la lectura de marcas.
5. Usa `Escanear cedula` para generar la captura digital o `Subir imagen` para cargar una imagen propia.
6. Presiona `Procesar y registrar voto`.

El sistema registra el voto en el backend, cifra el respaldo digital, genera hash de integridad, evita duplicados y actualiza resultados.

## Usuario administrador inicial

| Rol | Correo | Contrasena |
| --- | --- | --- |
| Administrador | admin@certus.pe | Admin2026! |

## Datos del proyecto

- Universidad Peruana de Ciencias Aplicadas
- SI720 Diseno y Patrones de Software
- Documento de Especificaciones Funcionales (DEF)
- Profesor: Jorge Luis Delgado Vite
- Integrantes:
  - Llanos Alvarez, Guillermo Enrique - U202422204
  - Garcia Bernal, Daniela - U202212994
  - Condor Velasquez, Angela - U202217165
  - Chavez Valeriano, Milene - U20241C489
  - Ayvar Valdez, Piero - U202312035
