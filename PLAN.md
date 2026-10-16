# Proyecto_C — Plan de desarrollo

> **Nombre provisional.** No lo escribas a mano en el código: usa el slug `proyecto-c` y la constante `APP_NAME` (ver `AGENTS.md`).
> Este documento es la fuente de verdad del proyecto. `AGENTS.md` contiene las reglas de trabajo para el agente.

## 1. Visión

Proyecto_C es un **planificador de carga de trabajo**. La persona introduce tareas con fecha límite, importancia y esfuerzo estimado, y la aplicación responde a una pregunta:

> **¿Qué debería hacer hoy para llegar a mis entregas sin sobrecargarme?**

Lo que lo diferencia de un gestor de tareas o un calendario es el **motor**: calcula la presión real de cada tarea (horas que faltan frente a horas disponibles), explica por qué ordena así y detecta cuándo una semana es inviable. Asignaturas, tareas y calendario son solo los datos que lo alimentan.

El producto no es específico de una universidad: sirve para cualquiera con entregas.

## 2. Decisiones tomadas

| ID | Decisión | Motivo |
|---|---|---|
| D1 | Producto = planificador de carga, no organizador académico | Se diferencia del Student Academic Manager y cuenta una historia más técnica |
| D2 | Backend **Node.js + Express + TypeScript** | Un solo lenguaje en todo el stack permite compartir `core` entre API y web. ASP.NET Core aprovecharía C#, pero obligaría a duplicar el motor o a aislarlo detrás de otra API, sin aportar valor aquí. C# se cubre en otros proyectos del portfolio |
| D3 | **PostgreSQL + Prisma** | Relaciones claras (workspace → asignaturas → tareas → sesiones) y migraciones tipadas. Cambia respecto a MongoDB del proyecto anterior |
| D4 | Monorepo con **pnpm workspaces** | `core` y `shared` se reutilizan sin publicar paquetes |
| D5 | Motor en `packages/core`, **puro y sin I/O** | Se testea con datos en memoria, sin mocks, y se explica de forma aislada |
| D6 | Tiempo en **minutos enteros**; fechas en UTC; zona horaria por workspace (`Europe/Madrid` por defecto) | Evita errores de coma flotante y bugs de zona horaria / cambio de hora |
| D7 | Prioridad basada en **presión** = minutos restantes / minutos disponibles hasta la fecha límite | Tiene sentido físico y es explicable. Los pesos arbitrarios no |
| D8 | Demo pública con **workspaces anónimos** (cookie, sin cuentas) | Cualquiera puede probarlo en segundos con datos de ejemplo, sin implementar autenticación |
| D9 | **Una sola unidad desplegable**: Express sirve la build de `web` | Mismo origen: cookies sencillas, sin CORS, un único servicio |
| D10 | UI en español; código, comentarios, commits y docs técnicos en inglés | Portfolio legible internacionalmente; la UI es para el público objetivo |
| D11 | React Router + TanStack Query en el frontend | Estándar para rutas y estado de servidor; evita reinventar caché y estados de carga |
| D12 | El plan semanal es **derivado**, no se guarda | Se recalcula bajo demanda; evita datos obsoletos |

## 3. Alcance

### Incluido en v1
- Asignaturas, tareas (incluye exámenes como tipo con fecha fija), disponibilidad semanal.
- Vista **Hoy**: ranking explicable de tareas.
- Registro de tiempo (temporizador y manual) y comparación estimado vs. real.
- Planificación semanal con detección de sobrecarga.
- Dashboard, calendario y estadísticas básicas.
- Estimaciones sugeridas a partir del historial.
- Demo pública con workspace anónimo y datos de ejemplo.

### Fuera de v1
Cuentas y autenticación, app móvil nativa, colaboración en tiempo real, notificaciones, IA generativa, importación `.ics`/CSV, subtareas, framework de i18n, integraciones con plataformas universitarias.

## 4. Arquitectura

```text
proyecto-c/
├── apps/
│   ├── web/            # React + TypeScript + Vite + Tailwind + Recharts
│   └── api/            # Express + TypeScript + Prisma
│       └── src/{routes,controllers,services,repositories,middleware,jobs}
├── packages/
│   ├── core/           # tipos de dominio, motor de prioridades, planner (puro)
│   └── shared/         # esquemas Zod y DTOs compartidos
├── docs/
│   ├── adr/            # decisiones de arquitectura
│   ├── data-model.md
│   └── priority-engine.md
├── .github/workflows/ci.yml
├── docker-compose.yml
├── AGENTS.md
├── PLAN.md
└── README.md
```

