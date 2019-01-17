var utilities = require('utilities');

var wallHealth = {
    0: 1,
    1: 5000,
    2: 30000,
    3: 100000,
    4: 300000,
    5: 1000000,
    6: 2000000,
    7: 5000000,
    8: 300000000,
};

/**
 * Collects information about all damaged or unfinished buildings in the current room.
 */
Creep.prototype.getAvailableBuilderTargets = function () {
    var creep = this;
    var options = [];

    var targets = creep.room.find(FIND_STRUCTURES, {
        filter: (structure) => structure.hits < structure.hitsMax && !structure.needsDismantling()
    });

    for (let i in targets) {
        let target = targets[i];

        let option = {
            priority: 3,
            weight: 1 - target.hits / target.hitsMax,
            type: 'structure',
            object: target,
        };

        let maxHealth = target.hitsMax;
        if (target.structureType == STRUCTURE_WALL || target.structureType == STRUCTURE_RAMPART) {
            option.priority--;
            if (target.structureType == STRUCTURE_WALL) {
                option.priority--;
            }

            // Walls and ramparts get repaired up to a certain health level.
            maxHealth = wallHealth[target.room.controller.level];
            if (target.hits >= maxHealth * 0.9) {
                if (target.hits < target.hitsMax && target.structureType == STRUCTURE_RAMPART) {
                    // This has really low priority.
                    option.priority = 0;
                    maxHealth = target.hitsMax;
                }
                else {
                    // Skip this.
                    continue;
                }
            }
            option.weight = 1 - target.hits / maxHealth;
            option.maxHealth = maxHealth;

            if (target.structureType == STRUCTURE_RAMPART && target.hits < 10000 && this.room.controller.level >= 4) {
                // Low ramparts get special treatment so they don't decay.
                option.priority++;
                option.weight++;
            }
        }
        else {
            if (target.hits / maxHealth > 0.9) {
                option.priority--;
            }
            if (target.hits / maxHealth < 0.2) {
                option.priority++;
            }

            // Roads are not that important, repair only when low.
            if (target.structureType == STRUCTURE_ROAD && target.hits > 1000) {
                option.priority--;
            }
        }

        // For many decaying structures, we don't care if they're "almost" full.
        if (target.structureType == STRUCTURE_ROAD || target.structureType == STRUCTURE_RAMPART || target.structureType == STRUCTURE_CONTAINER) {
            if (target.hits / maxHealth > 0.9) {
                continue;
            }
        }

        // Slightly adjust weight so that closer structures get prioritized. Not for walls or Ramparts, though, we want those to be equally strong all arond.
        if (target.structureType != STRUCTURE_RAMPART && target.structureType != STRUCTURE_WALL) {
            option.weight -= creep.pos.getRangeTo(target) / 100;
        }

        option.priority -= creep.room.getCreepsWithOrder('repair', target.id).length;

        options.push(option);
    }

    targets = creep.room.find(FIND_MY_CONSTRUCTION_SITES);
    for (let i in targets) {
        let target = targets[i];

        let option = {
            priority: 4,
            weight: 1,
            type: 'site',
            object: target,
        };

        // Slightly adjust weight so that closer sites get prioritized.
        option.weight -= creep.pos.getRangeTo(target) / 100;

        option.priority -= creep.room.getCreepsWithOrder('build', target.id).length;

        if (target.structureType == STRUCTURE_SPAWN) {
            // Spawns have highest construction priority - we want to make
            // sure moving a spawn always works out.
            option.priority = 5;
        }

        options.push(option);
    }

    return options;
};

/**
 * Sets a good repair or build target for this creep.
 */
Creep.prototype.calculateBuilderTarget = function () {
    var creep = this;
    var best = utilities.getBestOption(creep.getAvailableBuilderTargets());

    if (best) {
        //console.log('best repair target for this', creep.memory.role , ':', best.object.structureType, best.object.id, '@ priority', best.priority, best.weight, 'HP:', best.object.hits, '/', best.object.hitsMax);
        if (best.type == 'structure') {
            creep.memory.order = {
                type: 'repair',
                target: best.object.id,
                maxHealth: best.maxHealth,
            };

            //kuknob.log('creeps', this.pos.roomName).debug(creep.name, 'is now repairing', best.object);
        }
        else if (best.type == 'site') {
            creep.memory.order = {
                type: 'build',
                target: best.object.id,
            };

            //kuknob.log('creeps', this.pos.roomName).debug(creep.name, 'is now building', best.object);
        }
    }
    else {
        delete creep.memory.order;
    }
};

