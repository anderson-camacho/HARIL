# HARIL

> **Many minds. One flow.**

Una consola, múltiples inteligencias, un solo propósito.
HARIL es una plataforma **local** de orquestación de agentes de IA, desarrollo de software y automatización, con un solo comando: `haril`.
Un núcleo propio controla la ejecución; Pi, Engram, Herdr y los proveedores de modelos quedan detrás de puertos reemplazables.

> **Estado real (2026-10-17): MVP cerrado, versión 0.6.0.** Los 15 criterios de aceptación del MVP se cumplen o tienen un desvío explícito y justificado (ver `versions/`). La CI pública pasa en Windows y Linux. Ya está en marcha M4: la interfaz `haril shell` (0.5.0) es su primera pieza.
> **Carril real verificado (2026-10-16):** `npm run e2e:real` pasa en esta máquina con Pi 1.2.0 real y CLIProxyAPI (`cliproxy/gemini-3-flash`): una tarea `analyst` lee `README.md` con la herramienta del puente, responde el código pedido, HARIL lo verifica (`verified: true`) y el libro registra los tokens reales. Ollama no viene por defecto (demasiado pesado para el equipo de referencia). Bitácora: `odd/tasks/haril-phase4-real-lane.md`; matriz de criterios: `odd/tasks/haril-phase4-m3.md`.

> **Nota sobre la documentación.** La documentación de diseño (`docs/`) se publicará al final del proyecto. Hasta entonces, los enlaces a `docs/` y a `odd/` de este README no están disponibles en el repositorio público.

## Cómo probarlo

Requisitos: Node 24 (recomendado `^24.21.0`; con 24.19 funciona y `doctor` avisa) y `corepack` (incluido en Node 24). Los pasos son para PowerShell, desde la raíz del repositorio.

1. Instalar dependencias y compilar la CLI:

   ```powershell
   corepack pnpm install
   npm run build
   ```

2. Comprobar el entorno. `doctor` sale con 0 (correcto) o 1 (advertencias, por ejemplo Node 24.19):

   ```powershell
   .\bin\haril.ps1 doctor
   ```

3. Usar una carpeta de prueba y una raíz de datos propia para no tocar la predeterminada:

   ```powershell
   $env:HARIL_HOME = "$env:TEMP\haril-demo\data"
   New-Item -ItemType Directory -Force "$env:TEMP\haril-demo\proyecto" | Out-Null
   ```

4. Crear el proyecto. Sin `--yes` solo se muestra la vista previa y no se escribe nada:

   ```powershell
   .\bin\haril.ps1 project init "$env:TEMP\haril-demo\proyecto" --name Demo --slug demo
   .\bin\haril.ps1 project init "$env:TEMP\haril-demo\proyecto" --name Demo --slug demo --yes
   ```

5. Encolar trabajo. `task add` y `plan import` solo dejan comandos en la cola; `start` los aplica:

   ```powershell
   .\bin\haril.ps1 task add "Tarea de prueba" --project demo
   .\bin\haril.ps1 plan import examples\plan.valid.json --project demo
   ```

6. Ejecutar la cola. `run` aplica la cola, ejecuta las tareas listas y sale al no tener trabajo (0 si todo fue bien, 1 si una tarea falló):

   ```powershell
   .\bin\haril.ps1 run --project demo
   ```

Para trabajo en vivo, `start` se queda en primer plano y sale tras 120 s sin trabajo (`--idle-exit-sec <n>` cambia el plazo). `haril stop` lo detiene en orden: la tarea en curso vuelve a `ready` sin cobrar intento.

Un plan también puede pedir aprobación antes de encolarse: `haril plan propose <archivo>` crea una aprobación pendiente sin encolar nada, `haril approvals` la lista y `haril approve <id>` o `haril deny <id>` la deciden una sola vez. La decisión queda registrada con el usuario del sistema; en N0 es una declaración, no una autenticación. El runtime aplica la decisión en su siguiente turno: un plan aprobado se encola como el `plan import` de arriba.

7. Consultar el resultado:

   ```powershell
   .\bin\haril.ps1 status --project demo
   .\bin\haril.ps1 metrics --project demo
   .\bin\haril.ps1 events --project demo --limit 10
   ```

8. Limpiar la variable de sesión: `Remove-Item Env:HARIL_HOME`.

`task add` admite comprobaciones que el host ejecuta tras el agente; una comprobación fallida hace fallar el intento:

