export function parsePositiveIntEnv(name, fallback, min = 1, max = 500) {
  const parsed = parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(max, parsed);
}

export const MAX_NET_DOWNLOADS = parsePositiveIntEnv('MAX_NET_DOWNLOADS', 4, 1, 16);
export const MAX_CPU_JOBS = parsePositiveIntEnv('MAX_CPU_JOBS', 2, 1, 8);
export const MAX_PER_USER = parsePositiveIntEnv('MAX_PER_USER', 2, 1, 8);
export const MAX_QUEUED_PER_USER = parsePositiveIntEnv('MAX_QUEUED_PER_USER', 50, 1, 500);

export function createPoolState(options = {}) {
  return {
    maxNetDownloads: options.maxNetDownloads ?? MAX_NET_DOWNLOADS,
    maxCpuJobs: options.maxCpuJobs ?? MAX_CPU_JOBS,
    maxPerUser: options.maxPerUser ?? MAX_PER_USER,
    maxQueuedPerUser: options.maxQueuedPerUser ?? MAX_QUEUED_PER_USER,
    netRunning: 0,
    netActiveByUser: new Map(),
    netQueuesByUser: new Map(),
    netTurnOrder: [],
    cpuRunning: 0,
    cpuActiveByUser: new Map(),
    cpuQueuesByUser: new Map(),
    cpuTurnOrder: []
  };
}

if (!global.__extractionPools) {
  global.__extractionPools = createPoolState();
}
const defaultPools = global.__extractionPools;
if (!defaultPools.cpuActiveByUser) {
  defaultPools.cpuActiveByUser = new Map();
}
if (!defaultPools.maxNetDownloads) {
  defaultPools.maxNetDownloads = MAX_NET_DOWNLOADS;
  defaultPools.maxCpuJobs = MAX_CPU_JOBS;
  defaultPools.maxPerUser = MAX_PER_USER;
  defaultPools.maxQueuedPerUser = MAX_QUEUED_PER_USER;
}

export function getDefaultPools() {
  return defaultPools;
}

export function getUserQueuedCount(userId, pools = defaultPools) {
  const uid = String(userId || 'anon');
  const q = pools.netQueuesByUser.get(uid);
  return q ? q.length : 0;
}

export function computePresentUsersAndFairShare(pools = defaultPools) {
  const maxNet = pools.maxNetDownloads ?? MAX_NET_DOWNLOADS;

  for (let i = pools.netTurnOrder.length - 1; i >= 0; i--) {
    const uid = pools.netTurnOrder[i];
    const q = pools.netQueuesByUser.get(uid);
    if (!q || q.length === 0) {
      pools.netQueuesByUser.delete(uid);
      pools.netTurnOrder.splice(i, 1);
    }
  }

  for (const [uid, count] of pools.netActiveByUser.entries()) {
    if (!count || count <= 0) {
      pools.netActiveByUser.delete(uid);
    }
  }

  const present = new Set([
    ...pools.netTurnOrder,
    ...pools.netActiveByUser.keys()
  ]);
  const presentCount = Math.max(1, present.size);
  // Guaranteed minimum per present user:
  // 1 user -> 4 | 2 users -> 2 | 3 users -> 1 (+ 1 extra via Pass 2) | 4+ users -> 1
  const fairShare = Math.max(1, Math.floor(maxNet / presentCount));
  return { present, presentCount, fairShare, maxNet };
}

export function pumpNetQueue(pools = defaultPools) {
  const maxNet = pools.maxNetDownloads ?? MAX_NET_DOWNLOADS;

  while (pools.netRunning < maxNet && pools.netTurnOrder.length > 0) {
    const { fairShare } = computePresentUsersAndFairShare(pools);
    if (pools.netTurnOrder.length === 0) break;

    let pickedIndex = -1;

    // Pass 1 (Fair Share Guarantee): pick the first user in turn order with active < fairShare
    for (let i = 0; i < pools.netTurnOrder.length; i++) {
      const candidateUid = pools.netTurnOrder[i];
      const userActive = pools.netActiveByUser.get(candidateUid) || 0;
      if (userActive < fairShare) {
        pickedIndex = i;
        break;
      }
    }

    // Pass 2 (Work-Conserving): if all queued users already reached fairShare but network slots
    // are still available, assign the spare slot to the queued user with the fewest active slots
    if (pickedIndex === -1) {
      let minActive = Infinity;
      for (let i = 0; i < pools.netTurnOrder.length; i++) {
        const candidateUid = pools.netTurnOrder[i];
        const userActive = pools.netActiveByUser.get(candidateUid) || 0;
        if (userActive < maxNet && userActive < minActive) {
          minActive = userActive;
          pickedIndex = i;
        }
      }
    }

    if (pickedIndex === -1) break;

    const [uid] = pools.netTurnOrder.splice(pickedIndex, 1);
    const q = pools.netQueuesByUser.get(uid);
    const entry = q.shift();
    if (q.length > 0) {
      pools.netTurnOrder.push(uid);
    } else {
      pools.netQueuesByUser.delete(uid);
    }

    pools.netRunning += 1;
    pools.netActiveByUser.set(uid, (pools.netActiveByUser.get(uid) || 0) + 1);

    let slotReleased = false;
    const releaseNetSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      pools.netRunning = Math.max(0, pools.netRunning - 1);
      const curUserActive = (pools.netActiveByUser.get(uid) || 1) - 1;
      if (curUserActive <= 0) {
        pools.netActiveByUser.delete(uid);
      } else {
        pools.netActiveByUser.set(uid, curUserActive);
      }
      pumpNetQueue(pools);
    };

    Promise.resolve()
      .then(() => entry.fn(releaseNetSlot))
      .then(entry.resolve, entry.reject)
      .finally(() => {
        releaseNetSlot();
      });
  }
}

