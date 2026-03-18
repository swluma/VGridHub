const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocket, WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const ROOT_DIR = __dirname;
const MAX_PLAYERS_PER_ROOM = 2;
const ROOM_CODE_PATTERN = /^[A-Z0-9]{4,12}$/;
const CLIENT_ROOM_EVENTS = Object.freeze({
  JOIN_ROOM: "join_room",
  LEAVE_ROOM: "leave_room",
  PLAYER_READY: "player_ready",
  START_GAME: "start_game",
  GAME_ACTION: "game_action",
  SYNC_REQUEST: "sync_request",
  HEARTBEAT: "heartbeat"
});
const SERVER_ROOM_EVENTS = Object.freeze({
  ROOM_JOINED: "room_joined",
  ROOM_STATE: "room_state",
  PLAYER_JOINED: "player_joined",
  PLAYER_LEFT: "player_left",
  PLAYER_READY: "player_ready",
  GAME_STARTED: "game_started",
  GAME_ACTION: "game_action",
  SYNC_STATE: "sync_state",
  ERROR: "error",
  ROOM_CLOSED: "room_closed"
});
const CLIENT_EVENT_ALIASES = Object.freeze({
  joinroom: CLIENT_ROOM_EVENTS.JOIN_ROOM,
  join_room: CLIENT_ROOM_EVENTS.JOIN_ROOM,
  "join-room": CLIENT_ROOM_EVENTS.JOIN_ROOM,
  leaveroom: CLIENT_ROOM_EVENTS.LEAVE_ROOM,
  leave_room: CLIENT_ROOM_EVENTS.LEAVE_ROOM,
  "leave-room": CLIENT_ROOM_EVENTS.LEAVE_ROOM,
  playerready: CLIENT_ROOM_EVENTS.PLAYER_READY,
  player_ready: CLIENT_ROOM_EVENTS.PLAYER_READY,
  "player-ready": CLIENT_ROOM_EVENTS.PLAYER_READY,
  startgame: CLIENT_ROOM_EVENTS.START_GAME,
  start_game: CLIENT_ROOM_EVENTS.START_GAME,
  "start-game": CLIENT_ROOM_EVENTS.START_GAME,
  gameaction: CLIENT_ROOM_EVENTS.GAME_ACTION,
  game_action: CLIENT_ROOM_EVENTS.GAME_ACTION,
  "game-action": CLIENT_ROOM_EVENTS.GAME_ACTION,
  syncrequest: CLIENT_ROOM_EVENTS.SYNC_REQUEST,
  sync_request: CLIENT_ROOM_EVENTS.SYNC_REQUEST,
  "sync-request": CLIENT_ROOM_EVENTS.SYNC_REQUEST,
  heartbeat: CLIENT_ROOM_EVENTS.HEARTBEAT
});

const rooms = new Map();

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webp": "image/webp"
};

function getSafePath(urlPath) {
  const normalizedPath = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[\\/])+/, "");
  return path.join(ROOT_DIR, normalizedPath);
}

function sendResponse(res, statusCode, headers, body) {
  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendSocketMessage(socket, type, payload) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify({ type, payload }));
}

function clonePlayer(player) {
  return {
    id: player.id,
    name: player.name,
    ready: !!player.ready
  };
}

function createRoomSnapshot(room) {
  return {
    roomCode: room.roomCode,
    phase: room.phase,
    hostId: room.hostId,
    players: room.players.map(clonePlayer),
    startedAt: room.startedAt
  };
}

function broadcastRoom(room, type, payload) {
  for (const player of room.players) {
    sendSocketMessage(player.socket, type, payload);
  }
}

function broadcastRoomState(room) {
  broadcastRoom(room, SERVER_ROOM_EVENTS.ROOM_STATE, {
    room: createRoomSnapshot(room)
  });
}

function sendRoomError(socket, code, message, recoverable = true) {
  sendSocketMessage(socket, SERVER_ROOM_EVENTS.ERROR, { code, message, recoverable });
}

function normalizeRoomCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

function normalizePlayerName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 24);
}

function normalizeEventName(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const compact = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();

  return CLIENT_EVENT_ALIASES[compact] || compact;
}

function normalizeIncomingMessage(message) {
  if (!message || typeof message !== "object") {
    return null;
  }

  const type = normalizeEventName(
    message.type
    || message.event
    || message.kind
    || message.action
    || message.op
  );

  return {
    type,
    payload: message.payload ?? message.data ?? message.body ?? {}
  };
}

function getPlayerBySocket(socket) {
  for (const room of rooms.values()) {
    const player = room.players.find((entry) => entry.socket === socket);
    if (player) {
      return { room, player };
    }
  }
  return null;
}

