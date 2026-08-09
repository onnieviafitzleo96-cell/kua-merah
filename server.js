const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));

const BOT_NAMES = ['Oliver', 'Emma', 'Liam', 'Charlotte', 'Jack', 'Sophia', 'Henry', 'Amelia', 'James', 'Mia'];

let rooms = {};

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
  if (!hand || hand.length !== 8) return false;
  let counts = {};
  for (let c of hand) counts[c.value] = (counts[c.value] || 0) + 1;
  let pairs = 0;
  for (let val in counts) {
    if (counts[val] === 2) pairs++;
    if (counts[val] === 4) pairs += 2;
  }
  return pairs === 4;
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

function getOrCreateRoom(roomCode, isSolo) {
  if (!rooms[roomCode]) {
    let shuffledBots = [...BOT_NAMES].sort(() => 0.5 - Math.random());
    
    rooms[roomCode] = {
      roomCode: roomCode,
      isSolo: isSolo,
      deck: [],
      hands: [[], [], [], []],
      discardPile: [],
      turn: 0,
      winner: null,
      status: 'Ready to play.',
      actionLog: `Room ${roomCode} ready!`,
      botPool: shuffledBots,
      playerNames: ['Bot 1', 'Bot 2', 'Bot 3', 'Bot 4'],
      isHuman: [false, false, false, false],
      balances: [10.00, 10.00, 10.00, 10.00],
      gameEnded: true,
      revealStage: 0,
      isDealing: false,
      roomTier: 10.00,
      players: [],
      lastWinnerIdx: 0,
      pendingSteal: null,
      takeCooldown: [null, null, null, null],
      hostId: null
    };
  }
  return rooms[roomCode];
}

function updateRoomRoster(room) {
  let names = ['Bot 1', 'Bot 2', 'Bot 3', 'Bot 4'];
  let isHumanFlags = [false, false, false, false];

  room.players.forEach((p) => {
    if (p.seat >= 0 && p.seat < 4) {
      names[p.seat] = p.name;
      isHumanFlags[p.seat] = true;
      room.balances[p.seat] = p.balance;
    }
  });

  for (let i = 0; i < 4; i++) {
    if (!isHumanFlags[i]) {
      names[i] = `${room.botPool[i]} (Bot)`;
    }
  }

  room.playerNames = names;
  room.isHuman = isHumanFlags;
  io.to(room.roomCode).emit('stateUpdate', room);
}

function checkForOutOfTurnInterception(room, discarderIdx, discardedCard) {
  let waitingWinners = [];

  for (let i = 0; i < 4; i++) {
    if (i === discarderIdx) continue;
    let testHand = [...room.hands[i], discardedCard];
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

    let targetWinner = waitingWinners[0];

    if (room.isHuman[targetWinner]) {
      room.pendingSteal = { playerIdx: targetWinner, card: discardedCard };
      io.to(room.roomCode).emit('promptSteal', { playerIdx: targetWinner, card: discardedCard, name: room.playerNames[discarderIdx] });
      return true;
    } else {
      let stolenCard = room.discardPile.pop();
      room.hands[targetWinner].push(stolenCard);
      autoSortHand(room.hands[targetWinner]);

      io.to(room.roomCode).emit('animateCard', { source: 'discard', targetPlayer: targetWinner, card: stolenCard, isPrivate: false });
      room.actionLog = `⚡ ${room.playerNames[targetWinner]} STOLE ${stolenCard.value}${stolenCard.suit} out of turn to WIN!`;
      io.to(room.roomCode).emit('cardSound');
      
      setTimeout(() => io.to(room.roomCode).emit('stateUpdate', room), 600);
      declareWin(room, targetWinner, false);
      return true;
    }
  }

  return false;
}

