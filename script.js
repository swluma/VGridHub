const gameSites = [
  "https://swluma.github.io/RiverBed"
];

const gamesList = document.getElementById("gamesList");

function showMessage(text) {
  gamesList.innerHTML = `<div class="message">${text}</div>`;
}

function createGameCard(game, baseUrl) {
  const card = document.createElement("section");
  card.className = "game-card";

  const iconUrl = new URL(game.icon || "./icon.png", baseUrl + "/").href;
  const playUrl = new URL(game.playUrl || "./", baseUrl + "/").href;

  card.innerHTML = `
    <img class="game-icon" src="${iconUrl}" alt="${game.title} icon">
    <div class="game-content">
      <h2 class="game-title">${game.title}</h2>
      <p class="game-description">${game.description || ""}</p>
      <a class="game-link" href="${playUrl}">開く</a>
    </div>
  `;

  return card;
}

async function loadGames() {
  gamesList.innerHTML = "";

  let loadedCount = 0;

  for (const baseUrl of gameSites) {
    try {
      const response = await fetch(`${baseUrl}/game.json`, { cache: "no-store" });
      if (!response.ok) {
        continue;
      }

      const game = await response.json();
      const card = createGameCard(game, baseUrl);
      gamesList.appendChild(card);
      loadedCount++;
    } catch (error) {
      console.error("Failed to load game:", baseUrl, error);
    }
  }

  if (loadedCount === 0) {
    showMessage("ゲームを読み込めませんでした。");
  }
}

loadGames();