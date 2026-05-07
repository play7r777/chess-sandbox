# Chess Sandbox

Локальная веб-песочница для шахмат, всё крутится у тебя на машине,
никаких облаков:

- 🎲 **Редактор позиции** — стартовая позиция, перетаскивание фигур обеими сторонами,
  любая расстановка через палитру (добавить/удалить любую фигуру в любой клетке),
  переключение очерёдности хода, прав на рокировку и поля взятия на проходе,
  импорт/экспорт FEN.
- 🤖 **Игра против Stockfish 18 AVX2** из любой текущей позиции, выбор стороны,
  настройка времени на ход и уровня, кнопка «подсказать ход» (best move).
- 📷 **Распознавание позиции по скриншоту** — загружаешь PNG/JPG c шахматной
  диаграммой (lichess, chess.com, chesscom-like, рендеры python-chess), бэкенд
  возвращает FEN, который тут же подставляется в редактор. Можно подправить
  вручную и продолжить.
- 🧩 **500 000+ пазлов из открытой базы Lichess** (CC0). Скрипт импорта
  скачивает официальный CSV, семплирует нужное количество и кладёт в
  локальный SQLite. Соло-режим и пати-комнаты тянут пазлы из той же базы.

Бэкенд на FastAPI + python-chess; фронтенд — нативный JS/HTML/CSS, без бандлеров.
Кросс-платформенный (тестировался на Linux, целевая ОС — Windows).

---

## Быстрый старт (Windows)

### 1. Подготовка окружения

```powershell
# В корне репозитория
py -3.11 -m venv .venv
.venv\Scripts\activate
pip install -e .
```

