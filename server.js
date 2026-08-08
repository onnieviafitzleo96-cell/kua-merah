const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));

const BOT_NAMES = ['Ahmad', 'Siti', 'Boon', 'Mei', 'Devi', 'Raju', 'Ken', 'Sarah', 'Farid', 'Lisa'];

let humanName = 'Player 1';
let playerNames = [humanName, 'Bot 1', 'Bot 2', 'Bot 3'];
let balances = [10.00, 10.00, 10.00, 10.00];
let lastWinnerIdx = 0;
let roomInitialized = false;
let currentRoomTier = 10.00;

let gameState = {
  deck: [],
  hands: [[], [], [], []],
  discardPile: [],
  turn: 0,
  winner: null,
  status: 'Select a room tier to begin.',
  actionLog: '',
  playerNames: playerNames,
  balances: balances,
  gameEnded: false,
  revealStage: 0,
  isDealing: false,
  roomTier: 10.00
};

function assignBotNames() {
  if (!roomInitialized) {
    let shuffled = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    playerNames = [humanName, shuffled[0], shuffled[1], shuffled[2]];
    gameState.playerNames = playerNames;
    roomInitialized = true;
  }
}

function createDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const values = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  let deck = [];
  for (let s of suits) {
    for (let v of values) {
      let isRed = (s === '♥' || s === '♦');
      let pts = 0;
      if (isRed) {
        if (['J','Q','K'].includes(v)) pts = 2;
        else if (v === 'A') pts = 1;
        else pts = parseInt(v);
      }
      let rotation = (Math.random() * 30 - 15).toFixed(1);
      deck.push({ suit: s, value: v, isRed: isRed, points: pts, rotation: rotation, id: v + s });
    }
  }
  return deck.sort(() => Math.random() - 0.5);
}

function autoSortHand(hand) {
  const rankOrder = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};
  let counts = {};
  for (let c of hand) counts[c.value] = (counts[c.value] || 0) + 1;

  return hand.sort((a, b) => {
    let countA = counts[a.value];
    let countB = counts[b.value];
    let isPairA = countA >= 2 ? 1 : 0;
    let isPairB = countB >= 2 ? 1 : 0;

    if (isPairA !== isPairB) return isPairB - isPairA;
    if (rankOrder[a.value] !== rankOrder[b.value]) return rankOrder[a.value] - rankOrder[b.value];
    return a.suit.localeCompare(b.suit);
  });
}

function checkFourPairs(hand) {
  if (hand.length !== 8) return false;
  let counts = {};
  for (let c of hand) counts[c.value] = (counts[c.value] || 0) + 1;
  let pairs = 0;
  for (let val in counts) {
    if (counts[val] === 2) pairs++;
    if (counts[val] === 4) pairs += 2;
  }
  return pairs === 4;
}

function isPointSwappingCheating(hand, topDiscardCard) {
  if (!topDiscardCard) return false;
  let countInHand = hand.filter(c => c.value === topDiscardCard.value).length;
  return countInHand >= 2;
}

function calculatePayout(winningHand, isInstantWin) {
  if (isInstantWin) return 50;
  let redCount = winningHand.filter(c => c.isRed).length;
  let faceCount = winningHand.filter(c => ['J','Q','K'].includes(c.value)).length;
  let hasRedAce = winningHand.some(c => c.isRed && c.value === 'A');

  if (redCount === 0 || (redCount === 1 && hasRedAce) || faceCount === 8) {
    return 50;
  }
  return winningHand.reduce((sum, c) => sum + c.points, 0);
}

function checkForOutOfTurnInterception(discarderIdx, discardedCard) {
  let waitingWinners = [];

  for (let i = 0; i < 4; i++) {
    if (i === discarderIdx) continue;
    let testHand = [...gameState.hands[i], discardedCard];
    if (checkFourPairs(testHand)) {
      waitingWinners.push(i);
    }
  }

  if (waitingWinners.length > 0) {
    waitingWinners.sort((a, b) => {
      let distA = (a - discarderIdx + 4) % 4;
      let distB = (b - discarderIdx + 4) % 4;
      return distA - distB;
    });

    let winnerIdx = waitingWinners[0];
    let stolenCard = gameState.discardPile.pop();
    gameState.hands[winnerIdx].push(stolenCard);
    autoSortHand(gameState.hands[winnerIdx]);

    io.emit('animateCard', { source: 'discard', targetPlayer: winnerIdx });
    gameState.actionLog = `⚡ ${playerNames[winnerIdx]} STOLE ${stolenCard.value}${stolenCard.suit} out of turn to WIN!`;
    io.emit('cardSound');
    io.emit('stateUpdate', gameState);

    declareWin(winnerIdx, false);
    return true;
  }

  return false;
}