function closeRoom(room, message) {
  broadcastRoom(room, SERVER_ROOM_EVENTS.ROOM_CLOSED, {
    roomCode: room.roomCode,
    message
  });
  rooms.delete(room.roomCode);
}

function removePlayerFromRoom(room, playerId) {
  const index = room.players.findIndex((player) => player.id === playerId);
  if (index === -1) {
    return;
  }

  const [removed] = room.players.splice(index, 1);
  if (removed?.socket) {
    removed.socket.roomCode = null;
    removed.socket.playerId = null;
  }

  if (room.players.length === 0) {
    rooms.delete(room.roomCode);
    return;
  }

  if (room.hostId === playerId) {
    closeRoom(room, "The host left the room.");
    return;
  }

  if (room.phase === "playing") {
    room.phase = "waiting";
  }

  broadcastRoom(room, SERVER_ROOM_EVENTS.PLAYER_LEFT, {
    roomCode: room.roomCode,
    playerId
  });
  broadcastRoomState(room);
}

function joinRoom(socket, payload) {
  const roomCode = normalizeRoomCode(payload?.roomCode);
  const playerId = String(payload?.player?.id || "").trim();
  const playerName = normalizePlayerName(payload?.player?.name);
  const mode = String(payload?.mode || "").toLowerCase();

  if (!ROOM_CODE_PATTERN.test(roomCode)) {
    sendRoomError(socket, "INVALID_ROOM_CODE", "Room code must be 4-12 letters or digits.");
    return;
  }

  if (!playerId || !playerName) {
    sendRoomError(socket, "INVALID_PLAYER", "Player id and name are required for room play.");
    return;
  }

  let room = rooms.get(roomCode);
  if (!room) {
    if (mode !== "host") {
      sendRoomError(socket, "ROOM_NOT_FOUND", "That room does not exist yet.");
      return;
    }

    room = {
      roomCode,
      gameId: String(payload?.gameId || ""),
      phase: "waiting",
      hostId: playerId,
      startedAt: null,
      players: [],
      lastAction: null
    };
    rooms.set(roomCode, room);
  }

  const existingPlayer = room.players.find((player) => player.id === playerId);
  if (existingPlayer) {
    existingPlayer.socket = socket;
    existingPlayer.name = playerName;
  } else {
    if (room.players.length >= MAX_PLAYERS_PER_ROOM) {
      sendRoomError(socket, "ROOM_FULL", "This room is already full.");
      return;
    }

    if (mode === "host" && room.hostId !== playerId) {
      sendRoomError(socket, "HOST_TAKEN", "This room already has a different host.");
      return;
    }

    room.players.push({
      id: playerId,
      name: playerName,
      ready: mode === "host",
      socket,
      lastHeartbeatAt: Date.now()
    });
  }

  if (mode === "host") {
    room.hostId = playerId;
  }

  socket.roomCode = roomCode;
  socket.playerId = playerId;

  sendSocketMessage(socket, SERVER_ROOM_EVENTS.ROOM_JOINED, {
    roomCode,
    playerId,
    room: createRoomSnapshot(room)
  });

  broadcastRoom(room, SERVER_ROOM_EVENTS.PLAYER_JOINED, {
    roomCode,
    player: {
      id: playerId,
      name: playerName,
      ready: room.players.find((player) => player.id === playerId)?.ready || false
    }
  });
  broadcastRoomState(room);
}

function handlePlayerReady(socket, payload) {
  const match = getPlayerBySocket(socket);
  if (!match) {
    sendRoomError(socket, "NOT_IN_ROOM", "Join a room before marking ready.");
    return;
  }

  const { room, player } = match;
  player.ready = !!payload?.ready;
  player.lastHeartbeatAt = Date.now();

  broadcastRoom(room, SERVER_ROOM_EVENTS.PLAYER_READY, {
    roomCode: room.roomCode,
    playerId: player.id,
    playerName: player.name,
    ready: player.ready
  });
  broadcastRoomState(room);
}

function handleStartGame(socket, payload) {
  const match = getPlayerBySocket(socket);
  if (!match) {
    sendRoomError(socket, "NOT_IN_ROOM", "Join a room before starting a game.");
    return;
  }

  const { room, player } = match;
  if (player.id !== room.hostId) {
    sendRoomError(socket, "HOST_ONLY", "Only the host can start the match.");
    return;
  }

  if (room.players.length !== MAX_PLAYERS_PER_ROOM) {
    sendRoomError(socket, "NOT_ENOUGH_PLAYERS", "Two players are required to start.");
    return;
  }

  if (room.players.some((entry) => !entry.ready)) {
    sendRoomError(socket, "PLAYERS_NOT_READY", "Both players must be ready before starting.");
    return;
  }

  room.phase = "playing";
  room.startedAt = Date.now();
  room.lastAction = null;

  const startPayload = {
    roomCode: room.roomCode,
    startedAt: room.startedAt,
    startedBy: player.id,
    phase: room.phase,
    seed: Number(payload?.seed) || room.startedAt
  };

  broadcastRoom(room, SERVER_ROOM_EVENTS.GAME_STARTED, startPayload);
  broadcastRoomState(room);
}