**Reglas de dependencia**
- `core` no importa nada del repo ni hace I/O.
- `shared` puede importar tipos de `core`.
- `api` usa `core` y `shared`.
- `web` usa `shared` y tipos de `core`. **Nunca recalcula** rankings ni planes: la API es la fuente de verdad.

**Flujo de una petición:** cookie de sesión → middleware de workspace (`req.workspaceId`) → ruta (validación Zod) → controller → service (reglas, llama a `core`) → repository (Prisma, siempre filtrado por `workspaceId`).

## 5. Modelo de datos

```prisma
model Workspace {
  id          String   @id @default(uuid())
  tokenHash   String   @unique       // hash del secreto guardado en la cookie
  timezone    String   @default("Europe/Madrid")
  createdAt   DateTime @default(now())
  lastSeenAt  DateTime @default(now())
}

model Course {
  id          String   @id @default(uuid())
  workspaceId String
  name        String
  code        String?
  color       String
  archivedAt  DateTime?
}

model Task {
  id               String   @id @default(uuid())
  workspaceId      String
  courseId         String?
  title            String
  description      String?
  type             TaskType        // ASSIGNMENT | PROJECT | EXAM | STUDY | OTHER
  dueAt            DateTime
  importance       Importance      // LOW | MEDIUM | HIGH
  estimatedMinutes Int
  remainingMinutes Int
  status           TaskStatus      // TODO | IN_PROGRESS | DONE
  completedAt      DateTime?
  createdAt        DateTime @default(now())
  @@index([workspaceId, dueAt])
  @@index([workspaceId, status])
}

model StudySession {
  id              String   @id @default(uuid())
  workspaceId     String
  taskId          String
  startedAt       DateTime
  endedAt         DateTime?        // null = sesión activa
  durationMinutes Int?
  source          SessionSource    // TIMER | MANUAL
}

model Availability {
  id          String @id @default(uuid())
  workspaceId String
  weekday     Int                  // 1 = lunes ... 7 = domingo (ISO)
  minutes     Int
  @@unique([workspaceId, weekday])
}
```

Notas de diseño:
- `remainingMinutes` es un dato propio, no se deriva solo de las sesiones: la persona sabe mejor que nadie cuánto le queda.
- Disponibilidad por defecto de un workspace nuevo: lunes a viernes 180 min, sábado y domingo 120 min (ajustable).
- Todo modelo con datos de usuario lleva `workspaceId`. Borrar un workspace borra todo en cascada.

## 6. Motor de prioridades (especificación)

Vive en `packages/core`. Todas las funciones son puras y reciben `now` como parámetro.

### Entrada
```ts
type Importance = 'LOW' | 'MEDIUM' | 'HIGH';
type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7; // ISO, 1 = Monday

interface RankableTask {
  id: string;
  dueAt: Date;
  importance: Importance;
  remainingMinutes: number;
  status: 'TODO' | 'IN_PROGRESS' | 'DONE';
}

interface Availability {
  minutesByWeekday: Record<Weekday, number>;
  timezone: string;
}
```

### Algoritmo
1. Se excluyen las tareas `DONE`.
2. **Minutos disponibles** hasta la fecha límite: suma de la capacidad de cada día natural, en la zona del workspace, desde **hoy (incluido) hasta el día de `dueAt` (excluido)**. Hoy cuenta entero (limitación v1, documentar en ADR). Una tarea con entrega "dentro de 2 días" cuenta hoy y mañana.
3. **Presión** = `remainingMinutes / availableMinutes`.
   - `remainingMinutes = 0` → presión 0.
   - `availableMinutes = 0` y quedan minutos → presión = `maxPressure` (por defecto 10) y `infeasible = true`.
   - La presión se limita a `maxPressure` para que el resultado sea serializable.
4. **Nivel (tier)**, en este orden de prioridad:
   - `OVERDUE`: `dueAt < now`.
   - `CRITICAL`: presión ≥ 1.
   - `AT_RISK`: presión ≥ 0.5.
   - `ON_TRACK`: el resto.
5. **Peso de importancia**: `LOW = 1`, `MEDIUM = 1.5`, `HIGH = 2`.
6. **Puntuación** = `presión × peso`.
7. **Orden**: nivel, luego puntuación descendente, luego `dueAt` ascendente, luego `id` ascendente (desempate determinista).

