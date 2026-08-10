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
      let offsetX = (Math.random() * 12 - 6).toFixed(1);
      let offsetY = (Math.random() * 12 - 6).toFixed(1);

      deck.push({ 
        suit: s, 
        value: v, 
        isRed: isRed, 
        points: pts, 
        rotation: rotation, 
        offsetX: offsetX,
        offsetY: offsetY,
        id: v + s 
      });
    }
  }
  return deck.sort(() => Math.random() - 0.5);
}

function autoSortHand(hand) {
  if (!hand) return [];
  const rankOrder = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};
  let counts = {};
  for (let c of hand) {
    if (c) counts[c.value] = (counts[c.value] || 0) + 1;
  }

  return hand.sort((a, b) => {
    if (!a || !b) return 0;
    let countA = counts[a.value] || 0;
    let countB = counts[b.value] || 0;
    let isPairA = countA >= 2 ? 1 : 0;
    let isPairB = countB >= 2 ? 1 : 0;

    if (isPairA !== isPairB) return isPairB - isPairA;
    if (rankOrder[a.value] !== rankOrder[b.value]) return rankOrder[b.value] - rankOrder[a.value];
    return a.suit.localeCompare(b.suit);
  });
}

function checkFourPairs(hand) {
  if (!hand || hand.length !== 8) return false;
  let counts = {};
  for (let c of hand) {
    if (c) counts[c.value] = (counts[c.value] || 0) + 1;
  }
  let pairs = 0;
  for (let val in counts) {
    if (counts[val] === 2) pairs++;
    if (counts[val] === 4) pairs += 2;
  }
  return pairs === 4;
}

function calculatePayout(winningHand, isInstantWin) {
  if (isInstantWin) return 50;
  if (!winningHand) return 0;
  let redCount = winningHand.filter(c => c && c.isRed).length;
  let faceCount = winningHand.filter(c => c && ['J','Q','K'].includes(c.value)).length;
  let hasRedAce = winningHand.some(c => c && c.isRed && c.value === 'A');

  if (redCount === 0 || (redCount === 1 && hasRedAce) || faceCount === 8) {
    return 50;
  }
  return winningHand.reduce((sum, c) => sum + (c ? c.points : 0), 0);
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
      botDifficulty: 'normal',
      playerNames: ['Bot 1', 'Bot 2', 'Bot 3', 'Bot 4'],
      isHuman: [false, false, false, false],
      balances: [10.00, 10.00, 10.00, 10.00],
      gameEnded: true,
      sessionStopped: false,
      revealStage: 0,
      isDealing: false,
      roomTier: 10.00,
      players: [],
      lastWinnerIdx: 0,
      pendingSteal: null,
      takeCooldown: [null, null, null, null],
      hostId: null,
      roundCount: 0,
      roundHistory: []
    };
  }
  return rooms[roomCode];
}

function getCleanRoomState(room) {
  return {
    roomCode: room.roomCode,
    isSolo: room.isSolo,
    deck: room.deck,
    hands: room.hands,
    discardPile: room.discardPile,
    turn: room.turn,
    winner: room.winner,
    status: room.status,
    actionLog: room.actionLog,
    playerNames: room.playerNames,
    isHuman: room.isHuman,
    balances: room.balances,
    botDifficulty: room.isSolo ? room.botDifficulty : 'normal',
    gameEnded: room.gameEnded,
    sessionStopped: room.sessionStopped,
    revealStage: room.revealStage,
    isDealing: room.isDealing,
    roomTier: room.roomTier,
    lastWinnerIdx: room.lastWinnerIdx,
    roundCount: room.roundCount,
    roundHistory: room.roundHistory
  };
}

function broadcastRoomState(room) {
  io.to(room.roomCode).emit('stateUpdate', getCleanRoomState(room));
}

function broadcastRoomList() {
  let roomList = [];
  for (let code in rooms) {
    let r = rooms[code];
    if (!r.isSolo && r.players.length > 0) {
      roomList.push({
        roomCode: r.roomCode,
        humanCount: r.players.length,
        tier: r.roomTier,
        isFull: r.players.length >= 4,
        gameEnded: r.gameEnded
      });
    }
  }
  io.emit('roomListUpdate', roomList);
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
      if (room.roundCount === 0 && room.gameEnded) {
        room.balances[i] = room.roomTier;
      }
    }
  }

  room.playerNames = names;
  room.isHuman = isHumanFlags;
  broadcastRoomState(room);
  broadcastRoomList();
}

