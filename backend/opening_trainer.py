"""Opening Trainer — curated opening repertoire with a coach voice.

The dataset (``OPENINGS``) is intentionally compact: ten openings covering
the kinds of starts a club player will run into most weeks. Each entry
holds:

  • A short Russian-language theory blurb
  • The "main line" we drill against, given as SAN moves
  • A coach voice that scolds bad moves and praises good ones — three
    canned reactions per opening so feedback never feels copy-pasted

We expose two operations:

  • :func:`list_openings` — catalogue for the picker UI
  • :func:`evaluate_move` — the inner loop the practice page calls after
    every user move. It returns whether the move matches the trained
    line, which side moves next, and a coach line tailored to the
    outcome.

Mastery / per-user progress lives in ``users.py`` (``opening_trainer``
field on the user row); we just expose lookups so the HTTP layer can
glue both halves together.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import chess


@dataclass(frozen=True)
class Opening:
    id: str
    name: str
    eco: str
    side: str  # "white" | "black" — which colour the user is studying
    theory: str
    line_san: tuple[str, ...]
    coach_good: tuple[str, ...] = field(default_factory=tuple)
    coach_bad: tuple[str, ...] = field(default_factory=tuple)
    coach_complete: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "eco": self.eco,
            "side": self.side,
            "theory": self.theory,
            "line_san": list(self.line_san),
            "moves_count": len(self.line_san),
            "coach": {
                "good": list(self.coach_good),
                "bad": list(self.coach_bad),
                "complete": self.coach_complete,
            },
        }


# Curated list. Every line is a *main* line — we don't try to model
# every sideline; the coach blurb explains the idea well enough that a
# club player can branch off and still get useful feedback.
OPENINGS: tuple[Opening, ...] = (
    Opening(
        id="italian-game",
        name="Итальянская партия",
        eco="C50",
        side="white",
        theory=(
            "Классика: 1.e4 e5 2.Nf3 Nc6 3.Bc4. Белые целятся слоном на f7, "
            "развивают фигуры в центр и готовят рокировку. Цель — быстрое "
            "развитие и давление на слабый пункт f7. Главный план: c3, d3 "
            "(или d4), 0-0 и подготовка прорыва в центре."
        ),
        line_san=("e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "c3", "Nf6", "d4", "exd4"),
        coach_good=(
            "Хорошо! Слон на c4 целится в f7, ровно как и задумано.",
            "Развитие c3 + d4 — главная белая идея.",
            "Отлично, конь на f3 защищает e5 и атакует центр.",
        ),
        coach_bad=(
            "Чуть в сторону. Проверь, не сжимаешь ли ты собственную пешку c.",
            "Внимание: после такого хода у белых обычно не хватает темпа на d4.",
            "В Итальянской мы стремимся в центр — этот ход уводит фигуру с центральной диагонали.",
        ),
        coach_complete=(
            "Это была главная линия — от центральной идеи Италии до "
            "размена на d4. Дальше у белых выбор: гамбит Эванса, Грико "
            "или спокойный позиционный план."
        ),
    ),
    Opening(
        id="ruy-lopez",
        name="Испанская партия",
        eco="C60",
        side="white",
        theory=(
            "1.e4 e5 2.Nf3 Nc6 3.Bb5 — самая длинная и глубокая дебютная "
            "система за белых. Слон на b5 давит на c6 и косвенно на e5. "
            "В большинстве систем белые играют c3, d3 (или d4), Nbd2 и "
            "длинную игру на ферзевом фланге."
        ),
        line_san=("e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O", "Be7", "Re1", "b5", "Bb3"),
        coach_good=(
            "Точно по теории. Слон отступает по диагонали a4–c2.",
            "Re1 готовит c3, d4 — типичная испанская идея.",
            "0-0 раньше развития ферзевого фланга — классика испанки.",
        ),
        coach_bad=(
            "Этот ход выпускает напряжение. В испанке нам важно сохранить давление на e5.",
            "Поспешно. Сначала развитие, потом активность — иначе чёрные перехватят инициативу.",
            "Слон на b5 не должен меняться добровольно — он ключ к давлению.",
        ),
        coach_complete=(
            "Прошли главную ветку до Bb3. Теперь у чёрных большой выбор: "
            "Чигорин (Na5), Брейер (Nb8), Закрытая система (d6) и т.д."
        ),
    ),
    Opening(
        id="sicilian-najdorf",
        name="Сицилианская защита, Найдорф",
        eco="B90",
        side="black",
        theory=(
            "1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 a6 — Найдорф. "
            "Чёрные играют a6, чтобы при первой возможности подорвать "
            "центр через b5 и e5/e6. Главная идея — позиция гибкая, "
            "ферзевый фланг под контролем."
        ),
        line_san=("e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6"),
        coach_good=(
            "Идеально. a6 — фирменный ход Найдорфа, готовим b5.",
            "Конь на f6 атакует e4 и держит центр.",
            "d6 крепит e5-пункт — классическая структура Найдорфа.",
        ),
        coach_bad=(
            "Это другая сицилианская система. Найдорф требует именно a6 на 5-м ходу.",
            "Не торопись с e5 — без подготовки это слабит d6 и d5.",
            "Сначала Найдорфовский a6, иначе теряем главный плюс — гибкость.",
        ),
        coach_complete=(
            "Дошли до главной табии Найдорфа. Дальше у белых выбор между "
            "6.Be3 (английская атака), 6.Bg5 и 6.Be2."
        ),
    ),
    Opening(
        id="caro-kann",
        name="Защита Каро-Канн",
        eco="B10",
        side="black",
        theory=(
            "1.e4 c6 2.d4 d5 — солидный дебют без слабостей. Чёрные "
            "забирают центр без ослабления e6, как во Французской. "
            "Главные планы: разрядка через …dxe4 и развитие слона c8, "
            "часто на f5 или g4."
        ),
        line_san=("e4", "c6", "d4", "d5", "Nc3", "dxe4", "Nxe4", "Bf5"),
        coach_good=(
            "Очень по-Каро. Слон выходит ДО хода e6, не запираясь.",
            "dxe4 — ключевой размен, теперь белым придётся решать вопрос центра.",
            "Развитие слона на f5 — главное достоинство Каро-Канна.",
        ),
        coach_bad=(
            "В Каро-Канне мы не закрываем слона ходом e6 раньше времени.",
            "Не лучший ход порядка — сначала dxe4, иначе белые сохранят центр.",
            "Преждевременный размен. Дай белым сначала вывести фигуры.",
        ),
        coach_complete=(
            "Дошли до главной табии классической Каро-Канн. Дальше "
            "5.Ng3 Bg6 6.h4 — типичная атака на слона."
        ),
    ),
    Opening(
        id="french-defense",
        name="Французская защита",
        eco="C00",
        side="black",
        theory=(
            "1.e4 e6 2.d4 d5 — чёрные сразу бьют в центр. Минус: "
            "слон c8 заперт. Плюс: твёрдая центральная пешечная "
            "структура и возможности контригры по c-линии."
        ),
        line_san=("e4", "e6", "d4", "d5", "Nc3", "Bb4"),
        coach_good=(
            "Хорошо! Винавер — главная атакующая система за чёрных.",
            "e6 готовит d5 — это сердце Французской.",
            "d5 — точно по программе Французской защиты.",
        ),
        coach_bad=(
            "Не торопись с разменом — Французская выигрывает за счёт давления.",
            "Этот ход не из французских идей. Главное здесь — d5 и контригра.",
            "Без d5 на 2-м ходу мы лишаем дебют главной идеи.",
        ),
        coach_complete=(
            "Прошли в Винавер. Теперь у белых выбор: главная 4.e5 или "
            "размен 4.exd5."
        ),
    ),
    Opening(
        id="kings-indian",
        name="Староиндийская защита",
        eco="E60",
        side="black",
        theory=(
            "1.d4 Nf6 2.c4 g6 — чёрные строят гипермодерн: позволяют "
            "белым центр, чтобы потом подорвать его ходом …e5 или …c5. "
            "Главные планы: f7-f5, Nf6-h5-f4 и атака королевского фланга."
        ),
        line_san=("d4", "Nf6", "c4", "g6", "Nc3", "Bg7", "e4", "d6", "Nf3", "O-O"),
        coach_good=(
            "Отлично. Слон g7 — душа Староиндийки, держим его.",
            "0-0 рано — нам нужен король в безопасности перед f5.",
            "d6 готовит e5/c5 — главные подрывы.",
        ),
        coach_bad=(
            "Не отдавай слона g7 без боя — это твой основной атакующий ресурс.",
            "Не торопись с e5 без рокировки — белые могут получить инициативу.",
            "Без g6/Bg7 это уже не Староиндийская — структура другая.",
        ),
        coach_complete=(
            "Прошли в основную табию. Дальше выбор: классическая 7.0-0 "
            "или система Земиша 5.f3."
        ),
    ),
    Opening(
        id="queens-gambit",
        name="Ферзевый гамбит",
        eco="D06",
        side="white",
        theory=(
            "1.d4 d5 2.c4 — белые предлагают пешку, чтобы получить "
            "центр и развитие. Главные ветви: Принятый (2…dxc4), "
            "Отказанный (2…e6) и Славянка (2…c6)."
        ),
        line_san=("d4", "d5", "c4", "e6", "Nc3", "Nf6", "Bg5", "Be7"),
        coach_good=(
            "Bg5 — классика отказанного ферзевого гамбита.",
            "Хорошо: c4 наступает в центре сразу же.",
            "Nc3 поддерживает центр и готовит e3.",
        ),
        coach_bad=(
            "Не нужно сразу брать на c4 как белым — у нас свои фишки.",
            "В Ферзевом гамбите слон c1 хочет на g5 или f4, не запирай его.",
            "Без Nc3 центр трещит — этот ход не из дебюта.",
        ),
        coach_complete=(
            "Дошли до главной табии отказанного ферзевого гамбита. "
            "Дальше популярны 5.e3 или размен 5.cxd5."
        ),
    ),
    Opening(
        id="kings-indian-attack",
        name="Староиндийская атака",
        eco="A07",
        side="white",
        theory=(
            "1.Nf3 d5 2.g3 — гибкая система за белых, можно играть "
            "против почти любого ответа. Идея: фианкетто слона g2, "
            "0-0, e4 и атака на королевском фланге через Nh4 и f4."
        ),
        line_san=("Nf3", "d5", "g3", "Nf6", "Bg2", "e6", "O-O", "Be7", "d3", "O-O", "Nbd2"),
        coach_good=(
            "Идея КИА — фианкетто и e4 потом, ты идёшь по плану.",
            "Nbd2 — типичный КИА-манёвр, готовим e4.",
            "0-0 раньше центра — система гибкая.",
        ),
        coach_bad=(
            "В КИА мы избегаем раннего c4 — это другой дебют.",
            "Без g3/Bg2 это уже не Староиндийская атака.",
            "Не торопись с e4 — сначала рокировка и развитие.",
        ),
        coach_complete=(
            "Прошли построение КИА. Теперь идея — e4, Re1, Nh4 и атака."
        ),
    ),
    Opening(
        id="english",
        name="Английское начало",
        eco="A10",
        side="white",
        theory=(
            "1.c4 — фланговый дебют. Белые контролируют d5 пешкой и "
            "часто играют в Староиндийском стиле, но с лишним темпом. "
            "Гибкий, переходит в почти любое продолжение."
        ),
        line_san=("c4", "e5", "Nc3", "Nf6", "Nf3", "Nc6", "g3", "Bb4"),
        coach_good=(
            "g3 — главный ход, фианкетто слона.",
            "Nc3 контролирует d5 — главная идея английского.",
            "Хорошо! Без d4 мы избегаем размена в центре.",
        ),
        coach_bad=(
            "В английском мы не торопимся с d4 — это уже другой дебют.",
            "Без Nc3 пешка c4 теряет смысл — фигура должна её поддержать.",
            "Этот ход уводит коня от центра — нам нужен контроль над d5.",
        ),
        coach_complete=(
            "Дошли до симметричного варианта 4 рыцарей в английском. "
            "Дальше план: Bg2, 0-0, d3 — позиция типа Староиндийки наоборот."
        ),
    ),
    Opening(
        id="scandinavian",
        name="Скандинавская защита",
        eco="B01",
        side="black",
        theory=(
            "1.e4 d5 — самый прямой дебют за чёрных. После 2.exd5 Qxd5 "
            "или 2…Nf6 чёрные сразу решают проблему центра, но платят "
            "темпом ферзя или ранней разменной игрой."
        ),
        line_san=("e4", "d5", "exd5", "Qxd5", "Nc3", "Qa5"),
        coach_good=(
            "Точно по теории. Qa5 — главная клетка для ферзя.",
            "Nc3 — типичная атака на ферзя за белых.",
            "d5 — фирменный первый ход Скандинавки.",
        ),
        coach_bad=(
            "В Скандинавке мы не закрываем слона ходом e6.",
            "Без d5 это уже не Скандинавская защита.",
            "Не лучший отход ферзя — Qa5 и Qd6 — главные ветки.",
        ),
        coach_complete=(
            "Дошли до основной табии Mieses. Дальше у белых выбор: "
            "5.Nf3 или 5.Bc4."
        ),
    ),
)


_OPENING_BY_ID: dict[str, Opening] = {o.id: o for o in OPENINGS}


def list_openings() -> list[dict[str, Any]]:
    return [o.to_dict() for o in OPENINGS]


def get_opening(opening_id: str) -> Opening | None:
    return _OPENING_BY_ID.get(opening_id)


def _starting_board() -> chess.Board:
    return chess.Board()


def _coach_for(opening: Opening, *, correct: bool, ply: int) -> str:
    """Pick a deterministic coach line for the given (opening, ply, outcome).

    We rotate through ``coach_good`` / ``coach_bad`` based on the move
    number so the same line repeated three times in a row doesn't
    parrot the same blurb.
    """
    bank = opening.coach_good if correct else opening.coach_bad
    if not bank:
        return ""
    return bank[ply % len(bank)]


def evaluate_move(
    *,
    opening_id: str,
    ply: int,
    san: str,
) -> dict[str, Any]:
    """Check whether ``san`` matches the trained line at position ``ply``.

    ``ply`` is 0-indexed against ``opening.line_san``: the user has
    already played the first ``ply`` moves and is now trying ``ply``th.

    Returns a payload with:
      • ``correct`` — bool
      • ``expected`` — the SAN we wanted (always present)
      • ``coach`` — coach voice for this attempt
      • ``next_san`` — the engine's response if any (so the UI can
        auto-play the opponent's main-line reply)
      • ``next_index`` — ply the user is at after the auto-reply
      • ``finished`` — true once the whole line is exhausted
      • ``fen_before`` / ``fen_after`` — for client-side board sync
    """
    opening = get_opening(opening_id)
    if opening is None:
        raise KeyError("unknown_opening")
    line = opening.line_san
    if ply < 0 or ply >= len(line):
        raise IndexError("ply_out_of_range")
    board = _starting_board()
    for prev in line[:ply]:
        board.push_san(prev)
    fen_before = board.fen()
    expected_san = line[ply]
    correct = False
    fen_after = fen_before
    try:
        # Validate the user's move is legal in this position. Whether
        # it equals the canonical SAN we drill is the "correct" flag.
        move = board.parse_san(san)
    except (ValueError, AssertionError):
        move = None
    if move is not None:
        # Compare against what we *expect* — board.parse_san already
        # normalised SAN (so "Bxc6" vs "Bc6" mismatch is impossible).
        try:
            expected_move = board.parse_san(expected_san)
        except ValueError:
            expected_move = None
        if expected_move is not None and move == expected_move:
            board.push(move)
            fen_after = board.fen()
            correct = True
    coach = _coach_for(opening, correct=correct, ply=ply)
    next_san: str | None = None
    next_index = ply + (1 if correct else 0)
    if correct and next_index < len(line):
        # Auto-play the canonical opponent reply so the UI can advance
        # the board without an extra round-trip.
        opp_san = line[next_index]
        try:
            opp_move = board.parse_san(opp_san)
        except ValueError:
            opp_move = None
        if opp_move is not None:
            board.push(opp_move)
            next_san = opp_san
            fen_after = board.fen()
            next_index += 1
    finished = correct and next_index >= len(line)
    return {
        "opening_id": opening_id,
        "ply": ply,
        "user_san": san,
        "expected": expected_san,
        "correct": correct,
        "coach": coach if not finished else opening.coach_complete or coach,
        "next_san": next_san,
        "next_index": next_index,
        "finished": finished,
        "fen_before": fen_before,
        "fen_after": fen_after,
        "moves_total": len(line),
    }


def position_at(opening_id: str, ply: int) -> dict[str, Any]:
    """Return the FEN + side-to-move for ``ply`` moves into ``opening_id``."""
    opening = get_opening(opening_id)
    if opening is None:
        raise KeyError("unknown_opening")
    if ply < 0 or ply > len(opening.line_san):
        raise IndexError("ply_out_of_range")
    board = _starting_board()
    for san in opening.line_san[:ply]:
        board.push_san(san)
    return {
        "opening_id": opening_id,
        "ply": ply,
        "fen": board.fen(),
        "side_to_move": "w" if board.turn == chess.WHITE else "b",
        "expected": opening.line_san[ply] if ply < len(opening.line_san) else None,
        "moves_total": len(opening.line_san),
    }
