"use strict";

/**
 * game.js — логика чат-игры «Викторина».
 *
 * Конечный автомат состояний:
 *   idle      — ожидание игроков, игра не запущена
 *   question  — отображается вопрос, таймер отсчитывает секунды
 *   result    — показывается результат вопроса (перед переходом к следующему)
 *   gameover  — игра завершена, отображаются итоговые очки
 *
 * Переходы:
 *   idle → question   : startGame()
 *   question → result : таймер истёк или все ответили
 *   result → question : через RESULT_DELAY мс
 *   result → gameover : больше нет вопросов
 *   gameover → idle   : resetGame() или через AUTO_RESET_DELAY мс
 *
 * Генерируемые события (EventEmitter):
 *   "question"        (questionData)
 *   "timer"           (secondsLeft)
 *   "question_result" (resultData)
 *   "new_round"       (roundNumber)   — пул исчерпан, начинается новый круг
 *   "game_over"       (gameoverData)  — только при явном вызове stopGame()
 *   "game_reset"      ()
 *   "can_start"       (boolean)
 */

const EventEmitter = require("events");
const ALL_QUESTIONS = require("./questions");

const QUESTION_TIME  = 20;    // секунд на вопрос
const RESULT_DELAY   = 6_000; // мс показа результата перед следующим вопросом

class QuizGame extends EventEmitter {
  constructor() {
    super();

    /** @type {Map<string, { id: string, name: string, score: number, answered: boolean }>} */
    this.players = new Map();

    /** @type {"idle"|"question"|"result"|"gameover"} */
    this.state = "idle";

    /** @type {import("./questions")[]} */
    this.questions = [];

    this.questionIndex = -1;
    this.roundNumber   = 0;
    this.secondsLeft   = 0;

    this._timerInterval = null;
    this._resultTimeout = null;
  }

  // ─────────────────────────────────────────────
  //  Управление игроками
  // ─────────────────────────────────────────────

  /**
   * Добавляет нового игрока.
   * @param {string} id    Socket-идентификатор
   * @param {string} name  Имя игрока
   * @returns {{ id: string, name: string, score: number, answered: boolean }}
   */
  addPlayer(id, name) {
    const player = { id, name, score: 0, answered: false };
    this.players.set(id, player);
    this._emitCanStart();
    return player;
  }

  /**
   * Удаляет игрока (при отключении).
   * @param {string} id
   */
  removePlayer(id) {
    this.players.delete(id);
    this._emitCanStart();

    // Если все оставшиеся игроки уже ответили — завершаем вопрос досрочно
    if (this.state === "question" && this._allAnswered()) {
      this._endQuestion();
    }
  }

  // ─────────────────────────────────────────────
  //  Управление игрой
  // ─────────────────────────────────────────────

  /** Можно ли запустить игру прямо сейчас. */
  canStart() {
    return this.players.size >= 1 && this.state === "idle";
  }

  /**
   * Запускает новую игру.
   * @throws {Error} если игру нельзя начать в текущем состоянии
   */
  startGame() {
    if (!this.canStart()) {
      throw new Error("Невозможно запустить игру в текущем состоянии.");
    }

    // Перемешиваем вопросы и сбрасываем очки
    this.questions = _shuffle([...ALL_QUESTIONS]);
    for (const p of this.players.values()) {
      p.score = 0;
      p.answered = false;
    }

    this.questionIndex = -1;
    this.roundNumber   = 1;
    this._nextQuestion();
  }

  /**
   * Принимает ответ от игрока.
   * @param {string} id     Socket-идентификатор
   * @param {string} letter Буква ответа ("A"|"B"|"C"|"D")
   * @returns {{ alreadyAnswered: boolean, correct: boolean, letter: string } | null}
   *          null — если игрок не найден или не идёт фаза вопроса
   */
  submitAnswer(id, letter) {
    const player = this.players.get(id);
    if (!player || this.state !== "question") return null;
    if (player.answered) return { alreadyAnswered: true, correct: false, letter };

    const q = this.questions[this.questionIndex];
    const correct = letter.toUpperCase() === q.correct;

    player.answered = true;

    if (correct) {
      // Базовые 500 очков + бонус за скорость (до 500 очков)
      const timeBonus = Math.floor((this.secondsLeft / QUESTION_TIME) * 500);
      player.score += 500 + timeBonus;
    }

    if (this._allAnswered()) {
      this._endQuestion();
    }

    return { alreadyAnswered: false, correct, letter: letter.toUpperCase() };
  }