function calculateSettlements(room) {
  let roundLogs = room.roundHistory.map((r) => {
    return {
      roundNumber: r.roundNumber,
      winnerName: r.winnerName,
      totalWinnings: r.totalWinnings,
      perPlayerCost: r.perPlayerCost,
      payments: r.payments || []
    };
  });

  let sessionNet = [0, 0, 0, 0];
  room.roundHistory.forEach((r) => {
    if (r.netChanges) {
      r.netChanges.forEach((change, i) => {
        sessionNet[i] += change;
      });
    }
  });

  let netBalances = room.playerNames.map((name, i) => {
    return {
      index: i,
      name: name,
      isHuman: room.isHuman[i],
      netChange: sessionNet[i]
    };
  });

  let debtors = netBalances.filter(p => p.netChange < -0.001).map(p => ({ ...p, amount: Math.abs(p.netChange) }));
  let creditors = netBalances.filter(p => p.netChange > 0.001).map(p => ({ ...p, amount: p.netChange }));

  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  let settlements = [];

  let d = 0, c = 0;
  while (d < debtors.length && c < creditors.length) {
    let debtor = debtors[d];
    let creditor = creditors[c];

    let payment = Math.min(debtor.amount, creditor.amount);
    if (payment > 0.001) {
      settlements.push({
        fromIdx: debtor.index,
        fromName: debtor.name,
        toIdx: creditor.index,
        toName: creditor.name,
        amount: payment
      });
    }

    debtor.amount -= payment;
    creditor.amount -= payment;

    if (debtor.amount <= 0.001) d++;
    if (creditor.amount <= 0.001) c++;
  }

  let playerSummaries = room.playerNames.map((name, idx) => {
    let pays = settlements.filter(s => s.fromIdx === idx);
    let receives = settlements.filter(s => s.toIdx === idx);
    let net = sessionNet[idx];

    return {
      name: name,
      netChange: net,
      pays: pays,
      receives: receives
    };
  });

  return {
    roundCount: room.roundCount,
    roundLogs: roundLogs,
    playerSummaries: playerSummaries,
    settlements: settlements,
    netBalances: netBalances
  };
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
      room.pendingSteal = { playerIdx: targetWinner, card: discardedCard, discarderIdx: discarderIdx };
      io.to(room.roomCode).emit('promptSteal', { playerIdx: targetWinner, card: discardedCard, name: room.playerNames[discarderIdx] });
      return true;
    } else {
      let effectiveDiff = room.isSolo ? room.botDifficulty : 'normal';

      if (effectiveDiff === 'easy' && Math.random() > 0.3) {
        return false;
      }

      let stolenCard = room.discardPile.pop();
      if (stolenCard) {
        room.hands[targetWinner].push(stolenCard);
        autoSortHand(room.hands[targetWinner]);

        io.to(room.roomCode).emit('animateCard', { source: 'discard', targetPlayer: targetWinner, card: stolenCard, isPrivate: false });
        room.actionLog = `⚡ ${room.playerNames[targetWinner]} STOLE ${stolenCard.value}${stolenCard.suit} out of turn to WIN!`;
        io.to(room.roomCode).emit('cardSound', 'pickup');
        
        let stepDelay = effectiveDiff === 'hard' ? 400 : 700;
        setTimeout(() => broadcastRoomState(room), stepDelay);
        declareWin(room, targetWinner, false);
        return true;
      }
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
      if (dealtCard) {
        room.hands[pIdx].push(dealtCard);
        autoSortHand(room.hands[pIdx]);
        io.to(room.roomCode).emit('animateCard', { source: 'deck', targetPlayer: pIdx, card: null, isPrivate: true });
        io.to(room.roomCode).emit('cardSound', 'pickup');
        broadcastRoomState(room);
        dealtCount++;
      }
    }

    pIdx = (pIdx + 1) % 4;
  }, 180);
}