Umbrales, pesos y `maxPressure` se agrupan en un `EngineConfig` con valores por defecto.

### Salida
```ts
interface RankedTask {
  taskId: string;
  rank: number;                 // 1-based
  tier: 'OVERDUE' | 'CRITICAL' | 'AT_RISK' | 'ON_TRACK';
  pressure: number;
  infeasible: boolean;
  importanceWeight: number;
  score: number;
  remainingMinutes: number;
  availableMinutes: number;
  daysUntilDue: number;
  reasons: ReasonCode[];        // códigos, no texto: la UI los traduce
}
```
`ReasonCode` (lista inicial, el agente puede refinarla): `OVERDUE`, `NO_TIME_LEFT`, `TIGHT_SCHEDULE`, `HIGH_IMPORTANCE`, `COMFORTABLE`.

### Escenarios de referencia (tests "golden")
Fixture: disponibilidad de **180 min todos los días**, `now` = lunes 09:00 (`Europe/Madrid`).

| # | Escenario | Datos | Resultado esperado |
|---|---|---|---|
| S1 | Ejemplo base | A: práctica, entrega miércoles, 240 min, HIGH · B: informe, entrega sábado, 180 min, MEDIUM · C: examen, 10 días, 360 min, HIGH | A: presión 0,67 (240/360), puntuación 1,33, `AT_RISK`. C: 0,20, puntuación 0,40. B: 0,20, puntuación 0,30. **Orden: A, C, B** |
| S2 | Tarea larga con fecha lejana | L: 1200 min, entrega en 10 días, MEDIUM · Q: 60 min, entrega mañana, HIGH | L: presión 0,67, `AT_RISK`. Q: presión 0,33, `ON_TRACK`. **Orden: L, Q** (la fecha lejana no la hunde) |
| S3 | Atrasadas | O1: vencida, 60 min, LOW · O2: vencida, 300 min, HIGH · más una `AT_RISK` | Atrasadas primero. Entre ellas por puntuación: **O2, O1**, después la `AT_RISK` |
| S4 | Entrega hoy | T: 30 min, entrega hoy 18:00 | Disponibles 0 → `CRITICAL`, `infeasible`. Va por delante de cualquier `AT_RISK` |
| S5 | Completada | Tarea `DONE` | No aparece en el ranking |
| S6 | Empates | Dos tareas idénticas salvo el `id` | Orden estable por `id`; cambiar el orden de entrada no cambia el resultado |
| S7 | Sin disponibilidad | Capacidad 0 todos los días, tarea con minutos pendientes | `CRITICAL`, `infeasible` |
| S8 | Cambio de hora | Horizonte que cruza el cambio horario de `Europe/Madrid` | Los días naturales se cuentan bien (ni 23 ni 25 horas "mágicas") |

Propiedades a comprobar: el resultado no depende del orden de entrada; más minutos restantes nunca baja la presión; una fecha límite más tardía nunca la sube; el ranking es idempotente.

## 7. Planificador semanal (especificación)

Misma ubicación y mismas reglas de pureza que el motor. Se implementa en la fase 5.

- **Entrada:** tareas pendientes, disponibilidad por día, horizonte (por defecto 7 días), `now`.
- **Comprobación de viabilidad (carga acumulada):** ordenar por fecha límite y, para cada fecha límite `d`, comprobar que `demanda acumulada ≤ capacidad acumulada` hasta `d`. Es la condición exacta de viabilidad cuando todas las tareas se pueden empezar ya y partirse en bloques. Si falla, se informa del **déficit** en minutos y de la fecha afectada.
- **Reparto:** algoritmo voraz por **fecha límite más próxima (EDF)**, con la puntuación del motor como desempate. Se rellenan los días por orden hasta agotar la capacidad. Bloque mínimo configurable (por defecto 30 min).
- **Salida:** bloques por día `{ day, taskId, minutes }`, lista de tareas no encajadas y déficit por fecha límite.
- **Escenario S9 (sobrecarga):** A: 300 min, entrega en 2 días · B: 300 min, entrega en 3 días · 180 min/día. Individualmente A tiene presión 0,83 y B 0,56, pero la demanda acumulada hasta la fecha de B es 600 min frente a 540 de capacidad → **déficit de 60 min**. El planificador debe detectarlo.
- **Escenario S10 (semana normal):** el plan respeta la capacidad diaria, no asigna más minutos de los restantes y es determinista.
- v1 no descarta tareas automáticamente: avisa y deja decidir a la persona.

