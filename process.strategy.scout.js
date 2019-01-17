'use strict';

var Process = require('process');
var utilities = require('utilities');

var ScoutProcess = function (params, data) {
  Process.call(this, params, data);

  if (!Memory.strategy) {
    Memory.strategy = {};
  }
};
ScoutProcess.prototype = Object.create(Process.prototype);

ScoutProcess.prototype.run = function () {
  Memory.strategy.roomList = this.generateScoutTargets();

  // Add data to scout list for creating priorities.
  for (let roomName in Memory.strategy.roomList) {
    this.calculateRoomPriorities(roomName);
  }
};

ScoutProcess.prototype.calculateRoomPriorities = function (roomName) {
  let roomList = Memory.strategy.roomList;
  let roomIntel = kuknob.roomIntel(roomName);

  let info = roomList[roomName];

  info.roomName = roomName;
  info.scoutPriority = 0;
  info.expansionScore = 0;
  info.harvestPriority = 0;

  let timeSinceLastScan = roomIntel.getAge();

  if (info.range > 0 && info.range <= 2) {
    // This is a potential room for remote mining.
    if (timeSinceLastScan > 5000) {
      info.scoutPriority = 2;
    }
    else if (roomIntel.isClaimable() && !roomIntel.isClaimed()) {
      info.harvestPriority = this.calculateHarvestScore(roomName);
      // Check if we could reasonably expand to this room.
      if (kuknob.roomIntel(info.origin).getRcl() >= 5) {
        // info.expansionScore = this.calculateExpansionScore(roomName);
      }
    }
  }
  else if (info.range > 2 && info.range <= 7) {
    // This room might be interesting for expansions.
    if (timeSinceLastScan > 5000) {
      info.scoutPriority = 1;
    }
    else {
      // Check if we could reasonably expand to this room.
      if (roomIntel.isClaimable() && !roomIntel.isClaimed() && kuknob.roomIntel(info.origin).getRcl() >= 5) {
        info.expansionScore = this.calculateExpansionScore(roomName);
      }
    }
  }
  // @todo For higher ranges (7-10), only scout if we have memory to spare.

  if (info.observer && info.range <= 6 && (/^[EW][0-9]*0[NS][0-9]+$/.test(roomName) || /^[EW][0-9]+[NS][0-9]*0$/.test(roomName)) && timeSinceLastScan > 1000) {
    // Corridor rooms get scouted more often to look for power banks.
    info.scoutPriority = 2;
  }

  if (info.scoutPriority > 0 && info.observer) {
    // Only observe if last Scan was longer ago than intel manager delay,
    // so we don't get stuck scanning the same room for some reason.
    if (timeSinceLastScan > 500) {
      // No need to manually scout rooms in range of an observer.
      info.scoutPriority = 0.5;

      // Let observer scout one room per run at maximum.
      // @todo Move this to structure management so we can scan one open room per tick.
      let observer = Game.getObjectById(info.observer);
      if (observer && !observer.hasScouted) {
        observer.observeRoom(roomName);
        observer.hasScouted = true;
      }
      else {
        if (!Memory.rooms[info.observerRoom].observeTargets) {
          Memory.rooms[info.observerRoom].observeTargets = [];
        }
        Memory.rooms[info.observerRoom].observeTargets.push(roomName);
      }
    }
  }
};

/**
 * Determines how worthwile a room is for remote mining.
 */
ScoutProcess.prototype.calculateHarvestScore = function (roomName) {
  let info = Memory.strategy.roomList[roomName];

  if (!info.safePath) return 0;

  let income = -2000; // Flat cost for room reservation
  let pathLength = 0;
  let sourcePositions = kuknob.roomIntel(roomName).getSourcePositions();
  for (let i in sourcePositions) {
    income += 3000;
    pathLength += info.range * 50; // Flag path length if it has not been calculated yet.
    if (typeof(sourcePositions[i]) == 'object') {
      let sourcePos = new RoomPosition(sourcePositions[i].x, sourcePositions[i].y, roomName);
      utilities.precalculatePaths(Game.rooms[info.origin], sourcePos);

      if (Memory.rooms[info.origin].remoteHarvesting) {
        let harvestMemory = Memory.rooms[info.origin].remoteHarvesting[utilities.encodePosition(sourcePos)];
        if (harvestMemory && harvestMemory.cachedPath) {
          pathLength -= info.range * 50;
          pathLength += harvestMemory.cachedPath.path.length;
        }
      }
    }
  }

  // @todo Add score if this is a safe room (that will be reserved
  // anyways and can't be attacked).

  if (pathLength <= 0) return 0;
  return income / pathLength;
};

/**
 * Determines how worthwile a room is for expanding.
 */