function startRoundLogic(room) {
  if (!room.gameEnded || room.sessionStopped) return;

  room.roundCount++;
  updateRoomRoster(room);
  
  io.to(room.roomCode).emit('cardSound', 'shuffle');

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
  
  let diffLabel = room.isSolo ? ` (${room.botDifficulty.toUpperCase()})` : '';
  room.actionLog = `Round ${room.roundCount} - $${room.roomTier} Tier${diffLabel} - ${room.playerNames[starterIdx]} starts!`;
  room.status = `Turn: ${room.playerNames[starterIdx]}`;

  setTimeout(() => {
    dealCardsOneByOne(room, starterIdx, () => {
      if (checkFourPairs(room.hands[starterIdx]) && !room.isHuman[starterIdx]) {
        declareWin(room, starterIdx, true);
        return;
      }

      room.actionLog = `Cards dealt! ${room.playerNames[starterIdx]} starts with 8 cards.`;
      room.status = `Turn: ${room.playerNames[starterIdx]}`;
      broadcastRoomState(room);

      if (!room.isHuman[starterIdx]) {
        runBotTurn(room, true);
      }
    });
  }, 500);
}

function processTurn(room) {
  if (room.gameEnded) return;

  let currentTurnSeat = room.turn;
  room.takeCooldown[currentTurnSeat] = null;
  room.status = `Turn: ${room.playerNames[currentTurnSeat]}`;
  broadcastRoomState(room);

  let isHumanTurn = room.isHuman[currentTurnSeat];

  if (!isHumanTurn) {
    runBotTurn(room, false);
  }
}

function runBotTurn(room, isInitialDiscard = false) {
  if (room.gameEnded) return;

  let currentBot = room.turn;
  let botHand = room.hands[currentBot];
  if (!botHand || botHand.length === 0) return;

  let effectiveDiff = room.isSolo ? room.botDifficulty : 'normal';
  let turnDelay = effectiveDiff === 'hard' ? 400 : 700;

  setTimeout(() => {
    if (room.gameEnded || room.turn !== currentBot) return;

    let tookDiscard = false;

    if (!isInitialDiscard && botHand.length === 7) {
      if (room.discardPile.length > 0) {
        let topDiscard = room.discardPile[room.discardPile.length - 1];
        if (topDiscard) {
          let cardCountInHand = botHand.filter(c => c && c.value === topDiscard.value).length;
          let testHand = [...botHand, topDiscard];
          let completesWin = checkFourPairs(testHand);

          let willTake = effectiveDiff === 'easy' ? Math.random() < 0.5 : true;

          if (willTake && (cardCountInHand === 1 || completesWin)) {
            let c = room.discardPile.pop();
            if (c) {
              botHand.push(c);
              autoSortHand(botHand);
              tookDiscard = true;

              io.to(room.roomCode).emit('animateCard', { source: 'discard', targetPlayer: currentBot, card: c, isPrivate: false });
              room.actionLog = `🎴 ${room.playerNames[currentBot]} took ${c.value}${c.suit} from DISCARD!`;
              io.to(room.roomCode).emit('cardSound', 'pickup');
              
              setTimeout(() => broadcastRoomState(room), turnDelay);

              if (checkFourPairs(botHand)) {
                setTimeout(() => declareWin(room, currentBot, false), turnDelay);
                return;
              }
            }
          }
        }
      }

      if (!tookDiscard) {
        if (room.deck.length === 0) {
          endGameNoWinner(room);
          return;
        }
        let drawnCard = room.deck.pop();
        if (drawnCard) {
          botHand.push(drawnCard);
          autoSortHand(botHand);

          io.to(room.roomCode).emit('animateCard', { source: 'deck', targetPlayer: currentBot, card: null, isPrivate: true });
          room.actionLog = `📥 ${room.playerNames[currentBot]} drew from MIDDLE DECK.`;
          io.to(room.roomCode).emit('cardSound', 'pickup');
          
          setTimeout(() => broadcastRoomState(room), turnDelay);
        }
      }

      if (checkFourPairs(botHand)) {
        setTimeout(() => declareWin(room, currentBot, false), turnDelay);
        return;
      }
    }

    setTimeout(() => {
      if (room.gameEnded || room.turn !== currentBot || botHand.length === 0) return;

      let cardToDiscard = null;

      if (effectiveDiff === 'easy') {
        cardToDiscard = botHand[Math.floor(Math.random() * botHand.length)];
      }
      else if (effectiveDiff === 'hard') {
        let rankCounts = {};
        for (let c of botHand) {
          if (c) rankCounts[c.value] = (rankCounts[c.value] || 0) + 1;
        }

        let singletons = botHand.filter(c => c && rankCounts[c.value] === 1);

        if (singletons.length > 0) {
          singletons.sort((a, b) => {
            let scoreA = 0, scoreB = 0;
            if (!a.isRed) scoreA += 10;
            if (!b.isRed) scoreB += 10;

            scoreA += (10 - a.points);
            scoreB += (10 - b.points);

            if (a.isRed && a.value === '10') scoreA -= 25;
            if (b.isRed && b.value === '10') scoreB -= 25;
            if (a.isRed && a.value === 'A') scoreA -= 20;
            if (b.isRed && b.value === 'A') scoreB -= 20;

            return scoreB - scoreA;
          });
          cardToDiscard = singletons[0];
        } else {
          let triplets = botHand.filter(c => c && rankCounts[c.value] === 3);
          if (triplets.length > 0) cardToDiscard = triplets[0];
          else cardToDiscard = botHand[0];
        }
      }
      else {
        let rankCounts = {};
        for (let c of botHand) {
          if (c) rankCounts[c.value] = (rankCounts[c.value] || 0) + 1;
        }

        let triplets = botHand.filter(c => c && rankCounts[c.value] === 3);
        let singletons = botHand.filter(c => c && rankCounts[c.value] === 1);

        if (triplets.length > 0) {
          cardToDiscard = triplets[0];
        } else if (singletons.length > 0) {
          singletons.sort((a, b) => a.points - b.points);
          cardToDiscard = singletons[0];
        } else {
          cardToDiscard = botHand[0];
        }
      }

      if (!cardToDiscard) cardToDiscard = botHand[0];

      let discardIndex = botHand.findIndex(c => c && c.id === cardToDiscard.id);
      if (discardIndex === -1) discardIndex = 0;

      let card = botHand.splice(discardIndex, 1)[0];
      if (!card) return;

      room.discardPile.push(card);
      autoSortHand(botHand);

      io.to(room.roomCode).emit('animateCard', { source: 'player', sourcePlayer: currentBot, target: 'discard', card: card, isPrivate: false });
      io.to(room.roomCode).emit('cardSound', 'flip');

      room.actionLog = `📤 ${room.playerNames[currentBot]} discarded ${card.value}${card.suit}.`;

      let intercepted = checkForOutOfTurnInterception(room, currentBot, card);

      if (!intercepted) {
        room.turn = (room.turn + 1) % 4;
        setTimeout(() => {
          processTurn(room);
        }, turnDelay);
      }
    }, turnDelay);

  }, isInitialDiscard ? turnDelay : turnDelay + 100);
}