> Если PyPI недоступен или `pip install` падает на `cairosvg` — установи
> `GTK3 Runtime` (нужен для рендеринга SVG-эталонов; на Windows
> [scoop](https://scoop.sh) или [https://github.com/tschoonj/GTK-for-Windows-Runtime-Environment-Installer/releases](https://github.com/tschoonj/GTK-for-Windows-Runtime-Environment-Installer/releases)).
> Без `cairosvg` шаблонное распознавание выключится, но движок и редактор будут работать.

### 2. Stockfish 18 AVX2

Скачай свежий релиз с [stockfishchess.org/download/](https://stockfishchess.org/download/),
распакуй и положи `stockfish-windows-x86-64-avx2.exe` куда удобно (например
`C:\stockfish\stockfish-windows-x86-64-avx2.exe`).

Указать путь можно тремя способами:

1. Через UI — поле «Путь к Stockfish» в правой панели → кнопка «Применить».
2. Через переменную окружения:
   ```powershell
   $env:CHESS_STOCKFISH_PATH = "C:\stockfish\stockfish-windows-x86-64-avx2.exe"
   ```
3. Положить `stockfish.exe` в `PATH` — приложение само его найдёт.

### 3. (Опционально) База пазлов из Lichess

Без этого шага доступно только 90 встроенных пазлов (для разработки).
Чтобы подтянуть полноценную базу из открытого датасета
[Lichess Puzzle Database](https://database.lichess.org/#puzzles) (CC0),
запусти один раз.

**Полная база (~5.5 млн пазлов, ~1.5 GB SQLite, рекомендуется):**

```powershell
.venv\Scripts\python -m backend.import_puzzles --all
```

**Сэмпл 500k пазлов (быстрее, ~150 MB SQLite):**

```powershell
.venv\Scripts\python -m backend.import_puzzles
```

Скрипт:

1. Скачает `lichess_db_puzzle.csv.zst` (~300 MB) в `backend/data/`.
   Если файл уже там — скачивание пропускается.
2. Стримом распакует и пройдёт по всем ~5.5 млн пазлов.
3. С `--all` — запишет все, без семплинга. Без флага — reservoir-семпл
   на N пазлов в `backend/data/puzzles.sqlite` с индексами по рейтингу
   и сложности.

Полный прогон занимает ~10–15 минут (download) + 1–3 минуты (семпл) или
~20–40 минут (запись всех 5.5M в SQLite). Дальше команду повторно
запускать не надо — база живёт локально.

Параметры:

- `--all` — без семплинга, импортировать все пазлы (~5.5 млн).
- `--target N` — другое количество (например `--target 100000`).
- `--url …` — другой источник CSV.

При запуске сервер печатает первой строкой:

```
[chess-sandbox] Пазлы: 5,500,000 (источник: sqlite — Lichess база)
```

Так что сразу видно, какая база подключилась. Если SQLite-файла нет,
бэкенд автоматически работает с встроенными 90 пазлами (`source: "json"`).

### 4. Запуск сервера

```powershell
.venv\Scripts\python -m uvicorn backend.main:app --host 127.0.0.1 --port 8001
```

Открой в браузере [http://127.0.0.1:8001/](http://127.0.0.1:8001/).

---

## Игра с друзьями (туннель в интернет)

Локальный сервер по умолчанию слушает `127.0.0.1` — снаружи невидим.
Чтобы кенты из других стран подключались (соло-пазлы, пати-комнаты,
анализ — всё через одну ссылку), нужен туннель: либо
**[ngrok](https://ngrok.com)**, либо **[playit.gg](https://playit.gg)**.

В репо есть готовые скрипты, которые ставят `CHESS_HOST=0.0.0.0`,
запускают сервер и параллельно поднимают туннель.

### Windows — PowerShell

```powershell
# ngrok (по умолчанию)
.\scripts\start-public.ps1

# playit.gg
.\scripts\start-public.ps1 -Tunnel playit

# Просто 0.0.0.0, туннель поднимешь сам
.\scripts\start-public.ps1 -Tunnel none -Port 9000
```

### Linux / macOS — bash

```bash
./scripts/start-public.sh                       # ngrok
./scripts/start-public.sh --tunnel playit
./scripts/start-public.sh --tunnel none --port 9000
```

### Что нужно поставить заранее

**ngrok** (рекомендую — самый простой, работает по WebSocket из коробки):

1. Качаешь с [ngrok.com/download](https://ngrok.com/download).
2. Регистрируешься, копируешь authtoken из дашборда.
3. Один раз: `ngrok config add-authtoken <твой_токен>`.
4. **Где разместить `ngrok.exe`** (скрипт смотрит в этом порядке):
   - В папке `scripts\` рядом со `start-public.ps1` — самый простой вариант,
     ничего не настраивать.
   - В корне проекта (рядом с `pyproject.toml`).
   - В `PATH` (Win+R → `sysdm.cpl` → «Дополнительно» → «Переменные среды» →
     `Path` → «Изменить» → добавить путь к папке с `ngrok.exe` → закрыть
     все окна PowerShell и открыть новое).
5. Запускаешь скрипт выше — он сам стартанёт `ngrok http 8001`,
   опросит локальный API ngrok (`http://127.0.0.1:4040/api/tunnels`)
   и напечатает публичный URL вида `https://abc-123.ngrok-free.app`.

На бесплатном тарифе ngrok при первом заходе показывает страницу-предупреждение
с кнопкой «Visit Site» — кенты кликают один раз и играют. Платный тариф
($8/мес) даёт постоянный URL без warning-страницы.

**playit.gg** (TCP-туннели для геймсерверов, но и HTTP/WebSocket поддерживает):

1. Качаешь агента с [playit.gg/download](https://playit.gg/download),
   регистрируешься.
2. `playit.exe` положи рядом со скриптом (`scripts\`), в корень проекта,
   или в `PATH` — как и ngrok.
3. Запускаешь скрипт с `-Tunnel playit` (или `--tunnel playit`).
4. В веб-консоли [playit.gg/account/tunnels/add](https://playit.gg/account/tunnels/add)
   создаёшь туннель типа **HTTPS**, локальный порт **8001**.
5. Получаешь URL вида `https://*.playit.gg` — кидаешь кентам.

В отличие от ngrok, у playit нужно вручную настроить туннель в
веб-интерфейсе один раз — потом он постоянный и бесплатный.

> Бинарники `ngrok.exe` / `playit.exe` уже добавлены в `.gitignore` —
> можешь смело класть их в `scripts\` или корень проекта, в коммит они
> не попадут.

### Что важно знать

- **Пати-комнаты по WebSocket.** Фронт сам собирает `wss://` URL из
  `location.host`/`location.protocol`, поэтому пати работает через
  любой туннель без правок (см. `frontend/app.js`, функция `_partyWsUrl`).
- **Не светите URL чужим.** Любой, у кого ссылка, видит твою лидерборд-базу
  и может играть. Если нужен закрытый клуб — поставь
  [Tailscale](https://tailscale.com), это VPN-сетка между вашими
  машинами без публичных URL.
- **Stockfish крутится у тебя.** Все запросы анализа / лучшего хода
  работают за счёт твоего CPU. Если кент гоняет анализ на 30 ply,
  это нагрузит твой компьютер.

---

## Использование

### Редактор позиции

- **Перетаскивание** — двигаешь фигуры с доски на доску (любой стороной — никакой
  проверки легальности в режиме редактора). Перетаскиваешь фигуру из палитры
  справа, чтобы добавить её в любую клетку.
- **Удаление** — нажми «Стереть» (или ПКМ по клетке). Повторное нажатие выходит
  из режима стирания.
- **Переключение хода / прав на рокировку / поле en-passant / счётчики** —
  блок «Метаданные FEN» под доской.
- **FEN** — поле сверху доски: вставь FEN, нажми «Загрузить»; «Скопировать»
  кладёт текущий FEN в буфер.
- **Reset / Clear / Flip** — три кнопки в шапке.

### Игра против Stockfish

1. Расставь интересующую позицию (или загрузи FEN).
2. В блоке «Игра» выбери цвет (за кого играешь), время на ход движка (мс).
3. Нажми «Старт» — если ход твой, делай ход на доске; ход движка прилетит
   автоматически. Если ход движка — увидишь его сразу.
4. «Стоп» прерывает партию (можно продолжить в редакторе).
5. «Подсказать ход» вызывает движок на текущем FEN и подсвечивает его лучший ход.

### Распознавание скриншота

Три способа отдать картинку:

- **Ctrl+V** где угодно на странице (если делал PrintScreen или скопировал
  картинку из мессенджера / браузера) — позиция распознаётся и сразу
  применяется к доске.
- **Drag & drop** файла на серую зону в блоке «Распознать со скриншота» —
  тоже автоматическое применение.
- **«Выбрать файл»** + кнопка «Распознать» — классический путь, ручной
  Apply для согласия с результатом.

Бэкенд отдаёт FEN, метод (`template` / `chesscog` / `occupancy_only`),
уверенность и заметки. Очерёдность хода и права на рокировку
выставляются по умолчанию (белые, без прав) — поправь вручную в редакторе,
если нужно.

**Что хорошо распознаётся:** скриншоты с lichess / python-chess / chess.com
(стандартные наборы Cburnett / Merida / Alpha) на чистом фоне.

**Что хуже:** фотографии физической доски с бликами / перспективными искажениями.
Для таких случаев можно поставить опциональную CNN-зависимость:

```powershell
pip install -e .[recognize]
```

(подтянет PyTorch + chesscog). Тогда конвейер сначала пробует CNN, и только потом
fallback на шаблоны.

---

## Архитектура

```
backend/
  main.py             # FastAPI приложение, маршруты API + статические файлы
  settings.py         # Настройки через env + UI override
  stockfish_engine.py # Async-обёртка над python-chess.engine.SimpleEngine
  recognize.py        # CV pipeline: chesscog → template → occupancy
  puzzles.py          # Фасад: SQLite (если есть) или JSON-fallback
  puzzle_db.py        # Read-only обёртка над puzzles.sqlite
  import_puzzles.py   # CLI для импорта Lichess Puzzle DB (CC0)
  party.py            # Пати-комнаты на WebSocket, общий queue
  users.py            # Профиль / лидерборд / история ELO
  analysis.py         # Импорт партии (PGN/URL) + анализ Stockfish
  data/
    puzzles.json      # Встроенные ~90 пазлов (fallback для разработки)
    puzzles.sqlite    # 500k пазлов после `python -m backend.import_puzzles`
    users.json        # JSON-стор пользователей и лидерборда
frontend/
  index.html          # Один экран SPA
  style.css           # Тёмная тема
  app.js              # Логика доски, FEN, движка, распознавания
  lib/chess.js        # Локальная копия chess.js (валидация ходов)
pyproject.toml        # Зависимости + ruff/mypy/pytest конфиг
```

API:

| Метод | Путь                       | Описание                           |
|-------|----------------------------|------------------------------------|
| GET   | `/api/health`              | состояние движка и распознавания   |
| POST  | `/api/engine/configure`    | выбрать путь к Stockfish + опции   |
| POST  | `/api/engine/best_move`    | лучший ход для FEN                 |
| POST  | `/api/engine/analyse`      | top-N линий                        |
| POST  | `/api/engine/stop`         | остановить движок                  |
| POST  | `/api/move/apply`          | применить UCI-ход к FEN            |
| POST  | `/api/legal_moves`         | легальные ходы из клетки           |
| POST  | `/api/recognize`           | FEN из изображения (multipart)     |
| GET   | `/api/puzzle/stats`        | количество пазлов, источник (sqlite/json) |
| GET   | `/api/puzzle/random`       | случайный пазл (`difficulty`, `theme`, `min_rating`, `max_rating`) |
| GET   | `/api/puzzle/{id}`         | пазл по Lichess id                 |
| WS    | `/api/party/ws/{code}`     | пати-комната: общий queue 1000 пазлов на матч |

### Настройки (env, префикс `CHESS_`)

| Переменная                          | По умолчанию | Что делает                        |
|-------------------------------------|--------------|-----------------------------------|
| `CHESS_STOCKFISH_PATH`              | —            | путь к бинарнику Stockfish        |
| `CHESS_STOCKFISH_THREADS`           | 1            | UCI Threads                        |
| `CHESS_STOCKFISH_HASH_MB`           | 64           | UCI Hash                           |
| `CHESS_STOCKFISH_DEFAULT_MOVETIME_MS` | 800        | время на ход по умолчанию          |
| `CHESS_STOCKFISH_DEFAULT_SKILL_LEVEL` | 20         | UCI Skill Level (0..20)            |
| `CHESS_HOST`                        | 127.0.0.1    | bind хост                          |
| `CHESS_PORT`                        | 8001         | bind порт                          |
| `CHESS_OLLAMA_BASE_URL`             | `http://127.0.0.1:11434` | URL локального Ollama-демона |
| `CHESS_OLLAMA_MODEL`                | `llama3.2:3b` | модель для AI-тренера дебютов     |
| `CHESS_OLLAMA_TIMEOUT_S`            | 60           | таймаут на ответ модели (сек)      |
| `CHESS_OLLAMA_NUM_PREDICT`          | 320          | максимум токенов в ответе         |

---

## AI-тренер дебютов (Ollama + Stockfish)

В таб **Opening** встроен AI-тренер: после любого хода в режиме практики
жми **«🧠 Подробнее от тренера»** — бэкенд берёт текущий FEN, прогоняет
его через Stockfish 18 (multipv=2), кладёт результат в промпт вместе с
теорией дебюта и стримит объяснение от локальной LLM. Ничего не уходит
в облако: всё крутится у тебя.

### Установка

1. Скачай и поставь **Ollama** с [ollama.com/download](https://ollama.com/download)
   (Windows-инсталлер `OllamaSetup.exe`, macOS .app, Linux `curl …`).
2. После установки демон Ollama стартует сам и слушает
   `http://127.0.0.1:11434`. Проверить можно так:
   ```powershell
   curl http://127.0.0.1:11434/api/tags
   ```
3. Поставь одну из рекомендованных моделей (одной хватает):
   ```powershell
   # Самая быстрая (~2 GB), нормально объясняет идеи дебюта
   ollama pull llama3.2:3b

   # Лучше понимает шахматную нотацию, ~4.5 GB
   ollama pull qwen2.5:7b

   # Компромисс между качеством и скоростью, ~5 GB
   ollama pull llama3.1:8b-instruct-q4_K_M
   ```
4. Запусти Chess Sandbox обычным способом (`uvicorn backend.main:app …`).
   В таб Opening появится бейдж **«Ollama on · llama3.2:3b»** — значит
   AI-тренер подключён.

### Как сменить модель

Положи в окружение перед запуском:

```powershell
$env:CHESS_OLLAMA_MODEL = "qwen2.5:7b"
.venv\Scripts\python -m uvicorn backend.main:app --host 127.0.0.1 --port 8001
```

Или в `.env` рядом с `pyproject.toml`:

```
CHESS_OLLAMA_MODEL=qwen2.5:7b
CHESS_OLLAMA_BASE_URL=http://127.0.0.1:11434
```

### Что если Ollama не запущена?

Тренер сам проверяет демон через `/api/opening_trainer/coach/status`.
Если Ollama не отвечает, бейдж показывает **«Ollama off»** и инструкции
по запуску, а кнопка «Подробнее от тренера» отдаёт **fallback** — теорию
дебюта + оценку Stockfish 18 + canned-фразы тренера. То есть UX не
ломается даже без LLM, просто разбор не такой подробный.

### Stockfish 18 в промпте

Каждый запрос к тренеру тянет с движка топ-2 PV на глубину 18.
Эти линии попадают в системный промпт, чтобы модель опиралась на
объективную оценку и не выдумывала анализ. Без сконфигурённого
Stockfish-а тренер всё равно ответит, но без эталонных линий.

---

## Разработка

```bash
pip install -e .[dev]
ruff check backend/
mypy backend/
```

Запуск с автоперезагрузкой:

```bash
uvicorn backend.main:app --host 127.0.0.1 --port 8001 --reload
```

CI прогоняет `ruff` и `mypy` на каждый PR.
