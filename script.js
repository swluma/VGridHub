const gameSites = [
  "https://swluma.github.io/RiverBed"
];

const HUB_SERVER_URL = "https://vgridhub.onrender.com";
const HUB_WS_URL = HUB_SERVER_URL.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

const DEFAULT_GAME_META = {
  maxPlayers: 2,
  supportsLocal: true,
  supportsRooms: true,
  roomModes: ["host", "join"]
};

const gamesList = document.getElementById("gamesList");
const playerNameInput = document.getElementById("playerName");
const playModeSelect = document.getElementById("playMode");
const roomCodeInput = document.getElementById("roomCode");
const roomField = document.querySelector(".room-field");
const generateRoomCodeBtn = document.getElementById("generateRoomCodeBtn");

function normalizeRoomCode(value) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

function generateRoomCode(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < length; i += 1) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function updateRoomFieldVisibility() {
  const needsRoom = playModeSelect.value === "host" || playModeSelect.value === "join";
  roomField.classList.toggle("hidden", !needsRoom);

  if (playModeSelect.value === "host" && !roomCodeInput.value.trim()) {
    roomCodeInput.value = generateRoomCode();
  }

  if (!needsRoom) {
    roomCodeInput.value = "";
  }
}

function showMessage(text) {
  gamesList.innerHTML = `<div class="message">${text}</div>`;
}

function buildGameUrl(baseUrl, mode, roomCode, playerName) {
  const url = new URL(baseUrl + "/");
  url.searchParams.set("hub", "1");
  url.searchParams.set("mode", mode);
  url.searchParams.set("server", HUB_SERVER_URL);
  url.searchParams.set("ws", HUB_WS_URL);

  if (playerName) {
    url.searchParams.set("name", playerName);
  }

  if (mode === "host" || mode === "join") {
    url.searchParams.set("room", roomCode);
  }

  return url.toString();
}

function createActionButton(text, onClick, secondary = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = secondary ? "action-button secondary" : "action-button";
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

function createGameCard(game, baseUrl) {
  const meta = {
    ...DEFAULT_GAME_META,
    ...game
  };

  const card = document.createElement("section");
  card.className = "game-card";

  const iconUrl = new URL(meta.icon || "./icon.png", baseUrl + "/").href;

  const actions = document.createElement("div");
  actions.className = "card-actions";

  const localButton = createActionButton("Open in Local Mode", () => {
    window.location.href = buildGameUrl(baseUrl, "local", "", playerNameInput.value.trim());
  }, true);

  const roomButton = createActionButton("Open with Selected Mode", () => {
    const mode = playModeSelect.value;
    const playerName = playerNameInput.value.trim();
    const roomCode = normalizeRoomCode(roomCodeInput.value);

    if (!meta.supportsLocal && mode === "local") {
      alert("This game does not support local play.");
      return;
    }

    if (!meta.supportsRooms && (mode === "host" || mode === "join")) {
      alert("This game does not support room play.");
      return;
    }

    if ((mode === "host" || mode === "join") && !roomCode) {
      alert("Please enter a room code.");
      roomCodeInput.focus();
      return;
    }

    if (!playerName) {
      alert("Please enter a player name.");
      playerNameInput.focus();
      return;
    }

    window.location.href = buildGameUrl(baseUrl, mode, roomCode, playerName);
  });

  if (meta.supportsLocal) {
    actions.appendChild(localButton);
  }

  actions.appendChild(roomButton);

  const roomSupportText = meta.supportsRooms
    ? `Room support / up to ${meta.maxPlayers} players`
    : "No room support";

  card.innerHTML = `
    <img class="game-icon" src="${iconUrl}" alt="${meta.title} icon">
    <div class="game-content">
      <h2 class="game-title">${meta.title}</h2>
      <p class="game-description">${meta.description || ""}</p>
      <p class="game-meta">${roomSupportText}</p>
    </div>
  `;

  card.querySelector(".game-content").appendChild(actions);

  return card;
}

async function fetchGameMeta(baseUrl) {
  const response = await fetch(`${baseUrl}/game.json`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load ${baseUrl}/game.json`);
  }
  return response.json();
}

async function loadGames() {
  gamesList.innerHTML = "";
  let loadedCount = 0;

  for (const baseUrl of gameSites) {
    try {
      const game = await fetchGameMeta(baseUrl);
      const card = createGameCard(game, baseUrl);
      gamesList.appendChild(card);
      loadedCount += 1;
    } catch (error) {
      console.error(error);
    }
  }

  if (loadedCount === 0) {
    showMessage("Could not load games.");
  }
}

playModeSelect.addEventListener("change", updateRoomFieldVisibility);
roomCodeInput.addEventListener("input", () => {
  roomCodeInput.value = normalizeRoomCode(roomCodeInput.value);
});
generateRoomCodeBtn.addEventListener("click", () => {
  roomCodeInput.value = generateRoomCode();
});

updateRoomFieldVisibility();
loadGames();