## 8. API (`/api/v1`)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/workspace/session` | Crea o reanuda el workspace anónimo (cookie) |
| GET/POST | `/courses` | Listar / crear asignaturas |
| PATCH/DELETE | `/courses/:id` | Editar, archivar o borrar |
| GET/POST | `/tasks` | Listar (filtros, orden) / crear |
| GET/PATCH/DELETE | `/tasks/:id` | Detalle, edición, borrado |
| GET | `/today` | Ranking con desglose (usa `core`) |
| GET/PUT | `/availability` | Disponibilidad semanal |
| POST | `/sessions/start`, `/sessions/stop`, `/sessions/manual` | Registro de tiempo |
| GET | `/sessions` | Historial |
| GET | `/plan/week` | Plan semanal y déficits |
| GET | `/stats/summary` | Estadísticas |
| POST | `/demo/reset` | Restaura los datos de ejemplo del workspace |

Formato de error: `{ "error": { "code", "message", "details?" } }`.

## 9. Workspaces anónimos

- Primera visita: el servidor genera un **secreto aleatorio** (≥128 bits), guarda su hash en `Workspace.tokenHash` y lo envía en una cookie `HttpOnly`, `SameSite=Lax`, `Secure` en producción.
- El `workspaceId` se obtiene **siempre** de la cookie en el servidor. Nunca viene del cliente.
- Un workspace nuevo se siembra con datos de ejemplo con **fechas relativas a hoy**, para que la demo siempre parezca viva.
- **Límites:** tamaño máximo de cuerpo (p. ej. 100 KB), cuotas por workspace (p. ej. 30 asignaturas, 300 tareas), rate limiting por IP.
- **Limpieza:** tarea programada que borra workspaces sin actividad en N días (por defecto 30, configurable).
- **Aviso en la UI:** los datos de la demo son temporales y están ligados a este navegador.
- Se pierde la cookie → se pierde el acceso al workspace. Es una limitación aceptada en la v1.

## 10. Fases y tareas

Tamaño relativo: S, M, L. Cada fase termina con algo ejecutable. **Las fases 0 a 3 forman un proyecto presentable por sí solas**: si el tiempo falla, ahí hay un corte limpio. Lo demás es ampliación.

### Fase 0 — Fundaciones (S)
- [x] **P0-T1** Monorepo con pnpm workspaces, `tsconfig.base.json`, versión de Node fijada (`.nvmrc` y `engines`), `.gitignore`, `.editorconfig`, README mínimo.
- [x] **P0-T2** ESLint (typescript-eslint) + Prettier + Vitest. Scripts `dev`, `build`, `lint`, `typecheck`, `test`, `check`.
- [x] **P0-T3** `docker-compose.yml` con Postgres (base de desarrollo y de test) y `.env.example`. Scripts `db:up`, `db:migrate`, `db:seed`.
- [x] **P0-T4** Esqueleto de `apps/api`: `createApp()`, `GET /api/v1/health` que comprueba la base de datos, Prisma inicializado, test de humo con Supertest.
- [x] **P0-T5** Esqueleto de `apps/web`: Vite + React + TypeScript + Tailwind; una pantalla que llama a `/health` mediante proxy de desarrollo.
- [x] **P0-T6** `packages/core` y `packages/shared` con un test trivial cada uno; imports entre paquetes funcionando.
- [x] **P0-T7** GitHub Actions: lint, typecheck, test (con servicio Postgres) y build.
- [x] **P0-T8** `docs/adr/` con plantilla y ADR-0001 (backend TypeScript/Express) y ADR-0002 (`core` puro).

**Criterio:** CI en verde; `pnpm dev` levanta web y api; `/health` informa del estado de la base de datos.

### Fase 1 — Motor de prioridades (M)
- [ ] **P1-T1** Tipos de dominio y `EngineConfig` con valores por defecto en `core`.
- [ ] **P1-T2** `availableMinutes` con lógica de días naturales y zona horaria (elegir librería de fechas en un ADR). Tests con cambio de hora de `Europe/Madrid`.
- [ ] **P1-T3** Cálculo de presión y niveles, incluyendo `infeasible` y `maxPressure`.
- [ ] **P1-T4** `rankTasks` con desglose, razones y orden determinista.
- [ ] **P1-T5** Suite de tests tabulares con los escenarios S1–S8.
- [ ] **P1-T6** Tests de propiedades (independencia del orden de entrada, monotonía, idempotencia).
- [ ] **P1-T7** `docs/priority-engine.md` con la fórmula, ejemplos y limitaciones; ADR-0003 (presión como métrica) y ADR-0004 (días contados con fecha límite exclusiva).

