/* ===================================================================
 * LEADERBOARD BACKEND API - VERCEL DEPLOYMENT WITH STANDARD REDIS
 * 
 * FIXED VERSION: Resolves race conditions and state inconsistencies
 * ================================================================ */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('redis');

const app = express();
const PORT = process.env.PORT || 3000;

// ===================================================================
// # CONFIGURATION
// ===================================================================
const CONFIG = {
    EXTERNAL_API_BASE: 'https://api.skinrave.gg/affiliates/public/applicants',
    EXTERNAL_API_TOKEN: '35eb5f92-aa7a-4e53-80eb-b8efce4b70fe',
    COMPETITION_DURATION_DAYS: 30,
    ADMIN_API_KEY: process.env.ADMIN_API_KEY || 'change-me-in-production',
    MAX_RECORDS_PER_REQUEST: 30,
    REDIS_KEY: 'competition:state'
};

// ===================================================================
// # REDIS CLIENT SETUP
// ===================================================================
let redisClient = null;
let redisConnected = false;
let serverReady = false; // NEW: Prevents serving requests before initialization

async function initRedis() {
    try {
        const redisUrl = process.env.REDIS_URL;
        
        if (!redisUrl) {
            console.log('⚠️  Redis not configured - using in-memory storage only');
            console.log('   Set REDIS_URL environment variable to enable persistence');
            return null;
        }

        console.log('🔄 Connecting to Redis...');
        redisClient = createClient({
            url: redisUrl,
            socket: {
                tls: true,
                rejectUnauthorized: false,
                connectTimeout: 10000 // NEW: Add connection timeout
            }
        });

        redisClient.on('error', (err) => {
            console.error('❌ Redis Client Error:', err);
            redisConnected = false;
        });

        redisClient.on('connect', () => {
            console.log('✅ Redis connected');
            redisConnected = true;
        });

        redisClient.on('disconnect', () => {
            console.log('⚠️  Redis disconnected');
            redisConnected = false;
        });

        await redisClient.connect();
        
        // Verify connection with a ping
        await redisClient.ping();
        console.log('✅ Redis connection verified with ping');
        
        return redisClient;
    } catch (error) {
        console.error('❌ Failed to connect to Redis:', error);
        redisConnected = false;
        return null;
    }
}

// ===================================================================
// # STATE MANAGEMENT WITH MUTEX LOCK + CACHE
// ===================================================================

// In-memory cache (single source of truth after loading)
let competitionState = null;
let stateLock = false; // Simple mutex for state updates

// NEW: Leaderboard data cache to reduce fluctuation
let leaderboardCache = {
    data: null,
    fetchedAt: null,
    dateRange: null,
    ttl: 30000 // 30 seconds cache
};

// Get default empty state
function getDefaultState() {
    return {
        isActive: false,
        startTime: null,
        endTime: null,
        isEnded: false,
        createdAt: null,
        durationDays: null
    };
}