function dealCardsOneByOne(room, starterIdx, callback) {
  room.isDealing = true;
  let totalCardsToDeal = 29;
  let dealtCount = 0;
  let pIdx = starterIdx;

  let dealInterval = setInterval(() => {
    if (room.deck.length === 0 || dealtCount >= totalCardsToDeal) {
      room.isDealing = false;
      clearInterval(dealInterval);
      callback();
      return;
    }

    let targetCount = (pIdx === starterIdx) ? 8 : 7;
    if (room.hands[pIdx].length < targetCount) {
      let dealtCard = room.deck.pop();
      room.hands[pIdx].push(dealtCard);
      autoSortHand(room.hands[pIdx]);
      io.to(room.roomCode).emit('animateCard', { source: 'deck', targetPlayer: pIdx, card: null, isPrivate: true });
      io.to(room.roomCode).emit('cardSound');
      io.to(room.roomCode).emit('stateUpdate', room);
      dealtCount++;
    }

    pIdx = (pIdx + 1) % 4;
  }, 200);
}

function startRoundLogic(room) {
  if (!room.gameEnded) return;

  updateRoomRoster(room);
  room.deck = createDeck();
  room.hands = [[], [], [], []];
  room.discardPile = [];
  room.winner = null;
  room.gameEnded = false;
  room.revealStage = 0;
  room.pendingSteal = null;
  room.takeCooldown = [null, null, null, null];

  let starterIdx = room.lastWinnerIdx;
  room.turn = starterIdx;
  room.actionLog = `$${room.roomTier} Room - ${room.playerNames[starterIdx]} starts first!`;
  room.status = `Turn: ${room.playerNames[starterIdx]}`;

  dealCardsOneByOne(room, starterIdx, () => {
    if (checkFourPairs(room.hands[starterIdx]) && !room.isHuman[starterIdx]) {
      declareWin(room, starterIdx, true);
      return;
    }

    room.actionLog = `Cards dealt! ${room.playerNames[starterIdx]} starts first with 8 cards.`;
    room.status = `Turn: ${room.playerNames[starterIdx]}`;
    io.to(room.roomCode).emit('stateUpdate', room);

    if (!room.isHuman[starterIdx]) {
      runBotTurn(room, true);
    }
  });
}

function processTurn(room) {
  if (room.gameEnded) return;

  let currentTurnSeat = room.turn;
  room.takeCooldown[currentTurnSeat] = null;
  room.status = `Turn: ${room.playerNames[currentTurnSeat]}`;
  io.to(room.roomCode).emit('stateUpdate', room);

  let isHumanTurn = room.isHuman[currentTurnSeat];

  if (!isHumanTurn) {
    runBotTurn(room, false);
  }
}