| Flag | Comprobación |
|---|---|
| `--accept-file <ruta>` | El archivo existe dentro de la raíz del proyecto |
| `--accept-contains <ruta>=<texto>` | El archivo contiene el texto |
| `--accept-output <texto>` | La respuesta final del agente contiene el texto |

### Instalar HARIL en tu usuario

El instalador copia la CLI compilada a `%LOCALAPPDATA%\HARIL\app\<versión>\` y crea los lanzadores en `%LOCALAPPDATA%\HARIL\bin\`. No edita el PATH ni el registro: se llama al lanzador por su ruta completa.

```powershell
npm run build
node apps/bootstrap/dist/haril-bootstrap.mjs install
& "$env:LOCALAPPDATA\HARIL\bin\haril.ps1" --version
```

`uninstall` borra solo lo que `install` creó y conserva `data\`, `runtime\` y `vendor\`. Si quieres usar `haril` sin ruta completa, añade `%LOCALAPPDATA%\HARIL\bin` a tu PATH de usuario a mano; HARIL no lo hará por ti.

### M2: agente real `analyst` (opt-in)

`analyst` ejecuta Pi 1.2.0, aislado en un Node propio, a través del Broker de HARIL y de un gateway compatible con OpenAI (CLIProxyAPI). Necesita un runtime instalado, una clave de cliente del gateway y un modelo de `haril models`. HARIL no guarda la clave: la lee solo de la variable de entorno de la sesión y nunca la escribe en el repositorio, en la base de datos, en los eventos ni en la salida.

```powershell
npm run runtime:install
$env:HARIL_CLIPROXYAPI_KEY = "<tu clave de cliente de CLIProxyAPI>"
$env:HARIL_DEFAULT_MODEL = "<id de haril models, por ejemplo cliproxy/gemini-3-flash>"
.\bin\haril.ps1 models
.\bin\haril.ps1 task add "Lee README.md y resúmelo en una frase" --project demo --agent analyst
.\bin\haril.ps1 run --project demo
.\bin\haril.ps1 task show <taskId>
.\bin\haril.ps1 metrics --project demo
npm run e2e:real
```

Si falta el runtime, `run` no reclama la tarea: la muestra como `skipped` con lo que falta y sale con 1; las tareas `fake:*` siguen su curso. Si falta la clave del proveedor del modelo, la tarea falla con `agent.not_ready` y nombra la variable. `task add --agent analyst` sin `--model` ni `HARIL_DEFAULT_MODEL` sale con 2. `npm run e2e:real` imprime `SKIP real lane` y sale con 0 cuando algo falta; si todo está listo, ejecuta una tarea real que lee `README.md` y responde un código secreto, y comprueba que la tarea queda completada y verificada, que el libro registra tokens y que hubo al menos una lectura por el puente.

Notas:

- **Agentes simulados.** `fake:succeed` (por defecto), `fake:fail` y `fake:slow:<ms>` se comportan como su nombre indica. Cualquier otro agente del plan (por ejemplo `developer-block`) se ejecuta como simulado con éxito y `start` lo indica. Solo `analyst` es real, y solo con la configuración de la sección anterior. Ningún agente real modifica el disco en M2.
- **Otras formas de invocar la CLI.** `bin\haril.cmd` (cmd) y `sh bin/haril` (POSIX) hacen lo mismo. No editan el `PATH`. Si falta `apps/haril/dist/haril.mjs`, avisan de que hay que ejecutar `npm run build`.
- **Códigos de salida.** 0 correcto, 1 advertencias o tarea fallida, 2 error de uso o de entorno.

Calidad del repositorio:

| Comando | Qué ejecuta |
|---|---|
| `corepack pnpm run check` | Biome, `tsc --noEmit` por workspace, `scripts/check-layers`, `check-purity`, `check-forbidden` y knip |
| `corepack pnpm test` | Vitest (contratos, core, CLI) y `node:test` (scripts de control con violaciones sembradas) |
| `npm run e2e` | Compila y recorre el flujo M1 completo con la CLI en directorios temporales, incluida una caída a mitad de run, y el flujo M2 hermético (Pi falso detrás del Broker y un servidor OpenAI falso) (`scripts/e2e.mjs`) |
| `npm run e2e:real` | Carril real opt-in de M2 (`scripts/e2e-real.mjs`): una tarea `analyst` contra el gateway real; sale con `SKIP real lane` si falta el runtime, la clave o el modelo |

El CI (`.github/workflows/ci.yml`) ejecuta lo mismo en `windows-latest` y `ubuntu-latest`.

### M3: proveedores en `config/haril.json`

HARIL lee sus proveedores de `HARIL_CONFIG` o, si no está definida, de `config\haril.json` dentro de la raíz del runtime (en Windows, `%LOCALAPPDATA%\HARIL`). Sin archivo usa un solo proveedor: `cliproxy` (clave de `HARIL_CLIPROXYAPI_KEY`; `HARIL_GATEWAY_URL` cambia su URL). Ollama no viene por defecto: la inferencia local es demasiado pesada para el equipo de referencia; quien la quiera puede añadirla en el archivo. El archivo nunca contiene claves: `keyEnv` nombra la variable de entorno que las guarda, y un campo `apiKey` se rechaza. `config/haril.example.json` muestra el formato e incluye `openrouter`, un catálogo anónimo que no está activo por defecto.

```json
{
  "providers": [
    { "id": "cliproxy", "baseUrl": "http://127.0.0.1:8317/v1", "keyEnv": "HARIL_CLIPROXYAPI_KEY" }
  ]
}
```

`haril models` consulta todos los proveedores a la vez y muestra cada modelo como `<proveedor>/<modelo>`; un proveedor cuya `keyEnv` no está definida aparece como `key not set` y no recibe ninguna petición. `task add --model cliproxy/<modelo>` fija el proveedor. Un id sin proveedor solo se resuelve si exactamente un proveedor lo sirve en ese momento; si no, la tarea falla con `model_ambiguous`.

> **Aviso sobre gateways y términos de servicio.** `cliproxy` es solo un nombre y una URL local (`127.0.0.1:8317`): HARIL no incluye, instala ni configura ningún gateway, y no publica cuentas, plantillas OAuth ni configuración de terceros. Sirve cualquier endpoint compatible con OpenAI que declares en `haril.json`. Algunos gateways, como CLIProxyAPI, convierten suscripciones de consumo en una API; ese uso puede ir contra los términos de servicio del proveedor del modelo y acabar en la suspensión de la cuenta. Cada usuario es responsable de cumplir los términos de sus proveedores. HARIL no rota cuentas ni cambia solo a planes de pago.

### M4: interfaz de terminal (`haril shell`)

`haril shell` abre una interfaz interactiva sobre los datos de HARIL. Necesita una terminal real (Windows Terminal o PowerShell); sin ella sale con 2. La interfaz solo lee: nunca arranca el runtime y no consulta la base en bucle. Los datos se cargan al abrir, con `r` y después de cada acción.

```powershell
cd D:\github\haril
npm run build
.\bin\haril.ps1 shell
```

| Tecla | Acción |
|---|---|
| `1`-`9`, `Tab`, `Shift+Tab` | Cambiar de panel (11: proyectos, tareas, agentes, tokens, eventos, modelos, configuración, temas, memoria, servicios y terminales) |
| `↑` `↓` `PageUp` `PageDown` `Home` `End` | Moverse por la lista |
| `Enter` | En Proyectos filtra por proyecto; en Tareas abre el detalle; en Temas aplica el tema |
| `Esc` | Cerrar el detalle, la ayuda o el formulario |
| `a` | Añadir una tarea (título, agente y modelo); se encola con `haril task add` y la ejecuta `haril start` |
| `t` | Ir a Temas |
| `r` | Recargar |
| `?` | Ayuda |
| `q`, `Ctrl+C` | Salir |

El tema elegido se guarda en `config\haril.json` como `ui.theme` y se mantiene al reabrir. Los temas propios van en `config\themes\<nombre>.json` dentro de la raíz del runtime, con el formato JSON de temas de Pi. Memoria, servicios y terminales todavía muestran «no disponible en esta versión».


## Qué es y qué no es

Fuente: `docs/PRODUCT_VISION.md` 1 y 4.

| Es | No es |
|---|---|
| Un único punto de control: un Runtime bajo demanda por raíz de datos, propietario del estado; ningún agente lanza agentes | Un fork ni un reemplazo de Pi: lo ejecuta como proceso externo `--mode rpc`, con versión fijada |
| Gasto acotado por código: presupuesto de pago 0 por defecto, Broker local con corte a mitad de flujo | Una copia de Gentle Shell, Gentle AI o DC-Pi: son referencias de diseño |
| Permisos reales: `PathGuard`, motor de políticas y aprobaciones atadas a hash, aplicados por el Runtime y no por un prompt | Un emulador de terminal: funciona en terminal estándar; Herdr es opcional |
| Recuperación: el estado vive en `haril.db` con fencing; los procesos son desechables | Una base de memoria nueva: Engram es el proveedor principal |
| Resultado verificable: comprobaciones que ejecuta el host, no la respuesta del agente | Un servicio de enrutado para terceros ni un agregador de suscripciones |
| Piezas sustituibles e instalación aislada que coexiste con lo ya instalado | Un agente LLM supervisor, un framework ni un sandbox: el MVP declara N0 |

## Arquitectura en diez líneas

Fuente: `docs/ARCHITECTURE.md` 3 a 5.

1. **Hexágono.** Un Core puro (`packages/core`) decide y no toca el mundo; los adaptadores abren archivos, procesos, sockets y la base.
2. **Un Runtime por raíz de datos**, bajo demanda: nace con `haril start` (en vivo) o `haril run` (la cola y salir), toma una lease con época en SQLite y muere por ocio o con `haril stop`. Sin servicios ni autoarranque.
3. **La CLI** (`apps/haril`) lee `haril.db` y encola comandos en `commands`; el Runtime los drena.
4. **Pi no es frontera de seguridad.** Corre como hijo `--mode rpc`, uno por intento, sin herramientas integradas.
5. **El puente** (`agent-pi-bridge`, extensión `-e`) reenvía cada operación de archivo y shell al Runtime, que la autoriza (PDP) y la ejecuta.
6. **El Broker** en loopback recibe las llamadas de Pi con una clave virtual de alcance de run y reenvía al proveedor con la clave real.
7. **Puertos con suite de contrato** (19 en ARCH 5.1): `Store`, `AgentRuntime`, `ModelProvider`, `BrokerControl`, `MemoryProvider`, `TerminalHost`, `ProcessSupervisor`, `SandboxBackend`, `SecretStore`, entre otros.
8. **Todo es bloque declarativo** (`BlockManifest v1`, diez categorías): agentes, herramientas, metodologías, verificadores.
9. **Las restricciones críticas son código**: fencing, `PathGuard`, reserva de presupuesto, cerrojos de superficie, regla de dos.
10. **Honestidad de evidencia**: el MVP declara N0 y trata los spikes pendientes como puertas de cada hito.

```mermaid
flowchart LR
  U["Usuario en terminal"] --> CLI["apps/haril: CLI"]
  CLI -->|"cola commands y aviso"| RT
  CLI -->|"lecturas y admin"| DB[("haril.db")]
  subgraph RT["Runtime: un proceso por raiz de datos"]
    CORE["Core puro"] --> PORTS["Puertos"]
    PORTS --> BROKER["Broker loopback"]
  end
  PORTS -->|"Store"| DB
  PORTS -->|"AgentRuntime, stdio JSONL"| PI["Pi --mode rpc + puente"]
  PI -->|"HTTP loopback, clave virtual"| BROKER
  BROKER -->|"HTTPS, clave real"| PROV["Proveedores y gateways"]
  PORTS -.->|"MemoryProvider, M4"| ENG["engram serve"]