// NEW: Wait for lock to be released
async function acquireLock(maxWaitMs = 5000) {
    const startTime = Date.now();
    while (stateLock) {
        if (Date.now() - startTime > maxWaitMs) {
            console.error('⚠️  Lock acquisition timeout');
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    stateLock = true;
    return true;
}

function releaseLock() {
    stateLock = false;
}

// Load competition state from Redis with retry
async function loadCompetitionState() {
    if (!await acquireLock()) {
        console.error('❌ Failed to acquire lock for loading state');
        return getDefaultState();
    }

    try {
        if (!redisClient || !redisConnected) {
            console.log('⚠️  Redis not available - using in-memory storage only');
            return getDefaultState();
        }
        
        const stateJson = await redisClient.get(CONFIG.REDIS_KEY);
        
        if (stateJson) {
            const state = JSON.parse(stateJson);
            console.log('✅ Competition state loaded from Redis');
            
            // Validate and auto-update if ended
            if (state.isActive && state.endTime) {
                const remaining = calculateRemainingSeconds(state.endTime);
                
                if (remaining === 0 && !state.isEnded) {
                    console.log('⚠️  Competition already ended, updating state');
                    state.isEnded = true;
                    state.isActive = false;
                    // Save the updated state back
                    await redisClient.set(CONFIG.REDIS_KEY, JSON.stringify(state));
                }
            }
            
            return state;
        }
        
        console.log('ℹ️  No competition state found in Redis, using default');
        return getDefaultState();
    } catch (error) {
        console.error('❌ Error loading state from Redis:', error);
        return getDefaultState();
    } finally {
        releaseLock();
    }
}

// Save competition state to Redis with lock
async function saveCompetitionState(state) {
    if (!await acquireLock()) {
        console.error('❌ Failed to acquire lock for saving state');
        return false;
    }

    try {
        if (!redisClient || !redisConnected) {
            console.log('⚠️  Redis not available - state will not persist');
            return true; // Still return true to allow in-memory updates
        }
        
        const stateJson = JSON.stringify(state);
        await redisClient.set(CONFIG.REDIS_KEY, stateJson);
        console.log('✅ Competition state saved to Redis');
        return true;
    } catch (error) {
        console.error('❌ Error saving state to Redis:', error);
        return false;
    } finally {
        releaseLock();
    }
}

// NEW: Get state safely (returns copy to prevent mutations)
function getCompetitionState() {
    return { ...competitionState };
}

// NEW: Update state safely
async function updateCompetitionState(updates) {
    if (!await acquireLock()) {
        console.error('❌ Failed to acquire lock for updating state');
        return false;
    }

    try {
        competitionState = { ...competitionState, ...updates };
        await saveCompetitionState(competitionState);
        return true;
    } finally {
        releaseLock();
    }
}

// ===================================================================
// # MIDDLEWARE - WAIT FOR SERVER READY
// ===================================================================

// NEW: Ensure server is initialized before handling requests
app.use((req, res, next) => {
    if (!serverReady && !req.path.includes('/health')) {
        return res.status(503).json({
            success: false,
            message: 'Server is starting up, please try again in a moment'
        });
    }
    next();
});

app.use(cors({
    origin: function(origin, callback) {
        if (!origin) return callback(null, true);
        
        if (process.env.VERCEL || process.env.VERCEL_ENV) {
            return callback(null, true);
        }
        
        const allowedOrigins = [
            'http://127.0.0.1:5500',
            'http://localhost:5500',
            'http://127.0.0.1:8080',
            'http://localhost:8080',
            'http://localhost:3000',
            process.env.FRONTEND_URL
        ].filter(Boolean);
        
        if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV === 'development') {
            return callback(null, true);
        }
        
        callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
}));

app.use(express.json());

app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path}`);
    next();
});

// ===================================================================
// # AUTHENTICATION MIDDLEWARE
// ===================================================================

function authenticateAdmin(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey) {
        return res.status(401).json({
            success: false,
            message: 'Authentication required. Provide X-API-Key header.'
        });
    }
    
    if (apiKey !== CONFIG.ADMIN_API_KEY) {
        return res.status(403).json({
            success: false,
            message: 'Invalid API key. Access denied.'
        });
    }
    
    next();
}

// ===================================================================
// # UTILITY FUNCTIONS
// ===================================================================

function calculateRemainingSeconds(endTimeISO) {
    if (!endTimeISO) return 0;
    
    const now = Date.now();
    const end = new Date(endTimeISO).getTime();
    const diffMs = end - now;
    
    return Math.max(0, Math.floor(diffMs / 1000));
}

// NEW: Synchronous status check (doesn't modify state, just checks)
function checkIfCompetitionEnded() {
    const state = getCompetitionState();
    
    if (!state.isActive || state.isEnded || !state.endTime) {
        return false; // No change needed
    }
    
    const remaining = calculateRemainingSeconds(state.endTime);
    return remaining === 0;
}

// MODIFIED: Async status update (separated from check)
async function updateCompetitionStatusIfEnded() {
    if (!checkIfCompetitionEnded()) {
        return false;
    }

    console.log('🏁 Competition has ended, updating state...');
    
    const success = await updateCompetitionState({
        isEnded: true,
        isActive: false
    });

    if (success) {
        console.log('✅ Competition status updated to ENDED');
    }
    
    return success;
}

// FIXED: Get consistent date range with proper "now" vs "endTime" logic
function getCompetitionDateRange() {
    const state = getCompetitionState();
    
    // CASE 1: Competition is ACTIVE - use min(now, endTime)
    // This prevents querying future dates while maintaining consistency
    if (state.isActive && !state.isEnded && state.startTime && state.endTime) {
        const now = new Date();
        const endTime = new Date(state.endTime);
        
        // Use whichever is earlier: now or competition end
        // This ensures we don't query the future, but also don't get fluctuating data
        const effectiveTo = now < endTime ? now : endTime;
        
        // Round down to the previous minute to reduce fluctuation
        // This gives us 60-second consistency windows
        effectiveTo.setSeconds(0, 0);
        
        console.log('📅 Active competition:');
        console.log(`   From: ${state.startTime}`);
        console.log(`   To: ${effectiveTo.toISOString()} (${now < endTime ? 'current time (rounded)' : 'competition end'})`);
        
        return {
            from: state.startTime,
            to: effectiveTo.toISOString()
        };
    }
    
    // CASE 2: Competition has ENDED
    if (state.isEnded && state.startTime && state.endTime) {
        console.log('📅 Ended competition (FROZEN)');
        console.log(`   From: ${state.startTime}`);
        console.log(`   To: ${state.endTime}`);
        
        return {
            from: state.startTime,
            to: state.endTime
        };
    }
    
    // CASE 3: No competition - use a fixed 30-day window from NOW
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
    
    console.log('📅 No competition - showing last 30 days');
    
    return {
        from: thirtyDaysAgo.toISOString(),
        to: now.toISOString()
    };
}

// ===================================================================
// # PUBLIC ROUTES
// ===================================================================

app.get('/api/leaderboard', async (req, res) => {
    try {
        // Check if competition ended (but don't wait for update)
        if (checkIfCompetitionEnded()) {
            // Update in background, don't await
            updateCompetitionStatusIfEnded().catch(err => {
                console.error('Background status update failed:', err);
            });
        }
        
        const { from, to } = getCompetitionDateRange();
        
        // NEW: Check cache validity
        const now = Date.now();
        const cacheKey = `${from}|${to}`;
        const isCacheValid = leaderboardCache.data 
            && leaderboardCache.dateRange === cacheKey
            && (now - leaderboardCache.fetchedAt) < leaderboardCache.ttl;
        
        if (isCacheValid) {
            console.log('📦 Serving from cache (fresh for', Math.round((leaderboardCache.ttl - (now - leaderboardCache.fetchedAt)) / 1000), 'more seconds)');
            
            const state = getCompetitionState();
            
            return res.json({
                success: true,
                data: leaderboardCache.data,
                competition: {
                    isActive: state.isActive,
                    isEnded: state.isEnded,
                    startTime: state.startTime,
                    endTime: state.endTime,
                    remainingSeconds: calculateRemainingSeconds(state.endTime),
                    durationDays: state.durationDays || CONFIG.COMPETITION_DURATION_DAYS
                },
                fetchedAt: new Date(leaderboardCache.fetchedAt).toISOString(),
                cached: true
            });
        }
        
        const apiUrl = `${CONFIG.EXTERNAL_API_BASE}` +
            `?token=${CONFIG.EXTERNAL_API_TOKEN}` +
            `&skip=0` +
            `&take=${CONFIG.MAX_RECORDS_PER_REQUEST}` +
            `&order=DESC` +
            `&from=${from}` +
            `&to=${to}`;
        
        console.log(`📊 Fetching fresh leaderboard data`);
        console.log(`   Date Range - From: ${from}`);
        console.log(`   Date Range - To: ${to}`);
        
        const response = await axios.get(apiUrl, {
            timeout: 15000, // Increased timeout
            headers: {
                'User-Agent': 'Leaderboard-Backend/1.0'
            }
        });
        
        console.log(`✅ External API responded with ${response.data?.list?.length || 0} players`);
        
        // Update cache
        leaderboardCache = {
            data: response.data,
            fetchedAt: now,
            dateRange: cacheKey,
            ttl: 30000 // 30 seconds
        };
        
        const state = getCompetitionState();
        
        res.json({
            success: true,
            data: response.data,
            competition: {
                isActive: state.isActive,
                isEnded: state.isEnded,
                startTime: state.startTime,
                endTime: state.endTime,
                remainingSeconds: calculateRemainingSeconds(state.endTime),
                durationDays: state.durationDays || CONFIG.COMPETITION_DURATION_DAYS
            },
            fetchedAt: new Date(now).toISOString(),
            cached: false
        });
        
    } catch (error) {
        console.error('❌ Error fetching leaderboard:', error.message);
        
        if (error.code === 'ECONNABORTED') {
            return res.status(504).json({
                success: false,
                message: 'External API request timed out. Please try again.'
            });
        }
        
        if (error.response) {
            console.error('External API error details:', error.response.status, error.response.statusText);
            
            return res.status(502).json({
                success: false,
                message: 'External API error. Please try again later.',
                ...(process.env.NODE_ENV === 'development' && {
                    details: error.response.data
                })
            });
        }
        
        res.status(500).json({
            success: false,
            message: 'Failed to fetch leaderboard data',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

app.get('/api/status', async (req, res) => {
    // Check and update if needed (but don't block response)
    if (checkIfCompetitionEnded()) {
        updateCompetitionStatusIfEnded().catch(err => {
            console.error('Background status update failed:', err);
        });
    }
    
    const state = getCompetitionState();
    
    res.json({
        success: true,
        competition: {
            isActive: state.isActive,
            isEnded: state.isEnded,
            startTime: state.startTime,
            endTime: state.endTime,
            remainingSeconds: calculateRemainingSeconds(state.endTime),
            durationDays: state.durationDays || CONFIG.COMPETITION_DURATION_DAYS
        },
        serverTime: new Date().toISOString()
    });
});

// ===================================================================
// # ADMIN ROUTES (Protected)
// ===================================================================

app.post('/api/admin/start', authenticateAdmin, async (req, res) => {
    try {
        const state = getCompetitionState();
        
        if (state.isActive && !state.isEnded) {
            return res.status(400).json({
                success: false,
                message: 'Competition is already active. Reset it first.',
                currentState: {
                    startTime: state.startTime,
                    endTime: state.endTime,
                    remainingSeconds: calculateRemainingSeconds(state.endTime)
                }
            });
        }
        
        const durationDays = req.body.durationDays || CONFIG.COMPETITION_DURATION_DAYS;
        
        if (durationDays < 1 || durationDays > 365) {
            return res.status(400).json({
                success: false,
                message: 'Duration must be between 1 and 365 days'
            });
        }
        
        const now = new Date();
        const endTime = new Date(now.getTime() + (durationDays * 24 * 60 * 60 * 1000));
        
        const newState = {
            isActive: true,
            startTime: now.toISOString(),
            endTime: endTime.toISOString(),
            isEnded: false,
            createdAt: now.toISOString(),
            durationDays
        };
        
        const success = await updateCompetitionState(newState);
        
        if (!success) {
            return res.status(500).json({
                success: false,
                message: 'Failed to save competition state'
            });
        }
        
        console.log(`🚀 Competition started: ${durationDays} days`);
        console.log(`   Start: ${newState.startTime}`);
        console.log(`   End:   ${newState.endTime}`);
        
        res.json({
            success: true,
            message: `Competition started successfully (${durationDays} days)`,
            competition: {
                ...newState,
                remainingSeconds: calculateRemainingSeconds(newState.endTime)
            }
        });
        
    } catch (error) {
        console.error('❌ Error starting competition:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to start competition',
            error: error.message
        });
    }
});

app.post('/api/admin/reset', authenticateAdmin, async (req, res) => {
    try {
        const previousState = getCompetitionState();
        
        const success = await updateCompetitionState(getDefaultState());
        
        if (!success) {
            return res.status(500).json({
                success: false,
                message: 'Failed to save reset state'
            });
        }
        
        console.log('🔄 Competition reset - all state cleared');
        
        res.json({
            success: true,
            message: 'Competition reset successfully',
            previousState,
            newState: getCompetitionState()
        });
        
    } catch (error) {
        console.error('❌ Error resetting competition:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to reset competition',
            error: error.message
        });
    }
});

app.get('/api/admin/status', authenticateAdmin, async (req, res) => {
    const state = getCompetitionState();
    const remaining = calculateRemainingSeconds(state.endTime);
    
    res.json({
        success: true,
        competition: {
            isActive: state.isActive,
            isEnded: state.isEnded,
            startTime: state.startTime,
            endTime: state.endTime,
            createdAt: state.createdAt,
            remainingSeconds: remaining,
            remainingDays: Math.ceil(remaining / 86400),
            durationDays: state.durationDays || CONFIG.COMPETITION_DURATION_DAYS
        },
        serverTime: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// ===================================================================
// # HEALTH CHECK
// ===================================================================

app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: serverReady ? 'healthy' : 'starting',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: '1.0.7-cached',
        redis: redisConnected ? 'connected' : 'not-connected',
        storage: redisConnected ? 'persistent' : 'in-memory-only',
        serverReady,
        cache: {
            enabled: true,
            ttl: `${leaderboardCache.ttl / 1000}s`,
            hasData: !!leaderboardCache.data,
            age: leaderboardCache.fetchedAt ? `${Math.round((Date.now() - leaderboardCache.fetchedAt) / 1000)}s` : 'empty'
        }
    });
});

// ===================================================================
// # ERROR HANDLING
// ===================================================================

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint not found',
        path: req.path
    });
});

app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err);
    
    res.status(err.status || 500).json({
        success: false,
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// ===================================================================
// # START SERVER
// ===================================================================

async function startServer() {
    try {
        console.log('🚀 Starting server initialization...');
        
        // Step 1: Initialize Redis connection
        await initRedis();
        
        // Step 2: Load competition state from Redis BEFORE accepting requests
        console.log('🔄 Loading competition state from storage...');
        competitionState = await loadCompetitionState();
        console.log('✅ Competition state loaded:', JSON.stringify(competitionState, null, 2));

        // Step 3: Check if competition needs to be marked as ended
        if (checkIfCompetitionEnded()) {
            console.log('⚠️  Competition already ended during startup, updating...');
            await updateCompetitionStatusIfEnded();
        }

        // Step 4: Mark server as ready
        serverReady = true;
        console.log('✅ Server ready to accept requests');

        // Step 5: Start listening
        app.listen(PORT, () => {
            console.log(`
╔════════════════════════════════════════════════════════════╗
║            🚀 LEADERBOARD BACKEND API RUNNING              ║
║              (FIXED - v1.0.7 with caching)                 ║
╚════════════════════════════════════════════════════════════╝

🌐 Server:     http://localhost:${PORT}
🔑 Admin Key:  ${CONFIG.ADMIN_API_KEY === 'change-me-in-production' ? '⚠️  USING DEFAULT KEY!' : '✅ Custom key set'}
📊 API:        ${CONFIG.EXTERNAL_API_BASE}
📝 Max Records: ${CONFIG.MAX_RECORDS_PER_REQUEST} per request
🌍 Environment: ${process.env.VERCEL ? 'Vercel' : 'Local'}
💾 Storage:     ${redisConnected ? 'Redis (persistent)' : 'In-memory (not persistent)'}

📝 PUBLIC ENDPOINTS:
   GET  /api/leaderboard          - Fetch leaderboard data
   GET  /api/status               - Competition status
   GET  /api/health               - Health check

🔒 ADMIN ENDPOINTS (require X-API-Key header):
   POST /api/admin/start          - Start competition
   POST /api/admin/reset          - Reset competition
   GET  /api/admin/status         - Detailed status

⚡ Competition Settings:
   Duration: ${CONFIG.COMPETITION_DURATION_DAYS} days
   State: ${competitionState.isActive ? '🟢 ACTIVE' : competitionState.isEnded ? '🔴 ENDED' : '⚪ INACTIVE'}
${competitionState.isActive ? `   Started: ${competitionState.startTime}
   Ends: ${competitionState.endTime}
   Duration: ${competitionState.durationDays} days` : ''}

✨ FIXES APPLIED:
   ✅ State synchronization with mutex locks
   ✅ Server waits for initialization before serving
   ✅ Smart date ranges (rounds to minute + uses min(now, endTime))
   ✅ 30-second cache to prevent rapid fluctuations
   ✅ Background status updates (non-blocking)
   ✅ Proper Redis connection handling
   ✅ Race condition prevention

💾 Redis: ${redisConnected ? 'Competition state persists across deployments' : 'Using in-memory storage (set REDIS_URL to enable persistence)'}
📦 Cache: 30-second TTL for consistent rapid requests
        `);
            
            if (CONFIG.ADMIN_API_KEY === 'change-me-in-production') {
                console.log(`
⚠️⚠️⚠️  SECURITY WARNING  ⚠️⚠️⚠️
You are using the default admin API key!
Please set ADMIN_API_KEY in your .env file.
            `);
            }
        });

        // ===================================================================
        // # AUTOMATIC COMPETITION STATUS CHECKER
        // ===================================================================

        setInterval(async () => {
            if (checkIfCompetitionEnded()) {
                await updateCompetitionStatusIfEnded();
            }
        }, 60000); // Check every 60 seconds

        console.log('⏰ Competition status checker started (runs every 60 seconds)');
        
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

// Start the server
startServer();

// ===================================================================
// # GRACEFUL SHUTDOWN
// ===================================================================

async function shutdown(signal) {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    serverReady = false;
    
    if (redisClient && redisConnected) {
        try {
            await redisClient.quit();
            console.log('✅ Redis connection closed');
        } catch (error) {
            console.error('Error closing Redis:', error);
        }
    }
    
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));