function runBotTurn(room, isInitialDiscard = false) {
  if (room.gameEnded) return;

  let currentBot = room.turn;
  let botHand = room.hands[currentBot];

  setTimeout(() => {
    if (room.gameEnded || room.turn !== currentBot) return;

    let tookDiscard = false;

    // STEP 1: DRAW / DISCARD PICKUP EVALUATION
    if (!isInitialDiscard && botHand.length === 7) {
      if (room.discardPile.length > 0) {
        let topDiscard = room.discardPile[room.discardPile.length - 1];
        let hasMatchingCardInHand = botHand.some(c => c.value === topDiscard.value);

        if (hasMatchingCardInHand) {
          let c = room.discardPile.pop();
          botHand.push(c);
          autoSortHand(botHand);
          tookDiscard = true;

          io.to(room.roomCode).emit('animateCard', { source: 'discard', targetPlayer: currentBot, card: c, isPrivate: false });
          room.actionLog = `🎴 ${room.playerNames[currentBot]} took ${c.value}${c.suit} from DISCARD!`;
          io.to(room.roomCode).emit('cardSound');
          
          setTimeout(() => io.to(room.roomCode).emit('stateUpdate', room), 600);

          if (checkFourPairs(botHand)) {
            setTimeout(() => declareWin(room, currentBot, false), 1800);
            return;
          }
        }
      }

      if (!tookDiscard) {
        if (room.deck.length === 0) {
          endGameNoWinner(room);
          return;
        }
        let drawnCard = room.deck.pop();
        botHand.push(drawnCard);
        autoSortHand(botHand);

        io.to(room.roomCode).emit('animateCard', { source: 'deck', targetPlayer: currentBot, card: null, isPrivate: true });
        room.actionLog = `📥 ${room.playerNames[currentBot]} drew from MIDDLE DECK.`;
        io.to(room.roomCode).emit('cardSound');
        
        setTimeout(() => io.to(room.roomCode).emit('stateUpdate', room), 600);
      }

      if (checkFourPairs(botHand)) {
        setTimeout(() => declareWin(room, currentBot, false), 1800);
        return;
      }
    }

    // STEP 2: ADVANCED DISCARD DECISION
    setTimeout(() => {
      if (room.gameEnded || room.turn !== currentBot) return;

      let rankCounts = {};
      for (let c of botHand) {
        rankCounts[c.value] = (rankCounts[c.value] || 0) + 1;
      }

      let singletons = botHand.filter(c => rankCounts[c.value] === 1);
      let triplets = botHand.filter(c => rankCounts[c.value] === 3);

      // Evaluate $5 Special Win Progress
      let redCount = botHand.filter(c => c.isRed).length;
      let blackCount = botHand.filter(c => !c.isRed).length;
      let faceCount = botHand.filter(c => ['J','Q','K'].includes(c.value)).length;

      let goingForAllBlack = blackCount >= 6;
      let goingForCourtCards = faceCount >= 5;

      let cardToDiscard = null;

      if (singletons.length > 0) {
        // Score each singleton dynamically based on strategy
        singletons.sort((a, b) => {
          let scoreA = a.points;
          let scoreB = b.points;

          // If chasing All Black special win, heavily penalize discarding black cards
          if (goingForAllBlack) {
            if (!a.isRed) scoreA += 50;
            if (!b.isRed) scoreB += 50;
          }

          // If chasing Court Card win (J, Q, K), penalize discarding face cards
          if (goingForCourtCards) {
            if (['J','Q','K'].includes(a.value)) scoreA += 40;
            if (['J','Q','K'].includes(b.value)) scoreB += 40;
          }

          // Otherwise, bots value high-point red cards (e.g. Red 10s) and are more willing to discard low-value or black singletons
          return scoreA - scoreB;
        });

        cardToDiscard = singletons[0];
      } 
      else if (triplets.length > 0) {
        // If holding triplets, break one down to maintain pair structure
        cardToDiscard = triplets[0];
      } 
      else {
        cardToDiscard = botHand[0];
      }

      let discardIndex = botHand.findIndex(c => c.id === cardToDiscard.id);
      let card = botHand.splice(discardIndex, 1)[0];
      room.discardPile.push(card);
      autoSortHand(botHand);

      io.to(room.roomCode).emit('animateCard', { source: 'player', sourcePlayer: currentBot, target: 'discard', card: card, isPrivate: false });
      io.to(room.roomCode).emit('cardSound');

      room.actionLog = `📤 ${room.playerNames[currentBot]} discarded ${card.value}${card.suit}.`;

      let intercepted = checkForOutOfTurnInterception(room, currentBot, card);

      if (!intercepted) {
        room.turn = (room.turn + 1) % 4;
        setTimeout(() => {
          processTurn(room);
        }, 700);
      }
    }, 1800);

  }, isInitialDiscard ? 1000 : 1500);
}

function declareWin(room, playerIdx, isInstantWin) {
  room.winner = playerIdx;
  room.gameEnded = true;
  room.lastWinnerIdx = playerIdx;

  let totalPoints = calculatePayout(room.hands[playerIdx], isInstantWin);
  let scale = (room.roomTier / 10.00);
  let perPlayerCost = (totalPoints * 0.10) * scale;
  let totalWinnings = perPlayerCost * 3;

  for (let i = 0; i < 4; i++) {
    if (i === playerIdx) {
      room.balances[i] += totalWinnings;
    } else {
      room.balances[i] -= perPlayerCost;
      if (room.balances[i] <= 0) {
        room.balances[i] = 10.00;
      }
    }

    let pObj = room.players.find(p => p.seat === i);
    if (pObj) pObj.balance = room.balances[i];
  }

  room.status = `🎉 ${room.playerNames[playerIdx]} Wins! +$${totalWinnings.toFixed(2)}`;
  room.revealStage = 1;
  io.to(room.roomCode).emit('stateUpdate', room);

  setTimeout(() => {
    room.revealStage = 2;
    io.to(room.roomCode).emit('stateUpdate', room);
  }, 2000);
}

