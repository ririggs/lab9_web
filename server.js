"use strict";

/**
 * server.js — точка входа чат-игры «Викторина».
 * Express раздаёт статику и EJS-шаблоны,
 * Socket.IO обеспечивает WebSocket-взаимодействие с игровой логикой.
 */

const http    = require("http");
const path    = require("path");
const express = require("express");
const { Server } = require("socket.io");

const game = require("./game");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// ─── Express ────────────────────────────────────────────────────────────────

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => res.render("index", { title: "Викторина" }));
app.get("/chat", (_req, res) => res.render("chat",  { title: "Викторина" }));

app.use((_req, res) => res.status(404).render("404", { title: "Страница не найдена" }));

app.use((err, _req, res, _next) => {
  console.error("[server] Ошибка:", err);
  res.status(500).render("404", { title: "Внутренняя ошибка сервера" });
});

// ─── Socket.IO — обработка подключений ──────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`[ws] connect   ${socket.id}`);

  // ── join ──────────────────────────────────────────────────────────────────
  socket.on("join", (rawName) => {
    if (socket.data.name) return;

    const name = String(rawName || "").trim().slice(0, 32);
    if (!name) {
      socket.emit("error_msg", "Имя не может быть пустым.");
      return;
    }

    const player = game.addPlayer(socket.id, name);
    socket.data.name = player.name;

    socket.emit("joined", {
      id:              socket.id,
      name:            player.name,
      players:         game.getPlayerList(),
      state:           game.state,
      canStart:        game.canStart(),
      currentQuestion: game.getCurrentQuestionForLateJoin(),
    });

    socket.broadcast.emit("player_joined", { name: player.name });
    io.emit("player_list", game.getPlayerList());
    io.emit("system_msg",  { text: `${player.name} присоединился к игре` });

    console.log(`[ws] joined    ${socket.id} as "${name}"`);
  });

  // ── answer ────────────────────────────────────────────────────────────────
  socket.on("answer", (letter) => {
    if (!socket.data.name) return;

    const l = String(letter || "").toUpperCase();
    if (!["A", "B", "C", "D"].includes(l)) return;

    const result = game.submitAnswer(socket.id, l);
    if (!result) return;

    socket.emit("answer_ack", result);

    if (!result.alreadyAnswered) {
      io.emit("player_list", game.getPlayerList());
    }
  });

  // ── chat ──────────────────────────────────────────────────────────────────
  socket.on("chat", (text) => {
    if (!socket.data.name) return;

    const msg = String(text || "").trim().slice(0, 500);
    if (!msg) return;

    io.emit("chat_msg", {
      name: socket.data.name,
      text: msg,
      ts:   Date.now(),
    });
  });

  // ── start_game ────────────────────────────────────────────────────────────
  socket.on("start_game", () => {
    if (!socket.data.name) return;
    if (!game.canStart()) {
      socket.emit("error_msg", "Нельзя начать игру в текущем состоянии.");
      return;
    }
    io.emit("system_msg", { text: `${socket.data.name} запустил игру!` });
    game.startGame();
  });

  // ── stop_game ─────────────────────────────────────────────────────────────
  socket.on("stop_game", () => {
    if (!socket.data.name) return;
    if (game.state === "idle" || game.state === "gameover") return;
    io.emit("system_msg", { text: `${socket.data.name} завершил игру.` });
    game.stopGame();
  });

  // ── reset_game ────────────────────────────────────────────────────────────
  socket.on("reset_game", () => {
    if (!socket.data.name || game.state !== "gameover") return;
    io.emit("system_msg", { text: `${socket.data.name} начинает новую игру…` });
    game.resetGame();
  });

  // ── disconnect ────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const name = socket.data.name;
    console.log(`[ws] disconnect ${socket.id}${name ? ` ("${name}")` : ""}`);

    if (name) {
      game.removePlayer(socket.id);
      io.emit("player_left", { name });
      io.emit("player_list",  game.getPlayerList());
      io.emit("system_msg",   { text: `${name} покинул игру` });
    }
  });
});

// ─── Проброс событий игры → всем клиентам ───────────────────────────────────

game.on("question",        (data) => io.emit("question",        data));
game.on("timer",           (sec)  => io.emit("timer",           sec));
game.on("question_result", (data) => io.emit("question_result", data));
game.on("new_round",       (n)    => io.emit("new_round",       n));
game.on("game_over",       (data) => io.emit("game_over",       data));
game.on("game_reset",      ()     => {
  io.emit("game_reset");
  io.emit("can_start",   game.canStart());
  io.emit("player_list", game.getPlayerList());
});
game.on("can_start", (v) => io.emit("can_start", v));

// ─── Запуск ──────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3000;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Викторина: http://localhost:${PORT}/`);
    console.log(`Игра:      http://localhost:${PORT}/chat`);
  });
}

module.exports = { app, server };
