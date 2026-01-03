/* ===================================================================
 * LEADERBOARD BACKEND API - Express.js (COMPLETE FIXED VERSION)
 * 
 * Features:
 * - Public leaderboard endpoint (proxies external API)
 * - Admin-protected endpoints for timer control
 * - 30-day competition timer management
 * - CORS enabled for local and hosted frontends
 * - Fixed date range logic (never queries future data)
 * - Auto-check for competition end
 * 
 * Setup:
 * 1. npm install express axios dotenv cors
 * 2. Create .env file with ADMIN_API_KEY=your_secret_key
 * 3. node src/index.js
 * ================================================================ */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const redis = require('redis');

// Create Redis client
const redisClient = redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));

// Connect to Redis
(async () => {
    await redisClient.connect();
    console.log('✅ Connected to Redis');
})();

// ===================================================================
// # CONFIGURATION
// ===================================================================
const CONFIG = {
    EXTERNAL_API_BASE: 'https://api.skinrave.gg/affiliates/public/applicants',
    EXTERNAL_API_TOKEN: '35eb5f92-aa7a-4e53-80eb-b8efce4b70fe',
    COMPETITION_DURATION_DAYS: 30,
    ADMIN_API_KEY: process.env.ADMIN_API_KEY || 'change-me-in-production',
    MAX_RECORDS_PER_REQUEST: 30  // API limit
};

// ===================================================================
// # IN-MEMORY STATE STORAGE
// ===================================================================
// Redis key prefixes
const REDIS_KEYS = {
    COMPETITION_STATE: 'competition:state',
    PLAYER_INITIAL_WAGERS: 'competition:initial_wagers' // Hash: username -> initial wagered
};

// Get competition state from Redis
async function getCompetitionState() {
    const state = await redisClient.get(REDIS_KEYS.COMPETITION_STATE);
    return state ? JSON.parse(state) : {
        isActive: false,
        startTime: null,
        endTime: null,
        isEnded: false,
        createdAt: null
    };
}

// Save competition state to Redis
async function saveCompetitionState(state) {
    await redisClient.set(REDIS_KEYS.COMPETITION_STATE, JSON.stringify(state));
}

// Store initial wagered amounts when competition starts
async function storeInitialWagers(playersList) {
    try {
        if (!playersList || playersList.length === 0) {
            console.log('⚠️ No players to store initial wagers for');
            return;
        }

        let stored = 0;
        for (const player of playersList) {
            try {
                // Skip if player data is invalid
                if (!player || !player.username) {
                    continue;
                }
                
                // Default to "0" if wagered is null/undefined
                const wageredValue = player.wagered != null ? player.wagered.toString() : "0";
                
                await redisClient.hSet(
                    REDIS_KEYS.PLAYER_INITIAL_WAGERS,
                    player.username,
                    wageredValue
                );
                stored++;
            } catch (err) {
                console.error(`Failed to store wager for ${player.username}:`, err.message);
            }
        }
        
        console.log(`📦 Stored initial wagers for ${stored} players`);
    } catch (error) {
        console.error('❌ Error in storeInitialWagers:', error);
    }
}

// Get player's initial wagered amount
async function getInitialWager(username) {
    try {
        if (!username) return 0;
        
        const value = await redisClient.hGet(REDIS_KEYS.PLAYER_INITIAL_WAGERS, username);
        
        // Return 0 if value is null/undefined or can't be parsed
        if (value == null || value === '') return 0;
        
        const parsed = parseFloat(value);
        return isNaN(parsed) ? 0 : parsed;
    } catch (error) {
        console.error(`Error getting initial wager for ${username}:`, error.message);
        return 0;
    }
}

// Clear all initial wagers (on reset)
async function clearInitialWagers() {
    await redisClient.del(REDIS_KEYS.PLAYER_INITIAL_WAGERS);
}

// ===================================================================
// # MIDDLEWARE
// ===================================================================

// Enable CORS for local development and production
app.use(cors({
    origin: "*",
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
}));