/**
 * Makes the creep repair damaged buildings.
 */
Creep.prototype.performRepair = function () {
    var creep = this;
    if (!creep.memory.order || !creep.memory.order.target) {
        creep.calculateBuilderTarget();
    }
    if (!creep.memory.order || !creep.memory.order.target) {
        return false;
    }
    var target = Game.getObjectById(creep.memory.order.target);
    if (!target) {
        creep.calculateBuilderTarget();
        return true;
    }

    if (creep.memory.order.type == 'repair') {
        var maxHealth = target.hitsMax;
        if (creep.memory.order.maxHealth) {
            maxHealth = creep.memory.order.maxHealth;

            // Repair ramparts past their maxHealth to counteract decaying.
            if (target.structureType == STRUCTURE_RAMPART) {
                maxHealth = Math.min(maxHealth + 10000, target.hitsMax);
            }
        }
        if (!target.hits || target.hits >= maxHealth) {
            creep.calculateBuilderTarget();
            return true;
        }

        creep.repairTarget(target);
        return true;
    }
    else if (creep.memory.order.type == 'build') {
        this.buildTarget(target);
        return true;
    }
    else {
        // Unknown order type, recalculate!
        kuknob.log('creeps', this.pos.roomName).info('Unknown order type detected on', creep.name);
        creep.calculateBuilderTarget();
        return true;
    }
};

/**
 * Moves towards a target structure and repairs it once close enough.
 */
Creep.prototype.repairTarget = function (target) {
    if (this.pos.getRangeTo(target) > 3) {
        this.moveToRange(target, 3);

        // Also try to repair things that are close by when appropriate.
        if ((this.carry.energy > this.carryCapacity * 0.7 || this.carry.energy < this.carryCapacity * 0.3) && !utilities.throttle(this.memory.throttleOffset)) {
            this.repairNearby();
        }
    }
    else {
        this.repair(target);
    }
};

/**
 * Moves towards a target construction site and builds it once close enough.
 */
Creep.prototype.buildTarget = function (target) {
    if (this.pos.getRangeTo(target) > 3) {
        this.moveToRange(target, 3);

        // Also try to repair things that are close by when appropriate.
        if ((this.carry.energy > this.carryCapacity * 0.7 || this.carry.energy < this.carryCapacity * 0.3) && !utilities.throttle(this.memory.throttleOffset)) {
            this.repairNearby();
        }
    }
    else {
        this.build(target);
    }
};

/**
 * While not actively working on anything else, use carried energy to repair nearby structures.
 */
Creep.prototype.repairNearby = function () {
    let workParts = this.memory.body.work;
    if (workParts) {
        var needsRepair = this.room.find(FIND_STRUCTURES);
        for (let i in needsRepair) {
            let structure = needsRepair[i];
            if (this.pos.getRangeTo(structure) > 3) continue;
            if (structure.needsDismantling()) continue;

            let maxHealth = structure.hitsMax;
            if (structure.structureType == STRUCTURE_RAMPART || structure.structureType == STRUCTURE_WALL) {
                maxHealth = wallHealth[structure.room.controller.level];
            }
            if (structure.hits <= maxHealth - workParts * 100) {
                if (needsRepair.length > 0) {
                    this.repair(needsRepair[0]);
                }
                return true;
            }
        }
    }
};

/**
 * Puts this creep into or out of repair mode.
 */
Creep.prototype.setBuilderState = function (repairing) {
    this.memory.repairing = repairing;
    delete this.memory.tempRole;
    delete this.memory.order;
};

/**
 * Makes this creep behave like a builder.
 */
Creep.prototype.runBuilderLogic = function () {
    if (this.memory.repairing && this.carry.energy == 0) {
        this.setBuilderState(false);
    }
    else if (!this.memory.repairing && _.sum(this.carry) >= this.carryCapacity * 0.9) {
        this.setBuilderState(true);
    }

    if (this.memory.repairing) {
        if (Game.cpu.bucket < 500) {
            return;
        }
        return this.performRepair();
    }
    else {
        this.performGetEnergy();
        return true;
    }
};