  /** Возвращает текущий вопрос для игрока, подключившегося во время фазы question. */
  getCurrentQuestionForLateJoin() {
    if (this.state !== "question") return null;
    const q = this.questions[this.questionIndex];
    return {
      index: this.questionIndex + 1,
      total: this.questions.length,
      text: q.text,
      options: q.options,
      timeLimit: QUESTION_TIME,
      secondsLeft: this.secondsLeft,
    };
  }

  /** Список игроков для отправки клиентам. */
  getPlayerList() {
    return [...this.players.values()].map((p) => ({
      id:       p.id,
      name:     p.name,
      score:    p.score,
      answered: p.answered,
    }));
  }

  /** Таблица очков (отсортированная). */
  getScores() {
    return [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Досрочно завершает игру и показывает итоги (по кнопке «Завершить игру»).
   */
  stopGame() {
    if (this.state === "idle" || this.state === "gameover") return;
    this._endGame();
  }

  /**
   * Сброс игры в состояние idle (по кнопке «Играть снова»).
   */
  resetGame() {
    this._clearTimers();
    this.state = "idle";
    for (const p of this.players.values()) {
      p.score = 0;
      p.answered = false;
    }
    this.questionIndex = -1;
    this.roundNumber   = 0;
    this.questions = [];
    this.emit("game_reset");
    this._emitCanStart();
  }

  // ─────────────────────────────────────────────
  //  Внутренняя логика
  // ─────────────────────────────────────────────

  _nextQuestion() {
    this.questionIndex++;

    // Пул исчерпан — перетасовать и начать новый круг
    if (this.questionIndex >= this.questions.length) {
      this.questions = _shuffle([...ALL_QUESTIONS]);
      this.questionIndex = 0;
      this.roundNumber++;
      this.emit("new_round", this.roundNumber);
    }

    this.state = "question";
    const q = this.questions[this.questionIndex];

    // Сбрасываем флаги ответов
    for (const p of this.players.values()) p.answered = false;

    this.secondsLeft = QUESTION_TIME;

    this.emit("question", {
      index:     this.questionIndex + 1,
      total:     this.questions.length,
      text:      q.text,
      options:   q.options,
      timeLimit: QUESTION_TIME,
      secondsLeft: this.secondsLeft,
    });

    // Таймер отсчёта
    this._timerInterval = setInterval(() => {
      this.secondsLeft--;
      this.emit("timer", this.secondsLeft);
      if (this.secondsLeft <= 0) {
        this._endQuestion();
      }
    }, 1_000);
  }

  _endQuestion() {
    if (this.state !== "question") return;
    this._clearTimers();

    this.state = "result";
    const q = this.questions[this.questionIndex];
    const answeredCount = [...this.players.values()].filter((p) => p.answered).length;

    this.emit("question_result", {
      correctLetter: q.correct,
      correctText:   q.options[q.correct],
      explanation:   q.explanation,
      scores:        this.getScores(),
      answeredCount,
      totalPlayers:  this.players.size,
    });

    // Переходим к следующему вопросу через RESULT_DELAY
    this._resultTimeout = setTimeout(() => this._nextQuestion(), RESULT_DELAY);
  }

  _endGame() {
    this._clearTimers();
    this.state = "gameover";

    const scores = this.getScores();
    const winner = scores[0] || null;

    this.emit("game_over", { scores, winner: winner ? winner.name : null });
  }

  _allAnswered() {
    if (this.players.size === 0) return true;
    return [...this.players.values()].every((p) => p.answered);
  }

  _emitCanStart() {
    this.emit("can_start", this.canStart());
  }

  _clearTimers() {
    if (this._timerInterval) { clearInterval(this._timerInterval); this._timerInterval = null; }
    if (this._resultTimeout) { clearTimeout(this._resultTimeout);  this._resultTimeout = null; }
  }
}

// ─────────────────────────────────────────────────────
//  Вспомогательные функции
// ─────────────────────────────────────────────────────

/** Перемешивает массив (Fisher–Yates). */
function _shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = new QuizGame();