// Parse JSON request bodies
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path}`);
    next();
});

// ===================================================================
// # AUTHENTICATION MIDDLEWARE
// ===================================================================

/**
 * Validates admin API key from request headers
 * Expects: X-API-Key header with valid admin key
 */
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

    // API key is valid, proceed
    next();
}

// ===================================================================
// # UTILITY FUNCTIONS
// ===================================================================

/**
 * Calculate remaining time in seconds
 * @param {string} endTimeISO - ISO 8601 end timestamp
 * @returns {number} Remaining seconds (0 if expired)
 */
function calculateRemainingSeconds(endTimeISO) {
    if (!endTimeISO) return 0;

    const now = new Date().getTime();
    const end = new Date(endTimeISO).getTime();
    const diffMs = end - now;

    return Math.max(0, Math.floor(diffMs / 1000));
}

/**
 * Check if competition should be marked as ended
 * Updates state if competition time has expired
 */
async function checkAndUpdateCompetitionStatus() {
    const competitionState = await getCompetitionState();
    if (!competitionState.isActive) return;

    const remaining = calculateRemainingSeconds(competitionState.endTime);

    if (remaining === 0 && !competitionState.isEnded) {
        competitionState.isEnded = true;
        competitionState.isActive = false;
        await saveCompetitionState(competitionState);
        console.log('🏁 Competition has ended automatically');
    }
}

/**
 * Get date range for API queries
 * For active competitions: from competition start to RIGHT NOW (or end if passed)
 * For inactive: rolling 30-day window
 * @returns {object} { from: ISO_DATE, to: ISO_DATE }
 */
async function getCompetitionDateRange() {
    const competitionState = await getCompetitionState();
    
    if (competitionState.isActive && competitionState.startTime && competitionState.endTime) {
        const now = new Date();
        const competitionEnd = new Date(competitionState.endTime);
        const effectiveTo = now < competitionEnd ? now : competitionEnd;

        console.log('📅 Active competition:');
        console.log(`   From: ${competitionState.startTime} (start)`);
        console.log(`   To: ${effectiveTo.toISOString()} (${now < competitionEnd ? 'now' : 'end'})`);

        return {
            from: competitionState.startTime,
            to: effectiveTo.toISOString()
        };
    }

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));

    console.log('📅 No active competition - showing last 30 days');
    return {
        from: thirtyDaysAgo.toISOString(),
        to: now.toISOString()
    };
}

// ===================================================================
// # PUBLIC ROUTES
// ===================================================================

/**
 * GET /api/leaderboard
 * Public endpoint - proxies external API with dynamic date filtering
 */
app.get('/api/leaderboard', async (req, res) => {
    try {
        await checkAndUpdateCompetitionStatus();
        const competitionState = await getCompetitionState();

        const { from, to } = await getCompetitionDateRange();

        const apiUrl = `${CONFIG.EXTERNAL_API_BASE}` +
            `?token=${CONFIG.EXTERNAL_API_TOKEN}` +
            `&skip=0` +
            `&take=${CONFIG.MAX_RECORDS_PER_REQUEST}` +
            `&order=DESC` +
            `&from=${from}` +
            `&to=${to}`;

        console.log(`📊 Fetching leaderboard data`);

        const response = await axios.get(apiUrl, {
            timeout: 10000,
            headers: { 'User-Agent': 'Leaderboard-Backend/1.0' }
        });

        // **KEY CHANGE**: Subtract initial wagers if competition is active
        if (competitionState.isActive && response.data && response.data.list) {
            for (const player of response.data.list) {
                const initialWager = await getInitialWager(player.username);
                const currentWager = parseFloat(player.wagered || 0);
                
                // Show only wagered DURING competition
                player.wagered = Math.max(0, currentWager - initialWager).toString();
            }
        }

        // Sort by wagered amount
        if (response.data && response.data.list) {
            response.data.list.sort((a, b) => parseFloat(b.wagered || 0) - parseFloat(a.wagered || 0));
        }

        console.log(`✅ External API responded with ${response.data?.list?.length || 0} players`);

        res.json({
            success: true,
            data: response.data,
            competition: {
                isActive: competitionState.isActive,
                isEnded: competitionState.isEnded,
                startTime: competitionState.startTime,
                endTime: competitionState.endTime,
                remainingSeconds: calculateRemainingSeconds(competitionState.endTime)
            },
            fetchedAt: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Error fetching leaderboard:', error.message);

        // Handle different error types
        if (error.code === 'ECONNABORTED') {
            return res.status(504).json({
                success: false,
                message: 'External API request timed out. Please try again.'
            });
        }

        if (error.response) {
            // External API returned an error
            console.error('External API error details:', error.response.data);

            return res.status(502).json({
                success: false,
                message: 'External API error. Please try again later.',
                // Only show details in development
                ...(process.env.NODE_ENV === 'development' && {
                    details: error.response.data
                })
            });
        }

        // Generic error
        res.status(500).json({
            success: false,
            message: 'Failed to fetch leaderboard data',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/status
 * Public endpoint - returns competition status without admin auth
 */
app.get('/api/status', async (req, res) => {
    await checkAndUpdateCompetitionStatus();
    const competitionState = await getCompetitionState();

    res.json({
        success: true,
        competition: {
            isActive: competitionState.isActive,
            isEnded: competitionState.isEnded,
            startTime: competitionState.startTime,
            endTime: competitionState.endTime,
            remainingSeconds: calculateRemainingSeconds(competitionState.endTime),
            durationDays: CONFIG.COMPETITION_DURATION_DAYS
        },
        serverTime: new Date().toISOString()
    });
});

// ===================================================================
// # ADMIN ROUTES (Protected)
// ===================================================================

/**
 * POST /api/admin/start
 * Starts a new 30-day competition
 * Requires: X-API-Key header
 * Body (optional): { durationDays: number }
 */
app.post('/api/admin/start', authenticateAdmin, async (req, res) => {
    try {
        await checkAndUpdateCompetitionStatus();
        const competitionState = await getCompetitionState();

        if (competitionState.isActive && !competitionState.isEnded) {
            return res.status(400).json({
                success: false,
                message: 'Competition is already active'
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

        await saveCompetitionState(newState);

        // **KEY ADDITION**: Fetch current leaderboard and store initial wagers
        const { from, to } = await getCompetitionDateRange();
        const apiUrl = `${CONFIG.EXTERNAL_API_BASE}?token=${CONFIG.EXTERNAL_API_TOKEN}&skip=0&take=${CONFIG.MAX_RECORDS_PER_REQUEST}&order=DESC&from=${from}&to=${to}`;
        
        try {
            const response = await axios.get(apiUrl, { timeout: 10000 });
            if (response.data && response.data.list) {
                await storeInitialWagers(response.data.list);
            }
        } catch (err) {
            console.error('⚠️ Failed to store initial wagers:', err.message);
        }

        console.log(`🚀 Competition started: ${durationDays} days`);

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
            message: 'Failed to start competition'
        });
    }
});

/**
 * POST /api/admin/reset
 * Resets the competition timer
 * Requires: X-API-Key header
 */
app.post('/api/admin/reset', authenticateAdmin, async (req, res) => {
    try {
        const previousState = await getCompetitionState();

        const newState = {
            isActive: false,
            startTime: null,
            endTime: null,
            isEnded: false,
            createdAt: null
        };

        await saveCompetitionState(newState);
        await clearInitialWagers(); // Clear stored initial wagers

        console.log('🔄 Competition reset');

        res.json({
            success: true,
            message: 'Competition reset successfully',
            previousState,
            newState
        });

    } catch (error) {
        console.error('❌ Error resetting competition:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to reset competition'
        });
    }
});

/**
 * GET /api/admin/status
 * Returns detailed competition status (admin view)
 * Requires: X-API-Key header
 */
app.get('/api/admin/status', authenticateAdmin, async (req, res) => {
    await checkAndUpdateCompetitionStatus();
    const competitionState = await getCompetitionState();

    const remaining = calculateRemainingSeconds(competitionState.endTime);

    res.json({
        success: true,
        competition: {
            isActive: competitionState.isActive,
            isEnded: competitionState.isEnded,
            startTime: competitionState.startTime,
            endTime: competitionState.endTime,
            createdAt: competitionState.createdAt,
            remainingSeconds: remaining,
            remainingDays: Math.ceil(remaining / 86400),
            durationDays: competitionState.durationDays || CONFIG.COMPETITION_DURATION_DAYS
        },
        serverTime: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// ===================================================================
// # HEALTH CHECK
// ===================================================================

/**
 * GET /api/health
 * Health check endpoint for monitoring
 */
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: '1.0.0'
    });
});

// ===================================================================
// # ERROR HANDLING
// ===================================================================

// 404 handler for unknown routes
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint not found',
        path: req.path
    });
});

// Global error handler
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

app.listen(PORT, async () => {
    const competitionState = await getCompetitionState();
    
    console.log(`