function declareWin(room, playerIdx, isInstantWin) {
  room.winner = playerIdx;
  room.gameEnded = true;
  room.lastWinnerIdx = playerIdx;

  let totalPoints = calculatePayout(room.hands[playerIdx], isInstantWin);
  let scale = (room.roomTier / 10.00);
  let perPlayerCost = (totalPoints * 0.10) * scale;
  let totalWinnings = perPlayerCost * 3;

  let netChanges = [0, 0, 0, 0];
  let roundPayments = [];

  for (let i = 0; i < 4; i++) {
    if (i === playerIdx) {
      room.balances[i] += totalWinnings;
      netChanges[i] = totalWinnings;
    } else {
      room.balances[i] -= perPlayerCost;
      netChanges[i] = -perPlayerCost;

      roundPayments.push({
        from: room.playerNames[i],
        to: room.playerNames[playerIdx],
        amount: perPlayerCost
      });
    }

    let pObj = room.players.find(p => p.seat === i);
    if (pObj) pObj.balance = room.balances[i];
  }

  room.roundHistory.push({
    roundNumber: room.roundCount,
    winnerName: room.playerNames[playerIdx],
    points: totalPoints,
    perPlayerCost: perPlayerCost,
    totalWinnings: totalWinnings,
    payments: roundPayments,
    netChanges: [...netChanges],
    playerNames: [...room.playerNames]
  });

  room.status = `🎉 ${room.playerNames[playerIdx]} Wins Round ${room.roundCount}! +$${totalWinnings.toFixed(2)}`;
  room.revealStage = 1;
  broadcastRoomState(room);

  io.to(room.roomCode).emit('cardSound', 'flip');

  io.to(room.roomCode).emit('showWinnerAnnouncement', {
    winnerIdx: playerIdx,
    winnerName: room.playerNames[playerIdx],
    winnings: totalWinnings
  });

  setTimeout(() => {
    io.to(room.roomCode).emit('roundResultBreakdown', {
      winnerName: room.playerNames[playerIdx],
      points: totalPoints,
      perPlayerCost: perPlayerCost,
      totalWinnings: totalWinnings,
      playerNames: room.playerNames,
      netChanges: netChanges,
      balances: room.balances
    });

    room.revealStage = 2;
    io.to(room.roomCode).emit('cardSound', 'flip');
    broadcastRoomState(room);
  }, 2500);
}