function dealCardsOneByOne(starterIdx, callback) {
  gameState.isDealing = true;
  let totalCardsToDeal = 29;
  let dealtCount = 0;
  let pIdx = starterIdx;

  let dealInterval = setInterval(() => {
    if (gameState.deck.length === 0 || dealtCount >= totalCardsToDeal) {
      gameState.isDealing = false;
      clearInterval(dealInterval);
      callback();
      return;
    }

    let targetCount = (pIdx === starterIdx) ? 8 : 7;
    if (gameState.hands[pIdx].length < targetCount) {
      gameState.hands[pIdx].push(gameState.deck.pop());
      autoSortHand(gameState.hands[pIdx]);
      io.emit('cardSound');
      io.emit('stateUpdate', gameState);
      dealtCount++;
    }

    pIdx = (pIdx + 1) % 4;
  }, 180);
}

function runBotTurn(isInitialDiscard = false) {
  if (gameState.gameEnded || gameState.turn === 0) return;

  let currentBot = gameState.turn;
  let botHand = gameState.hands[currentBot];

  setTimeout(() => {
    if (gameState.gameEnded) return;

    let tookDiscard = false;

    if (!isInitialDiscard && botHand.length === 7) {
      if (gameState.discardPile.length > 0) {
        let topDiscard = gameState.discardPile[gameState.discardPile.length - 1];
        let testHand = [...botHand, topDiscard];

        if (checkFourPairs(testHand)) {
          botHand.push(gameState.discardPile.pop());
          autoSortHand(botHand);
          tookDiscard = true;

          io.emit('animateCard', { source: 'discard', targetPlayer: currentBot });
          gameState.actionLog = `🎴 ${playerNames[currentBot]} took the DISCARD card to WIN!`;
          io.emit('cardSound');
          io.emit('stateUpdate', gameState);

          setTimeout(() => declareWin(currentBot, false), 1500);
          return;
        }

        let isCheating = isPointSwappingCheating(botHand, topDiscard);
        let hasSingleMatchingCard = botHand.some(c => {
          let count = botHand.filter(x => x.value === c.value).length;
          return c.value === topDiscard.value && count === 1;
        });

        if (hasSingleMatchingCard && !isCheating) {
          botHand.push(gameState.discardPile.pop());
          autoSortHand(botHand);
          tookDiscard = true;

          io.emit('animateCard', { source: 'discard', targetPlayer: currentBot });
          gameState.actionLog = `🎴 ${playerNames[currentBot]} took ${topDiscard.value}${topDiscard.suit} from DISCARD to form a pair!`;
          io.emit('cardSound');
          io.emit('stateUpdate', gameState);
        }
      }

      if (!tookDiscard) {
        if (gameState.deck.length === 0) {
          endGameNoWinner();
          return;
        }
        botHand.push(gameState.deck.pop());
        autoSortHand(botHand);

        io.emit('animateCard', { source: 'deck', targetPlayer: currentBot });
        gameState.actionLog = `📥 ${playerNames[currentBot]} drew from MIDDLE DECK.`;
        io.emit('cardSound');
        io.emit('stateUpdate', gameState);
      }

      if (checkFourPairs(botHand)) {
        setTimeout(() => declareWin(currentBot, false), 1500);
        return;
      }
    }

    setTimeout(() => {
      if (gameState.gameEnded) return;

      let discardIndex = 0;
      for (let i = 0; i < botHand.length; i++) {
        let count = botHand.filter(c => c.value === botHand[i].value).length;
        if (count === 1 || count === 3) {
          discardIndex = i;
          break;
        }
      }

      let card = botHand.splice(discardIndex, 1)[0];
      gameState.discardPile.push(card);
      autoSortHand(botHand);
      io.emit('cardSound');

      gameState.actionLog = `📤 ${playerNames[currentBot]} discarded ${card.value}${card.suit}.`;

      let intercepted = checkForOutOfTurnInterception(currentBot, card);

      if (!intercepted) {
        gameState.turn = (gameState.turn + 1) % 4;
        gameState.status = `Current Turn: ${playerNames[gameState.turn]}`;
        io.emit('stateUpdate', gameState);

        if (gameState.turn !== 0) {
          runBotTurn(false);
        }
      }
    }, 2000);
  }, isInitialDiscard ? 1000 : 2500);
}

function declareWin(playerIdx, isInstantWin) {
  gameState.winner = playerIdx;
  gameState.gameEnded = true;
  lastWinnerIdx = playerIdx;

  let totalPoints = calculatePayout(gameState.hands[playerIdx], isInstantWin);
  let scale = (currentRoomTier / 10.00);
  let perPlayerCost = (totalPoints * 0.10) * scale;
  let totalWinnings = perPlayerCost * 3;

  for (let i = 0; i < 4; i++) {
    if (i === playerIdx) {
      balances[i] += totalWinnings;
    } else {
      balances[i] -= perPlayerCost;
    }
  }

  gameState.balances = balances;
  gameState.status = `🎉 ${playerNames[playerIdx]} Wins! +$${totalWinnings.toFixed(2)}`;

  gameState.revealStage = 1;
  io.emit('stateUpdate', gameState);

  setTimeout(() => {
    gameState.revealStage = 2;
    io.emit('stateUpdate', gameState);
  }, 2500);
}

