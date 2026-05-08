"use strict";

/**
 * chat.js — клиентская логика чат-игры «Викторина».
 * Взаимодействует с сервером через Socket.IO.
 */

(function () {
  const QUESTION_TIME = 20;

  // ── DOM ──────────────────────────────────────────────────────────────────
  const joinModal     = document.getElementById("join-modal");
  const joinForm      = document.getElementById("join-form");
  const playerNameInput = document.getElementById("player-name");
  const joinError     = document.getElementById("join-error");

  const stateBadge    = document.getElementById("state-badge");
  const startBtn      = document.getElementById("start-btn");
  const resetBtn      = document.getElementById("reset-btn");
  const idleHint      = document.getElementById("idle-hint");

  const phaseIdle     = document.getElementById("phase-idle");
  const phaseQuestion = document.getElementById("phase-question");
  const phaseResult   = document.getElementById("phase-result");
  const phaseGameover = document.getElementById("phase-gameover");

  const stopWrap = document.getElementById("stop-wrap");
  const stopBtn  = document.getElementById("stop-btn");

  const qCounter      = document.getElementById("q-counter");
  const timerNum      = document.getElementById("timer-num");
  const timerArc      = document.getElementById("timer-arc");
  const questionText  = document.getElementById("question-text");
  const optionsGrid   = document.getElementById("options-grid");
  const answeredHint  = document.getElementById("answered-hint");

  const resultCard    = document.getElementById("result-card");
  const resultAnswer  = document.getElementById("result-answer");
  const resultExpl    = document.getElementById("result-explanation");

  const winnerLine    = document.getElementById("winner-line");

  const scoreboard    = document.getElementById("scoreboard");
  const scoreList     = document.getElementById("score-list");

  const chatMessages  = document.getElementById("chat-messages");
  const chatForm      = document.getElementById("chat-form");
  const chatInput     = document.getElementById("chat-input");
  const chatSend      = document.getElementById("chat-send");
  const onlineCount   = document.getElementById("online-count");

  // ── Состояние ────────────────────────────────────────────────────────────
  let myName       = null;
  let myId         = null;
  let myAnswered   = false;
  let currentPhase = "idle"; // "idle"|"question"|"result"|"gameover"

  const socket = io();

  // ─────────────────────────────────────────────────────────────────────────
  //  JOIN
  // ─────────────────────────────────────────────────────────────────────────

  joinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = playerNameInput.value.trim();
    if (!name) return;
    socket.emit("join", name);
  });

  socket.on("joined", (data) => {
    myId   = data.id;
    myName = data.name;

    joinModal.hidden = true;
    enableChat();

    renderPlayers(data.players);
    applyState(data.state);

    if (data.canStart) startBtn.disabled = false;

    if (data.currentQuestion) {
      showPhase("question");
      renderQuestion(data.currentQuestion);
      updateTimer(data.currentQuestion.secondsLeft);
    }
  });

  socket.on("error_msg", (msg) => {
    joinError.textContent = msg;
    joinError.hidden = false;
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  Игроки
  // ─────────────────────────────────────────────────────────────────────────

  socket.on("player_joined", ({ name }) => {
    addSystemMsg(`${escHtml(name)} присоединился к игре`);
  });

  socket.on("player_left", ({ name }) => {
    addSystemMsg(`${escHtml(name)} покинул игру`);
  });

  socket.on("player_list", (players) => {
    renderPlayers(players);
  });

  socket.on("can_start", (ok) => {
    startBtn.disabled = !ok;
    if (currentPhase === "idle") {
      idleHint.textContent = ok
        ? "Можно начинать игру!"
        : "Ожидаем игроков…";
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  Управление игрой
  // ─────────────────────────────────────────────────────────────────────────

  startBtn.addEventListener("click", () => socket.emit("start_game"));
  stopBtn.addEventListener("click",  () => socket.emit("stop_game"));
  resetBtn.addEventListener("click", () => socket.emit("reset_game"));

  // ─────────────────────────────────────────────────────────────────────────
  //  Игровые события
  // ─────────────────────────────────────────────────────────────────────────

  socket.on("new_round", (n) => {
    addSystemMsg(`Круг ${n - 1} завершён — начинается круг ${n}!`);
  });

  socket.on("question", (q) => {
    myAnswered = false;
    showPhase("question");
    renderQuestion(q);
    setBadge("question");
  });

  socket.on("timer", (sec) => updateTimer(sec));

  socket.on("answer_ack", ({ alreadyAnswered, correct, letter }) => {
    if (alreadyAnswered) return;

    myAnswered = true;
    answeredHint.hidden = false;

    // Подсветить выбранный вариант
    document.querySelectorAll(".opt-btn").forEach((btn) => {
      btn.disabled = true;
      if (btn.dataset.letter === letter) {
        btn.classList.add(correct ? "opt-correct" : "opt-wrong");
      }
    });
  });

  socket.on("question_result", (data) => {
    showPhase("result");
    setBadge("result");

    const correct  = data.correctLetter;
    const isGood   = myAnswered; // ответил ли вообще (оценим по opt-correct/wrong)

    // Проверим, был ли мой ответ правильным через цвет кнопки
    const myBtn = document.querySelector(".opt-btn.opt-correct, .opt-btn.opt-wrong");
    const iGotRight = myBtn && myBtn.classList.contains("opt-correct");

    resultAnswer.innerHTML =
      `Правильный ответ: <strong class="answer-letter">${escHtml(correct)}</strong> — ` +
      `<strong>${escHtml(data.correctText)}</strong>`;
    resultExpl.textContent = data.explanation;

    if (!myAnswered) {
      resultCard.classList.remove("result-ok", "result-fail");
      resultCard.classList.add("result-neutral");
    } else if (iGotRight) {
      resultCard.classList.remove("result-neutral", "result-fail");
      resultCard.classList.add("result-ok");
    } else {
      resultCard.classList.remove("result-neutral", "result-ok");
      resultCard.classList.add("result-fail");
    }

    renderScores(data.scores);
  });

  socket.on("game_over", (data) => {
    showPhase("gameover");
    setBadge("gameover");

    winnerLine.textContent = data.winner
      ? `Победитель: ${data.winner} 🏆`
      : "Никто не набрал очков.";

    renderScores(data.scores);
  });

  socket.on("game_reset", () => {
    myAnswered = false;
    showPhase("idle");
    setBadge("idle");
    idleHint.textContent = "Ожидаем игроков…";
    startBtn.disabled = true;
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  Ответы на вопрос через кнопки
  // ─────────────────────────────────────────────────────────────────────────

  optionsGrid.addEventListener("click", (e) => {
    const btn = e.target.closest(".opt-btn");
    if (!btn || btn.disabled) return;
    socket.emit("answer", btn.dataset.letter);
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  Чат
  // ─────────────────────────────────────────────────────────────────────────

  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    socket.emit("chat", text);
    chatInput.value = "";
  });

  socket.on("chat_msg", ({ name, text }) => {
    addChatMsg(name, text, name === myName ? "mine" : "other");
  });

  socket.on("system_msg", ({ text }) => {
    addSystemMsg(text);
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  Вспомогательные функции рендеринга
  // ─────────────────────────────────────────────────────────────────────────

  function showPhase(phase) {
    currentPhase = phase;
    phaseIdle.hidden     = phase !== "idle";
    phaseQuestion.hidden = phase !== "question";
    phaseResult.hidden   = phase !== "result";
    phaseGameover.hidden = phase !== "gameover";

    // Кнопка «Завершить» видна только во время игры
    stopWrap.hidden = phase === "idle" || phase === "gameover";

    scoreboard.hidden = (phase === "idle" && scoreList.children.length === 0);
  }

  function applyState(state) {
    const map = { idle: "idle", question: "question", result: "result", gameover: "gameover" };
    showPhase(map[state] || "idle");
    setBadge(state);
  }

  const BADGE_LABELS = {
    idle:     "Ожидание",
    question: "Вопрос",
    result:   "Результат",
    gameover: "Игра окончена",
  };

  function setBadge(state) {
    stateBadge.textContent = BADGE_LABELS[state] || state;
    stateBadge.className   = `badge badge-${state}`;
  }

  function renderQuestion(q) {
    qCounter.textContent = `Вопрос ${q.index} / ${q.total}`;
    questionText.textContent = q.text;

    document.querySelectorAll(".opt-btn").forEach((btn) => {
      const l = btn.dataset.letter;
      btn.querySelector(".opt-text").textContent = q.options[l];
      btn.disabled = false;
      btn.className = "opt-btn";
    });

    answeredHint.hidden = true;
    resultCard.className = "result-card";
  }

  /** Обновляет таймер (числовой + SVG-дуга). */
  function updateTimer(sec) {
    const s = Math.max(sec, 0);
    timerNum.textContent = s;

    // Длина окружности ≈ 2π·18 ≈ 113.1
    const CIRC = 113.1;
    const frac = s / QUESTION_TIME;
    timerArc.style.strokeDashoffset = String(CIRC * (1 - frac));

    // Цвет при ≤ 5 секунд
    timerArc.classList.toggle("timer-urgent", s <= 5);
  }

  const MEDAL = ["🥇", "🥈", "🥉"];

  function renderScores(scores) {
    if (!scores || scores.length === 0) { scoreboard.hidden = true; return; }
    scoreboard.hidden = false;
    scoreList.innerHTML = scores
      .map((p, i) =>
        `<li class="score-item ${myId && p.id === myId ? "score-me" : ""}">
          <span class="score-rank">${MEDAL[i] || (i + 1) + "."}</span>
          <span class="score-name">${escHtml(p.name)}</span>
          <span class="score-pts">${p.score.toLocaleString("ru")}</span>
        </li>`
      )
      .join("");
  }

  function renderPlayers(players) {
    onlineCount.textContent = `${players.length} онлайн`;
    renderScores(players);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Сообщения чата
  // ─────────────────────────────────────────────────────────────────────────

  function addChatMsg(name, text, cls) {
    const el = document.createElement("div");
    el.className = `chat-message ${cls}`;
    el.innerHTML =
      `<span class="msg-name">${escHtml(name)}</span>` +
      `<span class="msg-text">${escHtml(text)}</span>`;
    appendAndScroll(el);
  }

  function addSystemMsg(text) {
    const el = document.createElement("div");
    el.className = "chat-message system";
    el.innerHTML = `<span class="msg-text">${escHtml(text)}</span>`;
    appendAndScroll(el);
  }

  function appendAndScroll(el) {
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function enableChat() {
    chatInput.disabled = false;
    chatSend.disabled  = false;
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }
})();
