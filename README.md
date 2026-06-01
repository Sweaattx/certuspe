# CERTUS / STELA

Sistema de conteo preliminar para procesos electorales.

## Descripcion

CERTUS simula el flujo de captura, procesamiento y registro preliminar de cedulas electorales. La propuesta original considera un terminal de escaneo fisico; para la demostracion web se usa un QR publico que permite registrar al votante y emitir una cedula virtual.

## Funciones principales

- Registro de votantes por DNI, correo y codigo de verificacion.
- QR publico para iniciar el flujo de votacion desde celular.
- Simulacion de cedula electoral y clasificacion de voto valido, nulo o en blanco.
- Registro de votos por mesa con control de duplicidad.
- Hash de integridad, trazabilidad y respaldo digital.
- Resultados preliminares generales y detalle para auditoria.
- Panel operativo con roles de administrador, auditor y miembro de mesa.

## Tecnologias

- React
- TypeScript
- Vite
- Node.js
- Express
- Supabase
- Resend

## Ejecucion local

```powershell
npm install
npm run build
npm test
npm start
```

La aplicacion inicia por defecto en `http://localhost:3000`.

## Integrantes

- Llanos Alvarez, Guillermo - U202422204
- Garcia Bernal, Daniela - U202212994
- Condor Velasquez, Angela - U202217165
- Chavez Valeriano, Milene - U20241C489
- Ayvar Valdez, Piero - U202312035