export function enqueueNetDownload(
  userId,
  downloadId,
  isManualRequest,
  taskFn,
  pools = defaultPools
) {
  const uid = String(userId || 'anon');
  return new Promise((resolve, reject) => {
    let userQueue = pools.netQueuesByUser.get(uid);
    if (!userQueue) {
      userQueue = [];
      pools.netQueuesByUser.set(uid, userQueue);
    }
    if (!pools.netTurnOrder.includes(uid)) {
      pools.netTurnOrder.push(uid);
    }

    // Server-controlled priority: a single manual download can move ahead of the same user's bulk items,
    // but never bypasses the round-robin turn order of other users.
    const hasQueuedManual = userQueue.some(e => e.isManualPriority);
    const grantLocalPriority = Boolean(isManualRequest) && !hasQueuedManual;
    const entry = {
      downloadId,
      isManualPriority: grantLocalPriority,
      fn: taskFn,
      resolve,
      reject
    };

    if (grantLocalPriority) {
      userQueue.unshift(entry);
    } else {
      userQueue.push(entry);
    }

    pumpNetQueue(pools);
  });
}

export function acquireContinuationNetSlot(userId, pools = defaultPools) {
  return new Promise(resolve => {
    enqueueNetDownload(
      userId,
      null,
      true,
      releaseSlot =>
        new Promise(done => {
          resolve(() => {
            releaseSlot();
            done();
          });
        }),
      pools
    );
  });
}

export function pumpCpuQueue(pools = defaultPools) {
  const maxCpu = pools.maxCpuJobs ?? MAX_CPU_JOBS;

  while (pools.cpuRunning < maxCpu && pools.cpuTurnOrder.length > 0) {
    let pickedIndex = -1;
    for (let i = 0; i < pools.cpuTurnOrder.length; i++) {
      const candidateUid = pools.cpuTurnOrder[i];
      const q = pools.cpuQueuesByUser.get(candidateUid);
      if (!q || q.length === 0) {
        pools.cpuQueuesByUser.delete(candidateUid);
        pools.cpuTurnOrder.splice(i, 1);
        i -= 1;
        continue;
      }
      pickedIndex = i;
      break;
    }

    if (pickedIndex === -1) break;

    const [uid] = pools.cpuTurnOrder.splice(pickedIndex, 1);
    const q = pools.cpuQueuesByUser.get(uid);
    const entry = q.shift();
    if (q.length > 0) {
      pools.cpuTurnOrder.push(uid);
    } else {
      pools.cpuQueuesByUser.delete(uid);
    }

    pools.cpuRunning += 1;
    pools.cpuActiveByUser.set(uid, (pools.cpuActiveByUser.get(uid) || 0) + 1);
    if (typeof entry.onSlotAcquired === 'function') {
      try {
        entry.onSlotAcquired();
      } catch {}
    }

    Promise.resolve()
      .then(() => entry.fn())
      .then(entry.resolve, entry.reject)
      .finally(() => {
        pools.cpuRunning = Math.max(0, pools.cpuRunning - 1);
        const curCpuActive = (pools.cpuActiveByUser.get(uid) || 1) - 1;
        if (curCpuActive <= 0) {
          pools.cpuActiveByUser.delete(uid);
        } else {
          pools.cpuActiveByUser.set(uid, curCpuActive);
        }
        pumpCpuQueue(pools);
      });
  }
}

export function enqueueCpuJob(userId, taskFn, onSlotAcquired = null, pools = defaultPools) {
  const uid = String(userId || 'anon');
  return new Promise((resolve, reject) => {
    let q = pools.cpuQueuesByUser.get(uid);
    if (!q) {
      q = [];
      pools.cpuQueuesByUser.set(uid, q);
    }
    if (!pools.cpuTurnOrder.includes(uid)) {
      pools.cpuTurnOrder.push(uid);
    }
    q.push({ fn: taskFn, onSlotAcquired, resolve, reject });
    pumpCpuQueue(pools);
  });
}

export function getPoolStatus(userId = null, downloadId = null, pools = defaultPools) {
  const uid = String(userId || 'anon');
  const userNetActive = pools.netActiveByUser.get(uid) || 0;
  const userCpuActive = pools.cpuActiveByUser.get(uid) || 0;
  const userActive = userNetActive + userCpuActive;
  const userQueue = pools.netQueuesByUser.get(uid) || [];
  const userQueued = userQueue.length;
  const { presentCount, fairShare, maxNet } = computePresentUsersAndFairShare(pools);
  const maxQueued = pools.maxQueuedPerUser ?? MAX_QUEUED_PER_USER;

  let aheadInQueue = 0;
  const targetIdx = downloadId
    ? userQueue.findIndex(e => e.downloadId === downloadId)
    : userQueued > 0
    ? 0
    : -1;

  if (targetIdx >= 0) {
    const turnPos = pools.netTurnOrder.indexOf(uid);
    for (let i = 0; i < pools.netTurnOrder.length; i++) {
      const otherUid = pools.netTurnOrder[i];
      const otherLen = pools.netQueuesByUser.get(otherUid)?.length || 0;
      if (otherUid === uid) {
        aheadInQueue += targetIdx;
      } else if (turnPos === -1 || i < turnPos) {
        aheadInQueue += Math.min(otherLen, targetIdx + 1);
      } else {
        aheadInQueue += Math.min(otherLen, targetIdx);
      }
    }
  }

  return {
    active: userActive,
    queued: userQueued,
    aheadInQueue,
    statusText: aheadInQueue > 0 ? `${aheadInQueue} delante de ti` : null,
    max: fairShare,
    maxNet,
    presentUsers: presentCount,
    maxQueued
  };
}