function endGameNoWinner() {
  gameState.gameEnded = true;
  gameState.revealStage = 2;
  gameState.actionLog = "Deck empty!";
  gameState.status = "No winner this round. All cards revealed.";
  io.emit('stateUpdate', gameState);
}

io.on('connection', (socket) => {
  socket.on('setPlayerName', (name) => {
    if (name && name.trim().length > 0) {
      humanName = name.trim();
      playerNames[0] = humanName;
      gameState.playerNames = playerNames;
    }
  });

  socket.on('resetRoom', () => {
    roomInitialized = false;
    balances = [10.00, 10.00, 10.00, 10.00];
    lastWinnerIdx = 0;
    assignBotNames();
    gameState.balances = balances;
    gameState.gameEnded = true;
    gameState.status = "Room reset. Back to $10 starter tier.";
    io.emit('stateUpdate', gameState);
  });

  socket.on('setRoomTier', (tierAmount) => {
    currentRoomTier = parseFloat(tierAmount);
    gameState.roomTier = currentRoomTier;
  });

  socket.on('startGame', () => {
    assignBotNames();
    gameState.deck = createDeck();
    gameState.hands = [[], [], [], []];
    gameState.discardPile = [];
    gameState.winner = null;
    gameState.gameEnded = false;
    gameState.revealStage = 0;

    let starterIdx = lastWinnerIdx;
    gameState.turn = starterIdx;
    gameState.actionLog = `$${currentRoomTier} Room - ${playerNames[starterIdx]} starts first!`;
    gameState.status = 'Shuffling & Dealing...';

    dealCardsOneByOne(starterIdx, () => {
      if (checkFourPairs(gameState.hands[starterIdx])) {
        declareWin(starterIdx, true);
        return;
      }

      let starterName = (starterIdx === 0) ? `${humanName}, you hold 8 cards. Discard one to kickstart!` : `${playerNames[starterIdx]} holds 8 cards and starts first.`;
      gameState.actionLog = `Cards dealt! ${starterName}`;
      gameState.status = `Current Turn: ${playerNames[starterIdx]}`;
      io.emit('stateUpdate', gameState);

      if (starterIdx !== 0) {
        runBotTurn(true);
      }
    });
  });

  socket.on('playerDraw', () => {
    if (gameState.turn !== 0 || gameState.hands[0].length >= 8 || gameState.gameEnded || gameState.isDealing) return;
    if (gameState.deck.length > 0) {
      gameState.hands[0].push(gameState.deck.pop());
      autoSortHand(gameState.hands[0]);

      io.emit('animateCard', { source: 'deck', targetPlayer: 0 });
      gameState.actionLog = `📥 ${humanName} drew from MIDDLE DECK.`;
      io.emit('cardSound');

      if (checkFourPairs(gameState.hands[0])) {
        declareWin(0, false);
        return;
      }
    } else {
      endGameNoWinner();
      return;
    }
    io.emit('stateUpdate', gameState);
  });

  socket.on('playerTakeDiscard', () => {
    if (gameState.turn !== 0 || gameState.discardPile.length === 0 || gameState.gameEnded || gameState.isDealing) return;
    let topDiscard = gameState.discardPile[gameState.discardPile.length - 1];

    if (isPointSwappingCheating(gameState.hands[0], topDiscard)) {
      gameState.actionLog = "❌ Illegal Move! You cannot swap discard cards to upgrade existing pairs.";
      io.emit('stateUpdate', gameState);
      return;
    }

    gameState.hands[0].push(gameState.discardPile.pop());
    autoSortHand(gameState.hands[0]);

    io.emit('animateCard', { source: 'discard', targetPlayer: 0 });
    gameState.actionLog = `🎴 ${humanName} took from DISCARD pile!`;
    io.emit('cardSound');

    if (checkFourPairs(gameState.hands[0])) {
      declareWin(0, false);
      return;
    }
    io.emit('stateUpdate', gameState);
  });

  socket.on('discardCard', (cardIndex) => {
    if (gameState.turn !== 0 || gameState.hands[0].length !== 8 || gameState.gameEnded || gameState.isDealing) return;
    let card = gameState.hands[0].splice(cardIndex, 1)[0];
    gameState.discardPile.push(card);
    autoSortHand(gameState.hands[0]);

    gameState.actionLog = `📤 ${humanName} discarded ${card.value}${card.suit}.`;
    io.emit('cardSound');

    let intercepted = checkForOutOfTurnInterception(0, card);

    if (!intercepted) {
      gameState.turn = 1;
      gameState.status = `${playerNames[1]}'s turn...`;
      io.emit('stateUpdate', gameState);
      runBotTurn(false);
    }
  });
});

http.listen(3000, () => {
  console.log('Kua Merah server running on http://localhost:3000');
});