```

## Índice de documentación

Todo bajo `docs/` salvo indicación. Los cinco últimos documentos de la primera tabla se redactan en paralelo con este README.

| Documento | Una línea |
|---|---|
| `ARCHITECTURE.md` | Arquitectura consolidada ("ARCH x.y"): componentes, procesos, puertos, monorepo, flujos, datos, seguridad, recuperación y estado de verificación. **Manda sobre los demás** |
| `DECISIONS.md` | Registro maestro: qué fija el prompt, 20 ADR, decisiones del usuario U-01 a U-18 y UA-01 a UA-08, spikes e inconsistencias |
| `REQUIREMENTS.md` | RF-001 a RF-252, RNF-001 a RNF-052, CU-01 a CU-18 y su cobertura del prompt (sección 7) |
| `PRODUCT_VISION.md` | Visión, usuarios, problema, qué no es HARIL, alcance por fases y criterios de éxito |
| `COMPONENTS.md` | Fichas de los 19 componentes con las 13 preguntas de PROMPT sec19 y cobertura de requisitos (sección 8) |
| `ORCHESTRATION.md` | DAG, `Task v1`, siete estados, `claim`, superficies, resultado verificable, reintentos, recuperación y Taxis |
| `AGENTS.md` | Agent Blocks, cuatro arquetipos, `AgentSpec`, ciclo de un run, permisos y delegación por DAG |
| `BLOCK_SYSTEM.md` | `BlockManifest v1`, diez categorías, registro, cuarentena, metodologías y sustitución |
| `MODEL_ROUTING.md` | Router, Broker, proveedores, niveles A/B/C, presupuestos, `costSource` y política de gasto |
| `MEMORY.md` | Las seis memorias, `MemoryProvider`, `ScopeRef`, outbox e integración con Engram |
| `DATA_MODEL.md` | Esquema lógico de `haril.db`: tablas, fencing, invariantes INV-nn, migraciones |
| `PROJECTS.md` | `haril project init`, `ProjectManifest v1`, `.haril/`, abrir, configurar y cerrar |
| `INTERFACE.md` | Terminal estándar, `TerminalHost`, TUI (`apps/shell`, M4) y adaptador de Herdr |
| `INSTALLATION.md` | Bootstrap, journal, manifiesto, Node fijado, instalación de Pi, coexistencia, `doctor`, `update` y `rollback` |
| `COMPATIBILITY.md` | Matriz por herramienta (versión, licencia, conflictos, estrategia, riesgo) y entorno local verificado |
| `SECURITY.md` | Amenazas, niveles N0/N1/N2, `PathGuard`, secretos y claves virtuales, aprobaciones, auditoría, inyección |
| `TEST_STRATEGY.md` | Carriles, fakes, suites de contrato, INV-nn, las 12 pruebas y los 15 criterios, cobertura (sección 11) |
| `ROADMAP.md` | Fases e hitos M0 a M4 con puertas y autorizaciones |
| `MVP.md` | Alcance mínimo, arquitectura de ejecución de los 11 pasos y pruebas E2E |
| `BACKLOG.md` | Historias BL-nnn por hito con orden de arranque |
| `RISKS.md` | Matriz de riesgos RK-nnn |
| `GLOSSARY.md` | Terminología de HARIL con "dónde se define" por término |

| Carpeta o archivo | Qué contiene |
|---|---|
| `adrs/` | ADR-0001 a ADR-0020, cada uno con estado (`confirmada-por-prompt`, `propuesta`, `requiere-autorizacion`) |
| `contracts/` | Índice y plantilla (`README.md`) y once contratos `v1 borrador` por puerto (`agent-runtime`, `task-store`, `orchestrator`, `executor`, `memory`, etc.) |
| `research/` | Fase 0: síntesis `00` y dossiers `01` a `15` (Pi, Gentle Shell, Gentle AI, Herdr, Engram, DC-Pi, gateways, proveedores, entorno, SQLite, monorepo, seguridad en Windows) |
| `source/MASTER_PROMPT.md` | Fuente primaria de requisitos ("PROMPT secN"); no se edita, sus cambios se registran en `DECISIONS.md` |
| `../odd/tasks/haril-foundations.md` | Documento ODD del propio proyecto: objetivo, alcance autorizado y tareas |

## Cómo continuar este proyecto

Para quien retome el trabajo sin acceso a ninguna conversación previa.

**Orden de lectura**

1. Este README.
2. `docs/DECISIONS.md`: "Resumen" y sección 4 (qué debe decidir el usuario).
3. `docs/ARCHITECTURE.md`: secciones 1 a 4 y 14 (qué está probado: nada).
4. `docs/ROADMAP.md`.
5. `docs/BACKLOG.md`, "Orden de arranque".

Los dossiers de `docs/research/` se leen solo bajo demanda, cuando un documento de diseño los cite.

**Convenciones**

| Convención | Regla |
|---|---|
| Etiquetas de evidencia | `[V]` verificado en fuente primaria (leído, no ejecutado), `[R]` reportado, `[I]` inferido, `[S]` decisión de diseño, NO VERIFICADO sin evidencia |
| Identificadores | Tal cual en las fuentes: RF/RNF/CU, ADR-NNNN, U-nn/UA-nn, AR-Gnn, INV-nn, H1 a H15, M0 a M4, "PROMPT secN", "ARCH x.y", "NN secX" |
| Idioma | Español neutro profesional; identificadores, código y URLs en su forma original |
| "Nada probado" | Ninguna cifra ni comportamiento es definitivo hasta releerlo en la fuente exacta y pasar su puerta |
| Jerarquía | `ARCHITECTURE.md` y los ADR mandan; quien difiera registra la diferencia, no corrige ARCH |
| Decisiones del usuario | Siempre con su postura segura por defecto; ninguna está cerrada |

**Qué debe decidir el usuario antes de implementar.** Las 26 decisiones de `docs/DECISIONS.md` 4 (U-01 a U-18, UA-01 a UA-08) y su efecto por hito en 4.3. M0 no empieza sin U-07 (a) (`git init`, gestor de paquetes) y UA-04 (instalar herramientas); M2 espera U-08 (spikes con Pi 1.2.0 aislado).

**Siguiente tarea concreta.** La primera historia del "Orden de arranque" de `docs/BACKLOG.md`.

## Trazabilidad

| Eslabón | Dónde vive |
|---|---|
| Prompt → requisitos | `docs/REQUIREMENTS.md` 7 (tabla de cobertura del prompt) |
| Requisitos → arquitectura | `docs/ARCHITECTURE.md` 15 (trazabilidad a PROMPT) |
| Requisitos → componentes | `docs/COMPONENTS.md` 8 (cobertura de requisitos) |
| Requisitos → tareas | `docs/BACKLOG.md` (historias BL-nnn vinculadas a RF y a hitos) |
| Requisitos → pruebas | `docs/TEST_STRATEGY.md` 11 (cobertura de requisitos) |

## Versiones

Versión actual: **0.4.1**. El estado del proyecto y el historial de cambios están en [`versions/README.md`](versions/README.md).

## Licencia

HARIL se publica bajo la **Apache License 2.0**: ver [`LICENSE`](LICENSE) y [`NOTICE`](NOTICE). El código de terceros que va dentro de los bundles y la obra derivada de Gentle AI (el bloque de metodología ODD) conservan sus licencias MIT, reproducidas en [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Inspiraciones y créditos

Herramientas estudiadas en la Fase 0 (solo lectura), con la licencia que registra `docs/COMPATIBILITY.md` 7.1. No se copió código de ninguna.

| Herramienta | Licencia | Uso en HARIL |
|---|---|---|
| Pi (`@earendil-works/pi-coding-agent`) | MIT | Proceso externo `--mode rpc` |
| Gentle Shell | MIT | Referencia de la TUI |
| Gentle AI | MIT (14 de 15 skills declaran Apache-2.0) | Referencia; ODD redactado por HARIL |
| Herdr | Apache-2.0 (AGPL-3.0-or-later hasta 0.7.x) | Proceso externo opcional (M4) |
| Engram | MIT | Proceso externo (M4) |
| DC-Pi | MIT | Referencia |
| MXC | MIT | Adaptador de sandbox (M4) |
| Node.js, SQLite, Git | MIT, dominio público, GPL-2.0 (CLI externo) | Runtime, base embebida, CLI |

### Qué toma HARIL de cada una

Cada referencia aporta una idea de diseño, nunca código. HARIL no está afiliado ni respaldado por ninguna de ellas.

- **Gentle AI™** (Gentleman Programming). HARIL toma de su protocolo ODD (Organic Driven Development) la idea de un flujo de trabajo por fases. El bloque de metodología `odd` de HARIL es una obra derivada, redactada a partir de la versión 4.1.1 de ese protocolo, y lleva su atribución.
- **Gentle Shell**. Su `LICENSE` (MIT) nombra a Mario Zechner; la titularidad real está pendiente de verificar. HARIL toma de esta referencia la maquetación de la TUI: paneles, rail de estado, cambios y tareas. Los temas de HARIL usan el formato JSON de Pi, no el de Gentle Shell.
- **Pi** (Mario Zechner, earendil-works). HARIL ejecuta Pi como proceso externo en modo RPC, sin fork, y adopta su formato de temas JSON para la interfaz.
- **Herdr**. HARIL toma la idea de agrupar terminales y sesiones de trabajo en paneles. La integración es opcional y se hará por su CLI en M4.
- **Engram™**. HARIL toma la idea de una memoria persistente separada del estado transaccional. La integración está prevista para M4.
- **DC-Pi**. HARIL toma tres ideas de diseño: el lease con latido y TTL, la limpieza de procesos abandonados y el registro de viajes. También la composición de agentes con bloques de datos validados. No toma su pool de cuentas de suscripción ni la lectura de credenciales.
- **CLIProxyAPI**. Es el gateway de modelos compatible con OpenAI al que se conecta HARIL en el carril real. HARIL no lo instala, no lo configura y no lee sus cuentas: solo usa la clave de cliente que aporta el usuario por variable de entorno.