**Criterio:** todos los escenarios pasan, el orden resultante tiene sentido al revisarlo a mano y el documento del motor explica cada decisión.

### Fase 2 — Primer corte vertical (M)
> El aislamiento por workspace se implementa **desde el primer endpoint**, no se añade después.

- [ ] **P2-T1** Esquema Prisma y migración (Workspace, Course, Task, Availability); `docs/data-model.md`.
- [ ] **P2-T2** Middleware de sesión de workspace (cookie, hash, `req.workspaceId`) y capa de repositorios con `workspaceId` obligatorio. Tests de aislamiento entre workspaces.
- [ ] **P2-T3** API de asignaturas (CRUD y archivado) con validación Zod y formato de error común.
- [ ] **P2-T4** API de tareas: CRUD, filtros, orden y reglas de transición de estado (completar pone `remainingMinutes = 0` y `completedAt`).
- [ ] **P2-T5** API de disponibilidad con valores por defecto.
- [ ] **P2-T6** `GET /today` usando el motor de `core`; tests de integración del ranking a través de la API.
- [ ] **P2-T7** Web: estructura de la app, rutas, TanStack Query y cliente API tipado con los esquemas de `shared`.
- [ ] **P2-T8** Web: pantallas de asignaturas y tareas (listado, formulario con validación, completar).
- [ ] **P2-T9** Web: vista **Hoy** con el ranking y un desplegable "¿por qué?" que muestra el desglose.

**Criterio:** creo asignaturas y tareas reales y la vista Hoy las ordena de forma coherente y explicada. Un test demuestra que un workspace no puede ver datos de otro.

### Fase 3 — Demo desplegada (S)
- [ ] **P3-T1** Datos de ejemplo con fechas relativas y acción de restaurar demo.
- [ ] **P3-T2** Límites: tamaño de cuerpo, cuotas por workspace y rate limiting.
- [ ] **P3-T3** Tarea programada de limpieza de workspaces inactivos, con test.
- [ ] **P3-T4** Build de producción: Express sirve `web`; Dockerfile multietapa; migraciones al desplegar.
- [ ] **P3-T5** Despliegue en un proveedor con Postgres gestionado (decisión en ADR), HTTPS y cookies `Secure`.
- [ ] **P3-T6** README: qué es y por qué existe, enlace a la demo, capturas o GIF, cómo ejecutarlo en local, diagrama de arquitectura (Mermaid) y enlaces a `docs/`.

**Criterio:** enlace público funcionando que un tercero puede probar sin registrarse, con datos de ejemplo y README claro.

### Fase 4 — Registro de tiempo (M)
- [ ] **P4-T1** Modelo `StudySession`, migración y API (`start`, `stop`, `manual`, `list`). Solo una sesión activa por workspace.
- [ ] **P4-T2** Política para sesiones huérfanas (cerrar con un tope máximo de duración o al iniciar una nueva) y para pausas: pausar cierra el tramo, reanudar abre uno nuevo.
- [ ] **P4-T3** Al finalizar una sesión se propone nuevo `remainingMinutes` (por defecto `max(0, restante − duración)`) y la persona lo confirma o corrige.
- [ ] **P4-T4** Web: temporizador cuya sesión activa **vive en la base de datos**, no solo en el cliente; sobrevive a recargas.
- [ ] **P4-T5** Estimado vs. real por tarea y por asignatura.
- [ ] **P4-T6** Tests: sesiones interrumpidas, inicios concurrentes y aislamiento de workspace.

**Criterio:** el tiempo registrado persiste tras cerrar el navegador y actualiza lo que queda por hacer.

### Fase 5 — Planificación semanal (L)
- [ ] **P5-T1** Documento de especificación del planner y tipos en `core`.
- [ ] **P5-T2** Comprobación de viabilidad por carga acumulada y cálculo del déficit. Tests S9.
- [ ] **P5-T3** Reparto voraz EDF con bloque mínimo. Tests S10 y casos límite.
- [ ] **P5-T4** `GET /plan/week` y excepciones de disponibilidad por fecha (opcional).
- [ ] **P5-T5** Web: vista del plan semanal y aviso de sobrecarga indicando qué fecha límite está en riesgo y cuántos minutos faltan.
- [ ] **P5-T6** Recalculo bajo demanda al cambiar tareas o registrar tiempo (el plan no se persiste, D12).

