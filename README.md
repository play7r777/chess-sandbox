# Chess Sandbox

Локальная веб-песочница для шахмат:

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

### 3. Запуск сервера

```powershell
.venv\Scripts\python -m uvicorn backend.main:app --host 127.0.0.1 --port 8001
```

Открой в браузере [http://127.0.0.1:8001/](http://127.0.0.1:8001/).

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

1. В блоке «Распознать с картинки» нажми «Выбрать файл», выбери PNG/JPG.
2. Нажми «Распознать». Бэкенд вернёт FEN, метод (`template` / `chesscog` /
   `occupancy_only`) и заметки.
3. Кнопка «Применить» подставляет распознанный FEN в редактор. Дальше можно
   подправить вручную (например, выставить очерёдность хода).

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