function endGameNoWinner(room) {
  room.gameEnded = true;
  room.revealStage = 2;
  room.actionLog = "Deck empty!";
  room.status = "No winner this round. All cards revealed.";
  io.to(room.roomCode).emit('stateUpdate', room);
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let playerObj = { id: socket.id, name: 'Guest', seat: -1, balance: 10.00 };

  socket.on('joinRoom', ({ name, roomCode, isSolo, currentBalance }) => {
    let finalCode = isSolo ? `SOLO_${socket.id.substring(0, 5)}` : (roomCode ? roomCode.trim().toUpperCase() : 'KUA88');
    
    currentRoom = getOrCreateRoom(finalCode, isSolo);
    playerObj.name = name ? name.trim() : 'Player 1';
    playerObj.balance = (currentBalance !== undefined && currentBalance > 0) ? currentBalance : 10.00;

    let occupiedSeats = currentRoom.players.map(p => p.seat);
    let assignedSeat = 0;
    for (let s = 0; s < 4; s++) {
      if (!occupiedSeats.includes(s)) {
        assignedSeat = s;
        break;
      }
    }
    playerObj.seat = assignedSeat;

    if (currentRoom.players.length === 0) {
      currentRoom.hostId = socket.id;
    }

    socket.join(finalCode);
    currentRoom.players.push(playerObj);
    updateRoomRoster(currentRoom);

    socket.emit('joinedRoomSuccess', { 
      roomCode: finalCode, 
      seat: playerObj.seat, 
      isHost: (currentRoom.hostId === socket.id) 
    });

    if (isSolo) {
      setTimeout(() => startRoundLogic(currentRoom), 800);
    }
  });

  socket.on('setRoomTier', (tierAmount) => {
    if (!currentRoom) return;
    currentRoom.roomTier = parseFloat(tierAmount);
  });

  socket.on('leaveRoom', () => {
    if (currentRoom) {
      currentRoom.players = currentRoom.players.filter(p => p.id !== socket.id);
      if (currentRoom.hostId === socket.id && currentRoom.players.length > 0) {
        currentRoom.hostId = currentRoom.players[0].id;
      }
      updateRoomRoster(currentRoom);
      socket.leave(currentRoom.roomCode);
      currentRoom = null;
    }
  });

  socket.on('startGame', () => {
    if (currentRoom && socket.id === currentRoom.hostId) {
      startRoundLogic(currentRoom);
    }
  });

  socket.on('claimWin', () => {
    if (!currentRoom || currentRoom.gameEnded) return;
    let pSeat = playerObj.seat;
    if (checkFourPairs(currentRoom.hands[pSeat])) {
      declareWin(currentRoom, pSeat, false);
    }
  });

  socket.on('respondSteal', (acceptSteal) => {
    if (!currentRoom || !currentRoom.pendingSteal) return;
    let stealData = currentRoom.pendingSteal;
    currentRoom.pendingSteal = null;

    if (acceptSteal) {
      let stolenCard = currentRoom.discardPile.pop();
      currentRoom.hands[stealData.playerIdx].push(stolenCard);
      autoSortHand(currentRoom.hands[stealData.playerIdx]);

      io.to(currentRoom.roomCode).emit('animateCard', { source: 'discard', targetPlayer: stealData.playerIdx, card: stolenCard, isPrivate: false });
      currentRoom.actionLog = `⚡ ${currentRoom.playerNames[stealData.playerIdx]} STOLE ${stolenCard.value}${stolenCard.suit} to WIN!`;
      io.to(currentRoom.roomCode).emit('cardSound');
      
      setTimeout(() => io.to(currentRoom.roomCode).emit('stateUpdate', currentRoom), 600);
      declareWin(currentRoom, stealData.playerIdx, false);
    } else {
      currentRoom.actionLog = `${currentRoom.playerNames[stealData.playerIdx]} passed on stealing. Game continues!`;
      currentRoom.turn = (currentRoom.turn + 1) % 4;
      processTurn(currentRoom);
    }
  });

  socket.on('playerDraw', () => {
    if (!currentRoom) return;
    let pSeat = playerObj.seat;
    if (pSeat !== currentRoom.turn || currentRoom.hands[pSeat].length >= 8 || currentRoom.gameEnded || currentRoom.isDealing) return;
    
    if (currentRoom.deck.length > 0) {
      let c = currentRoom.deck.pop();
      currentRoom.hands[pSeat].push(c);
      autoSortHand(currentRoom.hands[pSeat]);

      currentRoom.takeCooldown[pSeat] = null;

      io.to(currentRoom.roomCode).emit('animateCard', { source: 'deck', targetPlayer: pSeat, card: null, isPrivate: true });
      currentRoom.actionLog = `📥 ${playerObj.name} drew from MIDDLE DECK.`;
      io.to(currentRoom.roomCode).emit('cardSound');

      setTimeout(() => io.to(currentRoom.roomCode).emit('stateUpdate', currentRoom), 600);
    } else {
      endGameNoWinner(currentRoom);
    }
  });

  socket.on('playerTakeDiscard', () => {
    if (!currentRoom) return;
    let pSeat = playerObj.seat;
    if (pSeat !== currentRoom.turn || currentRoom.discardPile.length === 0 || currentRoom.gameEnded || currentRoom.isDealing) return;

    let c = currentRoom.discardPile.pop();
    currentRoom.hands[pSeat].push(c);
    autoSortHand(currentRoom.hands[pSeat]);

    currentRoom.takeCooldown[pSeat] = c.value;

    io.to(currentRoom.roomCode).emit('animateCard', { source: 'discard', targetPlayer: pSeat, card: c, isPrivate: false });
    currentRoom.actionLog = `🎴 ${playerObj.name} took ${c.value}${c.suit} from DISCARD pile!`;
    io.to(currentRoom.roomCode).emit('cardSound');

    setTimeout(() => io.to(currentRoom.roomCode).emit('stateUpdate', currentRoom), 600);
  });

  socket.on('discardCard', (cardIndex) => {
    if (!currentRoom) return;
    let pSeat = playerObj.seat;
    if (pSeat !== currentRoom.turn || currentRoom.hands[pSeat].length !== 8 || currentRoom.gameEnded || currentRoom.isDealing) return;
    
    let cardToDiscard = currentRoom.hands[pSeat][cardIndex];

    if (currentRoom.takeCooldown[pSeat] === cardToDiscard.value) {
      socket.emit('privateRuleAlert', `❌ Cooldown Rule: You took rank ${cardToDiscard.value} from DISCARD! You cannot discard rank ${cardToDiscard.value} on the same turn.`);
      return;
    }

    let card = currentRoom.hands[pSeat].splice(cardIndex, 1)[0];
    currentRoom.discardPile.push(card);
    autoSortHand(currentRoom.hands[pSeat]);

    io.to(currentRoom.roomCode).emit('animateCard', { source: 'player', sourcePlayer: pSeat, target: 'discard', card: card, isPrivate: false });
    currentRoom.actionLog = `📤 ${playerObj.name} discarded ${card.value}${card.suit}.`;
    io.to(currentRoom.roomCode).emit('cardSound');

    let intercepted = checkForOutOfTurnInterception(room, pSeat, card);

    if (!intercepted) {
      currentRoom.turn = (currentRoom.turn + 1) % 4;
      setTimeout(() => {
        processTurn(room);
      }, 700);
    }
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      currentRoom.players = currentRoom.players.filter(p => p.id !== socket.id);
      if (currentRoom.hostId === socket.id && currentRoom.players.length > 0) {
        currentRoom.hostId = currentRoom.players[0].id;
      }
      updateRoomRoster(currentRoom);
    }
  });
});

http.listen(3000, () => {
  console.log('Kua Merah server running on http://localhost:3000');
});