function handleGameAction(socket, payload) {
  const match = getPlayerBySocket(socket);
  if (!match) {
    sendRoomError(socket, "NOT_IN_ROOM", "Join a room before sending game actions.");
    return;
  }

  const { room, player } = match;
  const action = payload?.action;
  if (!action || typeof action.type !== "string") {
    sendRoomError(socket, "INVALID_ACTION", "A valid game action payload is required.");
    return;
  }

  room.lastAction = action;
  broadcastRoom(room, SERVER_ROOM_EVENTS.GAME_ACTION, {
    roomCode: room.roomCode,
    action,
    fromPlayerId: player.id
  });
}

function handleSyncRequest(socket) {
  const match = getPlayerBySocket(socket);
  if (!match) {
    sendRoomError(socket, "NOT_IN_ROOM", "Join a room before requesting sync.");
    return;
  }

  const { room } = match;
  sendSocketMessage(socket, SERVER_ROOM_EVENTS.SYNC_STATE, {
    roomCode: room.roomCode,
    room: createRoomSnapshot(room),
    lastAction: room.lastAction
  });
}

function handleHeartbeat(socket) {
  const match = getPlayerBySocket(socket);
  if (!match) {
    return;
  }
  match.player.lastHeartbeatAt = Date.now();
}

function serveFile(filePath, res) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      if (error.code === "ENOENT") {
        sendResponse(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
        return;
      }

      console.error(error);
      sendResponse(res, 500, { "Content-Type": "text/plain; charset=utf-8" }, "Internal server error");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] || "application/octet-stream";
    sendResponse(res, 200, { "Content-Type": contentType }, data);
  });
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    sendResponse(res, 400, { "Content-Type": "text/plain; charset=utf-8" }, "Bad request");
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (requestUrl.pathname === "/healthz") {
    sendResponse(res, 200, { "Content-Type": "application/json; charset=utf-8" }, JSON.stringify({ ok: true }));
    return;
  }

  const relativePath = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
  const filePath = getSafePath(relativePath);

  if (!filePath.startsWith(ROOT_DIR)) {
    sendResponse(res, 403, { "Content-Type": "text/plain; charset=utf-8" }, "Forbidden");
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (!error && stats.isDirectory()) {
      serveFile(path.join(filePath, "index.html"), res);
      return;
    }

    serveFile(filePath, res);
  });
});

const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
  socket.roomCode = null;
  socket.playerId = null;

  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      sendRoomError(socket, "BAD_MESSAGE", "Received invalid JSON.");
      return;
    }

    const normalizedMessage = normalizeIncomingMessage(message);
    if (!normalizedMessage) {
      sendRoomError(socket, "BAD_MESSAGE", "Received invalid message payload.");
      return;
    }

    const { type, payload } = normalizedMessage;
    if (!type) {
      return;
    }

    switch (type) {
      case CLIENT_ROOM_EVENTS.JOIN_ROOM:
        joinRoom(socket, payload);
        break;
      case CLIENT_ROOM_EVENTS.LEAVE_ROOM: {
        const roomCode = normalizeRoomCode(payload?.roomCode || socket.roomCode);
        const room = rooms.get(roomCode);
        if (room) {
          removePlayerFromRoom(room, String(payload?.playerId || socket.playerId || ""));
        }
        break;
      }
      case CLIENT_ROOM_EVENTS.PLAYER_READY:
        handlePlayerReady(socket, payload);
        break;
      case CLIENT_ROOM_EVENTS.START_GAME:
        handleStartGame(socket, payload);
        break;
      case CLIENT_ROOM_EVENTS.GAME_ACTION:
        handleGameAction(socket, payload);
        break;
      case CLIENT_ROOM_EVENTS.SYNC_REQUEST:
        handleSyncRequest(socket);
        break;
      case CLIENT_ROOM_EVENTS.HEARTBEAT:
        handleHeartbeat(socket);
        break;
      default:
        sendRoomError(socket, "UNKNOWN_EVENT", `Unsupported event "${String(type || "")}".`);
        break;
    }
  });

  socket.on("close", () => {
    if (!socket.roomCode || !socket.playerId) {
      return;
    }

    const room = rooms.get(socket.roomCode);
    if (room) {
      removePlayerFromRoom(room, socket.playerId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
