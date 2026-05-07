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
        # The frontend (frontend/app.js, `state.opening.catalog`) expects
        # ``color`` / ``description`` / ``lines: [{id, name, moves, description}]``
        # — so the practice/theory toggle and the AI-coach button can find a
        # selected line. We keep the legacy ``side`` / ``theory`` /
        # ``line_san`` fields too so any older client/build still works.
        moves = list(self.line_san)
        return {
            "id": self.id,
            "name": self.name,
            "eco": self.eco,
            "color": self.side,
            "description": self.theory,
            "lines": [
                {
                    "id": "main",
                    "name": "Главная линия",
                    "moves": moves,
                    "description": self.theory,
                }
            ],
            # Legacy fields kept for back-compat.
            "side": self.side,
            "theory": self.theory,
            "line_san": moves,
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
            "Точно по теории. Qa5 — главное поле для ферзя.",
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
    Opening(
        id="scotch-game",
        name="Шотландская партия",
        eco="C45",
        side="white",
        theory=(
            "1.e4 e5 2.Nf3 Nc6 3.d4 — белые сразу подрывают центр и "
            "стремятся к открытой игре. После 3…exd4 4.Nxd4 у белых "
            "сильный конь в центре и быстрое развитие."
        ),
        line_san=("e4", "e5", "Nf3", "Nc6", "d4", "exd4", "Nxd4", "Nf6", "Nxc6", "bxc6", "e5"),
        coach_good=(
            "Прямой подрыв центра — главная идея Шотландки.",
            "Nxd4 — конь занимает сильное центральное поле.",
            "e5 после размена коней — типичный приём, теснит коня f6.",
        ),
        coach_bad=(
            "В Шотландке центр вскрывается ходом d4 — без него идея теряется.",
            "Не отступай конём пассивно — Nxd4 даёт сильную позицию.",
            "Не теряй темп: размен на c6 и e5 — связанный план.",
        ),
        coach_complete=(
            "Прошли главную линию Шотландки. Дальше у чёрных Qe7 или Nd5 "
            "с типичной контригрой."
        ),
    ),
    Opening(
        id="pirc-defense",
        name="Защита Пирца",
        eco="B07",
        side="black",
        theory=(
            "1.e4 d6 2.d4 Nf6 3.Nc3 g6 — гипермодерн за чёрных. Чёрные "
            "пускают белых в центр, чтобы потом подорвать его ходами "
            "c5/e5. Слон g7 — главный атакующий ресурс."
        ),
        line_san=("e4", "d6", "d4", "Nf6", "Nc3", "g6", "Nf3", "Bg7", "Be2", "O-O"),
        coach_good=(
            "g6 + Bg7 — сердце Пирца, готовим фианкетто.",
            "0-0 рано — король в безопасности, дальше план с c5/e5.",
            "Nf6 без шаха коня атакует e4 — типичный ход Пирца.",
        ),
        coach_bad=(
            "Без g6 это уже не Пирц — фианкетто и слон g7 теряются.",
            "Не торопись с e5 без рокировки — белые перехватят центр.",
            "Не отдавай слона g7 без боя: это твой главный атакующий слон.",
        ),
        coach_complete=(
            "Дошли до классической установки Пирца. Дальше план: c6, b5 "
            "или e5 в зависимости от хода белых."
        ),
    ),
    Opening(
        id="alekhine-defense",
        name="Защита Алехина",
        eco="B02",
        side="black",
        theory=(
            "1.e4 Nf6 — провоцируем белых на расширение центра пешками "
            "e5/d4/c4, чтобы потом подорвать его. Главный план чёрных: "
            "d6, dxe5 и удары по перерасширенному центру."
        ),
        line_san=("e4", "Nf6", "e5", "Nd5", "d4", "d6", "Nf3", "Bg4"),
        coach_good=(
            "Nd5 — конь в центре под защитой, главная стоянка Алехина.",
            "d6 готовит подрыв центра ходом dxe5.",
            "Bg4 выводит слона ДО хода e6 — главная идея современного варианта.",
        ),
        coach_bad=(
            "Без Nf6 на 1-м ходу это уже не Алехин.",
            "Не отступай конём на b6 без необходимости — d5 сильнее.",
            "Не закрывай слона ходом e6 раньше времени.",
        ),
        coach_complete=(
            "Прошли в современный вариант Алехина. Дальше у белых "
            "выбор между h3 и Be2 с классическим центром."
        ),
    ),
    Opening(
        id="grunfeld-defense",
        name="Защита Грюнфельда",
        eco="D80",
        side="black",
        theory=(
            "1.d4 Nf6 2.c4 g6 3.Nc3 d5 — гипермодерн против ферзевой "
            "пешки. Чёрные отдают центр, но через …Nxd5 и давление "
            "слона g7 на длинную диагональ создают сильную контригру."
        ),
        line_san=("d4", "Nf6", "c4", "g6", "Nc3", "d5", "cxd5", "Nxd5", "e4", "Nxc3", "bxc3", "Bg7"),
        coach_good=(
            "d5 — сердце Грюнфельда, провоцируем размен в центре.",
            "Nxd5 + Nxc3 — типичный размен, ослабляющий пешки белых.",
            "Bg7 на длинной диагонали — главный атакующий слон.",
        ),
        coach_bad=(
            "Без d5 это уже не Грюнфельд, а Староиндийка.",
            "Не закрывай слона g7: он давит на c3 и e5 по диагонали.",
            "Не торопись с c5 без рокировки — белые перехватят инициативу.",
        ),
        coach_complete=(
            "Прошли в основной вариант обмена. Дальше у белых выбор: "
            "Bc4 (классика) или Nf3 со спокойным планом."
        ),
    ),
    Opening(
        id="dutch-defense",
        name="Голландская защита",
        eco="A80",
        side="black",
        theory=(
            "1.d4 f5 — резкий ответ против ферзевой пешки. Чёрные "
            "берут под контроль поле e4 и готовят атаку на королевском "
            "фланге. Минус — слабость диагонали a2-g8 и поля e6."
        ),
        line_san=("d4", "f5", "g3", "Nf6", "Bg2", "g6", "Nf3", "Bg7", "O-O", "O-O"),
        coach_good=(
            "f5 — фирменный голландский ход, давим на e4.",
            "Фианкетто Bg7 — типичная установка Ленинградского варианта.",
            "0-0 раньше развития ферзевого фланга — нормально для голландки.",
        ),
        coach_bad=(
            "Без f5 это уже не Голландская защита.",
            "Не открывай диагональ a2-g8 без необходимости — слабость e6/h5.",
            "Не торопись с e5 — сначала развитие фигур.",
        ),
        coach_complete=(
            "Прошли в Ленинградский вариант. Дальше план: Nc6, e5 "
            "и атака на королевском фланге."
        ),
    ),
    Opening(
        id="nimzo-indian",
        name="Защита Нимцовича",
        eco="E20",
        side="black",
        theory=(
            "1.d4 Nf6 2.c4 e6 3.Nc3 Bb4 — солидный дебют за чёрных. "
            "Идея Bb4 — связка коня c3 и контроль за полем e4. После "
            "размена слона на коня у белых ослабленная пешечная структура."
        ),
        line_san=("d4", "Nf6", "c4", "e6", "Nc3", "Bb4", "e3", "O-O", "Bd3", "d5"),
        coach_good=(
            "Bb4 связывает коня c3 — главный смысл дебюта.",
            "0-0 рано — король в безопасности, дальше центр.",
            "d5 в правильный момент — давление на c4 и центр.",
        ),
        coach_bad=(
            "Без Bb4 это другой дебют — теряется главная связка.",
            "Не размениваем слона b4 без выгоды — в этом смысл связки.",
            "Не торопись с c5 до рокировки — король под угрозой.",
        ),
        coach_complete=(
            "Прошли в Рубинштейн-вариант. Дальше план: c5 / Nc6 "
            "с давлением на пешку d4."
        ),
    ),
    Opening(
        id="vienna-game",
        name="Венская партия",
        eco="C26",
        side="white",
        theory=(
            "1.e4 e5 2.Nc3 — белые задерживают Nf3, чтобы подготовить "
            "f4 (Венский гамбит) или мирное развитие g3/Bg2. Гибкий "
            "и недооценённый дебют."
        ),
        line_san=("e4", "e5", "Nc3", "Nf6", "g3", "Bc5", "Bg2", "d6", "Nge2"),
        coach_good=(
            "Nc3 поддерживает e4 и не торопится с Nf3.",
            "g3 + Bg2 — спокойная установка, готовим d3 и 0-0.",
            "Nge2 — конь идёт на g3, чтобы прикрыть короля и не мешать слону.",
        ),
        coach_bad=(
            "Не торопись с Nf3 — теряется идея Венского гамбита.",
            "Без g3 в этой ветке слон g2 — главный атакующий ресурс.",
            "Не двигай пешку d сразу — подожди развития коней.",
        ),
        coach_complete=(
            "Прошли спокойный Венский. Дальше план: 0-0, d3 и медленная "
            "позиционная игра в стиле КИА."
        ),
    ),
    Opening(
        id="catalan-opening",
        name="Каталонское начало",
        eco="E00",
        side="white",
        theory=(
            "1.d4 Nf6 2.c4 e6 3.g3 — белые сочетают давление пешкой c4 "
            "с фианкеттированным слоном g2. Слон g2 простреливает длинную "
            "диагональ a8-h1 и давит на пешку d5 чёрных."
        ),
        line_san=("d4", "Nf6", "c4", "e6", "g3", "d5", "Bg2", "Be7", "Nf3", "O-O", "O-O"),
        coach_good=(
            "g3 + Bg2 — фирменное Каталонское фианкетто.",
            "0-0 быстро — король в безопасности, готовим Qc2 и Nbd2.",
            "Nf3 поддерживает d4 и готовит план e2-e4.",
        ),
        coach_bad=(
            "Без g3 это уже не Каталон, а классический ферзевый.",
            "Не размениваем слона g2 без необходимости — он главный.",
            "Не торопись с cxd5 — каталонские слон и c4 хотят оставить напряжение.",
        ),
        coach_complete=(
            "Прошли классический Каталон. Дальше план: Qc2, Rd1, "
            "Nbd2 и постепенное e4 в правильный момент."
        ),
    ),
    Opening(
        id="evans-gambit",
        name="Гамбит Эванса",
        eco="C51",
        side="white",
        theory=(
            "1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.b4 — острая ветвь Итальянской. "
            "Белые отдают пешку b4, чтобы выиграть темп ходом c3 и "
            "построить мощный центр d4."
        ),
        line_san=("e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "b4", "Bxb4", "c3", "Ba5", "d4"),
        coach_good=(
            "b4 — гамбитная жертва, выигрываем темп для c3 и d4.",
            "c3 готовит d4 с разгромом центра.",
            "d4 — выгодный размен пешки на инициативу и центр.",
        ),
        coach_bad=(
            "Не отказывайся от d4 — это компенсация за пешку.",
            "Без c3 идея гамбита теряется — нет темпа на d4.",
            "Не торопись с разменом слона на b4 — у нас своя выгода.",
        ),
        coach_complete=(
            "Прошли в основную линию Эванса. Дальше у чёрных Bb6 "
            "(классика) или принятие гамбита со сложной защитой."
        ),
    ),
    Opening(
        id="benoni-defense",
        name="Защита Бенони",
        eco="A60",
        side="black",
        theory=(
            "1.d4 Nf6 2.c4 c5 3.d5 e6 — острая защита за чёрных. После "
            "exd5 cxd5 у чёрных пешечный перевес на ферзевом фланге и "
            "слон g7 на длинной диагонали."
        ),
        line_san=("d4", "Nf6", "c4", "c5", "d5", "e6", "Nc3", "exd5", "cxd5", "d6", "e4", "g6"),
        coach_good=(
            "c5 + e6 + d6 — фирменная пешечная структура Бенони.",
            "Размен exd5 / cxd5 даёт чёрным полуоткрытую e-линию.",
            "g6 готовит фианкетто слона — главный атакующий слон Бенони.",
        ),
        coach_bad=(
            "Без c5 на 2-м ходу теряется главная идея — атака на ферзевом фланге.",
            "Не закрывай слона ходом e5 раньше времени — он нужен на g7.",
            "Не торопись с a6 / b5 — сначала рокировка и развитие.",
        ),
        coach_complete=(
            "Прошли в современный Бенони. Дальше план: 0-0, Re8 "
            "и подрыв b5 / f5 в зависимости от хода белых."
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