**Criterio:** el sistema genera un plan coherente en una semana normal y marca claramente la sobrecarga en una semana saturada.

> Si esta fase se complica, se reduce a "recomendación diaria" usando solo P5-T2 y `GET /today` sin perder el valor del proyecto.

### Fase 6 — Visualización (M)
- [ ] **P6-T1** Dashboard: pendientes, atrasadas, próximas entregas, progreso.
- [ ] **P6-T2** Calendario semanal y mensual con tareas y bloques planificados (justificar en ADR si se usa librería o cuadrícula propia).
- [ ] **P6-T3** Gráficas con Recharts: horas por asignatura, estimado vs. real, tareas completadas.
- [ ] **P6-T4** Pasada de accesibilidad y diseño responsive; estados vacíos y de error.

**Criterio:** de un vistazo se ve qué hacer hoy y cómo va el periodo.

### Fase 7 — Estimaciones adaptativas y cierre (M)
- [ ] **P7-T1** En `core`: factor de corrección = mediana de (real / estimado) de las últimas N tareas completadas de la misma asignatura o tipo; mínimo 3 muestras y límites razonables (p. ej. 0,5 a 3). Tests.
- [ ] **P7-T2** API y UI: **estimación sugerida** al crear una tarea. Es una sugerencia, nunca se aplica sola.
- [ ] **P7-T3** Logging estructurado, error boundary en el frontend y revisión de manejo de errores.
- [ ] **P7-T4** Test E2E de humo (Playwright) del flujo principal sobre la demo.
- [ ] **P7-T5** Revisión final: README, ADRs, diagramas, GIF de la demo.
- [ ] **Backlog (opcional):** importación CSV/`.ics`, autenticación real, exportación de datos.

**Criterio:** la app propone estimaciones basadas en datos reales y la documentación permite entender cada decisión sin preguntar.

## 11. Definición de terminado

Una tarea se da por cerrada cuando: se cumplen sus criterios de aceptación, `pnpm check` pasa, el comportamiento nuevo tiene tests (incluidos casos límite), la documentación afectada está actualizada y la casilla correspondiente de este archivo está marcada.

## 12. Cómo trabajar con OpenCode

1. Coloca `AGENTS.md` y `PLAN.md` en la raíz del repositorio antes de empezar. OpenCode lee `AGENTS.md` como contexto del proyecto (si cambia en futuras versiones, consulta su documentación).
2. **Una tarea por sesión.** Pide siempre el ID exacto (`P1-T3`). Las tareas están dimensionadas para cerrarse en una sesión.
3. Si tu herramienta tiene un modo de solo planificación, úsalo primero para revisar el enfoque antes de que escriba código.
4. Revisa el diff y ejecuta `pnpm check` tú mismo antes de aceptar. Comprender lo que entra en el repo es lo que hace que el proyecto sea tuyo en una entrevista.
5. Un commit por tarea, con mensaje Conventional Commits.

**Prompt de arranque sugerido:**

```text
Read AGENTS.md and PLAN.md in full. Work only on task P0-T1.
Before writing code, describe your approach in a few lines and wait for my OK.
When finished, run `pnpm check` if it exists, tick the checkbox in PLAN.md
and propose a Conventional Commit message.
```

## 13. Riesgos y decisiones abiertas

**Riesgos**
- **Fase 5** es la más difícil: empezar con la heurística voraz y no buscar un óptimo.
- **Zonas horarias y cambio de hora:** fuente típica de bugs; por eso hay tests dedicados desde la fase 1.
- **Abuso de la demo pública:** mitigado con límites, rate limiting y limpieza; revisar tras el despliegue.
- **Crecimiento de alcance:** la lista "Fuera de v1" y el corte tras la fase 3 existen para protegerse de esto.

**Decisiones abiertas** (cerrar en el ADR de la fase correspondiente)
- Nombre definitivo del proyecto.
- Proveedor de despliegue (fase 3).
- Disponibilidad por defecto de un workspace nuevo (valores propuestos en la sección 5).
- Librería de fechas (fase 1) y de calendario (fase 6).
- Si se añade autenticación real después de la fase 3.