╔════════════════════════════════════════════════════════════╗
║            🚀 LEADERBOARD BACKEND API RUNNING              ║
╚════════════════════════════════════════════════════════════╝

🌐 Server:     http://localhost:${PORT}
🔑 Admin Key:  ${CONFIG.ADMIN_API_KEY === 'change-me-in-production' ? '⚠️  USING DEFAULT KEY!' : '✅ Custom key set'}
📊 API:        ${CONFIG.EXTERNAL_API_BASE}

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
   State: ${competitionState.isActive ? '🟢 ACTIVE' : '⚪ INACTIVE'}

✅ Using Redis for persistent storage.
    `);

    // Warn if using default API key
    if (CONFIG.ADMIN_API_KEY === 'change-me-in-production') {
        console.log(`
⚠️⚠️⚠️  SECURITY WARNING  ⚠️⚠️⚠️
You are using the default admin API key!
Please set ADMIN_API_KEY in your .env file.

Generate a secure key:
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
        `);
    }
});

// ===================================================================
// # AUTOMATIC COMPETITION STATUS CHECKER
// ===================================================================

// Automatically check if competition should end every minute
// Automatically check if competition should end every minute
setInterval(async () => {
    const competitionState = await getCompetitionState();
    if (competitionState.isActive) {
        await checkAndUpdateCompetitionStatus();
    }
}, 60000); // Check every 60 seconds

console.log('⏰ Competition status checker started (runs every 60 seconds)');

// ===================================================================
// # GRACEFUL SHUTDOWN
// ===================================================================

process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('\nSIGINT received. Shutting down gracefully...');
    process.exit(0);
});