ScoutProcess.prototype.calculateExpansionScore = function (roomName) {
  let roomIntel = kuknob.roomIntel(roomName);

  // More sources is better.
  let score = roomIntel.getSourcePositions().length;

  // Having a mineral source is good.
  if (roomIntel.getMineralType()) {
    score++;
  }

  // Having fewer exit sides is good.
  let exits = roomIntel.getExits();
  score += 1 - _.size(exits) * 0.25;
  for (let i in exits) {
    let adjacentRoom = exits[i];
    let adjacentIntel = kuknob.roomIntel(adjacentRoom);

    if (adjacentIntel.isOwned()) {
      // Try not to expand too close to other players.
      // @todo Also check for room reservation.
      score -= 0.5;
    }
    else {
      let sourceFactor = 0.1;
      if (adjacentIntel.isClaimed()) {
        // If another player has reserved the adjacent room, we can't profit all that well.
        sourceFactor = 0.05;
      }

      // Adjacent rooms having more sources is good.
      score += adjacentIntel.getSourcePositions().length * sourceFactor;

      // @todo factor in path length to sources.
      // @todo If we're close to one of our own rooms, do not count double-used remote harvesting.
    }
  }

  // Having fewer exit tiles is good.
  score += 0.4 - roomIntel.countTiles('exit') * 0.002;
  // Having lots of open space is good (easier room layout).
  score += 1 - roomIntel.countTiles('wall') * 0.0005;
  // Having few swamp tiles is good (less cost for road maintenance, easier setup).
  score += 0.5 - roomIntel.countTiles('swamp') * 0.0002;

  // @todo Prefer rooms with minerals we have little sources of.
  // @todo Having dead ends / safe rooms nearby is similarly good. Counts
  // double if expanding here creates a safe direction for another of our rooms.
  return score;
};

/**
 * Generates a list of rooms originating from owned rooms.
 */
ScoutProcess.prototype.generateScoutTargets = function () {
  let roomList = {};

  let openList = this.getScoutOrigins();
  let closedList = {};

  this.findObservers();

  // Flood fill from own rooms and add rooms we need intel of.
  while (_.size(openList) > 0) {
    let nextRoom = this.getNextRoomCandidate(openList);

    if (!nextRoom) break;

    this.addAdjacentRooms(nextRoom, openList, closedList);
    let info = openList[nextRoom];
    delete openList[nextRoom];
    closedList[nextRoom] = true;

    // Add current room as a candidate for scouting.
    if (!roomList[nextRoom] || roomList[nextRoom].range > info.range) {
      let observer = this.getClosestObserver(nextRoom);

      roomList[nextRoom] = {
        range: info.range,
        origin: info.origin,
        observer: observer && observer.id,
        observerRoom: observer && observer.pos.roomName,
        safePath: info.safePath,
      };
    }
  }

  return roomList;
};

/**
 * Generates a list of rooms that can serve as a starting point for scouting.
 */
ScoutProcess.prototype.getScoutOrigins = function () {
  let openList = {};

  // Starting point for scouting operations are owned rooms.
  for (let roomName in Game.rooms) {
    let room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    openList[roomName] = {
      range: 0,
      origin: roomName,
      safePath: true,
    };
  }

  return openList;
};

/**
 * Generates a list of observer structures keyed by room name.
 */
ScoutProcess.prototype.findObservers = function () {
  this.observers = [];
  for (let roomName in Game.rooms) {
    let room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my || !room.observer) continue;

    this.observers[roomName] = room.observer;
  }
};

/**
 * Gets a the room from the list that has the lowest range from an origin point.
 */
ScoutProcess.prototype.getNextRoomCandidate = function (openList) {
  let minDist = null;
  let nextRoom = null;
  for (let rName in openList) {
    let info = openList[rName];
    if (minDist === null || info.range < minDist) {
      minDist = info.range;
      nextRoom = rName;
    }
  }

  return nextRoom;
};

/**
 * Adds unhandled adjacent rooms to open list.
 */
ScoutProcess.prototype.addAdjacentRooms = function (roomName, openList, closedList) {
  let info = openList[roomName];
  let exits = kuknob.roomIntel(roomName).getExits();
  for (let i in exits) {
    let exit = exits[i];
    if (openList[exit] || closedList[exit]) continue;

    let roomIsSafe = !kuknob.roomIntel(exit).isClaimed();

    openList[exit] = {
      range: info.range + 1,
      origin: info.origin,
      safePath: info.safePath && roomIsSafe,
    };
  }
};

/**
 * Finds the closest observer to a given room.
 */
ScoutProcess.prototype.getClosestObserver = function (roomName) {
  let observer = null;
  for (let observerRoom in this.observers) {
    let roomDist = Game.map.getRoomLinearDistance(observerRoom, roomName);
    if (roomDist <= OBSERVER_RANGE) {
      if (!observer || roomDist < Game.map.getRoomLinearDistance(observer.pos.roomName, roomName)) {
        observer = this.observers[observerRoom];
      }
    }
  }

  return observer;
};

module.exports = ScoutProcess;