function endGameNoWinner(room) {
  room.gameEnded = true;
  room.revealStage = 2;
  room.actionLog = "Deck empty!";
  room.status = "No winner this round. All cards revealed.";
  io.to(room.roomCode).emit('cardSound', 'flip');
  broadcastRoomState(room);
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let playerObj = { id: socket.id, name: 'Guest', seat: -1, balance: 10.00 };

  socket.emit('getRoomList');
  broadcastRoomList();

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
    currentRoom.balances[assignedSeat] = playerObj.balance;

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
      setTimeout(() => startRoundLogic(currentRoom), 600);
    }
  });

  socket.on('setRoomTier', (tierAmount) => {
    if (!currentRoom) return;
    currentRoom.roomTier = parseFloat(tierAmount);
    updateRoomRoster(currentRoom);
  });

  socket.on('setBotDifficulty', (diff) => {
    if (!currentRoom) return;
    if (currentRoom.isSolo) {
      if (['easy', 'normal', 'hard'].includes(diff)) {
        currentRoom.botDifficulty = diff;
        broadcastRoomState(currentRoom);
      }
    } else {
      currentRoom.botDifficulty = 'normal';
      broadcastRoomState(currentRoom);
    }
  });

  socket.on('getLedgerHistory', () => {
    if (!currentRoom) return;
    let data = calculateSettlements(currentRoom);
    socket.emit('ledgerHistoryData', data);
  });

  socket.on('stopGame', () => {
    if (!currentRoom) return;
    currentRoom.sessionStopped = true;
    currentRoom.gameEnded = true;
    currentRoom.status = "🛑 Session Ended. Final Ledger Settled.";
    currentRoom.actionLog = "Game Session Stopped by player. Refer to Ledger for Payments.";

    let data = calculateSettlements(currentRoom);
    io.to(currentRoom.roomCode).emit('gameSessionStopped', data);
    broadcastRoomState(currentRoom);
  });

  socket.on('leaveRoom', () => {
    if (currentRoom) {
      currentRoom.players = currentRoom.players.filter(p => p.id !== socket.id);
      if (currentRoom.hostId === socket.id && currentRoom.players.length > 0) {
        currentRoom.hostId = currentRoom.players[0].id;
      }

      if (currentRoom.players.length === 0) {
        delete rooms[currentRoom.roomCode];
      } else {
        updateRoomRoster(currentRoom);
      }

      broadcastRoomList();
      socket.leave(currentRoom.roomCode);
      currentRoom = null;
    }
  });

  socket.on('startGame', () => {
    if (currentRoom && socket.id === currentRoom.hostId && !currentRoom.sessionStopped) {
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
      if (stolenCard) {
        currentRoom.hands[stealData.playerIdx].push(stolenCard);
        autoSortHand(currentRoom.hands[stealData.playerIdx]);

        io.to(currentRoom.roomCode).emit('animateCard', { source: 'discard', targetPlayer: stealData.playerIdx, card: stolenCard, isPrivate: false });
        currentRoom.actionLog = `⚡ ${currentRoom.playerNames[stealData.playerIdx]} STOLE ${stolenCard.value}${stolenCard.suit} to WIN!`;
        io.to(currentRoom.roomCode).emit('cardSound', 'pickup');
        
        let effectiveDiff = currentRoom.isSolo ? currentRoom.botDifficulty : 'normal';
        let stepDelay = effectiveDiff === 'hard' ? 400 : 700;
        setTimeout(() => broadcastRoomState(currentRoom), stepDelay);
        declareWin(currentRoom, stealData.playerIdx, false);
      }
    } else {
      currentRoom.turn = (stealData.discarderIdx + 1) % 4;
      processTurn(currentRoom);
    }
  });

  socket.on('playerDraw', () => {
    if (!currentRoom) return;
    let pSeat = playerObj.seat;

    if (pSeat !== currentRoom.turn || currentRoom.hands[pSeat].length !== 7 || currentRoom.gameEnded || currentRoom.isDealing) return;
    
    if (currentRoom.deck.length > 0) {
      let c = currentRoom.deck.pop();
      if (c) {
        currentRoom.hands[pSeat].push(c);
        autoSortHand(currentRoom.hands[pSeat]);

        currentRoom.takeCooldown[pSeat] = null;

        io.to(currentRoom.roomCode).emit('animateCard', { source: 'deck', targetPlayer: pSeat, card: null, isPrivate: true });
        currentRoom.actionLog = `📥 ${playerObj.name} drew from MIDDLE DECK.`;
        io.to(currentRoom.roomCode).emit('cardSound', 'pickup');

        let effectiveDiff = currentRoom.isSolo ? currentRoom.botDifficulty : 'normal';
        let stepDelay = effectiveDiff === 'hard' ? 400 : 700;
        setTimeout(() => broadcastRoomState(currentRoom), stepDelay);
      }
    } else {
      endGameNoWinner(currentRoom);
    }
  });

  socket.on('playerTakeDiscard', () => {
    if (!currentRoom) return;
    let pSeat = playerObj.seat;

    if (pSeat !== currentRoom.turn || currentRoom.hands[pSeat].length !== 7 || currentRoom.discardPile.length === 0 || currentRoom.gameEnded || currentRoom.isDealing) return;

    let c = currentRoom.discardPile.pop();
    if (c) {
      currentRoom.hands[pSeat].push(c);
      autoSortHand(currentRoom.hands[pSeat]);

      currentRoom.takeCooldown[pSeat] = c.value;

      io.to(currentRoom.roomCode).emit('animateCard', { source: 'discard', targetPlayer: pSeat, card: c, isPrivate: false });
      currentRoom.actionLog = `🎴 ${playerObj.name} took ${c.value}${c.suit} from DISCARD pile!`;
      io.to(currentRoom.roomCode).emit('cardSound', 'pickup');

      let effectiveDiff = currentRoom.isSolo ? currentRoom.botDifficulty : 'normal';
      let stepDelay = effectiveDiff === 'hard' ? 400 : 700;
      setTimeout(() => broadcastRoomState(currentRoom), stepDelay);
    }
  });

  socket.on('discardCard', (cardIndex) => {
    if (!currentRoom) return;
    let pSeat = playerObj.seat;

    if (pSeat !== currentRoom.turn || currentRoom.hands[pSeat].length !== 8 || currentRoom.gameEnded || currentRoom.isDealing) return;
    
    let cardToDiscard = currentRoom.hands[pSeat][cardIndex];
    if (!cardToDiscard) return;

    if (currentRoom.isHuman[pSeat] && currentRoom.takeCooldown[pSeat] === cardToDiscard.value) {
      socket.emit('privateRuleAlert', `❌ Cooldown Rule: You took rank ${cardToDiscard.value} from DISCARD! You cannot discard rank ${cardToDiscard.value} on the same turn.`);
      return;
    }

    let card = currentRoom.hands[pSeat].splice(cardIndex, 1)[0];
    if (!card) return;

    currentRoom.discardPile.push(card);
    autoSortHand(currentRoom.hands[pSeat]);

    io.to(currentRoom.roomCode).emit('animateCard', { source: 'player', sourcePlayer: pSeat, target: 'discard', card: card, isPrivate: false });
    currentRoom.actionLog = `📤 ${playerObj.name} discarded ${card.value}${card.suit}.`;
    io.to(currentRoom.roomCode).emit('cardSound', 'flip');

    let intercepted = checkForOutOfTurnInterception(currentRoom, pSeat, card);

    if (!intercepted) {
      currentRoom.turn = (currentRoom.turn + 1) % 4;
      let effectiveDiff = currentRoom.isSolo ? currentRoom.botDifficulty : 'normal';
      let stepDelay = effectiveDiff === 'hard' ? 400 : 700;
      setTimeout(() => {
        processTurn(currentRoom);
      }, stepDelay);
    }
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      currentRoom.players = currentRoom.players.filter(p => p.id !== socket.id);
      if (currentRoom.hostId === socket.id && currentRoom.players.length > 0) {
        currentRoom.hostId = currentRoom.players[0].id;
      }
      
      if (currentRoom.players.length === 0) {
        delete rooms[currentRoom.roomCode];
      } else {
        updateRoomRoster(currentRoom);
      }

      broadcastRoomList();
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Kua Merah server running on port ${PORT}`);
});